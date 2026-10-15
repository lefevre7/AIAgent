import type { ToolDefinition, ToolRegistry, ToolSearchMatch, ToolSearchQuery } from "@/core/contracts";

import type { RuntimeTool } from "@/core/tools/runtime";
import { searchToolDefinitions } from "@/core/tools/search";

export interface ExecutableToolRegistry extends ToolRegistry {
  /** A connected MCP server's usage notes, for the registry that holds its tools. */
  getServerInstructions?(serverName: string): string | undefined;
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

    // resolveToolId (below) treats invocationNames, names, and aliases as one
    // shared lookup space, so a conflict check that only looks at a candidate
    // key's own keyspace can miss a real collision: a later tool's alias or
    // name could silently become permanently unreachable behind an earlier
    // tool's invocationName (or vice versa), with no warning at registration.
    // Reusing resolveToolId here — the same function callers actually go
    // through — keeps "would this collide" and "what does this resolve to"
    // from drifting apart again.
    const conflict = this.entries.has(toolId)
      ? `Tool id "${toolId}" is already registered.`
      : resolveToolId(invocationName, this.entries, this.invocationNames, this.names, this.aliases)
        ? `Tool invocation name "${invocationName}" is already registered.`
        : resolveToolId(tool.definition.name, this.entries, this.invocationNames, this.names, this.aliases)
          ? `Tool name "${tool.definition.name}" conflicts with an existing tool, invocation name, or alias.`
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
      if (resolveToolId(alias, this.entries, this.invocationNames, this.names, this.aliases)) {
        if (onDuplicate === "skip") {
          console.warn(`Skipping conflicting tool alias "${alias}".`);
          continue;
        }
        throw new Error(`Tool alias "${alias}" conflicts with an existing tool, invocation name, or alias.`);
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
    return searchToolDefinitions(this.listDefinitions(), query);
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

  getServerInstructions(serverName: string): string | undefined {
    for (const registry of this.registries) {
      const instructions = registry.getServerInstructions?.(serverName);
      if (instructions) {
        return instructions;
      }
    }
    return undefined;
  }

  // Ranked over every registry at once: BM25 weighs a word by how rare it is
  // across the whole catalog, so scores from separate registries would not
  // compare.
  searchDefinitions(query: ToolSearchQuery): ToolSearchMatch[] {
    return searchToolDefinitions(this.listDefinitions(), query, {
      serverInstructions: (serverName) => this.getServerInstructions(serverName)
    });
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

function normalizeLookupKey(value: string): string {
  return value.trim().toLowerCase();
}
