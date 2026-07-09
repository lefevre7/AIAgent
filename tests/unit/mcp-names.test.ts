import { describe, expect, test } from "vitest";

import { disambiguateInvocationName, sanitizeMcpInvocationName } from "@/core";

describe("sanitizeMcpInvocationName", () => {
  test("builds a stable mcp_<server>_<tool> slug within 64 chars", () => {
    // Hyphens are preserved (allowed in invocation names); other punctuation
    // (e.g. ".") collapses to "_".
    expect(sanitizeMcpInvocationName("context7", "resolve-library-id")).toBe(
      "mcp_context7_resolve-library-id"
    );
    expect(sanitizeMcpInvocationName("docs", "docs.lookup")).toBe(
      "mcp_docs_docs_lookup"
    );
  });

  test("hashes over-long names deterministically and keeps distinct inputs distinct", () => {
    const longTool = "t".repeat(80);
    const first = sanitizeMcpInvocationName("server", longTool);
    const second = sanitizeMcpInvocationName("server", longTool);

    // Deterministic for the same input.
    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(first.startsWith("mcp_")).toBe(true);

    // Two long names sharing a truncated prefix must not collapse to one name —
    // that is the entire reason the hash suffix exists.
    const other = sanitizeMcpInvocationName("server", `${"t".repeat(79)}z`);
    expect(other.length).toBeLessThanOrEqual(64);
    expect(other).not.toBe(first);
  });
});

describe("disambiguateInvocationName", () => {
  test("returns the base name the first time and suffixes later collisions", () => {
    const used = new Set<string>();
    expect(disambiguateInvocationName("mcp_a_tool", used)).toBe("mcp_a_tool");
    expect(disambiguateInvocationName("mcp_a_tool", used)).toBe("mcp_a_tool-2");
    expect(disambiguateInvocationName("mcp_a_tool", used)).toBe("mcp_a_tool-3");
    // A different base is unaffected.
    expect(disambiguateInvocationName("mcp_b_tool", used)).toBe("mcp_b_tool");
  });

  test("keeps the suffixed name within the 64-char cap", () => {
    const used = new Set<string>(["a".repeat(64)]);
    const result = disambiguateInvocationName("a".repeat(64), used);
    expect(result.length).toBe(64);
    expect(result.endsWith("-2")).toBe(true);
  });
});
