import { describe, expect, test } from "vitest";

import { ToolRuntime, createDefaultToolRegistry, sessionRecordSchema, toolCallRecordSchema, turnRecordSchema } from "@/core";

function buildRuntime() {
  return new ToolRuntime({
    approvalDecider: async () => ({ mode: "execute" }),
    registry: createDefaultToolRegistry({})
  });
}

function buildSession() {
  return sessionRecordSchema.parse({
    createdAt: "2026-06-11T00:00:00.000Z",
    cwd: "/workspace",
    goal: "exercise the runtime",
    id: "session.runtime.extra",
    lastActiveAt: "2026-06-11T00:00:00.000Z",
    metadata: {},
    status: "running_model",
    tags: [],
    title: "Runtime",
    updatedAt: "2026-06-11T00:00:00.000Z"
  });
}

function buildTurn() {
  return turnRecordSchema.parse({
    approvalRequestIds: [],
    executedToolCallIds: [],
    id: "turn.runtime.extra",
    inputMessageIds: [],
    metadata: {},
    outputMessageIds: [],
    requestedToolCallIds: [],
    sequence: 0,
    sessionId: "session.runtime.extra",
    startedAt: "2026-06-11T00:00:00.000Z",
    status: "running",
    trigger: "user"
  });
}

describe("ToolRuntime definition lookups and unknown tools", () => {
  test("resolves definitions and lists/searches them", () => {
    const runtime = buildRuntime();
    expect(runtime.getDefinition("think")?.invocationName).toBe("think");
    expect(runtime.getDefinition("does_not_exist")).toBeNull();
    expect(runtime.listDefinitions().length).toBeGreaterThan(0);
    expect(runtime.searchDefinitions({ limit: 5, query: "think" }).some((m) => m.definition.invocationName === "think")).toBe(true);
  });

  test("fails gracefully when executing an unregistered tool", async () => {
    const runtime = buildRuntime();
    const result = await runtime.execute(
      toolCallRecordSchema.parse({
        arguments: {},
        id: "tool-call.unknown.1",
        metadata: {},
        sessionId: "session.runtime.extra",
        startedAt: "2026-06-11T00:00:00.000Z",
        status: "pending",
        toolName: "no_such_tool",
        turnId: "turn.runtime.extra"
      }),
      { session: buildSession(), turn: buildTurn() }
    );
    expect(result.toolCall.status).toBe("failed");
    expect(result.toolCall.result ?? result.toolCall.error).toBeTruthy();
  });
});
