import { describe, expect, test } from "vitest";

import { MCPWebSearchService } from "@/core/research/search";
import type { MCPManager } from "@/core/mcp";

function searchCapability() {
  return {
    annotations: {},
    description: "Search the web for documentation",
    displayName: "Web Search",
    inputSchema: { properties: { limit: { type: "integer" }, query: { type: "string" } }, type: "object" },
    invocationName: "mcp_brave_web_search",
    kind: "tool" as const,
    name: "web_search",
    rawName: "brave.web_search",
    serverName: "brave",
    tags: ["search", "web"]
  };
}

function fakeManager(options: { capabilities?: unknown[]; callResult?: unknown } = {}): MCPManager {
  return {
    callTool: async () =>
      options.callResult ?? {
        content: [{ text: "Result body", type: "text" }],
        structuredContent: { results: [{ snippet: "snippet", title: "Example", url: "https://example.com" }] }
      },
    getToolCapabilities: () => options.capabilities ?? [searchCapability()]
  } as unknown as MCPManager;
}

describe("MCPWebSearchService", () => {
  test("routes a query to the highest-scoring MCP search tool", async () => {
    const service = new MCPWebSearchService({ mcpManager: fakeManager() });
    const result = await service.search("typescript esm", { limit: 3 });
    expect(result.query).toBe("typescript esm");
    expect(result.provider.toolName).toBe("brave.web_search");
    expect(result.rawText).toContain("Result body");
  });

  test("rejects an empty query", async () => {
    const service = new MCPWebSearchService({ mcpManager: fakeManager() });
    await expect(service.search("   ")).rejects.toMatchObject({ code: "web_search_invalid_query" });
  });

  test("reports when no search-capable MCP tool is connected", async () => {
    const service = new MCPWebSearchService({ mcpManager: fakeManager({ capabilities: [] }) });
    await expect(service.search("anything")).rejects.toMatchObject({ code: "web_search_no_backend" });
  });

  test("ignores tools that do not expose a query field", async () => {
    const noQuery = { ...searchCapability(), inputSchema: { properties: { other: { type: "string" } }, type: "object" } };
    const service = new MCPWebSearchService({ mcpManager: fakeManager({ capabilities: [noQuery] }) });
    await expect(service.search("anything")).rejects.toMatchObject({ code: "web_search_no_backend" });
  });
});
