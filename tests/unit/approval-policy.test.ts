import { describe, expect, test } from "vitest";

import {
  RegexApprovalPolicy,
  createToolApprovalDecider,
  createDefaultToolRegistry,
  createExternalAgentApprovalTargetResolver,
  externalAgentToolDefinition,
  extractApprovalTargets,
  toolCallRecordSchema,
  toolDefinitionSchema,
  turnRecordSchema,
  sessionRecordSchema,
  type ApprovalSettings
} from "@/core";

describe("approval policy", () => {
  test("extracts command, path, MCP, browser, and tool targets in a stable order", () => {
    const definition = createDefinition({
      kind: "mcp",
      invocationName: "context7_read_docs",
      name: "context7.read-docs",
      source: {
        displayName: "Context7",
        kind: "mcp",
        serverName: "context7"
      },
      toolId: "tool.mcp.context7.read_docs"
    });
    const call = createCall({
      arguments: {
        command: ["rg", "approval"],
        path: "src/core/approvals/policy.ts"
      },
      toolName: definition.invocationName
    });

    expect(extractApprovalTargets(call, definition)).toEqual([
      {
        kind: "command",
        label: "command",
        value: "rg approval"
      },
      {
        kind: "path",
        label: "path",
        value: "src/core/approvals/policy.ts"
      },
      {
        kind: "mcp_tool",
        label: "Fixture Tool",
        value: "context7.read-docs"
      },
      {
        kind: "mcp_server",
        label: "context7",
        value: "context7"
      },
      {
        kind: "tool",
        label: "Fixture Tool",
        value: "context7_read_docs"
      }
    ]);
  });

  test("extracts browser_action ahead of the generic tool target for browser tools", () => {
    const definition = createDefinition({
      kind: "browser",
      invocationName: "browser_click",
      name: "browser_click",
      toolId: "tool.browser.click"
    });
    const call = createCall({
      arguments: {
        selector: "#submit"
      },
      toolName: definition.invocationName
    });

    expect(extractApprovalTargets(call, definition)).toEqual([
      {
        kind: "browser_action",
        label: "Fixture Tool",
        value: "browser_click"
      },
      {
        kind: "tool",
        label: "Fixture Tool",
        value: "browser_click"
      }
    ]);
  });

  test("extracts voice_action ahead of the generic tool target for voice playback tools", () => {
    const definition = createDefinition({
      annotations: {
        meta: {
          voiceAction: true
        },
        title: "Play Audio"
      },
      kind: "voice",
      invocationName: "voice_play_audio",
      name: "voice_play_audio",
      sideEffects: ["local_process"],
      toolId: "tool.voice.play_audio"
    });
    const call = createCall({
      arguments: {
        text: "Speak this"
      },
      toolName: definition.invocationName
    });

    expect(extractApprovalTargets(call, definition)).toEqual([
      {
        kind: "voice_action",
        label: "Fixture Tool",
        value: "voice_play_audio"
      },
      {
        kind: "tool",
        label: "Fixture Tool",
        value: "voice_play_audio"
      }
    ]);
  });

  test("evaluates the first matching rule using target order", () => {
    const policy = new RegexApprovalPolicy({
      configVersion: 1,
      defaultMode: "ask",
      rules: [
        {
          id: "rule.command.deny",
          mode: "deny",
          pattern: "^rm\\b",
          targetKind: "command"
        },
        {
          id: "rule.tool.allow",
          mode: "allow",
          pattern: "^execute_",
          targetKind: "tool"
        }
      ]
    });

    const match = policy.evaluateTargets([
      {
        kind: "command",
        label: "command",
        value: "rm -rf /tmp/example"
      },
      {
        kind: "tool",
        label: "Execute Command",
        value: "execute_command"
      }
    ]);

    expect(match.mode).toBe("deny");
    expect(match.rule?.id).toBe("rule.command.deny");
    expect(match.target.kind).toBe("command");
  });

  test("allows, requests, and denies execution according to tool mode plus regex policy", async () => {
    const settings: ApprovalSettings = {
      configVersion: 1,
      defaultMode: "ask",
      rules: [
        {
          id: "rule.command.read.allow",
          mode: "allow",
          notes: "Allow safe reads.",
          pattern: "^rg\\b",
          targetKind: "command"
        },
        {
          id: "rule.command.destructive.deny",
          mode: "deny",
          notes: "Block destructive removes.",
          pattern: "^rm\\b",
          targetKind: "command"
        },
        {
          id: "rule.tool.read.allow",
          mode: "allow",
          notes: "Allow read tools.",
          pattern: "^read_",
          targetKind: "tool"
        }
      ]
    };
    const decider = createToolApprovalDecider({
      settings
    });
    const session = buildSession();
    const turn = buildTurn();

    const allowedDecision = await decider({
      call: createCall({
        arguments: {
          command: "rg approval src"
        },
        toolName: "execute_command"
      }),
      definition: createDefinition({
        approvalMode: "ask",
        invocationName: "execute_command",
        name: "execute_command",
        sideEffects: ["local_process"],
        toolId: "tool.builtin.execute_command"
      }),
      session,
      turn
    });
    expect(allowedDecision).toEqual({
      mode: "execute"
    });

    const requestedDecision = await decider({
      call: createCall({
        arguments: {
          path: "README.md"
        },
        toolName: "read_file"
      }),
      definition: createDefinition({
        approvalMode: "always",
        invocationName: "read_file",
        name: "read_file",
        sideEffects: ["workspace_read"],
        toolId: "tool.builtin.read_file"
      }),
      session,
      turn
    });
    expect(requestedDecision.mode).toBe("request");
    if (requestedDecision.mode !== "request") {
      throw new Error(`Expected an approval request, received ${requestedDecision.mode}.`);
    }
    expect(requestedDecision.request.target.kind).toBe("tool");
    expect(requestedDecision.request.metadata.matchedApprovalRuleId).toBe("rule.tool.read.allow");

    const deniedDecision = await decider({
      call: createCall({
        arguments: {
          command: "rm -rf /tmp/example"
        },
        toolName: "execute_command"
      }),
      definition: createDefinition({
        approvalMode: "ask",
        invocationName: "execute_command",
        name: "execute_command",
        sideEffects: ["local_process"],
        toolId: "tool.builtin.execute_command"
      }),
      session,
      turn
    });
    expect(deniedDecision.mode).toBe("deny");
    if (deniedDecision.mode !== "deny") {
      throw new Error(`Expected a policy denial, received ${deniedDecision.mode}.`);
    }
    expect(deniedDecision.error.code).toBe("tool_execution_denied_by_policy");
    expect(deniedDecision.metadata?.matchedApprovalRuleId).toBe("rule.command.destructive.deny");
  });

  test("applies command and path regex rules to the built-in shell and file tools", async () => {
    const registry = createDefaultToolRegistry({
      stateRoot: "/workspace/.aia",
      workspaceRoot: "/workspace"
    });
    const decider = createToolApprovalDecider({
      settings: {
        configVersion: 1,
        defaultMode: "ask",
        rules: [
          {
            id: "rule.command.shell.allow",
            mode: "allow",
            notes: "Allow status inspection commands.",
            pattern: "^git status\\b",
            targetKind: "command"
          },
          {
            id: "rule.path.secret.deny",
            mode: "deny",
            notes: "Block writes into the secrets directory.",
            pattern: "^/workspace/secrets/",
            targetKind: "path"
          }
        ]
      }
    });
    const session = buildSession();
    const turn = buildTurn();

    const allowedShellDecision = await decider({
      call: createCall({
        arguments: {
          command: "git status --short",
          cwd: "/workspace"
        },
        toolName: "shell_command"
      }),
      definition: requireDefinition(registry, "shell_command"),
      session,
      turn
    });
    expect(allowedShellDecision).toEqual({
      mode: "execute"
    });

    const requestedExecDecision = await decider({
      call: createCall({
        arguments: {
          command: "npm run dev",
          cwd: "/workspace"
        },
        toolName: "exec_command"
      }),
      definition: requireDefinition(registry, "exec_command"),
      session,
      turn
    });
    expect(requestedExecDecision.mode).toBe("request");
    if (requestedExecDecision.mode !== "request") {
      throw new Error(`Expected an approval request, received ${requestedExecDecision.mode}.`);
    }
    expect(requestedExecDecision.request.target.kind).toBe("command");
    expect(requestedExecDecision.request.riskSummary).toContain("local command");

    const deniedWriteDecision = await decider({
      call: createCall({
        arguments: {
          content: "token=secret\n",
          path: "/workspace/secrets/token.txt"
        },
        toolName: "write_file"
      }),
      definition: requireDefinition(registry, "write_file"),
      session,
      turn
    });
    expect(deniedWriteDecision.mode).toBe("deny");
    if (deniedWriteDecision.mode !== "deny") {
      throw new Error(`Expected a policy denial, received ${deniedWriteDecision.mode}.`);
    }
    expect(deniedWriteDecision.metadata?.matchedApprovalRuleId).toBe("rule.path.secret.deny");
    expect(deniedWriteDecision.metadata?.matchedApprovalTargetKind).toBe("path");
    expect(deniedWriteDecision.error.details.targetValue).toBe("/workspace/secrets/token.txt");
  });

  test("bypasses read-only external-agent actions and resolves agent targets for run actions", async () => {
    const decider = createToolApprovalDecider({
      resolveAdditionalTargets: createExternalAgentApprovalTargetResolver({
        service: {
          getDefinition: async (agentId) =>
            agentId === "codex"
              ? {
                  command: "codex",
                  defaultArgs: [],
                  displayName: "Codex CLI",
                  id: "codex",
                  kind: "codex",
                  metadata: {},
                  resumeSupported: true,
                  structuredOutputSupported: true
                }
              : null,
          getJob: async () => null
        }
      }),
      settings: {
        configVersion: 1,
        defaultMode: "ask",
        rules: []
      }
    });
    const session = buildSession();
    const turn = buildTurn();

    const listDecision = await decider({
      call: createCall({
        arguments: {
          action: "list"
        },
        toolName: "external_agent"
      }),
      definition: externalAgentToolDefinition,
      session,
      turn
    });
    expect(listDecision).toEqual({
      mode: "execute"
    });

    const runDecision = await decider({
      call: createCall({
        arguments: {
          action: "run",
          agentId: "codex",
          cwd: "/workspace"
        },
        toolName: "external_agent"
      }),
      definition: externalAgentToolDefinition,
      session,
      turn
    });

    expect(runDecision.mode).toBe("request");
    if (runDecision.mode !== "request") {
      throw new Error(`Expected an approval request, received ${runDecision.mode}.`);
    }
    expect(runDecision.request.target.kind).toBe("external_agent");
    expect(runDecision.request.target.value).toBe("codex");
  });
});

