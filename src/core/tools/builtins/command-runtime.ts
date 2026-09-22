import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { createArtifactReferenceFromFile } from "@/core/io/artifacts";
import { sleep, writeJsonAtomic } from "@/core/io/files";
import { startProcessSession } from "@/core/process/session";
import { runProcess } from "@/core/voice/utils";

import { normalizeSlashes, resolveLocalPath } from "@/core/tools/builtins/local-paths";

export type CommandLogStream = "combined" | "stderr" | "stdout";
export type CommandSessionStatus = "completed" | "failed" | "killed" | "running";

export type CommandSessionRecord = {
  args: string[];
  attached: boolean;
  command: string;
  commandLine: string;
  cwd: string;
  endedAt?: string;
  exitCode?: number;
  id: string;
  kind: "exec_command" | "shell_command";
  logPaths: {
    combined: string;
    stderr?: string;
    stdout?: string;
  };
  // The agent session that started this command. Live output is emitted long
  // after the starting tool call settled, so the association has to be stored
  // rather than inferred from whatever turn happens to be running.
  ownerSessionId?: string;
  pty: boolean;
  signal?: string | null;
  startedAt: string;
  status: CommandSessionStatus;
  timedOut?: boolean;
  updatedAt: string;
};

export type ShellCommandRunResult = {
  combinedOutput: string;
  record: CommandSessionRecord;
  stderr: string;
  stdout: string;
};

export type ReadCommandOutputResult = {
  artifact: Awaited<ReturnType<typeof createArtifactReferenceFromFile>> | null;
  matchCount: number;
  nextOffset: number | null;
  offset: number;
  output: string;
  record: CommandSessionRecord;
  stream: CommandLogStream;
  totalChars: number;
  truncated: boolean;
};

export type CommandTailResult = {
  logPath: string;
  offset: number;
  output: string;
  /**
   * Size of the whole log in bytes.
   *
   * Bytes, not characters, because the tail is read by seeking to the end of
   * the file rather than decoding all of it — counting characters would mean
   * reading everything, which is exactly the cost this avoids.
   */
  totalBytes: number;
  truncated: boolean;
};

export type CommandOutputListener = (event: {
  chunk: string;
  ownerSessionId?: string;
  sessionId: string;
  stream: CommandLogStream;
}) => void;

type RunningCommandSession = {
  completion: Promise<CommandSessionRecord>;
  handle: {
    kill(signal?: string): void;
    write(text: string, submit?: boolean): void;
  };
  killed: boolean;
  outputStream: fsSync.WriteStream;
  record: CommandSessionRecord;
};

export class CommandRuntime {
  private readonly commandsRoot: string;
  private readonly runningSessions = new Map<string, RunningCommandSession>();

  constructor(
    private readonly options: {
      baseDirectory: string;
      onOutput?: CommandOutputListener;
      stateRoot: string;
    }
  ) {
    this.commandsRoot = path.join(options.stateRoot, "commands", "runs");
  }

  /**
   * Fans live output out to the control plane.
   *
   * Swallowing listener failures is deliberate: `EventEmitter`-style dispatch is
   * synchronous, so a throwing subscriber would otherwise travel back into the
   * command it is merely reporting on.
   */
  private emitOutput(record: CommandSessionRecord, stream: CommandLogStream, chunk: string): void {
    if (!this.options.onOutput || chunk.length === 0) {
      return;
    }

    try {
      this.options.onOutput({
        chunk,
        ...(record.ownerSessionId ? { ownerSessionId: record.ownerSessionId } : {}),
        sessionId: record.id,
        stream
      });
    } catch {
      // Reporting output must never break the process producing it.
    }
  }

