import { spawn as spawnChild, type ChildProcessWithoutNullStreams } from "node:child_process";

import { spawn as spawnPty, type IPty } from "node-pty";

/**
 * Which of the child's streams a chunk came from.
 *
 * A PTY merges stdout and stderr onto one terminal device by design, so PTY
 * sessions always report `"combined"`. Pipe sessions can still distinguish the
 * two, and callers that only care about "what did it say" can ignore the field.
 */
export type ProcessSessionStream = "combined" | "stderr" | "stdout";

export type ProcessSessionExit = {
  /** Set only when the process could not be spawned at all. */
  error?: Error;
  exitCode: number;
  signal: string | null;
};

export type ProcessSessionOptions = {
  args: string[];
  cols?: number;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  /**
   * Called for every chunk the child emits. Failures are the caller's problem:
   * this module deliberately does not try/catch, because each consumer already
   * knows whether a throwing sink should abort it.
   */
  onData: (chunk: string, stream: ProcessSessionStream) => void;
  rows?: number;
  /**
   * Set false to skip the PTY entirely (tests, or a child that misbehaves under
   * a terminal). Defaults to true; a failed PTY spawn always falls back to pipes.
   */
  usePty?: boolean;
};

export type ProcessSession = {
  /** Resolves once, when the child exits or fails to spawn. Never rejects. */
  readonly exited: Promise<ProcessSessionExit>;
  kill(signal?: string): void;
  /** True when the child is attached to a real terminal device. */
  readonly pty: boolean;
  resize(cols: number, rows: number): void;
  write(text: string, submit?: boolean): void;
};

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;

/**
 * Starts a long-lived child process, preferring a pseudo-terminal.
 *
 * Why a PTY matters: many CLIs check `isatty()` and switch behavior. Without a
 * terminal they disable colour, drop progress rendering, and — crucially for
 * interactive agent CLIs — refuse to show a prompt at all, because they assume
 * they are being piped into a script. A PTY makes the child believe a human is
 * present, which is the only way to drive a TUI. The cost is that stdout and
 * stderr are merged and the bytes carry ANSI escape sequences, so anything that
 * wants the *rendered screen* has to replay those escapes.
 *
 * Pipes are the fallback: `node-pty` is a native addon, so a platform without a
 * prebuilt binary must still be able to run non-interactive children.
 */
export function startProcessSession(options: ProcessSessionOptions): ProcessSession {
  if (options.usePty !== false) {
    const session = startPtySession(options);
    if (session) {
      return session;
    }
  }

  return startPipeSession(options);
}

function startPtySession(options: ProcessSessionOptions): ProcessSession | null {
  let pty: IPty;
  try {
    pty = spawnPty(options.command, options.args, {
      cols: options.cols ?? DEFAULT_COLS,
      cwd: options.cwd,
      env: options.env ?? inheritedEnvironment(),
      name: process.env.TERM || "xterm-color",
      rows: options.rows ?? DEFAULT_ROWS
    });
  } catch (error) {
    warnPtyFallback(error);
    return null;
  }

  const exited = new Promise<ProcessSessionExit>((resolve) => {
    pty.onData((chunk) => {
      options.onData(chunk, "combined");
    });
    pty.onExit((event) => {
      resolve({
        exitCode: event.exitCode,
        signal: event.signal === 0 ? null : String(event.signal)
      });
    });
  });

  return {
    exited,
    kill(signal) {
      pty.kill(signal ?? "SIGTERM");
    },
    pty: true,
    resize(cols, rows) {
      pty.resize(cols, rows);
    },
    write(text, submit) {
      pty.write(text);
      if (submit) {
        // A terminal submits on carriage return, not newline: the line
        // discipline translates CR into the child's end-of-line.
        pty.write("\r");
      }
    }
  };
}

function startPipeSession(options: ProcessSessionOptions): ProcessSession {
  const child = spawnChild(options.command, options.args, {
    cwd: options.cwd,
    // Next.js augments ProcessEnv with required keys, so the plain record has to
    // be widened back to the spawn signature's expectation.
    env: (options.env ?? process.env) as NodeJS.ProcessEnv,
    stdio: "pipe"
  }) as ChildProcessWithoutNullStreams;

  const exited = new Promise<ProcessSessionExit>((resolve) => {
    let settled = false;
    const settle = (exit: ProcessSessionExit): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(exit);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    // A write to a dead child's stdin raises EPIPE on the stream, and an
    // unhandled stream 'error' is an uncaught exception that would take the
    // whole host process down. Writing after exit is an ordinary race — the
    // child can die between a caller's check and its write — so record it and
    // let the caller learn the truth from `exited`.
    child.stdin.on("error", (error) => {
      options.onData(`\n[stdin unavailable: ${error.message}]\n`, "stderr");
    });
    child.stdout.on("data", (chunk: string) => {
      options.onData(chunk, "stdout");
    });
    child.stderr.on("data", (chunk: string) => {
      options.onData(chunk, "stderr");
    });
    child.once("error", (error) => {
      settle({ error, exitCode: 1, signal: null });
    });
    child.once("exit", (exitCode, signal) => {
      settle({ exitCode: exitCode ?? 1, signal: signal ?? null });
    });
  });

  return {
    exited,
    kill(signal) {
      child.kill((signal as NodeJS.Signals | undefined) ?? "SIGTERM");
    },
    pty: false,
    resize() {
      // A pipe has no window size; resizing is a no-op rather than an error so
      // callers do not have to branch on `session.pty`.
    },
    write(text, submit) {
      child.stdin.write(submit ? `${text}\n` : text);
    }
  };
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

let warnedPtyFallback = false;

/**
 * Falling back to pipes silently is the worst outcome: interactive agent CLIs
 * simply stop rendering and nothing explains why. Warn once per process.
 */
function warnPtyFallback(error: unknown): void {
  if (warnedPtyFallback) {
    return;
  }
  warnedPtyFallback = true;
  const reason = error instanceof Error ? error.message : String(error);
  console.warn(
    `AIA_PTY_FALLBACK: node-pty could not start a terminal (${reason}); ` +
      "falling back to pipes, so interactive terminals will not render. " +
      "Run `npm run postinstall` to repair node-pty's spawn-helper permissions."
  );
}
