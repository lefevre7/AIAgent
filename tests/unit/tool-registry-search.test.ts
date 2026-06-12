import { describe, expect, test } from "vitest";

import { WorkspaceMutationEngine, createDefaultToolRegistry } from "@/core";

function registry() {
  return createDefaultToolRegistry({ workspaceEngine: new WorkspaceMutationEngine({ workspaceRoot: "/tmp" }) });
}

describe("tool registry lookups and search scoring", () => {
  test("resolves definitions by name, invocation name, and alias", () => {
    const reg = registry();
    expect(reg.getDefinition("think")?.invocationName).toBe("think");
    expect(reg.getDefinition("read_file")?.invocationName).toBe("read_file");
    // read_file exposes a view_file alias.
    expect(reg.getDefinition("view_file")?.invocationName).toBe("read_file");
    expect(reg.getDefinition("definitely_not_a_tool")).toBeNull();
  });

  test("ranks exact, prefix, and substring query matches", () => {
    const reg = registry();
    const exact = reg.searchDefinitions({ limit: 10, query: "think" });
    expect(exact[0]?.definition.invocationName).toBe("think");
    expect(exact[0]?.matchedOn.length).toBeGreaterThan(0);

    const prefix = reg.searchDefinitions({ limit: 10, query: "read" });
    expect(prefix.some((match) => match.definition.invocationName === "read_file")).toBe(true);

    const substring = reg.searchDefinitions({ limit: 10, query: "grep" });
    expect(substring.some((match) => match.definition.invocationName === "grep_files")).toBe(true);
  });

  test("returns everything (score 1) for an empty query and respects the limit", () => {
    const reg = registry();
    const all = reg.searchDefinitions({ limit: 3, query: "" });
    expect(all).toHaveLength(3);
    expect(all.every((match) => match.score >= 1)).toBe(true);
  });

  test("applies kind, approval-mode, and side-effect filters", () => {
    const reg = registry();
    const builtInOnly = reg.searchDefinitions({ kinds: ["built_in"], limit: 50, query: "" });
    expect(builtInOnly.length).toBeGreaterThan(0);
    expect(builtInOnly.every((match) => match.definition.kind === "built_in")).toBe(true);

    const writers = reg.searchDefinitions({ limit: 50, query: "", sideEffects: ["workspace_write"] });
    expect(writers.every((match) => match.definition.sideEffects.includes("workspace_write"))).toBe(true);

    const byApproval = reg.searchDefinitions({ approvalModes: ["always"], limit: 50, query: "" });
    expect(byApproval.every((match) => match.definition.approvalMode === "always")).toBe(true);
  });

  test("lists deduplicated definitions sorted by display name", () => {
    const reg = registry();
    const defs = reg.listDefinitions();
    expect(defs.length).toBeGreaterThan(1);
    const names = defs.map((definition) => definition.displayName);
    expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right)));
  });
});
