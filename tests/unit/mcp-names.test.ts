import { describe, expect, test } from "vitest";

import { buildMcpCapabilityId, entityIdSchema, toMcpIdSegment } from "@/core";

describe("toMcpIdSegment", () => {
  test("keeps a name that already fits an id", () => {
    expect(toMcpIdSegment("docs")).toBe("docs");
    expect(toMcpIdSegment("web.search_v2:beta-1")).toBe("web.search_v2:beta-1");
  });

  test("slugs any other name, with a hash that keeps names that slug alike apart", () => {
    const spaced = toMcpIdSegment("brave search");
    expect(spaced).toMatch(/^brave-search-[0-9a-f]{8}$/u);
    expect(toMcpIdSegment("brave search")).toBe(spaced);
    expect(toMcpIdSegment("brave  search")).not.toBe(spaced);
    expect(toMcpIdSegment("@playwright/mcp")).toMatch(/^playwright-mcp-[0-9a-f]{8}$/u);
    expect(toMcpIdSegment("🚀")).toMatch(/^[0-9a-f]{8}$/u);
  });

  test("builds capability ids that always satisfy the id schema", () => {
    const names = [
      ["brave search", "web search"],
      ["@playwright/mcp", "browser_navigate"],
      ["docs", "file:///Users/me/notes/a b.md"],
      ["x".repeat(128), "y".repeat(300)]
    ] as const;
    for (const [server, name] of names) {
      expect(entityIdSchema.safeParse(buildMcpCapabilityId("resource-template", server, name)).success).toBe(true);
    }
    expect(buildMcpCapabilityId("tool", "docs", "lookup")).toBe("mcp.tool.docs.lookup");
  });
});
