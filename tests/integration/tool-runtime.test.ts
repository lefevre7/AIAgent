import { describe, expect, test } from "vitest";

import {
  createToolApprovalDecider,
  ToolRegistryBuilder,
  ToolRuntime,
  createDefaultToolRuntime,
  type ApprovalSettings,
  toolCallRecordSchema,
  toolDefinitionSchema,
  turnRecordSchema,
  sessionRecordSchema,
  type RuntimeTool
} from "@/core";

describe("tool runtime", () => {
  test("creates approval requests for tools that require approval", async () => {
    const registry = new ToolRegistryBuilder()
      .register(
        createRuntimeTool({
          approvalMode: "ask",
          annotations: {
            destructiveHint: true,
            meta: {},
            title: "Write File"
          },
          descriptor: {
            approvalNotes: "Approval is required because the tool can modify files.",
            examples: ["Write a file into the workspace."],
            purpose: "Write file contents to disk.",
            sideEffectSummary: "Modifies workspace files.",
            whenNotToUse: ["Do not use for read-only inspection."],
            whenToUse: ["Use when you need to create or overwrite a file."]
          },
          displayName: "Write File",
          invocationName: "write_file",
          name: "workspace.write-file",
          sideEffects: ["workspace_write"],
          toolId: "tool.builtin.write_file"
        })
      )
      .build();
    const runtime = new ToolRuntime({
      registry
    });

    const call = toolCallRecordSchema.parse({
      arguments: {
        path: "README.md"
      },
      id: "tool-call.runtime.1",
      metadata: {},
      sessionId: "session.runtime.1",
      startedAt: "2026-03-27T12:00:00.000Z",
      status: "pending",
      toolId: "tool.builtin.write_file",
      toolName: "write_file",
      turnId: "turn.runtime.1"
    });

    const result = await runtime.execute(call, {
      session: buildSession(),
      turn: buildTurn()
    });

    expect(result.approvalRequest?.target.kind).toBe("tool");
    expect(result.approvalRequest?.riskSummary).toContain("destructive");
    expect(result.toolCall.status).toBe("awaiting_approval");
    expect(result.toolCall.metadata.approvalMode).toBe("ask");
  });

  test("executes tool_search through the default runtime and returns ranked matches", async () => {
    const runtime = createDefaultToolRuntime();

    const result = await runtime.execute(
      toolCallRecordSchema.parse({
        arguments: {
          limit: 5,
          query: "attempt_complete"
        },
        id: "tool-call.runtime.2",
        metadata: {},
        sessionId: "session.runtime.1",
        startedAt: "2026-03-27T12:00:00.000Z",
        status: "pending",
        toolId: "tool.builtin.tool_search",
        toolName: "tool_search",
        turnId: "turn.runtime.1"
      }),
      {
        session: buildSession(),
        turn: buildTurn()
      }
    );

    expect(result.toolCall.status).toBe("succeeded");
    expect(result.toolCall.result).toMatchObject({
      matches: [
        expect.objectContaining({
          invocationName: "attempt_complete",
          toolId: "tool.builtin.attempt_complete"
        })
      ]
    });
    expect(result.resultMessage?.parts).toEqual([
      {
        kind: "json",
        value: {
          error: null,
          result: {
            matches: [
              expect.objectContaining({
                invocationName: "attempt_complete",
                toolId: "tool.builtin.attempt_complete"
              })
            ]
          },
          status: "succeeded",
          toolId: "tool.builtin.tool_search",
          toolName: "tool_search"
        }
      }
    ]);
  });

  test("uses regex approval rules to allow, deny, and request tool execution", async () => {
    const settings: ApprovalSettings = {
      configVersion: 1,
      defaultMode: "ask",
      rules: [
        {
          id: "rule.command.read.allow",
          mode: "allow",
          pattern: "^rg\\b",
          targetKind: "command"
        },
        {
          id: "rule.command.destructive.deny",
          mode: "deny",
          pattern: "^rm\\b",
          targetKind: "command"
        }
      ]
    };
    const registry = new ToolRegistryBuilder()
      .register(
        createRuntimeTool({
          approvalMode: "ask",
          invocationName: "execute_command",
          name: "execute_command",
          sideEffects: ["local_process"],
          toolId: "tool.builtin.execute_command"
        })
      )
      .register(
        createRuntimeTool({
          approvalMode: "always",
          invocationName: "write_file",
          name: "write_file",
          sideEffects: ["workspace_write"],
          toolId: "tool.builtin.write_file"
        })
      )
      .build();
    const runtime = new ToolRuntime({
      approvalDecider: createToolApprovalDecider({
        settings
      }),
      registry
    });

    const allowedResult = await runtime.execute(
      createCall({
        arguments: {
          command: "rg approval src"
        },
        id: "tool-call.runtime.allow",
        toolName: "execute_command"
      }),
      {
        session: buildSession(),
        turn: buildTurn()
      }
    );
    expect(allowedResult.toolCall.status).toBe("succeeded");

    const deniedResult = await runtime.execute(
      createCall({
        arguments: {
          command: "rm -rf /tmp/example"
        },
        id: "tool-call.runtime.deny",
        toolName: "execute_command"
      }),
      {
        session: buildSession(),
        turn: buildTurn()
      }
    );
    expect(deniedResult.toolCall.status).toBe("failed");
    expect(deniedResult.toolCall.error?.code).toBe("tool_execution_denied_by_policy");

    const requestedResult = await runtime.execute(
      createCall({
        arguments: {
          path: "README.md"
        },
        id: "tool-call.runtime.request",
        toolName: "write_file"
      }),
      {
        session: buildSession(),
        turn: buildTurn()
      }
    );
    expect(requestedResult.toolCall.status).toBe("awaiting_approval");
    expect(requestedResult.approvalRequest?.target.kind).toBe("path");
  });
});

