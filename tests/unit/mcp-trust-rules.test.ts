import { describe, expect, test } from "vitest";

import {
  RegexApprovalPolicy,
  createMcpRuntimeTool,
  createToolApprovalDecider,
  extractApprovalTargets,
  sessionRecordSchema,
  toolCallRecordSchema,
  turnRecordSchema,
  withMcpTrustRules,
  type ApprovalSettings,
  type MCPManager,
  type MCPToolCapability
} from "@/core";

const BASE: ApprovalSettings = {
  configVersion: 1,
  defaultMode: "ask",
  rules: []
};

function mcpToolDefinition(serverName: string) {
  const capability: MCPToolCapability = {
    access: "model_and_api",
    annotations: { readOnlyHint: true },
    description: "Fixture MCP tool.",
    displayName: "Fixture Tool",
    execution: {},
    id: `mcp.tool.${serverName}.tool`,
    inputSchema: { type: "object" },
    invocationName: `mcp_${serverName}_tool`,
    kind: "tool",
    metadata: {},
    name: `${serverName}.tool`,
    rawName: "tool",
    serverName,
    tags: ["mcp", "tool"]
  };
  const manager = {
    callTool: async () => ({ content: [], isError: false })
  } as unknown as MCPManager;
  return createMcpRuntimeTool(manager, capability).definition;
}

function buildSession() {
  return sessionRecordSchema.parse({
    createdAt: "2026-03-27T12:00:00.000Z",
    cwd: "/workspace",
    goal: "Exercise MCP trust rules",
    id: "session.trust.1",
    lastActiveAt: "2026-03-27T12:00:00.000Z",
    metadata: {},
    status: "running_model",
    tags: [],
    title: "MCP Trust",
    updatedAt: "2026-03-27T12:00:00.000Z"
  });
}

function buildTurn() {
  return turnRecordSchema.parse({
    approvalRequestIds: [],
    executedToolCallIds: [],
    id: "turn.trust.1",
    inputMessageIds: [],
    metadata: {},
    outputMessageIds: [],
    requestedToolCallIds: [],
    sequence: 0,
    sessionId: "session.trust.1",
    startedAt: "2026-03-27T12:00:00.000Z",
    status: "running",
    trigger: "user"
  });
}

function buildCall(toolName: string) {
  return toolCallRecordSchema.parse({
    arguments: {},
    id: "tool-call.trust.1",
    metadata: {},
    sessionId: "session.trust.1",
    startedAt: "2026-03-27T12:00:00.000Z",
    status: "pending",
    toolName,
    turnId: "turn.trust.1"
  });
}

describe("withMcpTrustRules", () => {
  test("appends an mcp_server allow rule for each trusted server only", () => {
    const augmented = withMcpTrustRules(BASE, {
      good: { trust: "trusted" },
      off: { trust: "prompt" },
      plain: {}
    });
    expect(augmented.rules).toHaveLength(1);
    expect(augmented.rules[0]).toMatchObject({
      mode: "allow",
      pattern: "^good$",
      targetKind: "mcp_server"
    });
  });

  test("returns the settings unchanged when no server is trusted", () => {
    const augmented = withMcpTrustRules(BASE, { plain: {}, off: { trust: "prompt" } });
    expect(augmented).toBe(BASE);
  });

  test("keeps an explicit operator deny rule authoritative over a trust allow", () => {
    const withDeny: ApprovalSettings = {
      configVersion: 1,
      defaultMode: "ask",
      rules: [
        {
          id: "op.deny.good",
          mode: "deny",
          pattern: "^good$",
          targetKind: "mcp_server"
        }
      ]
    };
    const augmented = withMcpTrustRules(withDeny, { good: { trust: "trusted" } });
    const match = new RegexApprovalPolicy(augmented).evaluateTargets([
      { kind: "mcp_server", label: "good", value: "good" }
    ]);
    expect(match.mode).toBe("deny");
    expect(match.rule?.id).toBe("op.deny.good");
  });
});

describe("MCP tool approval end to end", () => {
  test("emits mcp_server and mcp_tool targets for MCP tools", () => {
    const definition = mcpToolDefinition("srv");
    const targets = extractApprovalTargets(buildCall(definition.invocationName), definition);
    expect(targets).toEqual(
      expect.arrayContaining([
        { kind: "mcp_server", label: "srv", value: "srv" },
        { kind: "mcp_tool", label: "Fixture Tool", value: "srv.tool" }
      ])
    );
  });

  test("prompts for an untrusted server, executes for a trusted one, and denies when an operator deny rule matches", async () => {
    const definition = mcpToolDefinition("trusted-srv");
    const call = buildCall(definition.invocationName);
    const session = buildSession();
    const turn = buildTurn();

    const untrusted = await createToolApprovalDecider({ settings: BASE })({
      call,
      definition,
      session,
      turn
    });
    expect(untrusted.mode).toBe("request");

    const trusted = await createToolApprovalDecider({
      settings: withMcpTrustRules(BASE, { "trusted-srv": { trust: "trusted" } })
    })({ call, definition, session, turn });
    expect(trusted).toEqual({ mode: "execute" });

    const denied = await createToolApprovalDecider({
      settings: withMcpTrustRules(
        {
          configVersion: 1,
          defaultMode: "ask",
          rules: [
            {
              id: "op.deny.trusted",
              mode: "deny",
              pattern: "^trusted-srv$",
              targetKind: "mcp_server"
            }
          ]
        },
        { "trusted-srv": { trust: "trusted" } }
      )
    })({ call, definition, session, turn });
    expect(denied.mode).toBe("deny");
  });

  test("lets a tool-level operator deny override server trust", async () => {
    const definition = mcpToolDefinition("trusted-srv"); // name = "trusted-srv.tool"
    const decider = createToolApprovalDecider({
      settings: withMcpTrustRules(
        {
          configVersion: 1,
          defaultMode: "ask",
          rules: [
            {
              id: "op.deny.one-tool",
              mode: "deny",
              pattern: "trusted-srv\\.tool",
              targetKind: "mcp_tool"
            }
          ]
        },
        { "trusted-srv": { trust: "trusted" } }
      )
    });

    const decision = await decider({
      call: buildCall(definition.invocationName),
      definition,
      session: buildSession(),
      turn: buildTurn()
    });
    // The tool-granularity deny is evaluated before the coarse server-level
    // trust allow, so the specific tool is still blocked on a trusted server.
    expect(decision.mode).toBe("deny");
  });
});
