import type { ToolApprovalMode, ToolDefinition, ToolRegistry, ToolSearchMatch, ToolSearchQuery } from "@/core/contracts";

import type { RuntimeTool } from "@/core/tools/runtime";

export interface ExecutableToolRegistry extends ToolRegistry {
  getTool(toolName: string): RuntimeTool | null;
}

type RegisteredTool = {
  normalizedAliases: string[];
  normalizedName: string;
  tool: RuntimeTool;
};

export class ToolRegistryBuilder {
  private readonly aliases = new Map<string, string>();
  private readonly entries = new Map<string, RegisteredTool>();
  private readonly invocationNames = new Map<string, string>();
  private readonly names = new Map<string, string>();

  register(tool: RuntimeTool, options?: { onDuplicate?: "skip" | "throw" }): this {
    const onDuplicate = options?.onDuplicate ?? "throw";
    const toolId = tool.definition.toolId;
    const invocationName = tool.definition.invocationName;
    const normalizedName = normalizeLookupKey(tool.definition.name);

    const conflict = this.entries.has(toolId)
      ? `Tool id "${toolId}" is already registered.`
      : this.invocationNames.has(invocationName)
        ? `Tool invocation name "${invocationName}" is already registered.`
        : this.names.has(normalizedName) || this.aliases.has(normalizedName)
          ? `Tool name "${tool.definition.name}" conflicts with an existing tool or alias.`
          : null;

    // A single misbehaving source (e.g. an MCP server exposing two tools that
    // collapse to the same identity) must not throw and take down the entire
    // registry — including built-in tools — when built with onDuplicate "skip".
    if (conflict) {
      if (onDuplicate === "skip") {
        console.warn(`Skipping duplicate tool registration: ${conflict}`);
        return this;
      }
      throw new Error(conflict);
    }

    const normalizedAliases: string[] = [];
    for (const alias of tool.definition.aliases) {
      const normalizedAlias = normalizeLookupKey(alias);
      if (normalizedAlias === normalizedName) {
        normalizedAliases.push(normalizedAlias);
        continue;
      }
      if (this.names.has(normalizedAlias) || this.aliases.has(normalizedAlias)) {
        if (onDuplicate === "skip") {
          console.warn(`Skipping conflicting tool alias "${alias}".`);
          continue;
        }
        throw new Error(`Tool alias "${alias}" conflicts with an existing tool or alias.`);
      }
      this.aliases.set(normalizedAlias, toolId);
      normalizedAliases.push(normalizedAlias);
    }

    this.entries.set(toolId, {
      normalizedAliases,
      normalizedName,
      tool
    });
    this.invocationNames.set(invocationName, toolId);
    this.names.set(normalizedName, toolId);

    return this;
  }

  build(): ExecutableToolRegistry {
    return new InMemoryToolRegistry(this.entries, this.invocationNames, this.names, this.aliases);
  }
}

export function createExecutableToolRegistry(
  tools: RuntimeTool[],
  options?: { onDuplicate?: "skip" | "throw" }
): ExecutableToolRegistry {
  const builder = new ToolRegistryBuilder();
  for (const tool of tools) {
    builder.register(tool, options);
  }
  return builder.build();
}

export function combineToolRegistries(registries: ExecutableToolRegistry[]): ExecutableToolRegistry {
  if (registries.length === 1) {
    return registries[0]!;
  }
  return new CompositeToolRegistry(registries);
}

class InMemoryToolRegistry implements ExecutableToolRegistry {
  constructor(
    private readonly entries: Map<string, RegisteredTool>,
    private readonly invocationNames: Map<string, string>,
    private readonly names: Map<string, string>,
    private readonly aliases: Map<string, string>
  ) {}

  getDefinition(toolName: string): ToolDefinition | null {
    return this.getTool(toolName)?.definition ?? null;
  }

  getTool(toolName: string): RuntimeTool | null {
    const toolId = resolveToolId(toolName, this.entries, this.invocationNames, this.names, this.aliases);
    if (!toolId) {
      return null;
    }

    return this.entries.get(toolId)?.tool ?? null;
  }