function buildSession() {
  return sessionRecordSchema.parse({
    createdAt: "2026-03-27T12:00:00.000Z",
    cwd: "/workspace",
    goal: "Implement tool runtime tests",
    id: "session.runtime.1",
    lastActiveAt: "2026-03-27T12:00:00.000Z",
    metadata: {},
    status: "running_model",
    tags: [],
    title: "Runtime Session",
    updatedAt: "2026-03-27T12:00:00.000Z"
  });
}

function buildTurn() {
  return turnRecordSchema.parse({
    approvalRequestIds: [],
    executedToolCallIds: [],
    id: "turn.runtime.1",
    inputMessageIds: [],
    metadata: {},
    outputMessageIds: [],
    requestedToolCallIds: [],
    sequence: 0,
    sessionId: "session.runtime.1",
    startedAt: "2026-03-27T12:00:00.000Z",
    status: "running",
    trigger: "user"
  });
}

function createCall(overrides: Partial<Parameters<typeof toolCallRecordSchema.parse>[0]> = {}) {
  return toolCallRecordSchema.parse({
    arguments: {},
    id: "tool-call.runtime.default",
    metadata: {},
    sessionId: "session.runtime.1",
    startedAt: "2026-03-27T12:00:00.000Z",
    status: "pending",
    toolName: "fixture_tool",
    turnId: "turn.runtime.1",
    ...overrides
  });
}

function createRuntimeTool(overrides: Partial<Parameters<typeof toolDefinitionSchema.parse>[0]> = {}): RuntimeTool {
  const definition = toolDefinitionSchema.parse({
    aliases: [],
    annotations: {
      meta: {},
      readOnlyHint: true,
      title: "Fixture Tool"
    },
    approvalMode: "never",
    descriptor: {
      approvalNotes: "No operator approval is required.",
      examples: ["Use in tests."],
      purpose: "Exercise the runtime in tests.",
      sideEffectSummary: "No side effects.",
      whenNotToUse: ["Do not use outside tests."],
      whenToUse: ["Use in runtime tests."]
    },
    description: "Fixture tool for runtime tests.",
    displayName: "Fixture Tool",
    execution: {
      inputMode: "json",
      resumable: false,
      taskSupport: "forbidden"
    },
    idempotent: true,
    inputSchema: {
      type: "object"
    },
    invocationName: "fixture_tool",
    kind: "built_in",
    metadata: {},
    name: "fixture_tool",
    outputKind: "json",
    outputSchema: {
      type: "object"
    },
    retryable: true,
    searchTags: [],
    sideEffects: ["none"],
    source: {
      displayName: "Fixture Tools",
      kind: "built_in"
    },
    streamingMode: "none",
    toolId: "tool.fixture.default",
    usageGuidance: "Use for tests.",
    version: "1.0.0",
    ...overrides
  });

  return {
    definition,
    async execute() {
      return {
        display: [{ kind: "text", text: "fixture" }],
        result: {
          ok: true
        }
      };
    }
  };
}
