import { describe, expect, test } from "vitest";

import { toolDefinitionSchema, ToolRegistryBuilder, type RuntimeTool } from "@/core";

describe("tool registry", () => {
  test("resolves tools by invocation name, canonical name, alias, and tool id", () => {
    const registry = new ToolRegistryBuilder()
      .register(
        createRuntimeTool({
          aliases: ["resolve_library_id"],
          displayName: "Resolve Library Id",
          invocationName: "context7_resolve_library_id",
          name: "context7.resolve-library-id",
          searchTags: ["context7", "libraries"],
          toolId: "tool.mcp.context7.resolve_library_id"
        })
      )
      .build();

    expect(registry.getDefinition("context7_resolve_library_id")?.toolId).toBe("tool.mcp.context7.resolve_library_id");
    expect(registry.getDefinition("context7.resolve-library-id")?.toolId).toBe("tool.mcp.context7.resolve_library_id");
    expect(registry.getDefinition("resolve_library_id")?.toolId).toBe("tool.mcp.context7.resolve_library_id");
    expect(registry.getDefinition("tool.mcp.context7.resolve_library_id")?.toolId).toBe(
      "tool.mcp.context7.resolve_library_id"
    );
  });

  test("ranks search results using invocation names and descriptor text while honoring filters", () => {
    const registry = new ToolRegistryBuilder()
      .register(
        createRuntimeTool({
          approvalMode: "never",
          displayName: "Read File",
          invocationName: "read_file",
          name: "read_file",
          searchTags: ["files", "workspace"],
          sideEffects: ["workspace_read"],
          toolId: "tool.builtin.read_file"
        })
      )
      .register(
        createRuntimeTool({
          approvalMode: "ask",
          descriptor: {
            approvalNotes: "Approval is required because the tool can modify files.",
            examples: ["Write a new file to the workspace."],
            purpose: "Write file contents to the workspace.",
            sideEffectSummary: "Changes workspace files.",
            whenNotToUse: ["Do not use when a read-only inspection is enough."],
            whenToUse: ["Use when you need to create or overwrite a file."]
          },
          displayName: "Write File",
          invocationName: "write_file",
          name: "workspace.write-file",
          searchTags: ["files", "write"],
          sideEffects: ["workspace_write"],
          toolId: "tool.builtin.write_file"
        })
      )
      .build();

    const writeMatches = registry.searchDefinitions({
      limit: 5,
      query: "write_file"
    });
    expect(writeMatches[0]?.definition.toolId).toBe("tool.builtin.write_file");
    expect(writeMatches[0]?.matchedOn).toContain("invocationName");

    const readOnlyMatches = registry.searchDefinitions({
      limit: 5,
      query: "file",
      sideEffects: ["workspace_read"]
    });
    expect(readOnlyMatches).toHaveLength(1);
    expect(readOnlyMatches[0]?.definition.toolId).toBe("tool.builtin.read_file");
  });
});

function createRuntimeTool(overrides: Partial<Parameters<typeof toolDefinitionSchema.parse>[0]> = {}): RuntimeTool {
  const definition = toolDefinitionSchema.parse({
    aliases: [],
    annotations: {
      meta: {},
      readOnlyHint: true,
      title: "Fixture Tool"
    },
    approvalMode: "never",
    descriptor: {
      approvalNotes: "No operator approval is required.",
      examples: ["Use in tests."],
      purpose: "Exercise the tool registry in tests.",
      sideEffectSummary: "No side effects.",
      whenNotToUse: ["Do not use outside tests."],
      whenToUse: ["Use in registry and runtime tests."]
    },
    description: "Fixture tool for registry tests.",
    displayName: "Fixture Tool",
    execution: {
      inputMode: "json",
      resumable: false,
      taskSupport: "forbidden"
    },
    idempotent: true,
    inputSchema: {
      type: "object"
    },
    invocationName: "fixture_tool",
    kind: "built_in",
    metadata: {},
    name: "fixture_tool",
    outputKind: "json",
    outputSchema: {
      type: "object"
    },
    retryable: true,
    searchTags: [],
    sideEffects: ["none"],
    source: {
      displayName: "Fixture Tools",
      kind: "built_in"
    },
    streamingMode: "none",
    toolId: "tool.fixture.default",
    usageGuidance: "Use for tests.",
    version: "1.0.0",
    ...overrides
  });

  return {
    definition,
    async execute() {
      return {
        result: {
          ok: true
        }
      };
    }
  };
}
