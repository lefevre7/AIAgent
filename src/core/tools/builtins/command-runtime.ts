import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { spawn as spawnPty, type IPty } from "node-pty";

import { createArtifactReferenceFromFile } from "@/core/io/artifacts";
import { sleep, writeJsonAtomic } from "@/core/io/files";
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
      stateRoot: string;
    }
  ) {
    this.commandsRoot = path.join(options.stateRoot, "commands", "runs");
  }

  async runShellCommand(params: {
    command: string;
    cwd?: string;
    timeoutMs?: number;
  }): Promise<ShellCommandRunResult> {
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
      pty: true,
      startedAt,
      status: "running",
      updatedAt: startedAt
    };

    const outputStream = fsSync.createWriteStream(combinedPath, { flags: "a" });
    const startedSession = this.startPtySession({
      cols: params.cols,
      cwd,
      id,
      outputStream,
      record,
      rows: params.rows
    }) ?? this.startPipeSession({ cwd, id, outputStream, record });

    this.runningSessions.set(id, startedSession);
    await this.persistRecord(startedSession.record);

    return startedSession.record;
  }

  async writeStdin(params: {
    sessionId: string;
    submit?: boolean;
    text: string;
  }): Promise<CommandSessionRecord> {
    const session = this.requireRunningSession(params.sessionId);
    session.handle.write(params.text, params.submit);
    session.record = {
      ...session.record,
      updatedAt: new Date().toISOString()
    };
    await this.persistRecord(session.record);
    return session.record;
  }

  async waitForCommand(params: {
    sessionId: string;
    timeoutMs?: number;
  }): Promise<{
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

  async killCommand(params: {
    sessionId: string;
    signal?: string;
    timeoutMs?: number;
  }): Promise<{
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

  async listCommandSessions(params: {
    limit?: number;
  } = {}): Promise<CommandSessionRecord[]> {
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
      const matches = raw
        .split(/\r?\n/u)
        .filter((line) => line.toLowerCase().includes(params.query!.toLowerCase()));

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

  private startPtySession(params: {
    cols?: number;
    cwd: string;
    id: string;
    outputStream: fsSync.WriteStream;
    record: CommandSessionRecord;
    rows?: number;
  }): RunningCommandSession | null {
    let pty: IPty;
    try {
      pty = spawnPty(params.record.command, params.record.args, {
        cols: params.cols ?? 120,
        cwd: params.cwd,
        env: buildPtyEnvironment(),
        name: process.env.TERM || "xterm-color",
        rows: params.rows ?? 40
      });
    } catch {
      return null;
    }

    const completion = this.createPtyCompletion(params.id, params.record, params.outputStream, pty);
    return {
      completion,
      handle: {
        kill(signal) {
          pty.kill(signal ?? "SIGTERM");
        },
        write(text, submit) {
          pty.write(text);
          if (submit) {
            pty.write("\r");
          }
        }
      },
      killed: false,
      outputStream: params.outputStream,
      record: params.record
    };
  }

  private startPipeSession(params: {
    cwd: string;
    id: string;
    outputStream: fsSync.WriteStream;
    record: CommandSessionRecord;
  }): RunningCommandSession {
    const child = spawnChild(params.record.command, params.record.args, {
      cwd: params.cwd,
      env: process.env,
      stdio: "pipe"
    }) as ChildProcessWithoutNullStreams;
    const record = {
      ...params.record,
      pty: false
    };
    const completion = this.createPipeCompletion(params.id, record, params.outputStream, child);

    return {
      completion,
      handle: {
        kill(signal) {
          child.kill((signal as NodeJS.Signals | undefined) ?? "SIGTERM");
        },
        write(text, submit) {
          child.stdin.write(submit ? `${text}\n` : text);
        }
      },
      killed: false,
      outputStream: params.outputStream,
      record
    };
  }

  private createPtyCompletion(
    sessionId: string,
    record: CommandSessionRecord,
    outputStream: fsSync.WriteStream,
    pty: IPty
  ): Promise<CommandSessionRecord> {
    return new Promise<CommandSessionRecord>((resolve) => {
      pty.onData((data) => {
        outputStream.write(data);
      });

      pty.onExit(async (event) => {
        outputStream.end();
        const nextRecord = await this.finalizeSessionRecord(sessionId, record, {
          exitCode: event.exitCode,
          signal: event.signal === 0 ? null : String(event.signal)
        });
        resolve(nextRecord);
      });
    });
  }

  private createPipeCompletion(
    sessionId: string,
    record: CommandSessionRecord,
    outputStream: fsSync.WriteStream,
    child: ChildProcessWithoutNullStreams
  ): Promise<CommandSessionRecord> {
    return new Promise<CommandSessionRecord>((resolve) => {
      let settled = false;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        outputStream.write(chunk);
      });
      child.stderr.on("data", (chunk: string) => {
        outputStream.write(chunk);
      });

      child.once("error", async (error) => {
        if (settled) {
          return;
        }
        settled = true;
        outputStream.write(`[spawn_error]\n${error.message}\n`);
        outputStream.end();
        const nextRecord = await this.finalizeSessionRecord(sessionId, record, {
          exitCode: 1,
          signal: null
        });
        resolve(nextRecord);
      });

      child.once("exit", async (exitCode, signal) => {
        if (settled) {
          return;
        }
        settled = true;
        outputStream.end();
        const nextRecord = await this.finalizeSessionRecord(sessionId, record, {
          exitCode: exitCode ?? 1,
          signal: signal ?? null
        });
        resolve(nextRecord);
      });
    });
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

function buildPtyEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
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