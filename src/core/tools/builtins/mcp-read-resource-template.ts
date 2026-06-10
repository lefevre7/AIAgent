import { z } from "zod";

import type { ToolDefinition } from "@/core/contracts";
import type { MCPManager } from "@/core/mcp/manager";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

const inputSchema = z
  .object({
    serverName: z.string().min(1).max(128),
    uriTemplate: z.string().min(1).max(4096),
    variables: z.record(z.string(), z.union([z.string().min(1), z.array(z.string().min(1)).max(32)])).default({})
  })
  .strict();

export function createMcpReadResourceTemplateTool(params: { mcpManager: MCPManager }): RuntimeTool {
  return {
    definition: mcpReadResourceTemplateToolDefinition,
    async execute(call): Promise<RuntimeToolResult> {
      const input = inputSchema.parse(call.arguments as unknown);
      const result = await params.mcpManager.readResourceTemplate(input.serverName, input.uriTemplate, input.variables);

      return {
        citations: [
          {
            title: result.uri,
            uri: result.uri
          }
        ],
        result
      };
    }
  };
}

export const mcpReadResourceTemplateToolDefinition: ToolDefinition = {
  aliases: ["mcp_instantiate_resource"],
  annotations: {
    idempotentHint: true,
    meta: {
      family: "mcp"
    },
    openWorldHint: false,
    readOnlyHint: true,
    title: "MCP Read Resource Template"
  },
  approvalMode: "never",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only expands and reads a resource template.",
    examples: [
      "Instantiate a resource template from mcp_search results by filling in its variables.",
      "Read a dynamic MCP resource when you know the URI template and variable values."
    ],
    purpose: "Expand an MCP resource template with variables and then read the resulting resource URI.",
    sideEffectSummary: "Performs a read-only MCP resource fetch after URI-template expansion.",
    whenNotToUse: ["Do not use this when you already know the exact resource URI; use mcp_read_resource instead."],
    whenToUse: [
      "Use after mcp_search returns a resource_template capability that matches the task.",
      "Use when the MCP server exposes dynamic resources through URI templates."
    ]
  },
  description: "Instantiate an MCP resource template with variables and read the resulting resource.",
  displayName: "MCP Read Resource Template",
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
      uriTemplate: {
        type: "string"
      },
      variables: {
        additionalProperties: {
          anyOf: [
            {
              type: "string"
            },
            {
              items: {
                type: "string"
              },
              type: "array"
            }
          ]
        },
        type: "object"
      }
    },
    required: ["serverName", "uriTemplate"],
    type: "object"
  },
  invocationName: "mcp_read_resource_template",
  kind: "built_in",
  metadata: {},
  name: "mcp_read_resource_template",
  outputKind: "json",
  outputSchema: {
    type: "object"
  },
  retryable: true,
  searchTags: ["instantiate", "mcp", "read", "resource_template"],
  sideEffects: ["none"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.builtin.mcp_read_resource_template",
  usageGuidance:
    "Use this when a connected MCP server exposes resource templates. Provide concrete variable values so the runtime can expand the URI template before reading it.",
  version: "1.0.0"
};
