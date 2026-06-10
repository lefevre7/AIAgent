import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  FileSessionStore,
  createDefaultToolRuntime,
  sessionRecordSchema,
  toolCallRecordSchema,
  turnRecordSchema,
  type Message,
  type SessionRecord,
  type ToolRuntime
} from "@/core";
import type { ChannelService } from "@/core/channels";

const tempRoots: string[] = [];
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

describe("view_image tool", () => {
  test("loads a local image as an image artifact message part", async () => {
    const root = await createTempRoot();
    await fs.writeFile(path.join(root, "pic.png"), Buffer.from(PNG_BASE64, "base64"));
    const runtime = createDefaultToolRuntime({ stateRoot: path.join(root, ".aia"), workspaceRoot: root });

    const outcome = await execute(runtime, root, "view_image", { path: "pic.png" });

    expect(outcome.toolCall.status).toBe("succeeded");
    expect(outcome.toolCall.result).toMatchObject({ mediaType: "image/png" });
    const imagePart = outcome.resultMessage?.parts.find((part) => part.kind === "image");
    expect(imagePart).toBeTruthy();
    expect((imagePart as { uri: string }).uri).toMatch(/^file:\/\//u);
  });

  test("rejects non-image files", async () => {
    const root = await createTempRoot();
    await fs.writeFile(path.join(root, "notes.txt"), "hello", "utf8");
    const runtime = createDefaultToolRuntime({ stateRoot: path.join(root, ".aia"), workspaceRoot: root });

    const outcome = await execute(runtime, root, "view_image", { path: "notes.txt" });
    expect(outcome.toolCall.status).toBe("failed");
    expect(outcome.toolCall.error?.message).toContain("not a recognized image type");
  });
});

describe("sessions_search tool", () => {
  test("lists recent sessions and searches titles, goals, and transcripts", async () => {
    const root = await createTempRoot();
    const store = new FileSessionStore(path.join(root, ".aia"));
    await store.saveSession(buildSession("session.alpha", "Alpha", "Wire up the shared gateway runtime"));
    await store.saveSession(buildSession("session.beta", "Beta", "Polish the voice subsystem"));
    await store.appendMessages([buildMessage("session.beta", "We also touched the gateway websocket path.")]);

    const runtime = createDefaultToolRuntime({ sessions: store });

    const listed = await execute(runtime, root, "sessions_search", {});
    expect((listed.toolCall.result as { total: number }).total).toBe(2);

    const searched = await execute(runtime, root, "sessions_search", { query: "gateway" });
    const result = searched.toolCall.result as { sessions: Array<{ id: string }>; total: number };
    expect(result.total).toBe(2);
    expect(result.sessions.map((session) => session.id).sort()).toEqual(["session.alpha", "session.beta"]);
  });
});

describe("channel_send tool", () => {
  test("requires approval, then sends to the session's bound channel", async () => {
    const sent: Array<{ identity: { channel: string } }> = [];
    const channelService = {
      async getRouteForSession(sessionId: string) {
        return sessionId === "session.bound"
          ? { identity: { accountId: "acct", channel: "whatsapp", displayName: "Op", userId: "u1" } }
          : null;
      },
      async send(input: { identity: { channel: string } }) {
        sent.push(input);
        return { id: "channel-message.1" };
      }
    } as unknown as ChannelService;

    const runtime = createDefaultToolRuntime({ channelService });

    const gated = await runtime.execute(buildCall("channel_send", { text: "Done!" }, "session.bound"), {
      session: buildSession("session.bound"),
      turn: buildTurn()
    });
    expect(gated.toolCall.status).toBe("awaiting_approval");
    expect(gated.approvalRequest).toBeTruthy();

    const delivered = await runtime.executeApproved(buildCall("channel_send", { text: "Done!" }, "session.bound"), {
      session: buildSession("session.bound"),
      turn: buildTurn()
    });
    expect(delivered.toolCall.status).toBe("succeeded");
    expect(delivered.toolCall.result).toMatchObject({ channel: "whatsapp", delivered: true, messageId: "channel-message.1" });
    expect(sent).toHaveLength(1);
  });

  test("fails when the session is not bound to a channel", async () => {
    const channelService = {
      async getRouteForSession() {
        return null;
      },
      async send() {
        throw new Error("should not be called");
      }
    } as unknown as ChannelService;

    const runtime = createDefaultToolRuntime({ channelService });
    const outcome = await runtime.executeApproved(buildCall("channel_send", { text: "hi" }, "session.unbound"), {
      session: buildSession("session.unbound"),
      turn: buildTurn()
    });
    expect(outcome.toolCall.status).toBe("failed");
    expect(outcome.toolCall.error?.message).toContain("not bound to a messaging channel");
  });
});

async function execute(runtime: ToolRuntime, cwd: string, toolName: string, args: Record<string, unknown>) {
  return runtime.executeApproved(buildCall(toolName, args, "session.tool", cwd), {
    session: buildSession("session.tool", "Tools", "Exercise tools", cwd),
    turn: buildTurn()
  });
}

function buildCall(toolName: string, args: Record<string, unknown>, sessionId: string, _cwd?: string) {
  return toolCallRecordSchema.parse({
    arguments: args,
    id: `tool-call.${toolName}.${Math.random().toString(36).slice(2, 10)}`,
    metadata: {},
    sessionId,
    startedAt: "2026-06-10T12:00:00.000Z",
    status: "pending",
    toolName,
    turnId: "turn.tools.1"
  });
}

function buildSession(id: string, title = "Session", goal = "Goal", cwd = "/workspace"): SessionRecord {
  return sessionRecordSchema.parse({
    createdAt: "2026-06-10T12:00:00.000Z",
    cwd,
    goal,
    id,
    lastActiveAt: "2026-06-10T12:00:00.000Z",
    metadata: {},
    status: "running_model",
    tags: [],
    title,
    updatedAt: "2026-06-10T12:00:00.000Z"
  });
}

function buildTurn() {
  return turnRecordSchema.parse({
    approvalRequestIds: [],
    executedToolCallIds: [],
    id: "turn.tools.1",
    inputMessageIds: [],
    metadata: {},
    outputMessageIds: [],
    requestedToolCallIds: [],
    sequence: 0,
    sessionId: "session.tool",
    startedAt: "2026-06-10T12:00:00.000Z",
    status: "running",
    trigger: "user"
  });
}

function buildMessage(sessionId: string, text: string): Message {
  return {
    createdAt: "2026-06-10T12:00:00.000Z",
    id: `message.${sessionId}.${Math.random().toString(36).slice(2, 8)}`,
    metadata: {},
    parts: [{ kind: "text", text }],
    role: "assistant",
    sessionId,
    source: "assistant",
    tags: [],
    turnId: "turn.seed.1",
    visibility: "default"
  };
}

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-sct-tools-"));
  tempRoots.push(root);
  return root;
}
