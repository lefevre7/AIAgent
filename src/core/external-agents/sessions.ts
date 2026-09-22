import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import type { AppConfig, ExternalAgentConfig } from "@/core/config";
import type {
  ExternalAgentSessionReadRequest,
  ExternalAgentSessionRecord,
  ExternalAgentSessionSendRequest,
  ExternalAgentSessionService,
  ExternalAgentSessionStartRequest,
  ExternalAgentSessionStopRequest,
  ExternalAgentSessionTurn
} from "@/core/contracts";
import { externalAgentSessionRecordSchema } from "@/core/contracts";
import { buildExternalAgentEnvironment } from "@/core/external-agents/environment";
import { writeJsonAtomic } from "@/core/io/files";
import {
  startProcessSession,
  type ProcessSession,
  type ProcessSessionStream
} from "@/core/process/session";
import { TerminalTurnWatcher } from "@/core/process/turn-watcher";

export type ExternalAgentSessionOutputListener = (event: {
  chunk: string;
  externalSessionId: string;
  sessionId?: string;
  stream: ProcessSessionStream;
}) => void;

/**
 * Writes a paragraph summary of what happened during a turn.
 *
 * Injected rather than depending on `LanguageModelRuntime` directly so the
 * service stays testable without a model and so the caller decides which model
 * pays for the summary.
 */
export type ExternalAgentTurnSummarizer = (params: {
  agentId: string;
  instruction: string;
  screen: string;
}) => Promise<string | undefined>;

export type ExternalAgentSessionServiceOptions = {
  agents: Record<string, ExternalAgentConfig>;
  cols?: number;
  defaultCwd: string;
  humanLockMs?: number;
  idleMs?: number;
  onOutput?: ExternalAgentSessionOutputListener;
  onWarning?: (message: string) => void;
  rows?: number;
  sessionWarningThreshold?: number;
  stabilityMs?: number;
  startupTimeoutMs?: number;
  stateRoot: string;
  summarize?: ExternalAgentTurnSummarizer;
  turnTimeoutMs?: number;
};

type LiveSession = {
  /** Resolves after the exit handler has persisted the terminal record. */
  finalized: Promise<void>;
  logStream: fsSync.WriteStream;
  process: ProcessSession;
  record: ExternalAgentSessionRecord;
  watcher: TerminalTurnWatcher;
};

const DEFAULT_COLS = 120;
const DEFAULT_HUMAN_LOCK_MS = 10_000;
const DEFAULT_IDLE_MS = 2_000;
const DEFAULT_ROWS = 40;
const DEFAULT_SESSION_WARNING_THRESHOLD = 4;
const DEFAULT_STABILITY_MS = 1_000;
// A TUI needs a moment to boot and paint before it can accept input. Bounded so
// an agent that prints nothing until spoken to still starts, just slower.
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_TURN_TIMEOUT_MS = 600_000;

/**
 * Runs external agent CLIs as long-lived interactive terminals.
 *
 * Design notes worth keeping in mind when editing this file:
 *
 * - **One generic PTY, no per-vendor protocols.** Claude and Codex both offer
 *   machine-readable protocol modes, but a protocol pipe is not a terminal a
 *   human can attach to. Since the requirement is that the operator and the
 *   agent drive the *same* live session, every agent gets the same treatment.
 * - **Sessions outlive the turn that started them.** They end only when stopped,
 *   when the child exits, or when a restart sweeps the orphans from disk.
 * - **Writes are soft-locked, not queued.** If a human typed recently, an agent
 *   write is refused with a clear error rather than silently interleaved into
 *   whatever the human was halfway through typing.
 */
export class FileExternalAgentSessionService implements ExternalAgentSessionService {
  private readonly live = new Map<string, LiveSession>();
  private readonly sessionsRoot: string;
  private readonly recoveryPromise: Promise<void>;

  constructor(private readonly options: ExternalAgentSessionServiceOptions) {
    this.sessionsRoot = path.join(options.stateRoot, "sessions");
    this.recoveryPromise = this.sweepOrphans();
  }

