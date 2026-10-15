import type { MCPCapability, MCPCapabilitySearchMatch, MCPCapabilitySearchQuery } from "@/core/contracts";
import { FieldSearchRanker, tokenizeForSearch, type IndexedSearchDocument } from "@/core/text/search";

// A query that is exactly a capability's name outranks everything else.
const EXACT_NAME_BOOST = 100;

// Ranked the way tool_search ranks tools (the same BM25 and tokenizer), so the
// model gets one order for a query whichever of the two it asks.
const CAPABILITY_FIELD_WEIGHTS = {
  access: 0.5,
  description: 1,
  displayName: 2,
  kind: 1,
  name: 3,
  serverName: 1.5,
  tags: 2,
  title: 2,
  uri: 2,
  uriTemplate: 2
} as const;

type CapabilityField = keyof typeof CAPABILITY_FIELD_WEIGHTS;

const capabilityRanker = new FieldSearchRanker(CAPABILITY_FIELD_WEIGHTS);

export class MCPCapabilityCatalog {
  // A catalog never changes once built (the manager builds a new one), so
  // each capability is indexed once, on the first search.
  private indexed?: Array<IndexedSearchDocument<CapabilityField>>;

  constructor(private readonly capabilities: MCPCapability[] = []) {}

  list(): MCPCapability[] {
    return [...this.capabilities].sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind.localeCompare(right.kind);
      }
      return left.displayName.localeCompare(right.displayName);
    });
  }

  search(query: MCPCapabilitySearchQuery): MCPCapabilitySearchMatch[] {
    const kinds = new Set(query.kinds ?? []);
    const scopes = new Set(query.scopes ?? []);
    const serverNames = new Set(query.serverNames ?? []);
    const filtered = this.capabilities.flatMap((capability, position) =>
      passesFilters(capability, kinds, scopes, serverNames) ? [{ capability, position }] : []
    );

    const rawQuery = query.query?.trim() ?? "";
    if (!rawQuery) {
      return filtered
        .map(({ capability }) => ({ capability, matchedOn: [], score: 1 }))
        .sort(byDisplayName)
        .slice(0, query.limit);
    }

    const indexed = this.index();
    const scores = capabilityRanker.rank(
      filtered.map(({ position }) => indexed[position]!),
      tokenizeForSearch(rawQuery)
    );
    const normalizedQuery = rawQuery.toLowerCase();
    const matches: MCPCapabilitySearchMatch[] = [];
    filtered.forEach(({ capability }, position) => {
      const matchedOn = new Set<string>(scores[position]!.matchedOn);
      let score = scores[position]!.score;
      if ([capability.name, capability.displayName].some((name) => name.toLowerCase() === normalizedQuery)) {
        score += EXACT_NAME_BOOST;
        matchedOn.add("name");
      }
      if (score > 0) {
        matches.push({ capability, matchedOn: [...matchedOn], score: Math.round(score * 1000) / 1000 });
      }
    });
    return matches.sort((left, right) => right.score - left.score || byDisplayName(left, right)).slice(0, query.limit);
  }

  private index(): Array<IndexedSearchDocument<CapabilityField>> {
    this.indexed ??= this.capabilities.map((capability) =>
      capabilityRanker.index({
        access: [capability.access],
        description: capability.description ? [capability.description] : [],
        displayName: [capability.displayName],
        kind: [capability.kind],
        name: [capability.name],
        serverName: capability.serverName ? [capability.serverName] : [],
        tags: capability.tags,
        title: "title" in capability && typeof capability.title === "string" ? [capability.title] : [],
        uri: "uri" in capability && typeof capability.uri === "string" ? [capability.uri] : [],
        uriTemplate:
          "uriTemplate" in capability && typeof capability.uriTemplate === "string" ? [capability.uriTemplate] : []
      })
    );
    return this.indexed;
  }
}

function passesFilters(
  capability: MCPCapability,
  kinds: Set<MCPCapability["kind"]>,
  scopes: Set<"connected" | "templates">,
  serverNames: Set<string>
): boolean {
  if (kinds.size > 0 && !kinds.has(capability.kind)) {
    return false;
  }
  const scope = capability.kind === "server_template" ? "templates" : "connected";
  if (scopes.size > 0 && !scopes.has(scope)) {
    return false;
  }
  return serverNames.size === 0 || (capability.serverName !== undefined && serverNames.has(capability.serverName));
}

function byDisplayName(left: MCPCapabilitySearchMatch, right: MCPCapabilitySearchMatch): number {
  return left.capability.displayName.localeCompare(right.capability.displayName);
}