  async runShellCommand(params: { command: string; cwd?: string; timeoutMs?: number }): Promise<ShellCommandRunResult> {
    const cwd = resolveLocalPath(params.cwd ?? this.options.baseDirectory, this.options.baseDirectory);
    const id = `command.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
    const attemptRoot = this.commandRoot(id);
    const stdoutPath = path.join(attemptRoot, "stdout.log");
    const stderrPath = path.join(attemptRoot, "stderr.log");
    const combinedPath = path.join(attemptRoot, "combined.log");
    await fs.mkdir(attemptRoot, { recursive: true });

    const invocation = buildShellInvocation(params.command);
    const startedAt = new Date().toISOString();
    const runningRecord: CommandSessionRecord = {
      args: invocation.args,
      attached: false,
      command: invocation.command,
      commandLine: params.command,
      cwd: normalizeSlashes(cwd),
      id,
      kind: "shell_command",
      logPaths: {
        combined: combinedPath,
        stderr: stderrPath,
        stdout: stdoutPath
      },
      pty: false,
      startedAt,
      status: "running",
      updatedAt: startedAt
    };
    await this.persistRecord(runningRecord);

    const result = await runProcess(invocation.command, invocation.args, {
      cwd,
      timeoutMs: params.timeoutMs
    });
    const endedAt = new Date().toISOString();
    const combinedOutput = buildCombinedOutput(result.stdout, result.stderr);
    await Promise.all([
      fs.writeFile(stdoutPath, result.stdout, "utf8"),
      fs.writeFile(stderrPath, result.stderr, "utf8"),
      fs.writeFile(combinedPath, combinedOutput, "utf8")
    ]);

    const completedRecord: CommandSessionRecord = {
      ...runningRecord,
      endedAt,
      exitCode: result.exitCode,
      signal: result.signal,
      status: result.timedOut ? "killed" : result.exitCode === 0 ? "completed" : "failed",
      timedOut: result.timedOut,
      updatedAt: endedAt
    };
    await this.persistRecord(completedRecord);

    return {
      combinedOutput,
      record: completedRecord,
      stderr: result.stderr,
      stdout: result.stdout
    };
  }

  async startExecCommand(params: {
    args: string[];
    cols?: number;
    command: string;
    cwd?: string;
    ownerSessionId?: string;
    rows?: number;
  }): Promise<CommandSessionRecord> {
    const cwd = resolveLocalPath(params.cwd ?? this.options.baseDirectory, this.options.baseDirectory);
    const id = `command.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
    const startedAt = new Date().toISOString();
    const attemptRoot = this.commandRoot(id);
    const combinedPath = path.join(attemptRoot, "combined.log");
    await fs.mkdir(attemptRoot, { recursive: true });
    await fs.writeFile(combinedPath, "", "utf8");

    const record: CommandSessionRecord = {
      args: params.args,
      attached: true,
      command: params.command,
      commandLine: buildCommandLine(params.command, params.args),
      cwd: normalizeSlashes(cwd),
      id,
      kind: "exec_command",
      logPaths: {
        combined: combinedPath
      },
      ...(params.ownerSessionId ? { ownerSessionId: params.ownerSessionId } : {}),
      pty: true,
      startedAt,
      status: "running",
      updatedAt: startedAt
    };

    const outputStream = fsSync.createWriteStream(combinedPath, { flags: "a" });
    const startedSession = this.startSession({
      cols: params.cols,
      cwd,
      id,
      outputStream,
      record,
      rows: params.rows
    });

    this.runningSessions.set(id, startedSession);
    await this.persistRecord(startedSession.record);

    return startedSession.record;
  }

  async writeStdin(params: { sessionId: string; submit?: boolean; text: string }): Promise<CommandSessionRecord> {
    const session = this.requireRunningSession(params.sessionId);
    session.handle.write(params.text, params.submit);
    session.record = {
      ...session.record,
      updatedAt: new Date().toISOString()
    };
    await this.persistRecord(session.record);
    return session.record;
  }

  async waitForCommand(params: { sessionId: string; timeoutMs?: number }): Promise<{
    record: CommandSessionRecord;
    timedOut: boolean;
  }> {
    const liveSession = this.runningSessions.get(params.sessionId);
    if (!liveSession) {
      return {
        record: await this.requireRecord(params.sessionId),
        timedOut: false
      };
    }

    if (!params.timeoutMs) {
      return {
        record: await liveSession.completion,
        timedOut: false
      };
    }

    const timedOut = await Promise.race([
      liveSession.completion.then(() => false),
      sleep(params.timeoutMs).then(() => true)
    ]);
    if (timedOut) {
      return {
        record: liveSession.record,
        timedOut: true
      };
    }

    return {
      record: await liveSession.completion,
      timedOut: false
    };
  }

  async killCommand(params: { sessionId: string; signal?: string; timeoutMs?: number }): Promise<{
    record: CommandSessionRecord;
    timedOut: boolean;
  }> {
    const session = this.requireRunningSession(params.sessionId);
    session.killed = true;
    session.handle.kill(params.signal ?? "SIGTERM");
    return this.waitForCommand({
      sessionId: params.sessionId,
      timeoutMs: params.timeoutMs ?? 5_000
    });
  }

