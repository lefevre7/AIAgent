import { describe, expect, test } from "vitest";

import { runCli } from "@/cli";
import type { AIAgentSdk } from "@/sdk";
import type { GatewaySessionSnapshot } from "@/core/contracts";

type CaptureStreams = {
  stderr: { write: (value: string) => boolean };
  stdout: { write: (value: string) => boolean };
};

function createCaptureStreams(): { streams: CaptureStreams; getStderr: () => string; getStdout: () => string } {
  let stdout = "";
  let stderr = "";
  return {
    getStderr: () => stderr,
    getStdout: () => stdout,
    streams: {
      stderr: {
        write: (value: string) => {
          stderr += value;
          return true;
        }
      },
      stdout: {
        write: (value: string) => {
          stdout += value;
          return true;
        }
      }
    }
  };
}

async function* lineSource(items: string[]): AsyncIterable<string> {
  for (const item of items) {
    yield item;
  }
}

function buildSnapshot(text: string, lastError?: string): GatewaySessionSnapshot {
  return {
    snapshot: {
      messages: [
        {
          parts: [{ kind: "text", text }],
          role: "assistant"
        }
      ],
      session: {
        lastError: lastError ? { message: lastError } : undefined,
        status: "completed"
      }
    },
    taskState: null
  } as unknown as GatewaySessionSnapshot;
}

type PendingApprovalSpec = { label: string; requestId: string; value: string };

type ToolEventSpec = { errorMessage?: string; status: string; toolName: string };

function createFakeSdk(
  options: {
    lastError?: string;
    modelStatus?: string;
    pendingApprovals?: PendingApprovalSpec[];
    reasoning?: string;
    suppressStream?: boolean;
    toolEvent?: ToolEventSpec;
  } = {}
): {
  sdk: AIAgentSdk;
  getResolved: () => Array<{ decision: string; requestId: string }>;
  getSent: () => string[];
  wasClosed: () => boolean;
} {
  const sent: string[] = [];
  const resolved: Array<{ decision: string; requestId: string }> = [];
  let pending = [...(options.pendingApprovals ?? [])];
  let closed = false;
  let listener: ((event: unknown) => void) | null = null;

  const emit = (delta: string): void => {
    listener?.({ payload: { delta, sessionId: "session.test.cli.1", turnId: "turn.1" }, topic: "message.delta" });
  };

  const handle = {
    async listPendingApprovals() {
      return pending.map((entry) => ({
        request: { id: entry.requestId, target: { kind: "tool", label: entry.label, value: entry.value } }
      }));
    },
    async resolveApproval(input: { decision: string; requestId: string }) {
      resolved.push({ decision: input.decision, requestId: input.requestId });
      pending = pending.filter((entry) => entry.requestId !== input.requestId);
      return { approval: { request: { id: input.requestId } } };
    },
    async resume() {
      return { async wait() {} };
    },
    async sendMessage(input: { text: string }) {
      sent.push(input.text);
      if (options.reasoning) {
        listener?.({
          payload: { delta: options.reasoning, sessionId: "session.test.cli.1", turnId: "turn.1" },
          topic: "message.reasoning"
        });
      }
      if (options.toolEvent) {
        listener?.({
          payload: {
            error: options.toolEvent.errorMessage ? { message: options.toolEvent.errorMessage } : undefined,
            status: options.toolEvent.status,
            toolName: options.toolEvent.toolName
          },
          topic: "tool.updated"
        });
      }
      if (!options.suppressStream) {
        emit("echo: ");
        emit(input.text);
      }
      return { async wait() {} };
    },
    async snapshot() {
      return buildSnapshot(`echo: ${sent[sent.length - 1] ?? ""}`, options.lastError);
    },
    subscribe(handler: (event: unknown) => void) {
      listener = handler;
      return () => {
        if (listener === handler) {
          listener = null;
        }
      };
    }
  };

  const sdk = {
    async close() {
      closed = true;
    },
    async request(topic: string) {
      if (topic === "model.health") {
        return { checkedAt: "2026-06-10T12:00:00.000Z", details: {}, providerId: "fake", status: options.modelStatus ?? "healthy" };
      }
      throw new Error(`unexpected request topic ${topic}`);
    },
    sessions: {
      async create() {
        return {
          handle,
          session: { id: "session.test.cli.1" }
        };
      }
    }
  } as unknown as AIAgentSdk;

  return {
    getResolved: () => resolved,
    getSent: () => sent,
    sdk,
    wasClosed: () => closed
  };
}

