import { z } from "zod";

import type { ToolDefinition } from "@/core/contracts";
import type { MCPManager } from "@/core/mcp/manager";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

const inputSchema = z
  .object({
    serverName: z.string().min(1).max(128),
    uri: z.string().min(1).max(4096)
  })
  .strict();

export function createMcpReadResourceTool(params: { mcpManager: MCPManager }): RuntimeTool {
  return {
    definition: mcpReadResourceToolDefinition,
    async execute(call): Promise<RuntimeToolResult> {
      const input = inputSchema.parse(call.arguments as unknown);
      const result = await params.mcpManager.readResource(input.serverName, input.uri);

      return {
        citations: [
          {
            title: input.uri,
            uri: input.uri
          }
        ],
        result
      };
    }
  };
}

export const mcpReadResourceToolDefinition: ToolDefinition = {
  aliases: ["mcp_get_resource"],
  annotations: {
    idempotentHint: true,
    meta: {
      family: "mcp"
    },
    openWorldHint: false,
    readOnlyHint: true,
    title: "MCP Read Resource"
  },
  approvalMode: "never",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool performs a read-only MCP resource fetch.",
    examples: [
      "Read a specific MCP resource URI after discovering it with mcp_search.",
      "Fetch a known MCP resource directly when you already have the URI."
    ],
    purpose: "Read a resource exposed by a connected MCP server using its exact URI.",
    sideEffectSummary: "Performs a read-only MCP resource request.",
    whenNotToUse: ["Do not use it when you only know a resource template; use mcp_read_resource_template instead."],
    whenToUse: [
      "Use when you already know the exact MCP resource URI to read.",
      "Use after mcp_search returns a resource capability that is relevant to the current task."
    ]
  },
  description: "Read a connected MCP resource by exact URI.",
  displayName: "MCP Read Resource",
  execution: {
    inputMode: "json",
    resumable: false,
    taskSupport: "forbidden"
  },
  idempotent: true,
  inputSchema: {
    additionalProperties: false,
    properties: {
      serverName: {
        type: "string"
      },
      uri: {
        type: "string"
      }
    },
    required: ["serverName", "uri"],
    type: "object"
  },
  invocationName: "mcp_read_resource",
  kind: "built_in",
  metadata: {},
  name: "mcp_read_resource",
  outputKind: "json",
  outputSchema: {
    type: "object"
  },
  retryable: true,
  searchTags: ["mcp", "read", "resource"],
  sideEffects: ["none"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.builtin.mcp_read_resource",
  usageGuidance: "Use this for exact MCP resource URIs. If you only know a template, search first and then instantiate the template.",
  version: "1.0.0"
};
