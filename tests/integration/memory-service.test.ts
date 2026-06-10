import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { FileBackedMemoryService, FileSessionStore, createDefaultToolRuntime, type SessionRecord } from "@/core";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

describe("file-backed memory service", () => {
  test("writes workspace and user-global summaries and answers lexical queries", async () => {
    const root = await createTempRoot();
    const workspaceRoot = path.join(root, "workspace", "memory");
    const userGlobalRoot = path.join(root, "home", ".aia", "memory");
    const chatSessionRoot = path.join(root, "workspace", "chat-session-memory");
    const stateRoot = path.join(root, "workspace", ".aia");
    const sessions = new FileSessionStore(stateRoot);
    await sessions.saveSession(buildSession());

    const memory = new FileBackedMemoryService({
      chatSessionRoot,
      sessions,
      stateRoot,
      userGlobalRoot,
      workspaceRoot
    });

    await memory.upsert({
      confidence: 0.95,
      content: "This workspace prefers TypeScript ESM and Node 22.",
      createdAt: "2026-03-27T17:00:00.000Z",
      id: "memory.workspace.1",
      kind: "fact",
      metadata: {},
      provenance: {
        messageIds: [],
        sourceLabel: "workspace-config",
        toolCallIds: []
      },
      recencyScore: 0.9,
      scope: "workspace",
      summary: "Workspace runtime baseline",
      tags: ["runtime"],
      updatedAt: "2026-03-27T17:00:00.000Z"
    });
    await memory.upsert({
      confidence: 0.8,
      content: "The operator prefers concise execution updates.",
      createdAt: "2026-03-27T17:00:01.000Z",
      id: "memory.user.1",
      kind: "preference",
      metadata: {},
      provenance: {
        messageIds: [],
        sourceLabel: "user-preference",
        toolCallIds: []
      },
      recencyScore: 0.8,
      scope: "user_global",
      summary: "Operator update style",
      tags: ["preferences"],
      updatedAt: "2026-03-27T17:00:01.000Z"
    });

    const hits = await memory.query({
      includeKinds: ["fact", "preference"],
      limit: 5,
      minConfidence: 0,
      scopes: ["workspace", "user_global"],
      text: "TypeScript ESM"
    });
    const promptContext = await memory.getPromptContext("session.memory.1");
    const workspaceSummary = await fs.readFile(path.join(root, "workspace", "MEMORY.md"), "utf8");
    const userSummary = await fs.readFile(path.join(userGlobalRoot, "summary.md"), "utf8");

    expect(hits[0]?.entry.id).toBe("memory.workspace.1");
    expect(workspaceSummary).toContain("Workspace runtime baseline");
    expect(userSummary).toContain("Operator update style");
    expect(promptContext?.workspaceSummary).toContain("Workspace runtime baseline");
    expect(promptContext?.userGlobalSummary).toContain("Operator update style");
  });

  test("records startup placeholders and session compaction summaries", async () => {
    const root = await createTempRoot();
    const workspaceRoot = path.join(root, "workspace", "memory");
    const userGlobalRoot = path.join(root, "home", ".aia", "memory");
    const chatSessionRoot = path.join(root, "workspace", "chat-session-memory");
    const stateRoot = path.join(root, "workspace", ".aia");
    const sessions = new FileSessionStore(stateRoot);
    const session = buildSession();
    await sessions.saveSession(session);
    await sessions.appendMessages([
      {
        createdAt: "2026-03-27T17:10:00.000Z",
        id: "message.user.memory.1",
        metadata: {},
        parts: [{ kind: "text", text: "Please summarize the finished work." }],
        role: "user",
        sessionId: session.id,
        source: "user",
        tags: [],
        turnId: "turn.memory.1",
        visibility: "default"
      },
      {
        createdAt: "2026-03-27T17:10:01.000Z",
        id: "message.assistant.memory.1",
        metadata: {},
        parts: [{ kind: "text", text: "Implemented the durable memory service and compaction placeholders." }],
        role: "assistant",
        sessionId: session.id,
        source: "assistant",
        tags: [],
        turnId: "turn.memory.1",
        visibility: "default"
      }
    ]);
    await sessions.appendToolCalls([
      {
        arguments: {},
        id: "tool-call.memory.1",
        metadata: {},
        result: {
          ok: true
        },
        sessionId: session.id,
        startedAt: "2026-03-27T17:10:02.000Z",
        status: "succeeded",
        toolName: "update_plan",
        turnId: "turn.memory.1"
      }
    ]);

    const memory = new FileBackedMemoryService({
      chatSessionRoot,
      sessions,
      stateRoot,
      userGlobalRoot,
      workspaceRoot
    });

    await memory.initializeSessionMemory(session);
    await memory.compactSession({
      sessionId: session.id,
      trigger: "completion"
    });

    const sessionSummary = await fs.readFile(path.join(chatSessionRoot, `${session.id}.md`), "utf8");
    const compactionHistory = await fs.readFile(path.join(stateRoot, "memory", "compactions", `${session.id}.jsonl`), "utf8");
    const promptContext = await memory.getPromptContext(session.id);

    expect(sessionSummary).toContain("Session Summary");
    expect(sessionSummary).toContain("Implemented the durable memory service");
    expect(compactionHistory).toContain('"phase":"startup_phase_1"');
    expect(compactionHistory).toContain('"phase":"startup_phase_2"');
    expect(compactionHistory).toContain('"phase":"session_completion"');
    expect(promptContext?.sessionSummary).toContain("Session Summary");
  });

  test("executes memory_write through the default runtime when the memory service is configured", async () => {
    const root = await createTempRoot();
    const workspaceRoot = path.join(root, "workspace", "memory");
    const userGlobalRoot = path.join(root, "home", ".aia", "memory");
    const chatSessionRoot = path.join(root, "workspace", "chat-session-memory");
    const stateRoot = path.join(root, "workspace", ".aia");
    const sessions = new FileSessionStore(stateRoot);
    const session = buildSession();
    await sessions.saveSession(session);

    const memory = new FileBackedMemoryService({
      chatSessionRoot,
      sessions,
      stateRoot,
      userGlobalRoot,
      workspaceRoot
    });
    const runtime = createDefaultToolRuntime({
      memoryService: memory
    });

    const result = await runtime.execute(
      {
        arguments: {
          content: "The workspace uses durable memory summaries.",
          kind: "fact",
          scope: "workspace",
          summary: "Workspace memory enabled"
        },
        id: "tool-call.memory-write.1",
        metadata: {},
        sessionId: session.id,
        startedAt: "2026-03-27T17:20:00.000Z",
        status: "pending",
        toolName: "memory_write",
        turnId: "turn.memory.2"
      },
      {
        session,
        turn: {
          approvalRequestIds: [],
          executedToolCallIds: [],
          id: "turn.memory.2",
          inputMessageIds: [],
          metadata: {},
          outputMessageIds: [],
          requestedToolCallIds: [],
          sequence: 1,
          sessionId: session.id,
          startedAt: "2026-03-27T17:20:00.000Z",
          status: "running",
          trigger: "user"
        }
      }
    );

    const workspaceIndex = JSON.parse(await fs.readFile(path.join(workspaceRoot, "index.json"), "utf8")) as Array<{
      id: string;
      summary?: string;
    }>;
    expect(result.toolCall.status).toBe("succeeded");
    expect(workspaceIndex[0]?.summary).toBe("Workspace memory enabled");
  });
});

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-memory-"));
  tempRoots.push(root);
  return root;
}

function buildSession(): SessionRecord {
  const now = "2026-03-27T17:00:00.000Z";
  return {
    createdAt: now,
    cwd: "/workspace",
    goal: "Exercise durable memory handling.",
    id: "session.memory.1",
    lastActiveAt: now,
    metadata: {},
    status: "running_model",
    tags: [],
    title: "Memory Session",
    updatedAt: now
  };
}
