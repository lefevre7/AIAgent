import { toJsonValue, type JsonValue, type MCPToolCapability, type StructuredError } from "@/core/contracts";
import type { MCPManager, McpCallContext } from "@/core/mcp";

const QUERY_FIELDS = ["query", "q", "term", "search", "searchQuery", "keywords", "question", "libraryName"] as const;
const LIMIT_FIELDS = ["limit", "maxResults", "count", "numResults", "topK"] as const;
const SEARCH_HINTS = [
  "search",
  "web",
  "internet",
  "docs",
  "documentation",
  "lookup",
  "find",
  "brave",
  "tavily",
  "perplexity"
];

export type WebSearchResult = {
  provider: {
    invocationName: string;
    serverName: string;
    toolName: string;
  };
  query: string;
  rawContent: JsonValue | null;
  rawText: string;
  results: Array<{
    snippet: string | null;
    title: string;
    url: string | null;
  }>;
};

export type MCPWebSearchServiceOptions = {
  defaultLimit?: number;
  mcpManager: MCPManager;
};

/**
 * Identifies one connected MCP search tool, as recorded when a search was
 * approved: by its server and the tool's own name, which survive a relist
 * (an invocation name can gain a "-2" when another tool slugs alike).
 */
export type WebSearchBackendBinding = {
  invocationName: string;
  /** Absent in bindings recorded before it was added. */
  rawName?: string;
  serverName: string;
};

export class MCPWebSearchService {
  private readonly defaultLimit: number;
  private readonly mcpManager: MCPManager;

  constructor(options: MCPWebSearchServiceOptions) {
    this.defaultLimit = options.defaultLimit ?? 8;
    this.mcpManager = options.mcpManager;
  }

  /** The MCP tool a search would run right now, or null when none qualifies. */
  selectBackend(): MCPToolCapability | null {
    return this.rankBackends()[0] ?? null;
  }

  /**
   * Every connected MCP tool a search could run, best first. Optional
   * servers still connecting at startup are waited for (within the startup
   * grace) first: a search in the first second used to find no backend.
   */
  async listBackends(): Promise<MCPToolCapability[]> {
    await this.mcpManager.waitForStartup();
    return this.rankBackends();
  }

  private rankBackends(): MCPToolCapability[] {
    return rankSearchCapabilities(this.mcpManager.getToolCapabilities());
  }

  /**
   * Runs a search. With `backend`, it runs exactly that MCP tool, which is how
   * an approved search executes: the tool was approved, and the best match
   * could be a different one by the time the approval is resolved.
   */
  async search(
    query: string,
    options: { backend?: WebSearchBackendBinding; context?: McpCallContext; limit?: number } = {}
  ): Promise<WebSearchResult> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw searchError("Search query cannot be empty.", "web_search_invalid_query");
    }

    const capability = options.backend
      ? this.findBoundBackend(options.backend)
      : ((await this.listBackends())[0] ?? null);
    if (!capability) {
      throw searchError(
        "No MCP search-capable tool is connected. Configure an MCP server that exposes a search or web-search tool.",
        "web_search_no_backend"
      );
    }

    const argumentsObject = buildSearchArguments(capability, normalizedQuery, options.limit ?? this.defaultLimit);
    // The call's own session and turn: a server that asks a question during
    // the search reaches that session's operator, and its clock is the call's.
    const response = await this.mcpManager.callTool(
      capability.serverName ?? "",
      capability.invocationName,
      argumentsObject,
      options.context ?? {}
    );
    const rawText = Array.isArray(response.content)
      ? response.content
          .flatMap((item) => {
            if (typeof item !== "object" || item === null || item.type !== "text" || typeof item.text !== "string") {
              return [];
            }
            return [item.text];
          })
          .join("\n\n")
          .trim()
      : "";
    if (response.isError === true) {
      // The tool ran and failed (a quota, a bad key); its text says why. It
      // used to be parsed as a result set: "no results", or the error as one.
      throw searchError(
        `The search tool ${capability.rawName} on MCP server "${capability.serverName ?? ""}" reported an error${rawText ? `: ${rawText}` : "."}`,
        "web_search_backend_error"
      );
    }
    const results = normalizeSearchResults(response.structuredContent, rawText);

    return {
      provider: {
        invocationName: capability.invocationName,
        serverName: capability.serverName ?? "",
        toolName: capability.rawName
      },
      query: normalizedQuery,
      rawContent: toJsonValue(response.structuredContent) ?? null,
      rawText,
      results
    };
  }

  private findBoundBackend(backend: WebSearchBackendBinding): MCPToolCapability {
    const capability = this.mcpManager
      .getToolCapabilities()
      .find(
        (candidate) =>
          candidate.serverName === backend.serverName &&
          (backend.rawName !== undefined
            ? candidate.rawName === backend.rawName
            : candidate.invocationName === backend.invocationName)
      );
    if (!capability) {
      throw searchError(
        `The search tool this call was approved for (${backend.invocationName} on MCP server "${backend.serverName}") is no longer connected. Run web_search again.`,
        "web_search_backend_changed"
      );
    }
    return capability;
  }
}