  async startSession(request: ExternalAgentSessionStartRequest): Promise<ExternalAgentSessionRecord> {
    await this.recoveryPromise;

    const config = this.options.agents[request.agentId];
    if (!config?.enabled) {
      throw new Error(`External agent ${request.agentId} is not configured or not enabled.`);
    }

    const interactive = config.interactive;
    const id = `external-session.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
    const cwd = request.cwd ?? this.options.defaultCwd;
    const root = path.join(this.sessionsRoot, id);
    const logPath = path.join(root, "terminal.log");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(logPath, "", "utf8");

    const args = [...config.args, ...(interactive?.args ?? [])];
    const createdAt = new Date().toISOString();
    const watcher = new TerminalTurnWatcher({
      cols: this.options.cols ?? DEFAULT_COLS,
      idleMs: interactive?.idleMs ?? this.options.idleMs ?? DEFAULT_IDLE_MS,
      ...(interactive?.readyPattern ? { readyPattern: new RegExp(interactive.readyPattern, "mu") } : {}),
      rows: this.options.rows ?? DEFAULT_ROWS,
      stabilityMs: interactive?.stabilityMs ?? this.options.stabilityMs ?? DEFAULT_STABILITY_MS
    });
    const logStream = fsSync.createWriteStream(logPath, { flags: "a" });

    const processSession = startProcessSession({
      args,
      cols: this.options.cols ?? DEFAULT_COLS,
      command: config.command,
      cwd,
      // Shared with the one-shot job path so the two cannot drift. Passing no
      // `env` here used to fall through to a full copy of `process.env`, which
      // meant an interactive session honoured neither the agent's `env` map
      // nor its `passEnv` allowlist while the one-shot path honoured both.
      env: buildExternalAgentEnvironment({ config }),
      onData: (chunk, stream) => {
        watcher.write(chunk);
        logStream.write(chunk);
        this.emitOutput(id, chunk, stream);
      },
      rows: this.options.rows ?? DEFAULT_ROWS
    });

    // The child is already running, so anything that throws before it is
    // registered in `this.live` would orphan it: neither `stopSession` nor
    // `shutdown` can reach a process they cannot see, and it would outlive
    // this host with a dangling log stream.
    let record: ExternalAgentSessionRecord;
    try {
      record = externalAgentSessionRecordSchema.parse({
        agentId: request.agentId,
        args,
        command: config.command,
        createdAt,
        cwd,
        id,
        logPath,
        pty: processSession.pty,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        status: "running",
        turnCount: 0,
        updatedAt: createdAt
      });
    } catch (error) {
      processSession.kill("SIGKILL");
      logStream.end();
      watcher.dispose();
      throw error;
    }

    // Assigned immediately below; the exit handler needs the entry to read the
    // latest record, and callers need the handler's promise to await teardown.
    const liveSession = { logStream, process: processSession, record, watcher } as LiveSession;
    this.live.set(id, liveSession);
    await this.persist(record);

    liveSession.finalized = processSession.exited.then(async (exit) => {
      logStream.end();
      const endedAt = new Date().toISOString();
      const current = this.live.get(id);
      const next: ExternalAgentSessionRecord = {
        ...(current?.record ?? record),
        endedAt,
        exitCode: exit.exitCode,
        ...(exit.error
          ? {
              error: {
                code: "external_agent_session_spawn_failed",
                details: {},
                message: exit.error.message,
                retriable: false
              }
            }
          : {}),
        status: exit.error ? "failed" : current?.record.status === "stopped" ? "stopped" : "exited",
        updatedAt: endedAt
      };
      this.live.delete(id);
      current?.watcher.dispose();
      await this.persist(next).catch(() => undefined);
    });

    // Do not hand back a session the agent is not ready to hear from. A TUI that
    // has not finished painting silently drops keystrokes, and the turn that
    // followed would report an empty screen as if the agent had answered with
    // nothing. Bounded, and a timeout is not fatal — an agent that stays silent
    // until spoken to is legitimate, it just costs the wait once.
    await watcher.waitForReady({
      exited: processSession.exited,
      timeoutMs: this.resolveStartupTimeout(request.agentId)
    });

    this.warnOnCrowding();
    return record;
  }

  async sendToSession(request: ExternalAgentSessionSendRequest): Promise<ExternalAgentSessionTurn> {
    const session = this.requireLive(request.externalSessionId);
    this.assertWritable(session.record);

    session.process.write(request.text, true);
    // Before persisting: the echo can land while the write below is in flight,
    // and the watcher has to count it as this turn's output rather than the
    // previous turn's.
    session.watcher.beginTurn();
    session.record = {
      ...session.record,
      turnCount: session.record.turnCount + 1,
      updatedAt: new Date().toISOString()
    };
    await this.persist(session.record);

    if (request.noWait) {
      return { record: session.record, screen: await session.watcher.read() };
    }

    const turn = await session.watcher.waitForTurnEnd({
      // A child that exits mid-turn — Claude answering "no" to its own trust
      // prompt, a crash, an auth failure — would otherwise sit out the full
      // turn timeout and then hand back the pre-exit screen as if it were an
      // answer. The caller only found out on its *next* call, which threw.
      exited: session.process.exited,
      timeoutMs: request.timeoutMs ?? this.resolveTurnTimeout(session.record.agentId)
    });
    const summary = await this.summarize(session.record.agentId, request.text, turn.screen);

    return {
      record: session.record,
      screen: turn.screen,
      ...(summary ? { summary } : {}),
      turnEndReason: turn.reason
    };
  }

  async readSession(request: ExternalAgentSessionReadRequest): Promise<ExternalAgentSessionTurn> {
    const session = this.live.get(request.externalSessionId);
    if (session) {
      return {
        record: session.record,
        screen: await session.watcher.read({
          includeScrollback: request.includeScrollback,
          ...(request.maxLines === undefined ? {} : { maxLines: request.maxLines })
        })
      };
    }

    // An ended session has no emulator left, so the durable raw log is the only
    // thing to report. It keeps escape sequences; that is the honest answer.
    const record = await this.requireRecord(request.externalSessionId);
    const raw = await fs.readFile(record.logPath, "utf8").catch(() => "");
    return { record, screen: raw };
  }

  async stopSession(request: ExternalAgentSessionStopRequest): Promise<ExternalAgentSessionRecord> {
    const session = this.live.get(request.externalSessionId);
    if (!session) {
      return this.requireRecord(request.externalSessionId);
    }

    session.record = { ...session.record, status: "stopped", updatedAt: new Date().toISOString() };
    await this.persist(session.record);
    session.process.kill(request.signal);
    await session.finalized;
    return this.requireRecord(request.externalSessionId);
  }

  async listSessions(): Promise<ExternalAgentSessionRecord[]> {
    await this.recoveryPromise;
    const stored = await this.readStoredRecords();
    const merged = new Map(stored.map((record) => [record.id, record]));
    for (const [id, session] of this.live.entries()) {
      merged.set(id, session.record);
    }

    return Array.from(merged.values()).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /** Records that a terminal window is now watching this session. */
  async noteAttached(externalSessionId: string): Promise<void> {
    const session = this.requireLive(externalSessionId);
    const now = new Date().toISOString();
    session.record = { ...session.record, attachedAt: now, updatedAt: now };
    await this.persist(session.record);
  }

  /** Records that a human just typed, which soft-locks agent writes for a while. */
  async noteHumanInput(externalSessionId: string): Promise<void> {
    const session = this.live.get(externalSessionId);
    if (!session) {
      return;
    }

    const now = new Date().toISOString();
    session.record = {
      ...session.record,
      attachedAt: session.record.attachedAt ?? now,
      lastHumanInputAt: now,
      updatedAt: now
    };
    await this.persist(session.record);
  }

  /** Relays a human keystroke from an attached terminal into the child. */
  async writeHumanInput(externalSessionId: string, text: string): Promise<void> {
    const session = this.requireLive(externalSessionId);
    await this.noteHumanInput(externalSessionId);
    session.process.write(text, false);
  }

  async shutdown(): Promise<void> {
    const sessions = Array.from(this.live.values());
    for (const session of sessions) {
      session.process.kill("SIGTERM");
    }
    await Promise.all(sessions.map((session) => session.finalized));
  }

  private assertWritable(record: ExternalAgentSessionRecord): void {
    const lockMs = this.options.humanLockMs ?? DEFAULT_HUMAN_LOCK_MS;
    if (lockMs <= 0 || !record.lastHumanInputAt) {
      return;
    }

    const lastHumanInputAt = Date.parse(record.lastHumanInputAt);
    if (Number.isNaN(lastHumanInputAt)) {
      // Fail closed. An unparsable timestamp means the record is damaged, and
      // the cost of refusing a write is one retry, while the cost of allowing
      // it is the agent typing into whatever the human is halfway through —
      // exactly what the lock exists to prevent.
      throw new Error(
        `External agent session ${record.id} has an unreadable lastHumanInputAt ("${record.lastHumanInputAt}"); refusing to write until a human confirms the session is idle.`
      );
    }

    const sinceHuman = Date.now() - lastHumanInputAt;
    if (sinceHuman < lockMs) {
      throw new Error(
        `A human is typing in external agent session ${record.id}. Wait ${Math.ceil((lockMs - sinceHuman) / 1_000)}s and retry, or ask them to finish.`
      );
    }
  }

  private async summarize(agentId: string, instruction: string, screen: string): Promise<string | undefined> {
    if (!this.options.summarize) {
      return undefined;
    }

    try {
      return await this.options.summarize({ agentId, instruction, screen });
    } catch {
      // A missing summary must never fail the turn; the screen is still returned.
      return undefined;
    }
  }

  private resolveStartupTimeout(agentId: string): number {
    return (
      this.options.agents[agentId]?.interactive?.startupTimeoutMs ??
      this.options.startupTimeoutMs ??
      DEFAULT_STARTUP_TIMEOUT_MS
    );
  }

  private resolveTurnTimeout(agentId: string): number {
    return (
      this.options.agents[agentId]?.interactive?.turnTimeoutMs ??
      this.options.turnTimeoutMs ??
      DEFAULT_TURN_TIMEOUT_MS
    );
  }

  private warnOnCrowding(): void {
    const threshold = this.options.sessionWarningThreshold ?? DEFAULT_SESSION_WARNING_THRESHOLD;
    if (this.live.size > threshold) {
      this.options.onWarning?.(
        `${this.live.size} interactive external agent sessions are live. Each holds a child process until it is stopped.`
      );
    }
  }

  private emitOutput(externalSessionId: string, chunk: string, stream: ProcessSessionStream): void {
    if (!this.options.onOutput || chunk.length === 0) {
      return;
    }

    const owningSessionId = this.live.get(externalSessionId)?.record.sessionId;
    try {
      this.options.onOutput({
        chunk,
        externalSessionId,
        ...(owningSessionId ? { sessionId: owningSessionId } : {}),
        stream
      });
    } catch {
      // Reporting output must never break the process producing it.
    }
  }

  private requireLive(externalSessionId: string): LiveSession {
    const session = this.live.get(externalSessionId);
    if (!session) {
      throw new Error(`External agent session ${externalSessionId} is not running.`);
    }

    return session;
  }

  private async requireRecord(externalSessionId: string): Promise<ExternalAgentSessionRecord> {
    const live = this.live.get(externalSessionId);
    if (live) {
      return live.record;
    }

    try {
      return externalAgentSessionRecordSchema.parse(
        JSON.parse(await fs.readFile(this.recordPath(externalSessionId), "utf8"))
      );
    } catch {
      throw new Error(`External agent session ${externalSessionId} was not found.`);
    }
  }

  /**
   * Marks sessions left "running" by a previous process as stopped.
   *
   * The child died with us, so a record claiming otherwise would let a later
   * `send` wait forever on a terminal that no longer exists.
   */
  private async sweepOrphans(): Promise<void> {
    const stored = await this.readStoredRecords();
    const now = new Date().toISOString();
    await Promise.all(
      stored
        .filter((record) => record.status === "running")
        .map(async (record) =>
          this.persist({ ...record, endedAt: now, status: "stopped", updatedAt: now }).catch(() => undefined)
        )
    );
  }

  private async readStoredRecords(): Promise<ExternalAgentSessionRecord[]> {
    let entries: string[];
    try {
      entries = (await fs.readdir(this.sessionsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }

    const records = await Promise.all(
      entries.map(async (id) => {
        try {
          return externalAgentSessionRecordSchema.parse(JSON.parse(await fs.readFile(this.recordPath(id), "utf8")));
        } catch {
          return null;
        }
      })
    );

    return records.filter((record): record is ExternalAgentSessionRecord => record !== null);
  }

  private async persist(record: ExternalAgentSessionRecord): Promise<void> {
    await writeJsonAtomic(this.recordPath(record.id), record);
  }

  private recordPath(externalSessionId: string): string {
    return path.join(this.sessionsRoot, externalSessionId, "session.json");
  }
}

export function createExternalAgentSessionServiceFromConfig(params: {
  config: AppConfig;
  onOutput?: ExternalAgentSessionOutputListener;
  onWarning?: (message: string) => void;
  summarize?: ExternalAgentTurnSummarizer;
  workspaceRoot: string;
}): FileExternalAgentSessionService | null {
  const externalAgents = params.config.externalAgents;
  if (!externalAgents.enabled) {
    return null;
  }

  const enabled = Object.fromEntries(
    Object.entries(externalAgents.agents).filter(([, config]) => config.enabled)
  );
  if (Object.keys(enabled).length === 0) {
    return null;
  }

  return new FileExternalAgentSessionService({
    agents: enabled,
    cols: externalAgents.interactive.cols,
    defaultCwd: params.workspaceRoot,
    humanLockMs: externalAgents.interactive.humanLockMs,
    idleMs: externalAgents.interactive.idleMs,
    ...(params.onOutput ? { onOutput: params.onOutput } : {}),
    ...(params.onWarning ? { onWarning: params.onWarning } : {}),
    rows: externalAgents.interactive.rows,
    sessionWarningThreshold: externalAgents.interactive.sessionWarningThreshold,
    stabilityMs: externalAgents.interactive.stabilityMs,
    stateRoot: externalAgents.stateRoot,
    ...(params.summarize ? { summarize: params.summarize } : {}),
    turnTimeoutMs: externalAgents.interactive.turnTimeoutMs
  });
}
