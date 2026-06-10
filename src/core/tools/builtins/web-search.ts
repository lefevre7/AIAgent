import type { ToolDefinition } from "@/core/contracts";
import type { MCPManager } from "@/core/mcp";
import { MCPWebSearchService } from "@/core/research";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

export function createWebSearchTool(options: { mcpManager: MCPManager }): RuntimeTool {
  const searchService = new MCPWebSearchService({
    mcpManager: options.mcpManager
  });

  return {
    definition: webSearchToolDefinition,
    async execute(call): Promise<RuntimeToolResult> {
      const query = normalizeQueryInput(call);
      const result = await searchService.search(query);

      return {
        citations: result.results
          .filter((entry) => entry.url)
          .map((entry) => ({
            title: entry.title,
            uri: entry.url as string
          })),
        result
      };
    }
  };
}

export const webSearchToolDefinition: ToolDefinition = {
  aliases: ["internet_search", "search_web"],
  annotations: {
    idempotentHint: true,
    meta: {
      family: "web"
    },
    openWorldHint: true,
    readOnlyHint: true,
    title: "Web Search"
  },
  approvalMode: "never",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only performs read-only internet search through configured MCP backends.",
    examples: [
      "Search the web for a recent product or API change before answering.",
      "Use this to discover URLs, then follow up with web_fetch for the best source."
    ],
    purpose: "Search the internet through connected MCP search tools and normalize the results into a model-friendly result set.",
    sideEffectSummary: "Performs public network reads through a connected MCP search backend.",
    whenNotToUse: [
      "Do not use this when you already know the exact page to inspect; use web_fetch instead.",
      "Do not use this when the answer is already available in local files or durable memory."
    ],
    whenToUse: [
      "Use when you need current or external information and must discover the right page first.",
      "Use before web_fetch when the best source URL is not already known."
    ]
  },
  description: "Search the internet through connected MCP search backends and return normalized result candidates.",
  displayName: "Web Search",
  execution: {
    inputMode: "text",
    resumable: false,
    taskSupport: "forbidden"
  },
  idempotent: true,
  inputSchema: {
    type: "string"
  },
  invocationName: "web_search",
  kind: "built_in",
  metadata: {},
  name: "web_search",
  outputKind: "json",
  outputSchema: {
    type: "object"
  },
  retryable: true,
  searchTags: ["current-events", "internet", "search", "web"],
  sideEffects: ["network_read"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.builtin.web_search",
  usageGuidance:
    "Use this when you need current or external information. It relies on connected MCP search tools, so configure an MCP search backend if internet search should be available.",
  version: "1.0.0"
};

function normalizeQueryInput(call: Parameters<RuntimeTool["execute"]>[0]): string {
  if (typeof call.inputText === "string" && call.inputText.trim().length > 0) {
    return call.inputText.trim();
  }

  const value = call.arguments as Record<string, unknown>;
  if (typeof value.query === "string" && value.query.trim().length > 0) {
    return value.query.trim();
  }
  if (typeof value.input === "string" && value.input.trim().length > 0) {
    return value.input.trim();
  }

  throw {
    code: "web_search_invalid_query",
    details: {},
    message: "web_search requires a non-empty query string.",
    retriable: false
  };
}
