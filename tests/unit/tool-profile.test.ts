import { describe, expect, test } from "vitest";

import { resolveVisibleToolDefinitions, type ToolDefinition } from "@/core";

function makeTool(invocationName: string): ToolDefinition {
  return {
    aliases: [],
    annotations: { meta: {}, readOnlyHint: true, title: invocationName },
    approvalMode: "never",
    descriptor: {
      approvalNotes: "Test fixture.",
      examples: ["x"],
      purpose: "Test fixture.",
      sideEffectSummary: "None.",
      whenNotToUse: [],
      whenToUse: ["test"]
    },
    description: `Tool ${invocationName}.`,
    displayName: invocationName,
    execution: {
      inputMode: "json",
      resumable: false,
      taskSupport: "forbidden"
    },
    idempotent: true,
    inputSchema: { type: "object" },
    invocationName,
    kind: "built_in",
    metadata: {},
    name: invocationName,
    outputKind: "json",
    retryable: true,
    searchTags: [invocationName],
    sideEffects: ["none"],
    source: { displayName: "Built-in Tools", kind: "built_in" },
    streamingMode: "none",
    toolId: `tool.builtin.${invocationName}`,
    usageGuidance: "test",
    version: "1.0.0"
  };
}

const registry = {
  listDefinitions: (): ToolDefinition[] => [
    makeTool("read_file"),
    makeTool("mcp_status"),
    makeTool("memory_search")
  ]
};
const toolsConfig = { exclude: [], include: [], profile: "lean" as const };

describe("resolveVisibleToolDefinitions", () => {
  test("lean profile hides non-core tools like mcp_status by default", () => {
    const visible = resolveVisibleToolDefinitions({
      registry,
      toolsConfig
    }).map((tool) => tool.invocationName);
    expect(visible).toContain("read_file");
    expect(visible).not.toContain("mcp_status");
    expect(visible).not.toContain("memory_search");
  });

  test("alwaysInclude surfaces mcp_status under the lean profile without exposing everything", () => {
    const visible = resolveVisibleToolDefinitions({
      alwaysInclude: ["mcp_status"],
      registry,
      toolsConfig
    }).map((tool) => tool.invocationName);
    expect(visible).toContain("read_file");
    expect(visible).toContain("mcp_status");
    expect(visible).not.toContain("memory_search");
  });

  test("full profile ignores alwaysInclude and returns everything not excluded", () => {
    const visible = resolveVisibleToolDefinitions({
      registry,
      toolsConfig: { exclude: ["memory_search"], include: [], profile: "full" }
    }).map((tool) => tool.invocationName);
    expect(visible).toEqual(
      expect.arrayContaining(["read_file", "mcp_status"])
    );
    expect(visible).not.toContain("memory_search");
  });
});