  listDefinitions(): ToolDefinition[] {
    return Array.from(this.entries.values())
      .map((entry) => entry.tool.definition)
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  searchDefinitions(query: ToolSearchQuery): ToolSearchMatch[] {
    const normalizedQuery = query.query?.trim().toLowerCase() ?? "";
    const filters = {
      approvalModes: new Set(query.approvalModes ?? []),
      kinds: new Set(query.kinds ?? []),
      sideEffects: new Set(query.sideEffects ?? [])
    };

    const matches = Array.from(this.entries.values())
      .map((entry) => scoreTool(entry, normalizedQuery, filters))
      .filter((match): match is ToolSearchMatch => match !== null)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return left.definition.displayName.localeCompare(right.definition.displayName);
      });

    return matches.slice(0, query.limit);
  }
}

class CompositeToolRegistry implements ExecutableToolRegistry {
  constructor(private readonly registries: ExecutableToolRegistry[]) {}

  getDefinition(toolName: string): ToolDefinition | null {
    return this.getTool(toolName)?.definition ?? null;
  }

  getTool(toolName: string): RuntimeTool | null {
    for (const registry of this.registries) {
      const tool = registry.getTool(toolName);
      if (tool) {
        return tool;
      }
    }
    return null;
  }

  listDefinitions(): ToolDefinition[] {
    const seen = new Set<string>();
    const definitions: ToolDefinition[] = [];

    for (const registry of this.registries) {
      for (const definition of registry.listDefinitions()) {
        if (seen.has(definition.toolId)) {
          continue;
        }
        seen.add(definition.toolId);
        definitions.push(definition);
      }
    }

    return definitions.sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  searchDefinitions(query: ToolSearchQuery): ToolSearchMatch[] {
    const deduped = new Map<string, ToolSearchMatch>();

    for (const registry of this.registries) {
      for (const match of registry.searchDefinitions(query)) {
        const existing = deduped.get(match.definition.toolId);
        if (!existing || match.score > existing.score) {
          deduped.set(match.definition.toolId, match);
        }
      }
    }

    return Array.from(deduped.values())
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        return left.definition.displayName.localeCompare(right.definition.displayName);
      })
      .slice(0, query.limit);
  }
}

function resolveToolId(
  toolName: string,
  entries: Map<string, RegisteredTool>,
  invocationNames: Map<string, string>,
  names: Map<string, string>,
  aliases: Map<string, string>
): string | null {
  if (entries.has(toolName)) {
    return toolName;
  }

  const invocationMatch = invocationNames.get(toolName);
  if (invocationMatch) {
    return invocationMatch;
  }

  const normalizedKey = normalizeLookupKey(toolName);
  const nameMatch = names.get(normalizedKey);
  if (nameMatch) {
    return nameMatch;
  }

  return aliases.get(normalizedKey) ?? null;
}