  async listCommandSessions(
    params: {
      limit?: number;
    } = {}
  ): Promise<CommandSessionRecord[]> {
    const stored = await this.readStoredRecords();
    const next = new Map(stored.map((record) => [record.id, record]));

    for (const [id, session] of this.runningSessions.entries()) {
      next.set(id, session.record);
    }

    return Array.from(next.values())
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, params.limit ?? 100);
  }

  async readCommandOutput(params: {
    maxChars?: number;
    offset?: number;
    query?: string;
    sessionId: string;
    stream?: CommandLogStream;
  }): Promise<ReadCommandOutputResult> {
    const record = await this.requireRecord(params.sessionId);
    const stream = params.stream ?? "combined";
    const targetPath = resolveOutputPath(record, stream);
    if (!targetPath) {
      throw new Error(`The ${stream} output stream is not available for command session ${record.id}.`);
    }

    const raw = await fs.readFile(targetPath, "utf8");
    if (params.query) {
      const matches = raw.split(/\r?\n/u).filter((line) => line.toLowerCase().includes(params.query!.toLowerCase()));

      return {
        artifact: await createArtifactReferenceFromFile(targetPath, "log", {
          name: path.basename(targetPath)
        }),
        matchCount: matches.length,
        nextOffset: null,
        offset: 0,
        output: matches.join("\n"),
        record,
        stream,
        totalChars: raw.length,
        truncated: false
      };
    }

    const offset = params.offset ?? 0;
    const maxChars = params.maxChars ?? 16_000;
    const nextOutput = raw.slice(offset, offset + maxChars);

    return {
      artifact: await createArtifactReferenceFromFile(targetPath, "log", {
        name: path.basename(targetPath)
      }),
      matchCount: 0,
      nextOffset: offset + maxChars < raw.length ? offset + nextOutput.length : null,
      offset,
      output: nextOutput,
      record,
      stream,
      totalChars: raw.length,
      truncated: offset + maxChars < raw.length
    };
  }

  /**
   * Reads the end of a session's combined log.
   *
   * Lifecycle tools (exec/write_stdin/wait/kill) need "what has this process
   * said lately", which is the opposite end of the log from the paged reads
   * `readCommandOutput` is built for. Keeping the tail here means every caller
   * reports output the same way instead of each tool re-deriving offsets.
   */
  async readCommandTail(params: {
    maxChars?: number;
    sessionId: string;
    stream?: CommandLogStream;
  }): Promise<CommandTailResult | null> {
    const record = await this.requireRecord(params.sessionId);
    const stream = params.stream ?? "combined";
    const targetPath = resolveOutputPath(record, stream);
    if (!targetPath) {
      return null;
    }

    const maxChars = params.maxChars ?? 8_000;

    // Seek rather than read the whole log: every command-lifecycle tool
    // (exec_command, write_stdin, wait_command, kill_command) calls this on
    // each invocation, and a long-running build or PTY tail can leave a log
    // far larger than the few KB actually wanted. Reading it whole made each
    // keystroke O(log size) in both time and peak memory.
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(targetPath, "r");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }

      throw error;
    }

    try {
      const { size } = await handle.stat();
      // UTF-8 is up to 4 bytes per character, so reading 4x the character
      // budget guarantees the tail contains at least `maxChars` characters.
      // The slice below then trims to the exact count.
      const readBytes = Math.min(size, maxChars * 4);
      const start = size - readBytes;
      const buffer = Buffer.alloc(readBytes);
      await handle.read(buffer, 0, readBytes, start);

      // A mid-character start offset would decode as a replacement character;
      // drop any leading continuation bytes (0b10xxxxxx) before decoding.
      let begin = 0;
      while (start > 0 && begin < buffer.length && (buffer[begin]! & 0xc0) === 0x80) {
        begin += 1;
      }
      const tail = buffer.subarray(begin).toString("utf8");
      const output = tail.length > maxChars ? tail.slice(tail.length - maxChars) : tail;

      return {
        logPath: targetPath,
        // Byte-accurate character offsets would need the whole file; the
        // caller uses this only to say "there is more before this", and
        // read_command_output(offset: 0) is the documented way to get it all.
        offset: Math.max(0, size - Buffer.byteLength(output, "utf8")),
        output,
        totalBytes: size,
        truncated: size > Buffer.byteLength(output, "utf8")
      };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async persistRecord(record: CommandSessionRecord): Promise<void> {
    await writeJsonAtomic(this.recordPath(record.id), record);
  }

  private async requireRecord(sessionId: string): Promise<CommandSessionRecord> {
    const live = this.runningSessions.get(sessionId);
    if (live) {
      return live.record;
    }

    const recordPath = this.recordPath(sessionId);
    try {
      return JSON.parse(await fs.readFile(recordPath, "utf8")) as CommandSessionRecord;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new Error(`Command session ${sessionId} was not found.`);
      }

      throw error;
    }
  }

  private requireRunningSession(sessionId: string): RunningCommandSession {
    const session = this.runningSessions.get(sessionId);
    if (!session) {
      throw new Error(`Command session ${sessionId} is not running.`);
    }

    return session;
  }

  private async readStoredRecords(): Promise<CommandSessionRecord[]> {
    try {
      const children = await fs.readdir(this.commandsRoot, { withFileTypes: true });
      const records = await Promise.all(
        children
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            try {
              return JSON.parse(await fs.readFile(this.recordPath(entry.name), "utf8")) as CommandSessionRecord;
            } catch {
              return null;
            }
          })
      );

      return records.filter((record): record is CommandSessionRecord => record !== null);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  private commandRoot(sessionId: string): string {
    return path.join(this.commandsRoot, sessionId);
  }

  private recordPath(sessionId: string): string {
    return path.join(this.commandRoot(sessionId), "record.json");
  }

  /**
   * Starts the child through the shared process primitive and wires its output
   * into this runtime's log file, live listener, and persisted record.
   *
   * The primitive owns PTY-vs-pipe; everything below is command-session
   * bookkeeping, which is why the two concerns live in different modules.
   */
  private startSession(params: {
    cols?: number;
    cwd: string;
    id: string;
    outputStream: fsSync.WriteStream;
    record: CommandSessionRecord;
    rows?: number;
  }): RunningCommandSession {
    // `record` is reassigned below once the primitive reports whether it got a
    // real terminal, so the emit closure reads through the session entry.
    const session = startProcessSession({
      args: params.record.args,
      ...(params.cols === undefined ? {} : { cols: params.cols }),
      command: params.record.command,
      cwd: params.cwd,
      onData: (chunk, stream) => {
        params.outputStream.write(chunk);
        this.emitOutput(this.runningSessions.get(params.id)?.record ?? params.record, stream, chunk);
      },
      ...(params.rows === undefined ? {} : { rows: params.rows })
    });

    const record: CommandSessionRecord = {
      ...params.record,
      pty: session.pty
    };

    const completion = session.exited.then(async (exit) => {
      if (exit.error) {
        params.outputStream.write(`[spawn_error]\n${exit.error.message}\n`);
      }
      params.outputStream.end();
      return this.finalizeSessionRecord(params.id, record, {
        exitCode: exit.exitCode,
        signal: exit.signal
      });
    });

    return {
      completion,
      handle: {
        kill: (signal) => {
          session.kill(signal);
        },
        write: (text, submit) => {
          session.write(text, submit);
        }
      },
      killed: false,
      outputStream: params.outputStream,
      record
    };
  }

  private async finalizeSessionRecord(
    sessionId: string,
    record: CommandSessionRecord,
    outcome: {
      exitCode: number;
      signal: string | null;
    }
  ): Promise<CommandSessionRecord> {
    const current = this.runningSessions.get(sessionId);
    const endedAt = new Date().toISOString();
    const nextRecord: CommandSessionRecord = {
      ...(current?.record ?? record),
      attached: false,
      endedAt,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      status: current?.killed ? "killed" : outcome.exitCode === 0 ? "completed" : "failed",
      updatedAt: endedAt
    };
    await this.persistRecord(nextRecord);
    this.runningSessions.delete(sessionId);
    return nextRecord;
  }
}

function buildCommandLine(command: string, args: string[]): string {
  return [command, ...args].join(" ").trim();
}

function buildCombinedOutput(stdout: string, stderr: string): string {
  const chunks: string[] = [];
  if (stdout.length > 0) {
    chunks.push(stdout.endsWith("\n") ? stdout : `${stdout}\n`);
  }
  if (stderr.length > 0) {
    chunks.push(`[stderr]\n${stderr}`);
  }
  return chunks.join("");
}

function buildShellInvocation(commandText: string): {
  args: string[];
  command: string;
} {
  if (process.platform === "win32") {
    return {
      args: ["/d", "/s", "/c", commandText],
      command: process.env.ComSpec || "cmd.exe"
    };
  }

  return {
    args: ["-lc", commandText],
    command: "/bin/sh"
  };
}

function resolveOutputPath(record: CommandSessionRecord, stream: CommandLogStream): string | null {
  if (stream === "combined") {
    return record.logPaths.combined;
  }
  if (stream === "stdout") {
    return record.logPaths.stdout ?? null;
  }

  return record.logPaths.stderr ?? null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
