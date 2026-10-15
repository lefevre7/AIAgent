import { buildMcpApprovalTargets } from "@/core/approvals/policy";
import type { MCPToolCapability, ToolCallRecord, ToolDefinition } from "@/core/contracts";
import type { MCPManager } from "@/core/mcp";
import { formatMcpToolName } from "@/core/mcp/names";
import { MCPWebSearchService, type WebSearchBackendBinding } from "@/core/research";
import {
  APPROVAL_BINDING_METADATA_KEY,
  type RuntimeTool,
  type RuntimeToolResult,
  type ToolApprovalScope
} from "@/core/tools/runtime";

export function createWebSearchTool(options: { mcpManager: MCPManager }): RuntimeTool {
  const searchService = new MCPWebSearchService({
    mcpManager: options.mcpManager
  });

  return {
    definition: webSearchToolDefinition,
    // A search runs an MCP server's tool, so it is approved exactly as a
    // direct call to that tool would be: a trusted server or an allow rule
    // runs it, a deny rule refuses it, and anything else asks. It used to
    // skip approval entirely, which ran whatever connected tool happened to
    // have a `query` field.
    async resolveApprovalScope(_call, { isDenied }) {
      const scopes = (await searchService.listBackends()).flatMap((backend) =>
        backend.serverName ? [scopeFor(backend, backend.serverName)] : []
      );
      // The best backend the operator allows: a deny rule on one search
      // server used to refuse every search while another one was allowed.
      // With every one denied, the first is kept so the refusal names its rule.
      for (const scope of scopes) {
        if (!(await isDenied(scope))) {
          return scope;
        }
      }
      // With none, nothing would run: the call fails with web_search_no_backend.
      return scopes[0] ?? { approvalMode: "never", targets: [] };
    },
    async execute(call, context): Promise<RuntimeToolResult> {
      const query = normalizeQueryInput(call);
      const backend = readApprovedBackend(call);
      const result = await searchService.search(query, {
        ...(backend ? { backend } : {}),
        context: { sessionId: context.session.id, toolCallId: call.id, turnId: context.turn.id }
      });

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
  approvalMode: "ask",
  descriptor: {
    approvalNotes:
      "Approved like a direct call to the MCP search tool it runs: runs without asking when that server is trusted or an allow rule covers it, and asks otherwise. An operator deny rule always wins.",
    examples: [
      "Search the web for a recent product or API change before answering.",
      "Use this to discover URLs, then follow up with web_fetch for the best source."
    ],
    purpose:
      "Search the internet through connected MCP search tools and normalize the results into a model-friendly result set.",
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

/** Approval for running one MCP search tool: as a direct call to it would be. */
function scopeFor(backend: MCPToolCapability, serverName: string): ToolApprovalScope {
  const binding: WebSearchBackendBinding = {
    invocationName: backend.invocationName,
    rawName: backend.rawName,
    serverName
  };
  return {
    approvalMode: "ask",
    binding,
    targets: [
      ...buildMcpApprovalTargets({
        serverName,
        tool: { label: backend.displayName, name: formatMcpToolName(serverName, backend.rawName) }
      }),
      // The `tool` target a direct call to that MCP tool carries (its
      // invocation name), so a `tool` deny rule on it stops this too.
      { kind: "tool", label: backend.displayName, value: backend.invocationName }
    ]
  };
}

function readApprovedBackend(call: ToolCallRecord): WebSearchBackendBinding | null {
  const binding = call.metadata[APPROVAL_BINDING_METADATA_KEY];
  if (typeof binding !== "object" || binding === null || Array.isArray(binding)) {
    return null;
  }
  const { invocationName, rawName, serverName } = binding as Record<string, unknown>;
  if (typeof invocationName !== "string" || typeof serverName !== "string") {
    return null;
  }
  return { invocationName, ...(typeof rawName === "string" ? { rawName } : {}), serverName };
}

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
