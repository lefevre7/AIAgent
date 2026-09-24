import { describe, expect, test } from "vitest";

import { collectPaginated } from "@/core/mcp";

// A misbehaving or malicious connected MCP server can return a nextCursor
// forever (or cycle through a repeating set of cursors), and refresh()
// serializes all server enumeration, so an unbounded loop here would hang
// every other configured server behind this one indefinitely.
describe("collectPaginated", () => {
  test("collects every page and stops once nextCursor is absent", async () => {
    const pages = [
      { items: ["a", "b"], nextCursor: "cursor-1" },
      { items: ["c"], nextCursor: "cursor-2" },
      { items: ["d"] }
    ];
    let calls = 0;
    const items = await collectPaginated(async () => {
      const page = pages[calls];
      calls += 1;
      return page!;
    }, "items");

    expect(items).toEqual(["a", "b", "c", "d"]);
    expect(calls).toBe(3);
  });

  test("stops instead of hanging forever when a server repeats the same cursor", async () => {
    let calls = 0;
    const items = await collectPaginated(async () => {
      calls += 1;
      return { items: [`page-${calls}`], nextCursor: "stuck-cursor" };
    }, "items");

    // Exactly two calls: the first sees "stuck-cursor" for the first time and
    // continues, the second sees it repeated and stops.
    expect(calls).toBe(2);
    expect(items).toEqual(["page-1", "page-2"]);
  });

  test("stops after a bounded number of pages when cursors keep changing but never end", async () => {
    let calls = 0;
    const items = await collectPaginated(async () => {
      calls += 1;
      return { items: [`page-${calls}`], nextCursor: `cursor-${calls}` };
    }, "items");

    expect(calls).toBeLessThanOrEqual(1000);
    expect(items).toHaveLength(calls);
  }, 15_000);
});