function buildSession() {
  return sessionRecordSchema.parse({
    createdAt: "2026-03-27T12:00:00.000Z",
    cwd: "/workspace",
    goal: "Exercise approval policy tests",
    id: "session.policy.1",
    lastActiveAt: "2026-03-27T12:00:00.000Z",
    metadata: {},
    status: "running_model",
    tags: [],
    title: "Approval Policy",
    updatedAt: "2026-03-27T12:00:00.000Z"
  });
}

function buildTurn() {
  return turnRecordSchema.parse({
    approvalRequestIds: [],
    executedToolCallIds: [],
    id: "turn.policy.1",
    inputMessageIds: [],
    metadata: {},
    outputMessageIds: [],
    requestedToolCallIds: [],
    sequence: 0,
    sessionId: "session.policy.1",
    startedAt: "2026-03-27T12:00:00.000Z",
    status: "running",
    trigger: "user"
  });
}

function createCall(overrides: Partial<Parameters<typeof toolCallRecordSchema.parse>[0]> = {}) {
  return toolCallRecordSchema.parse({
    arguments: {},
    id: "tool-call.policy.1",
    metadata: {},
    sessionId: "session.policy.1",
    startedAt: "2026-03-27T12:00:00.000Z",
    status: "pending",
    toolName: "fixture_tool",
    turnId: "turn.policy.1",
    ...overrides
  });
}

function createDefinition(overrides: Partial<Parameters<typeof toolDefinitionSchema.parse>[0]> = {}) {
  return toolDefinitionSchema.parse({
    aliases: [],
    annotations: {
      meta: {},
      readOnlyHint: true,
      title: "Fixture Tool"
    },
    approvalMode: "ask",
    descriptor: {
      approvalNotes: "Approval depends on runtime policy.",
      examples: ["Use in approval-policy tests."],
      purpose: "Exercise approval policy decisions.",
      sideEffectSummary: "No side effects unless overridden.",
      whenNotToUse: ["Do not use outside tests."],
      whenToUse: ["Use in approval policy tests."]
    },
    description: "Fixture tool for approval policy tests.",
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
    toolId: "tool.fixture.policy",
    usageGuidance: "Use for tests.",
    version: "1.0.0",
    ...overrides
  });
}

function requireDefinition(registry: ReturnType<typeof createDefaultToolRegistry>, toolName: string) {
  const definition = registry.getDefinition(toolName);
  if (!definition) {
    throw new Error(`Expected ${toolName} to be registered.`);
  }

  return definition;
}
