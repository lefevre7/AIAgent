import { describe, expect, test, vi } from "vitest";

import { FieldSearchRanker, searchToolDefinitions, tokenizeForSearch, type ToolDefinition } from "@/core";

function tool(name: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    aliases: [],
    annotations: { meta: {}, title: name },
    approvalMode: "never",
    descriptor: { examples: [], purpose: `The ${name} tool.`, whenNotToUse: [], whenToUse: [] },
    description: `The ${name} tool.`,
    displayName: name,
    execution: { inputMode: "json", resumable: false, taskSupport: "forbidden" },
    idempotent: true,
    inputSchema: { properties: {}, type: "object" },
    invocationName: name,
    kind: "built_in",
    metadata: {},
    name,
    outputKind: "json",
    retryable: false,
    searchTags: [],
    sideEffects: ["none"],
    source: { displayName: "Test", kind: "built_in" },
    streamingMode: "none",
    toolId: `tool.test.${name}`,
    usageGuidance: "",
    version: "1.0.0",
    ...overrides
  };
}

const catalog = [
  tool("read_file", { description: "Read a file from the workspace.", searchTags: ["files"] }),
  tool("write_file", { description: "Write a file to the workspace.", searchTags: ["files"] }),
  tool("browser_screenshot", { description: "Capture a screenshot of the browser page.", kind: "browser" }),
  tool("mcp_jira_create_ticket", {
    description: "Create an issue.",
    inputSchema: { properties: { assignee: { type: "string" }, summary: { type: "string" } }, type: "object" },
    kind: "mcp",
    source: { displayName: "jira", kind: "mcp", serverName: "jira" }
  }),
  tool("gh_pr_list", {
    description: "List pull requests.",
    kind: "mcp",
    source: { displayName: "gh", kind: "mcp", serverName: "gh" }
  }),
  tool("apply_patch", { description: "Apply a patch to the workspace." }),
  tool("buscar_documentos", { description: "Búsqueda de documentos en la base de conocimiento." }),
  tool("think", { aliases: ["reflect"], description: "Record a private thought." })
];

// The servers' own instructions come from the registry, once per server, not
// from each tool's definition.
const serverInstructions = (serverName: string) =>
  serverName === "jira" ? "Tracks sprint work items for the release team." : undefined;

function names(query: string, limit = 5): string[] {
  return searchToolDefinitions(catalog, { limit, query }, { serverInstructions }).map(
    (match) => match.definition.invocationName
  );
}

describe("BM25 tool search", () => {
  test("splits names the way people write them, and drops plurals and connectives", () => {
    expect(tokenizeForSearch("readFile read_file read-file")).toEqual(["read", "file", "read", "file", "read", "file"]);
    expect(tokenizeForSearch("HTTPServer")).toEqual(["http", "server"]);
    expect(tokenizeForSearch("screenshots of the pages")).toEqual(["screenshot", "page"]);
    expect(tokenizeForSearch("patches queries classes boxes status")).toEqual([
      "patch",
      "query",
      "class",
      "box",
      "status"
    ]);
    expect(tokenizeForSearch("to a of")).toEqual([]);
    // Two-character names are words; letters outside ASCII are too.
    expect(tokenizeForSearch("gh s3 búsqueda 検索")).toEqual(["gh", "s3", "búsqueda", "検索"]);
  });

  test("a camelCase query, a two-character name, a plural in -es, and a non-ASCII word all find their tool", () => {
    // Each used to find nothing: the query was lowercased before its
    // camelCase split, words under three letters and outside ASCII were
    // dropped, and only a trailing "s" was taken off ("patches" → "patche").
    expect(names("readFile")[0]).toBe("read_file");
    expect(names("gh")[0]).toBe("gh_pr_list");
    expect(names("patches")[0]).toBe("apply_patch");
    expect(names("búsqueda")[0]).toBe("buscar_documentos");
  });

  test("a server's instructions do not lengthen its tools, so good instructions cost its tools nothing", () => {
    const twin = (serverName: string) =>
      tool(`${serverName}_lookup`, {
        description: "Look up a record.",
        kind: "mcp",
        source: { displayName: serverName, kind: "mcp", serverName }
      });
    const long = "Use this server for the billing ledger. ".repeat(40);
    const scores = searchToolDefinitions(
      [twin("verbose"), twin("terse")],
      { limit: 2, query: "record" },
      { serverInstructions: (serverName) => (serverName === "verbose" ? long : undefined) }
    ).map((match) => match.score);
    expect(scores[0]).toBe(scores[1]);
  });

  test("indexes each tool once, not on every search", () => {
    const index = vi.spyOn(FieldSearchRanker.prototype, "index");
    try {
      names("file");
      const first = index.mock.calls.length;
      names("screenshot");
      names("sprint work");
      expect(index.mock.calls.length).toBe(first);
    } finally {
      index.mockRestore();
    }
  });

  test("weighs a rare word over a common one", () => {
    // "file" is in two tools, "screenshot" in one: a query with both prefers the rare hit.
    expect(names("file screenshot")[0]).toBe("browser_screenshot");
  });

  test("an exact name or alias comes first", () => {
    expect(names("think")[0]).toBe("think");
    expect(names("reflect")[0]).toBe("think");
  });

  test("finds a tool by its MCP server's instructions and by its argument names", () => {
    expect(names("sprint work items")[0]).toBe("mcp_jira_create_ticket");
    expect(names("assignee")[0]).toBe("mcp_jira_create_ticket");
    const match = searchToolDefinitions(catalog, { limit: 1, query: "sprint" }, { serverInstructions })[0];
    expect(match?.matchedOn).toContain("serverInstructions");
    // Without the registry's instructions, nothing on the tool says "sprint".
    expect(searchToolDefinitions(catalog, { limit: 1, query: "sprint" })).toEqual([]);
  });

  test("a word of four or more letters that begins a longer one still counts", () => {
    expect(names("brows")[0]).toBe("browser_screenshot");
    expect(names("screensh")[0]).toBe("browser_screenshot");
    // Three letters begin too many words to mean anything.
    expect(names("bro")).toEqual([]);
  });

  test("filters apply before ranking, and an empty query lists by display name", () => {
    expect(searchToolDefinitions(catalog, { kinds: ["mcp"], limit: 5, query: "file" })).toEqual([]);
    expect(searchToolDefinitions(catalog, { limit: 10 }).map((match) => match.definition.displayName)).toEqual([
      "apply_patch",
      "browser_screenshot",
      "buscar_documentos",
      "gh_pr_list",
      "mcp_jira_create_ticket",
      "read_file",
      "think",
      "write_file"
    ]);
  });
});
