import { describe, expect, test } from "vitest";

import { MCPCapabilityCatalog, type MCPCapability } from "@/core";

function toolCap(params: { name: string; serverName: string; tags?: string[]; displayName?: string }): MCPCapability {
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
  test("an exact name outranks a capability whose tags merely repeat the word", () => {
    const exactName = toolCap({ name: "search", serverName: "a", tags: [] });
    const tagHeavy = toolCap({
      displayName: "Other",
      name: "other",
      serverName: "b",
      tags: ["search", "web-search", "research"]
    });
    const catalog = new MCPCapabilityCatalog([exactName, tagHeavy]);

    const matches = catalog.search({ limit: 10, query: "search" });

    expect(matches.map((match) => match.capability.name)).toEqual(["search", "other"]);
    expect(matches[0]!.score).toBeGreaterThan(matches[1]!.score);
  });

  test("ranks with tool_search's BM25: a rare word over a common one, and a camelCase or plural query", () => {
    // The tier scorer it replaced matched the whole query as one substring, so
    // "file screenshot" found nothing and the order differed from tool_search.
    const catalog = new MCPCapabilityCatalog([
      toolCap({ displayName: "Read File", name: "read_file", serverName: "fs", tags: ["files"] }),
      toolCap({ displayName: "Write File", name: "write_file", serverName: "fs", tags: ["files"] }),
      toolCap({ displayName: "Take Screenshot", name: "take_screenshot", serverName: "browser" })
    ]);

    expect(catalog.search({ limit: 3, query: "file screenshot" })[0]?.capability.name).toBe("take_screenshot");
    expect(catalog.search({ limit: 3, query: "readFile" })[0]?.capability.name).toBe("read_file");
    expect(catalog.search({ limit: 3, query: "screenshots" })[0]?.capability.name).toBe("take_screenshot");
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
