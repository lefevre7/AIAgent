import { describe, expect, test } from "vitest";

import { createMcpStatusTool, toolCallRecordSchema, type MCPManager, type MCPServerSummary } from "@/core";
import type { RuntimeToolContext } from "@/core/tools/runtime";

const server: MCPServerSummary = {
  capabilities: { prompts: 0, resourceTemplates: 0, resources: 0, tools: 2 },
  serverName: "jira",
  state: "connected",
  tools: [
    { description: "Create an issue.", invocationName: "mcp_jira_create", name: "jira.create" },
    { description: "Find issues.", invocationName: "mcp_jira_search", name: "jira.search" }
  ],
  transport: "stdio"
};

function statusTool() {
  return createMcpStatusTool({ mcpManager: { summarizeServers: () => [server] } as unknown as MCPManager });
}

const call = toolCallRecordSchema.parse({
  arguments: {},
  id: "tool-call.status.1",
  metadata: {},
  sessionId: "session.status.1",
  startedAt: "2026-10-14T00:00:00.000Z",
  status: "pending",
  toolName: "mcp_status",
  turnId: "turn.status.1"
});

function contextWith(callableToolNames?: string[]): RuntimeToolContext {
  return {
    ...(callableToolNames ? { callableToolNames: new Set(callableToolNames) } : {}),
    session: { id: "session.status.1" },
    turn: { id: "turn.status.1" }
  } as unknown as RuntimeToolContext;
}

describe("mcp_status", () => {
  test("marks the tools the model cannot call this turn, and names the tool_search that activates them", async () => {
    // Under the lean profile a server's tools are callable only after
    // tool_search finds them. Listed as callable, a small model called them,
    // was refused, and asked mcp_status again, in a loop.
    const outcome = await statusTool().execute(call, contextWith(["mcp_status", "tool_search", "mcp_jira_search"]));

    expect(outcome.result).toEqual({
      servers: [
        {
          ...server,
          activateWith: { limit: 2, query: "jira" },
          tools: [{ ...server.tools[0], callable: false }, server.tools[1]]
        }
      ]
    });
    const text = outcome.display?.[0]?.kind === "text" ? outcome.display[0].text : "";
    expect(text).toContain("mcp_jira_create (not callable yet): Create an issue.");
    expect(text).toContain('first call tool_search with {"limit":2,"query":"jira"}');
    expect(text).not.toContain("mcp_jira_search (not callable yet)");
  });

  test("marks nothing when every tool is callable, or for a direct call that says nothing about the turn", async () => {
    for (const context of [contextWith(["mcp_jira_create", "mcp_jira_search"]), contextWith()]) {
      const outcome = await statusTool().execute(call, context);
      expect(outcome.result).toEqual({ servers: [server] });
    }
  });
});
