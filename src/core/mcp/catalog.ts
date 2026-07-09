import type { MCPCapability, MCPCapabilitySearchMatch, MCPCapabilitySearchQuery } from "@/core/contracts";

export class MCPCapabilityCatalog {
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
    const normalizedQuery = query.query?.trim().toLowerCase() ?? "";
    const kindFilter = new Set(query.kinds ?? []);
    const scopeFilter = new Set(query.scopes ?? []);
    const serverFilter = new Set(query.serverNames ?? []);

    const matches = this.capabilities
      .map((capability) => scoreCapability(capability, normalizedQuery, kindFilter, scopeFilter, serverFilter))
      .filter((match): match is MCPCapabilitySearchMatch => match !== null)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return left.capability.displayName.localeCompare(right.capability.displayName);
      });

    return matches.slice(0, query.limit);
  }
}

function scoreCapability(
  capability: MCPCapability,
  normalizedQuery: string,
  kinds: Set<MCPCapability["kind"]>,
  scopes: Set<"connected" | "templates">,
  serverNames: Set<string>
): MCPCapabilitySearchMatch | null {
  if (kinds.size > 0 && !kinds.has(capability.kind)) {
    return null;
  }

  const scope = capability.kind === "server_template" ? "templates" : "connected";
  if (scopes.size > 0 && !scopes.has(scope)) {
    return null;
  }

  if (serverNames.size > 0) {
    if (!capability.serverName || !serverNames.has(capability.serverName)) {
      return null;
    }
  }

  if (!normalizedQuery) {
    return {
      capability,
      matchedOn: [],
      score: 1
    };
  }

  const matchedOn: string[] = [];
  let score = 0;
  const add = (field: string, increment: number) => {
    score += increment;
    if (!matchedOn.includes(field)) {
      matchedOn.push(field);
    }
  };

  matchText(capability.name, normalizedQuery, "name", 95, 80, 70, add);
  matchText(capability.displayName, normalizedQuery, "displayName", 92, 76, 66, add);
  matchText(capability.description, normalizedQuery, "description", 0, 0, 40, add);

  if (capability.serverName) {
    matchText(capability.serverName, normalizedQuery, "serverName", 75, 60, 45, add);
  }

  if ("title" in capability && typeof capability.title === "string") {
    matchText(capability.title, normalizedQuery, "title", 82, 68, 48, add);
  }

  if ("uri" in capability && typeof capability.uri === "string") {
    matchText(capability.uri, normalizedQuery, "uri", 88, 72, 52, add);
  }

  if ("uriTemplate" in capability && typeof capability.uriTemplate === "string") {
    matchText(capability.uriTemplate, normalizedQuery, "uriTemplate", 88, 72, 52, add);
  }

  // Score tags once at their best tier rather than accumulating per matching
  // tag. Every capability carries injected tags ("mcp", the kind, plus the
  // server's configured tags), so summing per-tag matches let tag-heavy
  // capabilities outrank an exact name/displayName match on another capability.
  let bestTagScore = 0;
  for (const tag of capability.tags) {
    const normalizedTag = tag.toLowerCase();
    if (normalizedTag === normalizedQuery) {
      bestTagScore = Math.max(bestTagScore, 80);
    } else if (normalizedTag.startsWith(normalizedQuery)) {
      bestTagScore = Math.max(bestTagScore, 65);
    } else if (normalizedTag.includes(normalizedQuery)) {
      bestTagScore = Math.max(bestTagScore, 55);
    }
  }
  if (bestTagScore > 0) {
    add("tags", bestTagScore);
  }

  if (capability.kind.includes(normalizedQuery)) {
    add("kind", 20);
  }

  if (capability.access.includes(normalizedQuery)) {
    add("access", 18);
  }

  return score > 0
    ? {
        capability,
        matchedOn,
        score
      }
    : null;
}

function matchText(
  value: string | undefined,
  query: string,
  field: string,
  exact: number,
  prefix: number,
  contains: number,
  add: (field: string, increment: number) => void
): void {
  if (!value) {
    return;
  }

  const normalized = value.toLowerCase();
  if (normalized === query && exact > 0) {
    add(field, exact);
    return;
  }
  if (normalized.startsWith(query) && prefix > 0) {
    add(field, prefix);
    return;
  }
  if (normalized.includes(query) && contains > 0) {
    add(field, contains);
  }
}
