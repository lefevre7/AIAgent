import type { ToolDefinition, ToolSearchMatch, ToolSearchQuery } from "@/core/contracts";
import { FieldSearchRanker, tokenizeForSearch, type IndexedSearchDocument } from "@/core/text/search";

// A query that is exactly a tool's name or alias outranks everything else.
const EXACT_NAME_BOOST = 100;

// Field weights: names say the most, then titles and tags, then prose. Codex
// ranks on the same fields, the server's instructions and the argument names
// included. The instructions get the least: they help choose between servers,
// but say little about any one tool.
const TOOL_FIELD_WEIGHTS = {
  aliases: 2,
  "annotations.title": 2,
  "descriptor.purpose": 1,
  "descriptor.whenToUse": 0.5,
  description: 1,
  displayName: 2,
  "inputSchema.properties": 1,
  invocationName: 3,
  name: 3,
  searchTags: 2,
  serverInstructions: 0.25,
  "source.serverName": 1.5,
  usageGuidance: 0.5
} as const;

type ToolField = keyof typeof TOOL_FIELD_WEIGHTS;

const toolRanker = new FieldSearchRanker(TOOL_FIELD_WEIGHTS);

type IndexedTool = {
  own: IndexedSearchDocument<ToolField>;
  /** `own` with its server's instructions, for the instructions it was made with. */
  withServer?: { document: IndexedSearchDocument<ToolField>; instructions: ServerWords };
};
type ServerWords = Map<string, number>;

// Each definition is indexed once: definitions do not change for the life of
// a registry (built-ins are constants, and the MCP registry builds new ones
// only when the manager's catalog changes), and tokenizing every field of
// every tool on every search cost seconds at 2,048 MCP tools.
const indexedTools = new WeakMap<ToolDefinition, IndexedTool>();
// Each server's instructions are tokenized once (again when they change), and
// that one table is shared by all of the server's tools: they used to be
// copied onto every tool definition, and from there into every model request.
const indexedServers = new Map<string, { instructions: string; words: ServerWords }>();

export type ToolSearchOptions = {
  /** A connected MCP server's usage notes (its `instructions`), searched once per server. */
  serverInstructions?: (serverName: string) => string | undefined;
};

/**
 * Ranks tools for `tool_search` with BM25 over their names, titles, tags,
 * descriptions, usage notes, MCP server name and instructions, and argument
 * names, after the kind, approval-mode, and side-effect filters.
 *
 * A phrased request ("search the workspace for files containing a pattern")
 * finds the tool whose fields share its words, weighted by how rare each word
 * is across the catalog; a query that is exactly a tool's name or alias puts
 * that tool first; common connectives match nothing on their own. An empty
 * query lists every tool that passes the filters, by display name.
 */
export function searchToolDefinitions(
  definitions: ToolDefinition[],
  query: ToolSearchQuery,
  options: ToolSearchOptions = {}
): ToolSearchMatch[] {
  const filtered = definitions.filter((definition) => passesFilters(definition, query));
  const rawQuery = query.query?.trim() ?? "";
  if (!rawQuery) {
    return filtered
      .map((definition) => ({ definition, matchedOn: [], score: 1 }))
      .sort(byDisplayName)
      .slice(0, query.limit);
  }

  // Tokenized as written: lowercasing first lost the camelCase split
  // ("readFile" no longer met read_file).
  const queryWords = tokenizeForSearch(rawQuery);
  const normalizedQuery = rawQuery.toLowerCase();
  const scores = toolRanker.rank(
    filtered.map((definition) => indexTool(definition, serverWords(definition, options.serverInstructions))),
    queryWords
  );

  const matches: ToolSearchMatch[] = [];
  filtered.forEach((definition, position) => {
    const matchedOn = new Set<string>(scores[position]!.matchedOn);
    let score = scores[position]!.score;
    if (isExactName(definition, normalizedQuery)) {
      score += EXACT_NAME_BOOST;
      matchedOn.add("invocationName");
    }
    if (score > 0) {
      matches.push({ definition, matchedOn: [...matchedOn], score: Math.round(score * 1000) / 1000 });
    }
  });
  return matches.sort((left, right) => right.score - left.score || byDisplayName(left, right)).slice(0, query.limit);
}

function passesFilters(definition: ToolDefinition, query: ToolSearchQuery): boolean {
  if (query.approvalModes?.length && !query.approvalModes.includes(definition.approvalMode)) {
    return false;
  }
  if (query.kinds?.length && !query.kinds.includes(definition.kind)) {
    return false;
  }
  if (query.sideEffects?.length && !definition.sideEffects.some((effect) => query.sideEffects!.includes(effect))) {
    return false;
  }
  return true;
}

function isExactName(definition: ToolDefinition, normalizedQuery: string): boolean {
  return [definition.invocationName, definition.name, ...definition.aliases].some(
    (name) => name.toLowerCase() === normalizedQuery
  );
}

function indexTool(
  definition: ToolDefinition,
  instructions: ServerWords | undefined
): IndexedSearchDocument<ToolField> {
  let indexed = indexedTools.get(definition);
  if (!indexed) {
    indexed = {
      own: toolRanker.index({
        aliases: definition.aliases,
        "annotations.title": definition.annotations.title ? [definition.annotations.title] : [],
        "descriptor.purpose": [definition.descriptor.purpose],
        "descriptor.whenToUse": definition.descriptor.whenToUse,
        description: [definition.description],
        displayName: [definition.displayName],
        "inputSchema.properties": Object.keys(
          typeof definition.inputSchema.properties === "object" && definition.inputSchema.properties !== null
            ? definition.inputSchema.properties
            : {}
        ),
        invocationName: [definition.invocationName],
        name: [definition.name],
        searchTags: definition.searchTags,
        "source.serverName": definition.source.serverName ? [definition.source.serverName] : [],
        usageGuidance: [definition.usageGuidance]
      })
    };
    indexedTools.set(definition, indexed);
  }
  if (!instructions) {
    return indexed.own;
  }
  if (indexed.withServer?.instructions !== instructions) {
    // The instructions do not add to the tool's length: a server that writes
    // good instructions used to push its own tools down the ranking.
    indexed.withServer = {
      document: {
        fields: new Map([...indexed.own.fields, ["serverInstructions", instructions]]),
        length: indexed.own.length
      },
      instructions
    };
  }
  return indexed.withServer.document;
}

function serverWords(
  definition: ToolDefinition,
  instructionsOf: ToolSearchOptions["serverInstructions"]
): ServerWords | undefined {
  const serverName = definition.source.serverName;
  const instructions = serverName ? instructionsOf?.(serverName) : undefined;
  if (!serverName || !instructions) {
    return undefined;
  }
  const cached = indexedServers.get(serverName);
  if (cached?.instructions === instructions) {
    return cached.words;
  }
  const words = toolRanker.index({ serverInstructions: [instructions] }).fields.get("serverInstructions") ?? new Map();
  indexedServers.set(serverName, { instructions, words });
  return words;
}

function byDisplayName(left: ToolSearchMatch, right: ToolSearchMatch): number {
  return left.definition.displayName.localeCompare(right.definition.displayName);
}
