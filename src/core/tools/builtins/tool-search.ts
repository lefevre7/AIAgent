import { z } from "zod";

import type { ToolSearchQuery } from "@/core/contracts";
import { toolSearchQuerySchema, type ToolDefinition } from "@/core/contracts";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

const inputSchema = toolSearchQuerySchema.extend({
  query: z.string().min(1).max(500).optional()
});

export function createToolSearchTool(): RuntimeTool {
  return {
    definition: toolSearchToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const query = inputSchema.parse(call.arguments as unknown) as ToolSearchQuery;
      const matches = context.registry.searchDefinitions(query).map((match) => serializeMatch(match.definition, match.matchedOn, match.score));

      return {
        result: {
          matches
        }
      };
    }
  };
}

export const toolSearchToolDefinition: ToolDefinition = {
  aliases: ["find_tool", "list_tools"],
  annotations: {
    idempotentHint: true,
    meta: {
      family: "catalog"
    },
    openWorldHint: false,
    readOnlyHint: true,
    title: "Tool Search"
  },
  approvalMode: "never",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only inspects the active tool catalog.",
    examples: [
      "Use before guessing between multiple file-editing tools.",
      "Use to find tools that require approval or have network side effects."
    ],
    purpose: "Inspect and rank the currently available executable tools before choosing the next action.",
    sideEffectSummary: "This tool only reads the local tool catalog and returns ranked matches.",
    whenNotToUse: [
      "Do not use it when you already know the exact canonical tool to call next.",
      "Do not use it as a substitute for reading the result of a tool you already ran."
    ],
    whenToUse: [
      "Use when multiple tools seem plausible and you need the safest canonical path.",
      "Use when you want to filter tools by side effects, approval requirements, or tool kind."
    ]
  },
  description:
    "Search the current tool catalog by purpose, side effects, approval mode, or name. Use this when you are unsure which tool is appropriate or need to inspect the available runtime surface before acting.",
  displayName: "Tool Search",
  execution: {
    inputMode: "json",
    resumable: false,
    taskSupport: "forbidden"
  },
  idempotent: true,
  inputSchema: {
    additionalProperties: false,
    properties: {
      approvalModes: {
        items: {
          enum: ["always", "ask", "never"],
          type: "string"
        },
        type: "array"
      },
      kinds: {
        items: {
          enum: ["browser", "built_in", "channel", "external_agent", "image", "mcp", "memory", "skill", "voice"],
          type: "string"
        },
        type: "array"
      },
      limit: {
        default: 10,
        minimum: 1,
        maximum: 100,
        type: "integer"
      },
      query: {
        description: "Optional free-text query to match against tool names, aliases, tags, descriptions, and usage guidance.",
        type: "string"
      },
      sideEffects: {
        items: {
          enum: [
            "channel_io",
            "local_process",
            "network_read",
            "network_write",
            "none",
            "remote_mutation",
            "workspace_read",
            "workspace_write"
          ],
          type: "string"
        },
        type: "array"
      }
    },
    type: "object"
  },
  invocationName: "tool_search",
  kind: "built_in",
  metadata: {},
  name: "tool_search",
  outputKind: "json",
  outputSchema: {
    additionalProperties: false,
    properties: {
      matches: {
        items: {
          additionalProperties: false,
          properties: {
            aliases: {
              items: {
                type: "string"
              },
              type: "array"
            },
            approvalMode: {
              type: "string"
            },
            description: {
              type: "string"
            },
            displayName: {
              type: "string"
            },
            invocationName: {
              type: "string"
            },
            kind: {
              type: "string"
            },
            matchedOn: {
              items: {
                type: "string"
              },
              type: "array"
            },
            name: {
              type: "string"
            },
            score: {
              type: "number"
            },
            toolId: {
              type: "string"
            },
            searchTags: {
              items: {
                type: "string"
              },
              type: "array"
            },
            source: {
              additionalProperties: false,
              properties: {
                displayName: {
                  type: "string"
                },
                kind: {
                  type: "string"
                },
                serverName: {
                  type: "string"
                }
              },
              required: ["kind"],
              type: "object"
            },
            sideEffects: {
              items: {
                type: "string"
              },
              type: "array"
            },
            usageGuidance: {
              type: "string"
            }
          },
          required: [
            "aliases",
            "approvalMode",
            "description",
            "displayName",
            "invocationName",
            "kind",
            "matchedOn",
            "name",
            "score",
            "toolId",
            "searchTags",
            "source",
            "sideEffects",
            "usageGuidance"
          ],
          type: "object"
        },
        type: "array"
      }
    },
    required: ["matches"],
    type: "object"
  },
  retryable: true,
  searchTags: ["catalog", "discover", "find", "search", "tools"],
  sideEffects: ["none"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.builtin.tool_search",
  usageGuidance:
    "Use this before guessing. Prefer it when multiple tools seem plausible, when you need to filter by side effects or approval requirements, or when you want to confirm the safest canonical tool for the next step.",
  version: "1.0.0"
};

function serializeMatch(definition: ToolDefinition, matchedOn: string[], score: number) {
  return {
    aliases: definition.aliases,
    approvalMode: definition.approvalMode,
    description: definition.description,
    displayName: definition.displayName,
    invocationName: definition.invocationName,
    kind: definition.kind,
    matchedOn,
    name: definition.name,
    score,
    toolId: definition.toolId,
    searchTags: definition.searchTags,
    source: definition.source,
    sideEffects: definition.sideEffects,
    usageGuidance: definition.usageGuidance
  };
}
