import { describe, expect, test } from "vitest";

import { MCPCapabilityCatalog, type MCPCapability } from "@/core";

function toolCap(params: {
  name: string;
  serverName: string;
  tags?: string[];
  displayName?: string;
}): MCPCapability {
  return {
    access: "model_and_api",
    annotations: {},
    displayName: params.displayName ?? params.name,
    execution: {},
    id: `mcp.tool.${params.serverName}.${params.name}`,
    inputSchema: {},
    invocationName: `mcp_${params.serverName}_${params.name}`,
    kind: "tool",
    metadata: {},
    name: params.name,
    rawName: params.name,
    serverName: params.serverName,
    tags: params.tags ?? []
  } as MCPCapability;
}

describe("MCPCapabilityCatalog.search", () => {
  test("scores tags once at their best tier instead of accumulating per tag", () => {
    const exactName = toolCap({ name: "search", serverName: "a", tags: [] });
    const tagHeavy = toolCap({
      displayName: "Other",
      name: "other",
      serverName: "b",
      tags: ["search", "websearch", "research"]
    });
    const catalog = new MCPCapabilityCatalog([exactName, tagHeavy]);

    const matches = catalog.search({ limit: 10, query: "search" });
    const tagHeavyMatch = matches.find((m) => m.capability.name === "other");

    // Three tags contain "search"; the old accumulating scorer would give
    // 80 + 55 + 55 = 190 and let it outrank an exact name match (95). The fix
    // caps the tag contribution to a single best-tier add (80).
    expect(tagHeavyMatch?.score).toBe(80);
    // The exact name match therefore ranks first.
    expect(matches[0]?.capability.name).toBe("search");
    expect(matches[0]!.score).toBeGreaterThan(tagHeavyMatch!.score);
  });

  test("filters by serverNames", () => {
    const catalog = new MCPCapabilityCatalog([
      toolCap({ name: "search", serverName: "a" }),
      toolCap({ name: "search", serverName: "b" })
    ]);

    const matches = catalog.search({
      limit: 10,
      query: "search",
      serverNames: ["a"]
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.capability.serverName).toBe("a");
  });

  test("returns every capability with score 1 for an empty query (browse mode)", () => {
    const catalog = new MCPCapabilityCatalog([
      toolCap({ name: "search", serverName: "a" }),
      toolCap({ name: "lookup", serverName: "b" })
    ]);

    const matches = catalog.search({ limit: 10 });
    expect(matches).toHaveLength(2);
    expect(matches.every((m) => m.score === 1)).toBe(true);
  });
});
