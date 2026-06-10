import { z } from "zod";

import type { ToolDefinition } from "@/core/contracts";
import { mcpCapabilityKindSchema, mcpCapabilitySearchQuerySchema } from "@/core/contracts";
import type { MCPManager } from "@/core/mcp/manager";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

const inputSchema = mcpCapabilitySearchQuerySchema.extend({
  query: z.string().min(1).max(500).optional()
});

export function createMcpSearchTool(params: { mcpManager: MCPManager }): RuntimeTool {
  return {
    definition: mcpSearchToolDefinition,
    async execute(call): Promise<RuntimeToolResult> {
      const query = inputSchema.parse(call.arguments as unknown);
      const matches = params.mcpManager.searchCapabilities(query).map((match) => ({
        access: match.capability.access,
        description: match.capability.description ?? null,
        displayName: match.capability.displayName,
        id: match.capability.id,
        kind: match.capability.kind,
        matchedOn: match.matchedOn,
        name: match.capability.name,
        score: match.score,
        serverName: match.capability.serverName ?? null,
        tags: match.capability.tags
      }));

      return {
        result: {
          matches
        }
      };
    }
  };
}

export const mcpSearchToolDefinition: ToolDefinition = {
  aliases: ["find_mcp", "search_mcp"],
  annotations: {
    idempotentHint: true,
    meta: {
      family: "mcp"
    },
    openWorldHint: false,
    readOnlyHint: true,
    title: "MCP Search"
  },
  approvalMode: "never",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only inspects the local MCP capability catalog.",
    examples: [
      "Search connected MCP tools before choosing between multiple remote capabilities.",
      "Find prompt, resource, resource-template, or server-template entries exposed by the MCP layer."
    ],
    purpose: "Search the MCP capability catalog across connected tools, resources, prompts, resource templates, and installable server templates.",
    sideEffectSummary: "Reads the local MCP catalog only.",
    whenNotToUse: ["Do not use this when you already know the exact MCP tool invocation name or resource URI you need."],
    whenToUse: [
      "Use when you need to discover what connected MCP servers expose before acting.",
      "Use when you want to search installable MCP server templates without exposing them as executable tools."
    ]
  },
  description:
    "Search MCP-connected capabilities and known server templates. Use this before guessing which MCP surface to use next.",
  displayName: "MCP Search",
  execution: {
    inputMode: "json",
    resumable: false,
    taskSupport: "forbidden"
  },
  idempotent: true,
  inputSchema: {
    additionalProperties: false,
    properties: {
      kinds: {
        items: {
          enum: mcpCapabilityKindSchema.options,
          type: "string"
        },
        type: "array"
      },
      limit: {
        maximum: 100,
        minimum: 1,
        type: "integer"
      },
      query: {
        type: "string"
      },
      scopes: {
        items: {
          enum: ["connected", "templates"],
          type: "string"
        },
        type: "array"
      },
      serverNames: {
        items: {
          type: "string"
        },
        type: "array"
      }
    },
    type: "object"
  },
  invocationName: "mcp_search",
  kind: "built_in",
  metadata: {},
  name: "mcp_search",
  outputKind: "json",
  outputSchema: {
    type: "object"
  },
  retryable: true,
  searchTags: ["catalog", "discover", "mcp", "search", "templates"],
  sideEffects: ["none"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.builtin.mcp_search",
  usageGuidance:
    "Use this before choosing a connected MCP tool or resource path. It is also the canonical way to inspect installable MCP server templates.",
  version: "1.0.0"
};
