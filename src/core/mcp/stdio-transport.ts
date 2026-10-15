import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const CLOSE_GRACE_MS = 2_000;
const STDERR_TAIL_BYTES = 8_192;

/**
 * The stdio transport for an MCP server launched by aia.
 *
 * On POSIX the server starts in its own process group. The SDK's transport
 * leaves it in aia's group, so the SIGINT a terminal sends the whole
 * foreground group on Ctrl-C killed every stdio MCP server whenever an
 * operator only meant to cancel a turn, and nothing ever reconnected them.
 * Windows has no process groups in that sense, so it keeps the SDK transport.
 */
export function createStdioClientTransport(params: StdioServerParameters): Transport {
  return process.platform === "win32" ? new StdioClientTransport(params) : new ProcessGroupStdioClientTransport(params);
}

/**
 * Follows the SDK's StdioClientTransport, with two differences: the child
 * leads its own process group (`detached`), which lets `close()` stop the
 * whole group (a server started through `npx` is a grandchild), and piped
 * stderr is always drained into a short tail. The SDK pipes stderr into a
 * stream nothing reads, so a server that writes stderr synchronously (most
 * non-Node servers) blocked, mid-request, once the pipe filled.
 */
export class ProcessGroupStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  private child: ChildProcess | undefined;
  private readonly readBuffer = new ReadBuffer();
  private stderrTail = "";
  private exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;

  constructor(private readonly params: StdioServerParameters) {}

  /** The child's pid once started; it is also its process group id. */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** The last few KB the server wrote to stderr, when stderr is piped. */
  get recentStderr(): string {
    return this.stderrTail;
  }

  /** How the server process ended, once it has. */
  get exitStatus(): { code: number | null; signal: NodeJS.Signals | null } | undefined {
    return this.exit;
  }

  async start(): Promise<void> {
    if (this.child) {
      throw new Error("The stdio transport was already started.");
    }

    await new Promise<void>((resolve, reject) => {
      const stderrMode = this.params.stderr ?? "inherit";
      const options: SpawnOptions = {
        cwd: this.params.cwd,
        detached: true,
        // Exactly what the caller built (src/core/process/environment.ts):
        // the base allowlist, the server's passEnv, and its env.
        env: (this.params.env ?? {}) as NodeJS.ProcessEnv,
        shell: false,
        stdio: ["pipe", "pipe", stderrMode === "overlapped" ? "pipe" : stderrMode]
      };
      const child: ChildProcess = spawn(this.params.command, this.params.args ?? [], options);
      this.child = child;

      child.on("error", (error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.on("spawn", () => {
        resolve();
      });
      child.on("exit", (code, signal) => {
        this.exit = { code, signal };
      });
      child.on("close", (code, signal) => {
        this.exit ??= { code, signal };
        if (this.child === child) {
          this.child = undefined;
        }
        this.onclose?.();
      });
      child.stdin?.on("error", (error) => {
        this.onerror?.(error);
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        this.readBuffer.append(chunk);
        this.processReadBuffer();
      });
      child.stdout?.on("error", (error) => {
        this.onerror?.(error);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-STDERR_TAIL_BYTES);
      });
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (!stdin) {
      throw new Error("Not connected");
    }
    await new Promise<void>((resolve) => {
      if (stdin.write(serializeMessage(message))) {
        resolve();
      } else {
        stdin.once("drain", resolve);
      }
    });
  }

  // Same escalation as the SDK (end stdin, then SIGTERM, then SIGKILL, with a
  // grace period each), sent to the whole group. "close" fires only once the
  // pipes are shut too, so a grandchild still holding them (the server behind
  // `npx`) is signalled even after the direct child has exited.
  async close(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (child) {
      let finished = false;
      const closed = new Promise<void>((resolve) => {
        child.once("close", () => {
          finished = true;
          resolve();
        });
      });
      const settle = async () =>
        Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, CLOSE_GRACE_MS).unref())]);

      try {
        child.stdin?.end();
      } catch {
        // Already gone.
      }
      await settle();
      if (!finished) {
        signalProcessGroup(child, "SIGTERM");
        await settle();
      }
      if (!finished) {
        signalProcessGroup(child, "SIGKILL");
      }
    }
    this.readBuffer.clear();
  }

  private processReadBuffer(): void {
    for (;;) {
      try {
        const message = this.readBuffer.readMessage();
        if (message === null) {
          return;
        }
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}