describe("interactive CLI loop", () => {
  test("stays open until /exit, sends messages, and prints assistant output", async () => {
    const fake = createFakeSdk();
    const capture = createCaptureStreams();

    const exitCode = await runCli([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["hello there", "/exit", "ignored after exit"])
    });

    expect(exitCode).toBe(0);
    expect(capture.getStdout()).toContain("Session: session.test.cli.1");
    expect(capture.getStdout()).toContain("echo: hello there");
    expect(capture.getStdout()).toContain("Goodbye.");
    // Bare `aia` must enter the REPL, never the old bootstrap-info dead-end.
    expect(capture.getStdout()).not.toContain("bootstrap is in place");
    expect(fake.getSent()).toEqual(["hello there"]);
    expect(fake.wasClosed()).toBe(true);
  });

  test("exits cleanly when the input stream ends with no /exit (EOF)", async () => {
    const fake = createFakeSdk();
    const capture = createCaptureStreams();

    const exitCode = await runCli([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource([])
    });

    expect(exitCode).toBe(0);
    expect(capture.getStdout()).toContain("AIAgent interactive session.");
    expect(fake.getSent()).toEqual([]);
    expect(fake.wasClosed()).toBe(true);
  });

  test("exits with a clean error when the chat model is unavailable", async () => {
    const fake = createFakeSdk({ modelStatus: "unavailable" });
    const capture = createCaptureStreams();

    const exitCode = await runCli([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["hello"])
    });

    expect(exitCode).toBe(1);
    expect(capture.getStderr()).toContain("the chat model provider");
    expect(capture.getStderr()).toContain("unavailable");
    // The REPL must not open or send anything when the model is down.
    expect(capture.getStdout()).not.toContain("AIAgent interactive session.");
    expect(fake.getSent()).toEqual([]);
    expect(fake.wasClosed()).toBe(true);
  });

  test("prints a clean startup error (not a raw stack) when boot fails", async () => {
    const capture = createCaptureStreams();

    const exitCode = await runCli([], capture.streams, {
      createSdk: async () => {
        throw new Error("runtime boot exploded");
      },
      interactiveInput: lineSource(["hello"])
    });

    expect(exitCode).toBe(1);
    expect(capture.getStderr()).toContain("Failed to start AIAgent: runtime boot exploded");
  });

  test("`aia info` prints runtime surfaces/providers without starting a session", async () => {
    const capture = createCaptureStreams();
    let sdkCreated = false;

    const exitCode = await runCli(["info"], capture.streams, {
      createSdk: async () => {
        sdkCreated = true;
        throw new Error("info must not create a session");
      }
    });

    expect(exitCode).toBe(0);
    expect(sdkCreated).toBe(false);
    expect(capture.getStdout()).toContain("Surfaces:");
    expect(capture.getStdout()).toContain("Providers:");
    expect(capture.getStdout()).toContain("bootstrap is in place");
  });

  test("shows a thinking indicator and streams the response", async () => {
    const fake = createFakeSdk();
    const capture = createCaptureStreams();

    const exitCode = await runCli([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["hi there", "/exit"])
    });

    expect(exitCode).toBe(0);
    expect(capture.getStdout()).toContain("Thinking…");
    expect(capture.getStdout()).toContain("echo: hi there");
  });

  test("streams the model's reasoning under the thinking section", async () => {
    const fake = createFakeSdk({ reasoning: "Plan: mkdir ~/temp then write index.html." });
    const capture = createCaptureStreams();

    const exitCode = await runCli([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["make a site", "/exit"])
    });

    expect(exitCode).toBe(0);
    expect(capture.getStdout()).toContain("Thinking…");
    expect(capture.getStdout()).toContain("Plan: mkdir ~/temp then write index.html.");
    expect(capture.getStdout()).toContain("echo: make a site");
  });

  test("does not reprint a prior message on a tool-only turn (no deltas)", async () => {
    // snapshot would return "echo: …" as the latest assistant text; with the
    // stale-summary fallback removed, a no-delta turn must not reprint it.
    const fake = createFakeSdk({
      suppressStream: true,
      toolEvent: { status: "succeeded", toolName: "write_file" }
    });
    const capture = createCaptureStreams();

    const exitCode = await runCli([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["write a file", "/exit"])
    });

    expect(exitCode).toBe(0);
    expect(capture.getStderr()).toContain("· write_file: succeeded");
    expect(capture.getStdout()).not.toContain("echo:");
  });

  test("surfaces the reason a tool failed", async () => {
    const fake = createFakeSdk({
      toolEvent: { errorMessage: "ENOENT: no such directory", status: "failed", toolName: "shell_command" }
    });
    const capture = createCaptureStreams();

    const exitCode = await runCli([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["run a command", "/exit"])
    });

    expect(exitCode).toBe(0);
    expect(capture.getStderr()).toContain("· shell_command: failed — ENOENT: no such directory");
  });

  test("prompts inline for approval and resolves it when the operator approves", async () => {
    const fake = createFakeSdk({ pendingApprovals: [{ label: "Write File", requestId: "approval.1", value: "write_file" }] });
    const capture = createCaptureStreams();

    const exitCode = await runCli([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["write the file", "y", "/exit"])
    });

    expect(exitCode).toBe(0);
    expect(capture.getStdout()).toContain("Approve Write File → write_file? [y/N]");
    expect(capture.getStdout()).toContain("Approved write_file.");
    expect(fake.getResolved()).toEqual([{ decision: "approved", requestId: "approval.1" }]);
    expect(fake.getSent()).toEqual(["write the file"]);
  });

  test("denies an approval when the operator declines", async () => {
    const fake = createFakeSdk({ pendingApprovals: [{ label: "Run Command", requestId: "approval.2", value: "shell_command" }] });
    const capture = createCaptureStreams();

    const exitCode = await runCli([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["run it", "n", "/exit"])
    });

    expect(exitCode).toBe(0);
    expect(capture.getStdout()).toContain("Denied shell_command.");
    expect(fake.getResolved()).toEqual([{ decision: "denied", requestId: "approval.2" }]);
  });

  test("treats /quit as an exit alias", async () => {
    const fake = createFakeSdk();
    const capture = createCaptureStreams();

    const exitCode = await runCli([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["/quit"])
    });

    expect(exitCode).toBe(0);
    expect(fake.getSent()).toEqual([]);
    expect(fake.wasClosed()).toBe(true);
  });

  test("shows help and reports unknown commands without leaving the loop", async () => {
    const fake = createFakeSdk();
    const capture = createCaptureStreams();

    const exitCode = await runCli([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["/help", "/bogus", "real message", "/exit"])
    });

    expect(exitCode).toBe(0);
    expect(capture.getStdout()).toContain("Interactive commands:");
    expect(capture.getStderr()).toContain('Unknown command "/bogus"');
    expect(fake.getSent()).toEqual(["real message"]);
  });

  test("skips blank input and exits cleanly when the input stream ends", async () => {
    const fake = createFakeSdk();
    const capture = createCaptureStreams();

    const exitCode = await runCli([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["   ", "only message"])
    });

    expect(exitCode).toBe(0);
    expect(fake.getSent()).toEqual(["only message"]);
    expect(fake.wasClosed()).toBe(true);
  });

  test("surfaces a session error to stderr but keeps the loop alive", async () => {
    const fake = createFakeSdk({ lastError: "model exploded" });
    const capture = createCaptureStreams();

    const exitCode = await runCli([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["trigger", "/exit"])
    });

    expect(exitCode).toBe(0);
    expect(capture.getStderr()).toContain("Error: model exploded");
    expect(capture.getStdout()).toContain("Goodbye.");
  });
});
