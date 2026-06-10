import type { JsonValue, MCPToolCapability, StructuredError } from "@/core/contracts";
import type { MCPManager } from "@/core/mcp";

const QUERY_FIELDS = ["query", "q", "term", "search", "searchQuery", "keywords", "question", "libraryName"] as const;
const LIMIT_FIELDS = ["limit", "maxResults", "count", "numResults", "topK"] as const;
const SEARCH_HINTS = ["search", "web", "internet", "docs", "documentation", "lookup", "find", "brave", "tavily", "perplexity"];

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

export class MCPWebSearchService {
  private readonly defaultLimit: number;
  private readonly mcpManager: MCPManager;

  constructor(options: MCPWebSearchServiceOptions) {
    this.defaultLimit = options.defaultLimit ?? 8;
    this.mcpManager = options.mcpManager;
  }

  async search(query: string, options: { limit?: number } = {}): Promise<WebSearchResult> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      throw searchError("Search query cannot be empty.", "web_search_invalid_query");
    }

    const capability = selectSearchCapability(this.mcpManager.getToolCapabilities());
    if (!capability) {
      throw searchError(
        "No MCP search-capable tool is connected. Configure an MCP server that exposes a search or web-search tool.",
        "web_search_no_backend"
      );
    }

    const argumentsObject = buildSearchArguments(capability, normalizedQuery, options.limit ?? this.defaultLimit);
    const response = await this.mcpManager.callTool(capability.serverName ?? "", capability.invocationName, argumentsObject);
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
}

function selectSearchCapability(capabilities: MCPToolCapability[]): MCPToolCapability | null {
  const ranked = capabilities
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
    });

  return ranked[0]?.capability ?? null;
}

function scoreSearchCapability(capability: MCPToolCapability): number {
  const queryField = findFirstMatchingProperty(capability.inputSchema, QUERY_FIELDS, isStringPropertySchema);
  if (!queryField) {
    return 0;
  }

  let score = 80;
  const haystack = [capability.name, capability.displayName, capability.description ?? "", ...capability.tags].join(" ").toLowerCase();

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

function extractResultsFromStructuredContent(value: unknown): Array<{ snippet: string | null; title: string; url: string | null }> {
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
    const title = line.replace(url, "").replace(/[-:]\s*$/, "").trim() || url;
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

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