function scoreTool(
  entry: RegisteredTool,
  normalizedQuery: string,
  filters: {
    approvalModes: Set<ToolApprovalMode>;
    kinds: Set<ToolDefinition["kind"]>;
    sideEffects: Set<ToolDefinition["sideEffects"][number]>;
  }
): ToolSearchMatch | null {
  const definition = entry.tool.definition;

  if (filters.approvalModes.size > 0 && !filters.approvalModes.has(definition.approvalMode)) {
    return null;
  }
  if (filters.kinds.size > 0 && !filters.kinds.has(definition.kind)) {
    return null;
  }
  if (filters.sideEffects.size > 0 && !definition.sideEffects.some((sideEffect) => filters.sideEffects.has(sideEffect))) {
    return null;
  }

  if (!normalizedQuery) {
    return {
      definition,
      matchedOn: [],
      score: 1
    };
  }

  let score = 0;
  const matchedOn: string[] = [];
  const addMatch = (field: string, increment: number) => {
    score += increment;
    if (!matchedOn.includes(field)) {
      matchedOn.push(field);
    }
  };

  matchText(definition.invocationName, normalizedQuery, {
    contains: 70,
    exact: 100,
    field: "invocationName",
    matchedOn,
    prefix: 85,
    updateScore: (increment) => {
      score += increment;
    }
  });
  matchText(definition.name, normalizedQuery, {
    contains: 65,
    exact: 95,
    field: "name",
    matchedOn,
    prefix: 80,
    updateScore: (increment) => {
      score += increment;
    }
  });
  matchText(definition.displayName, normalizedQuery, {
    contains: 60,
    exact: 90,
    field: "displayName",
    matchedOn,
    prefix: 75,
    updateScore: (increment) => {
      score += increment;
    }
  });
  matchText(definition.toolId, normalizedQuery, {
    contains: 70,
    exact: 98,
    field: "toolId",
    matchedOn,
    prefix: 82,
    updateScore: (increment) => {
      score += increment;
    }
  });
  matchText(definition.description, normalizedQuery, {
    contains: 35,
    exact: 0,
    field: "description",
    matchedOn,
    prefix: 0,
    updateScore: (increment) => {
      score += increment;
    }
  });
  matchText(definition.usageGuidance, normalizedQuery, {
    contains: 32,
    exact: 0,
    field: "usageGuidance",
    matchedOn,
    prefix: 0,
    updateScore: (increment) => {
      score += increment;
    }
  });
  matchText(definition.descriptor.purpose, normalizedQuery, {
    contains: 40,
    exact: 0,
    field: "descriptor.purpose",
    matchedOn,
    prefix: 0,
    updateScore: (increment) => {
      score += increment;
    }
  });

  for (const item of definition.descriptor.whenToUse) {
    matchText(item, normalizedQuery, {
      contains: 32,
      exact: 0,
      field: "descriptor.whenToUse",
      matchedOn,
      prefix: 0,
      updateScore: (increment) => {
        score += increment;
      }
    });
  }

  for (const item of definition.descriptor.whenNotToUse) {
    matchText(item, normalizedQuery, {
      contains: 25,
      exact: 0,
      field: "descriptor.whenNotToUse",
      matchedOn,
      prefix: 0,
      updateScore: (increment) => {
        score += increment;
      }
    });
  }

  for (const alias of definition.aliases) {
    matchText(alias, normalizedQuery, {
      contains: 55,
      exact: 92,
      field: "aliases",
      matchedOn,
      prefix: 70,
      updateScore: (increment) => {
        score += increment;
      }
    });
  }

  for (const tag of definition.searchTags) {
    matchText(tag, normalizedQuery, {
      contains: 50,
      exact: 85,
      field: "searchTags",
      matchedOn,
      prefix: 65,
      updateScore: (increment) => {
        score += increment;
      }
    });
  }

  if (definition.source.serverName) {
    matchText(definition.source.serverName, normalizedQuery, {
      contains: 40,
      exact: 60,
      field: "source.serverName",
      matchedOn,
      prefix: 55,
      updateScore: (increment) => {
        score += increment;
      }
    });
  }

  if (definition.annotations.title) {
    matchText(definition.annotations.title, normalizedQuery, {
      contains: 42,
      exact: 75,
      field: "annotations.title",
      matchedOn,
      prefix: 58,
      updateScore: (increment) => {
        score += increment;
      }
    });
  }

  if (definition.kind.toLowerCase().includes(normalizedQuery)) {
    addMatch("kind", 20);
  }
  if (definition.approvalMode.toLowerCase().includes(normalizedQuery)) {
    addMatch("approvalMode", 18);
  }
  if (definition.sideEffects.some((sideEffect) => sideEffect.toLowerCase().includes(normalizedQuery))) {
    addMatch("sideEffects", 18);
  }
  if (definition.execution.inputMode.toLowerCase().includes(normalizedQuery)) {
    addMatch("execution.inputMode", 15);
  }
  if (definition.execution.taskSupport.toLowerCase().includes(normalizedQuery)) {
    addMatch("execution.taskSupport", 15);
  }
  if (definition.source.kind.toLowerCase().includes(normalizedQuery)) {
    addMatch("source.kind", 15);
  }

  if (score === 0) {
    return null;
  }

  return {
    definition,
    matchedOn,
    score
  };
}

function matchText(
  value: string,
  normalizedQuery: string,
  options: {
    contains: number;
    exact: number;
    field: string;
    matchedOn: string[];
    prefix: number;
    updateScore: (increment: number) => void;
  }
) {
  const normalizedValue = value.toLowerCase();
  let increment = 0;

  if (options.exact > 0 && normalizedValue === normalizedQuery) {
    increment = options.exact;
  } else if (options.prefix > 0 && normalizedValue.startsWith(normalizedQuery)) {
    increment = options.prefix;
  } else if (options.contains > 0 && normalizedValue.includes(normalizedQuery)) {
    increment = options.contains;
  }

  if (increment === 0) {
    return;
  }

  options.updateScore(increment);
  if (!options.matchedOn.includes(options.field)) {
    options.matchedOn.push(options.field);
  }
}

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase();
}
