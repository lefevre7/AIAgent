import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { runCli } from "@/cli";
import type { AIAgentSdk } from "@/sdk";
import type { ArtifactReference, GatewaySessionSnapshot, SessionRecord, VoiceService } from "@/core/contracts";
import type { FileSessionStore } from "@/core";

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

type PendingApprovalSpec = {
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
    lastError?: string;
    modelStatus?: string;
    pendingApprovals?: PendingApprovalSpec[];
    reasoning?: string;
    suppressStream?: boolean;
    toolEvent?: ToolEventSpec;
  } = {}
): {
  sdk: AIAgentSdk;
  getCompactCalls: () => number;
  getResolved: () => ResolvedApprovalSpec[];
  getSent: () => string[];
  wasClosed: () => boolean;
} {
  const sent: string[] = [];
  const resolved: ResolvedApprovalSpec[] = [];
  let pending = [...(options.pendingApprovals ?? [])];
  let closed = false;
  let compactCalls = 0;
  let listener: ((event: unknown) => void) | null = null;

  const emit = (delta: string): void => {
    listener?.({ payload: { delta, sessionId: "session.test.cli.1", turnId: "turn.1" }, topic: "message.delta" });
  };

  const handle = {
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
          metadata: entry.options ? { options: entry.options } : {},
          target: { kind: entry.kind ?? "tool", label: entry.label, value: entry.value }
        }
      }));
    },
    async resolveApproval(input: { comment?: string; decision: string; requestId: string }) {
      resolved.push({
        ...(input.comment !== undefined ? { comment: input.comment } : {}),
        decision: input.decision,
        requestId: input.requestId
      });
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
    getCompactCalls: () => compactCalls,
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
    const fake = createFakeSdk({
      pendingApprovals: [
        { justification: "Ask before file writes.", label: "Write File", requestId: "approval.1", value: "write_file" }
      ]
    });
    const capture = createCaptureStreams();

    const exitCode = await runCli([], capture.streams, {
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
    const fake = createFakeSdk({ pendingApprovals: [{ label: "Run Command", requestId: "approval.2", value: "shell_command" }] });
    const capture = createCaptureStreams();

    const exitCode = await runCli([], capture.streams, {
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
    const fake = createFakeSdk({ pendingApprovals: [{ label: "Run Command", requestId: "approval.3", value: "shell_command" }] });
    const capture = createCaptureStreams();

    const exitCode = await runCli([], capture.streams, {
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

    const exitCode = await runCli([], capture.streams, {
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
    expect(capture.getStdout()).toContain("further write_file requests are auto-approved for this session");
    expect(capture.getStdout()).toContain("Auto-approved write_file (always for this session).");
    expect(capture.getStdout()).toContain("Approve Run Command → shell_command? [y/N/a/e]");
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

    const exitCode = await runCli([], capture.streams, {
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

    const exitCode = await runCli([], capture.streams, {
      createSdk: async () => fake.sdk,
      interactiveInput: lineSource(["set up the db", "2", "/exit"])
    });

    expect(exitCode).toBe(0);
    // Numbering is a CLI convenience; the tool only ever sees the label, so
    // ask_user_question can still report matchedOption correctly.
    expect(fake.getResolved()).toEqual([{ comment: "postgres", decision: "approved", requestId: "approval.8" }]);
  });

  test("/compact summarizes the session through the SDK and reports the result", async () => {
    const fake = createFakeSdk({ compactResult: { hiddenMessageCount: 6, summaryPath: "/tmp/chat-session-memory/session.md" } });
    const capture = createCaptureStreams();

    const exitCode = await runCli([], capture.streams, {
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
      await runCli([], emptyCapture.streams, { createSdk: async () => empty.sdk, interactiveInput: lineSource(["/compact", "/exit"]) })
    ).toBe(0);
    expect(emptyCapture.getStdout()).toContain("Nothing to compact yet");

    const failing = createFakeSdk({ compactError: "Session has pending approvals" });
    const failingCapture = createCaptureStreams();
    expect(
      await runCli([], failingCapture.streams, {
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
    expect(capture.getStdout()).toContain("/compact");
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

function createPromptSdk(options: { assistant?: string; lastError?: string; status?: string; throwOnCreate?: boolean } = {}): {
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

describe("CLI help, voice help, and one-shot prompt", () => {
  test("prints top-level help", async () => {
    const capture = createCaptureStreams();
    const exitCode = await runCli(["--help"], capture.streams, {});
    expect(exitCode).toBe(0);
    expect(capture.getStdout()).toContain("Available commands:");
  });

  test("prints voice help for --help and a bare voice command", async () => {
    const help = createCaptureStreams();
    expect(await runCli(["voice", "--help"], help.streams, {})).toBe(0);
    expect(help.getStdout().toLowerCase()).toContain("voice");

    const bare = createCaptureStreams();
    expect(await runCli(["voice"], bare.streams, {})).toBe(0);
    expect(bare.getStdout().toLowerCase()).toContain("voice");
  });

  test("reports an unknown voice subcommand", async () => {
    const capture = createCaptureStreams();
    const exitCode = await runCli(["voice", "teleport"], capture.streams, {});
    expect(exitCode).toBe(1);
    expect(capture.getStderr()).toContain("Unknown voice subcommand: teleport");
  });

  test("runs a one-shot --prompt session and prints the assistant summary", async () => {
    const fake = createPromptSdk({ assistant: "All done." });
    const capture = createCaptureStreams();
    const exitCode = await runCli(["--prompt", "do the thing"], capture.streams, { createSdk: async () => fake.sdk });
    expect(exitCode).toBe(0);
    expect(capture.getStdout()).toContain("Assistant: All done.");
    expect(capture.getStdout()).toContain("Status: completed");
    expect(capture.getStdout()).toContain("Run: run.prompt.1");
    expect(fake.wasClosed()).toBe(true);
  });

  test("returns a non-zero exit and surfaces session errors for an unfinished prompt run", async () => {
    const fake = createPromptSdk({ lastError: "ran out of fuel", status: "failed" });
    const capture = createCaptureStreams();
    const exitCode = await runCli(["--prompt", "do the thing"], capture.streams, { createSdk: async () => fake.sdk });
    expect(exitCode).toBe(1);
    expect(capture.getStdout()).toContain("Error: ran out of fuel");
  });

  test("surfaces a failure when the prompt session cannot be created", async () => {
    const fake = createPromptSdk({ throwOnCreate: true });
    const capture = createCaptureStreams();
    const exitCode = await runCli(["--prompt", "do the thing"], capture.streams, { createSdk: async () => fake.sdk });
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
    listDevices: async () => [{ default: true, id: "spk", kind: "output", metadata: {}, name: "Speaker", providerId: "local_system" }],
    listProviderHealth: async () => [],
    listVoices: async () => [{ default: true, displayName: "Alex", id: "Alex", locale: "en-US", metadata: {}, providerId: "local_system" }],
    playback: async () => ({ id: "playback.1", metadata: {}, providerId: "local_system", startedAt: "x", status: "completed" }),
    startCapture: async () => ({ id: "capture.1", metadata: {}, providerId: "apple_native", startedAt: "x", status: "recording" }),
    stopCapture: async () => ({ id: "capture.1", metadata: {}, providerId: "apple_native", startedAt: "x", status: "completed" }),
    synthesize: async () => ({ audio: audioArtifact("file:///tmp/synth.aiff"), completedAt: "x", id: "synthesis.1", metadata: {}, providerId: "local_system" }),
    transcribe: async () => ({ completedAt: "x", id: "transcription.1", locale: "en-US", metadata: {}, providerId: "apple_native", text: "transcribed words" }),
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
    expect(await runCli(["voice", "list-devices", "--kind", "output"], cap.streams, voiceDeps(fakeVoiceService()))).toBe(0);
    expect(cap.getStdout()).toContain("Speaker");

    const voicesCap = createCaptureStreams();
    expect(await runCli(["voice", "list-voices", "--locale", "en"], voicesCap.streams, voiceDeps(fakeVoiceService()))).toBe(0);
    expect(voicesCap.getStdout()).toContain("Alex");

    const emptyCap = createCaptureStreams();
    await runCli(["voice", "list-devices"], emptyCap.streams, voiceDeps(fakeVoiceService({ listDevices: async () => [] })));
    expect(emptyCap.getStdout()).toContain("No matching voice devices");
  });

  test("transcribes a file and records it on a session", async () => {
    const filePath = await tempAudioFile();
    const cap = createCaptureStreams();
    const exitCode = await runCli(
      ["voice", "transcribe-file", "--file", filePath, "--session", "session.voice.cli"],
      cap.streams,
      voiceDeps(fakeVoiceService())
    );
    expect(exitCode).toBe(0);
    expect(cap.getStdout()).toContain("transcribed words");
  });

  test("requires a file for transcribe-file", async () => {
    const cap = createCaptureStreams();
    expect(await runCli(["voice", "transcribe-file"], cap.streams, voiceDeps(fakeVoiceService()))).toBe(1);
    expect(cap.getStdout()).toContain("Usage: aia voice transcribe-file");
  });

  test("captures audio and reports failures", async () => {
    const okCap = createCaptureStreams();
    expect(await runCli(["voice", "capture", "--max-duration-ms", "5000"], okCap.streams, voiceDeps(fakeVoiceService()))).toBe(0);
    expect(okCap.getStdout()).toContain("captured words");

    const failCap = createCaptureStreams();
    const failing = fakeVoiceService({
      waitForCapture: async () => ({ id: "capture.1", metadata: {}, providerId: "apple_native", startedAt: "x", status: "failed" }) as never
    });
    expect(await runCli(["voice", "capture"], failCap.streams, voiceDeps(failing))).toBe(1);
  });

  test("synthesizes and speaks text", async () => {
    const synthCap = createCaptureStreams();
    expect(await runCli(["voice", "synthesize", "--text", "hello"], synthCap.streams, voiceDeps(fakeVoiceService()))).toBe(0);
    expect(synthCap.getStdout()).toContain("file:///tmp/synth.aiff");

    const speakCap = createCaptureStreams();
    expect(await runCli(["voice", "speak", "--text", "hello"], speakCap.streams, voiceDeps(fakeVoiceService()))).toBe(0);
    expect(speakCap.getStdout()).toContain("Speech playback completed.");

    const noTextCap = createCaptureStreams();
    expect(await runCli(["voice", "synthesize"], noTextCap.streams, voiceDeps(fakeVoiceService()))).toBe(1);
  });

  test("surfaces an error for an invalid numeric option", async () => {
    const cap = createCaptureStreams();
    const exitCode = await runCli(
      ["voice", "capture", "--max-duration-ms", "not-a-number"],
      cap.streams,
      voiceDeps(fakeVoiceService())
    );
    expect(exitCode).toBe(1);
    expect(cap.getStderr().length).toBeGreaterThan(0);
  });
});
