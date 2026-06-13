import { z } from "zod";

import type { ToolDefinition } from "@/core/contracts";
import type { MCPManager } from "@/core/mcp/manager";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

const inputSchema = z
  .object({
    serverNames: z.array(z.string().min(1)).max(64).optional()
  })
  .strict();

export function createMcpStatusTool(params: {
  mcpManager: MCPManager;
}): RuntimeTool {
  return {
    definition: mcpStatusToolDefinition,
    async execute(call): Promise<RuntimeToolResult> {
      const input = inputSchema.parse(call.arguments as unknown);
      const filter = input.serverNames ? new Set(input.serverNames) : null;
      const servers = params.mcpManager
        .summarizeServers()
        .filter((server) => !filter || filter.has(server.serverName));

      return {
        display: [{ kind: "text", text: renderServers(servers) }],
        result: { servers }
      };
    }
  };
}

function renderServers(
  servers: ReturnType<MCPManager["summarizeServers"]>
): string {
  if (servers.length === 0) {
    return "No MCP servers are configured.";
  }
  return servers
    .map((server) => {
      const header = `${server.serverName} [${server.state}, ${server.transport}]`;
      const errorLine = server.error ? `\n  error: ${server.error}` : "";
      const toolLines =
        server.tools.length > 0
          ? server.tools
              .map(
                (tool) =>
                  `\n  - ${tool.invocationName}${tool.description ? `: ${tool.description}` : ""}`
              )
              .join("")
          : "\n  (no tools exposed)";
      return `${header}${errorLine}${toolLines}`;
    })
    .join("\n");
}

export const mcpStatusToolDefinition: ToolDefinition = {
  aliases: ["list_mcp_servers", "mcp_servers"],
  annotations: {
    idempotentHint: true,
    meta: {
      family: "mcp"
    },
    openWorldHint: false,
    readOnlyHint: true,
    title: "MCP Status"
  },
  approvalMode: "never",
  descriptor: {
    approvalNotes:
      "No operator approval is required because this tool only reports the local MCP server state.",
    examples: [
      'Answer "what MCP servers do you have and what are their tools?".',
      "Check whether a configured MCP server connected or failed before relying on its tools."
    ],
    purpose:
      "List the configured MCP servers, their connection state, and the tools each one exposes.",
    sideEffectSummary:
      "Reads the local MCP server status and tool catalog only.",
    whenNotToUse: [
      "Do not use it to search MCP resources, prompts, or installable templates; use `mcp_search` for that.",
      "Do not use it to call an MCP tool; call the MCP tool directly once you know it is connected."
    ],
    whenToUse: [
      "Use to enumerate connected MCP servers and their tools, including servers that are disabled or failed to connect.",
      "Use first when the user asks what MCP servers or MCP tools are available."
    ]
  },
  description:
    "List configured MCP servers with their connection state, transport, any connection error, and the tools each exposes. This is the canonical way to answer what MCP servers and tools are available.",
  displayName: "MCP Status",
  execution: {
    inputMode: "json",
    resumable: false,
    taskSupport: "forbidden"
  },
  idempotent: true,
  inputSchema: {
    additionalProperties: false,
    properties: {
      serverNames: {
        description: "Optional list of server names to restrict the report to.",
        items: { type: "string" },
        type: "array"
      }
    },
    type: "object"
  },
  invocationName: "mcp_status",
  kind: "built_in",
  metadata: {},
  name: "mcp_status",
  outputKind: "json",
  outputSchema: {
    type: "object"
  },
  retryable: true,
  searchTags: [
    "catalog",
    "connected",
    "discover",
    "mcp",
    "servers",
    "status",
    "tools"
  ],
  sideEffects: ["none"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.builtin.mcp_status",
  usageGuidance:
    "Use this to report which MCP servers are configured, whether they connected, and which tools they expose. It includes disabled and failed servers so you can explain why an expected MCP tool is missing.",
  version: "1.0.0"
};