function rankSearchCapabilities(capabilities: MCPToolCapability[]): MCPToolCapability[] {
  return capabilities
    .map((capability) => ({
      capability,
      score: scoreSearchCapability(capability)
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.capability.displayName.localeCompare(right.capability.displayName);
    })
    .map((candidate) => candidate.capability);
}

function scoreSearchCapability(capability: MCPToolCapability): number {
  const queryField = findFirstMatchingProperty(capability.inputSchema, QUERY_FIELDS, isStringPropertySchema);
  if (!queryField) {
    return 0;
  }

  let score = 80;
  const haystack = [capability.name, capability.displayName, capability.description ?? "", ...capability.tags]
    .join(" ")
    .toLowerCase();

  for (const hint of SEARCH_HINTS) {
    if (haystack.includes(hint)) {
      score += 20;
    }
  }

  if (queryField === "query") {
    score += 20;
  }
  if (findFirstMatchingProperty(capability.inputSchema, LIMIT_FIELDS, isIntegerLikePropertySchema)) {
    score += 10;
  }

  return score;
}

function buildSearchArguments(capability: MCPToolCapability, query: string, limit: number): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const queryField = findFirstMatchingProperty(capability.inputSchema, QUERY_FIELDS, isStringPropertySchema);
  if (!queryField) {
    throw searchError(
      `The MCP tool "${capability.rawName}" does not expose a supported query field.`,
      "web_search_schema_unsupported"
    );
  }
  args[queryField] = query;

  const limitField = findFirstMatchingProperty(capability.inputSchema, LIMIT_FIELDS, isIntegerLikePropertySchema);
  if (limitField) {
    args[limitField] = limit;
  }

  if (hasBooleanProperty(capability.inputSchema, "includeContent")) {
    args.includeContent = true;
  }
  if (hasBooleanProperty(capability.inputSchema, "includeRawContent")) {
    args.includeRawContent = true;
  }

  return args;
}

function findFirstMatchingProperty(
  schema: MCPToolCapability["inputSchema"],
  candidates: readonly string[],
  predicate: (value: JsonValue) => boolean
): string | null {
  const properties = extractSchemaProperties(schema);
  for (const candidate of candidates) {
    const property = properties[candidate];
    if (property && predicate(property)) {
      return candidate;
    }
  }
  return null;
}

function hasBooleanProperty(schema: MCPToolCapability["inputSchema"], propertyName: string): boolean {
  const property = extractSchemaProperties(schema)[propertyName];
  return typeof property === "object" && property !== null && !Array.isArray(property) && property.type === "boolean";
}

function extractSchemaProperties(schema: MCPToolCapability["inputSchema"]): Record<string, JsonValue> {
  const properties = schema.properties;
  return typeof properties === "object" && properties !== null && !Array.isArray(properties)
    ? (properties as Record<string, JsonValue>)
    : {};
}

function isStringPropertySchema(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && value.type === "string";
}

function isIntegerLikePropertySchema(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && value.type === "integer";
}

function normalizeSearchResults(structuredContent: unknown, rawText: string) {
  const normalized = dedupeResults([
    ...extractResultsFromStructuredContent(structuredContent),
    ...extractResultsFromText(rawText)
  ]);

  if (normalized.length > 0) {
    return normalized;
  }

  return rawText
    ? [
        {
          snippet: rawText,
          title: "Search result",
          url: null
        }
      ]
    : [];
}

function extractResultsFromStructuredContent(
  value: unknown
): Array<{ snippet: string | null; title: string; url: string | null }> {
  const matches: Array<{ snippet: string | null; title: string; url: string | null }> = [];

  visitValue(value, (entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return;
    }

    const record = entry as Record<string, unknown>;

    const title = firstString(record.title, record.name, record.label, record.heading);
    const url = firstString(record.url, record.link, record.uri, record.href);
    const snippet = firstString(record.snippet, record.description, record.text, record.content, record.summary);

    if (title || url || snippet) {
      matches.push({
        snippet: snippet ?? null,
        title: title ?? url ?? "Search result",
        url: url ?? null
      });
    }
  });

  return matches;
}

function extractResultsFromText(text: string): Array<{ snippet: string | null; title: string; url: string | null }> {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const results: Array<{ snippet: string | null; title: string; url: string | null }> = [];

  for (const line of lines) {
    const urlMatch = line.match(/https?:\/\/[^\s)]+/i);
    if (!urlMatch) {
      continue;
    }

    const url = urlMatch[0];
    const title =
      line
        .replace(url, "")
        .replace(/[-:]\s*$/, "")
        .trim() || url;
    results.push({
      snippet: line,
      title,
      url
    });
  }

  return results;
}

function dedupeResults(results: Array<{ snippet: string | null; title: string; url: string | null }>) {
  const seen = new Set<string>();
  const deduped: Array<{ snippet: string | null; title: string; url: string | null }> = [];

  for (const result of results) {
    const key = result.url ? `url::${result.url}` : `title::${result.title.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(result);
  }

  return deduped.slice(0, 10);
}

function visitValue(value: unknown, visitor: (value: unknown) => void): void {
  visitor(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      visitValue(entry, visitor);
    }
    return;
  }

  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) {
      visitValue(entry, visitor);
    }
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string") {
      const normalized = value.trim();
      if (normalized.length > 0) {
        return normalized;
      }
    }
  }
  return undefined;
}

function searchError(message: string, code: StructuredError["code"]): StructuredError {
  return {
    code,
    details: {},
    message,
    retriable: false
  };
}
