import { describe, expect, test } from "vitest";

import {
  APPROVAL_BINDING_METADATA_KEY,
  DEFAULT_APPROVAL_SETTINGS,
  ToolRuntime,
  createDefaultToolRegistry,
  createDefaultToolRuntime,
  createToolApprovalDecider,
  readApprovalTargets,
  sanitizeMcpInvocationName,
  sessionRecordSchema,
  toolCallRecordSchema,
  turnRecordSchema,
  withMcpTrustRules,
  type MCPManager
} from "@/core";

describe("web tools", () => {
  test("web_fetch fetches and extracts markdown content with query snippets", async () => {
    const runtime = createDefaultToolRuntime({
      fetchImpl: async () =>
        new Response(
          `<!doctype html>
          <html>
            <head><title>Model Context Protocol</title></head>
            <body>
              <main>
                <h1>Model Context Protocol</h1>
                <p>MCP standardizes tool and resource integration.</p>
                <p>Use transport adapters to connect over stdio or HTTP.</p>
              </main>
            </body>
          </html>`,
          {
            headers: {
              "content-type": "text/html; charset=utf-8"
            },
            status: 200
          }
        )
    });

    const result = await runtime.execute(
      createToolCall({
        arguments: {
          query: "transport adapters",
          url: "https://example.com/mcp"
        },
        id: "tool-call.web.fetch.1",
        toolName: "web_fetch"
      }),
      {
        session: buildSession(),
        turn: buildTurn()
      }
    );

    expect(result.toolCall.status).toBe("succeeded");
    expect(result.toolCall.result).toMatchObject({
      finalUrl: "https://example.com/mcp",
      query: "transport adapters",
      queryMatchCount: 1,
      title: "Model Context Protocol"
    });
    expect(result.toolCall.result).toMatchObject({
      contentMarkdown: expect.stringContaining("# Model Context Protocol")
    });
    expect(result.resultMessage?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "markdown"
        })
      ])
    );
  });

  test("web_search runs a trusted server's search tool without asking and normalizes results", async () => {
    const search = createFakeSearchManager();
    const runtime = createRuntime(
      search.manager,
      withMcpTrustRules(DEFAULT_APPROVAL_SETTINGS, { search: { trust: "trusted" } })
    );

    const result = await runtime.execute(searchCall(), { session: buildSession(), turn: buildTurn() });

    expect(search.calls).toEqual([
      {
        arguments: { limit: 8, query: "latest aiagent docs" },
        context: { sessionId: "session.web.tools.1", toolCallId: "tool-call.web.search.1", turnId: "turn.web.tools.1" },
        invocationName: SEARCH_INVOCATION_NAME,
        serverName: "search"
      }
    ]);
    expect(result.toolCall.status).toBe("succeeded");
    expect(result.toolCall.result).toMatchObject({
      provider: {
        invocationName: SEARCH_INVOCATION_NAME,
        serverName: "search",
        toolName: "web.search"
      },
      query: "latest aiagent docs",
      results: [
        {
          snippet: "Docs for the local-first agent.",
          title: "AIAgent Docs",
          url: "https://example.com/docs"
        }
      ]
    });
  });

  // web_search used to skip approval entirely, which ran whatever connected MCP
  // tool happened to have a `query` field. It is now approved exactly as a
  // direct call to that tool.
  test("web_search asks before running an untrusted server's search tool, then runs the one approved", async () => {
    const search = createFakeSearchManager();
    const runtime = createRuntime(search.manager, DEFAULT_APPROVAL_SETTINGS);

    const pending = await runtime.execute(searchCall(), { session: buildSession(), turn: buildTurn() });

    expect(search.calls).toEqual([]);
    expect(pending.toolCall.status).toBe("awaiting_approval");
    expect(readApprovalTargets(pending.approvalRequest!)).toEqual(
      expect.arrayContaining([
        { kind: "mcp_tool", label: "Web Search", value: "search.web.search" },
        { kind: "mcp_server", label: "search", value: "search" }
      ])
    );
    expect(pending.toolCall.metadata[APPROVAL_BINDING_METADATA_KEY]).toEqual({
      invocationName: SEARCH_INVOCATION_NAME,
      rawName: "web.search",
      serverName: "search"
    });

    const approved = await runtime.executeApproved(pending.toolCall, { session: buildSession(), turn: buildTurn() });
    expect(approved.toolCall.status).toBe("succeeded");
    expect(search.calls.map((call) => call.serverName)).toEqual(["search"]);
  });

  test("an approved web_search refuses to run a different tool than the one approved", async () => {
    const search = createFakeSearchManager();
    const runtime = createRuntime(search.manager, DEFAULT_APPROVAL_SETTINGS);
    const pending = await runtime.execute(searchCall(), { session: buildSession(), turn: buildTurn() });

    // By the time the approval is resolved the approved server is gone and
    // another search tool would be the best match.
    search.setCapabilities([searchCapability({ serverName: "other" })]);
    const approved = await runtime.executeApproved(pending.toolCall, { session: buildSession(), turn: buildTurn() });

    expect(approved.toolCall.status).toBe("failed");
    expect(approved.toolCall.error?.code).toBe("web_search_backend_changed");
    expect(search.calls).toEqual([]);
  });

  test("a deny rule on the MCP server refuses web_search", async () => {
    const search = createFakeSearchManager();
    const runtime = createRuntime(search.manager, {
      ...DEFAULT_APPROVAL_SETTINGS,
      rules: [
        ...DEFAULT_APPROVAL_SETTINGS.rules,
        { id: "rule.deny.search", mode: "deny", pattern: "^search$", targetKind: "mcp_server" }
      ]
    });

    const result = await runtime.execute(searchCall(), { session: buildSession(), turn: buildTurn() });

    expect(result.toolCall.status).toBe("failed");
    expect(result.toolCall.error?.code).toBe("tool_execution_denied_by_policy");
    expect(search.calls).toEqual([]);
  });

  test("a deny rule on the search tool's own name refuses web_search", async () => {
    // The `tool` target a direct call to that MCP tool carries: a rule written
    // against the tool must not be avoidable by searching through web_search.
    const search = createFakeSearchManager();
    const runtime = createRuntime(search.manager, {
      ...DEFAULT_APPROVAL_SETTINGS,
      rules: [
        ...DEFAULT_APPROVAL_SETTINGS.rules,
        { id: "rule.deny.search-tool", mode: "deny", pattern: `^${SEARCH_INVOCATION_NAME}$`, targetKind: "tool" }
      ]
    });

    const result = await runtime.execute(searchCall(), { session: buildSession(), turn: buildTurn() });

    expect(result.toolCall.error).toMatchObject({
      code: "tool_execution_denied_by_policy",
      details: { matchedRuleId: "rule.deny.search-tool" }
    });
    expect(search.calls).toEqual([]);
  });

  test("a deny rule on one search server picks another the operator allows", async () => {
    const search = createFakeSearchManager();
    search.setCapabilities([searchCapability(), searchCapability({ serverName: "backup" })]);
    const runtime = createRuntime(
      search.manager,
      withMcpTrustRules(
        {
          ...DEFAULT_APPROVAL_SETTINGS,
          rules: [
            ...DEFAULT_APPROVAL_SETTINGS.rules,
            { id: "rule.deny.search", mode: "deny", pattern: "^search$", targetKind: "mcp_server" }
          ]
        },
        { backup: { trust: "trusted" } }
      )
    );

    const result = await runtime.execute(searchCall(), { session: buildSession(), turn: buildTurn() });

    expect(result.toolCall.status).toBe("succeeded");
    expect(search.calls.map((call) => call.serverName)).toEqual(["backup"]);
  });

  test("runs the search as part of the call, and reports a tool error as one", async () => {
    const search = createFakeSearchManager({ isError: true });
    const runtime = createRuntime(
      search.manager,
      withMcpTrustRules(DEFAULT_APPROVAL_SETTINGS, { search: { trust: "trusted" } })
    );

    const result = await runtime.execute(searchCall(), { session: buildSession(), turn: buildTurn() });

    // The session and turn reach the server's call, so a question it asks
    // goes to this session's operator.
    expect(search.calls[0]?.context).toEqual({
      sessionId: "session.web.tools.1",
      toolCallId: "tool-call.web.search.1",
      turnId: "turn.web.tools.1"
    });
    // It used to be parsed as an empty result set.
    expect(result.toolCall.error).toMatchObject({
      code: "web_search_backend_error",
      message: expect.stringContaining("quota exceeded for this API key")
    });
  });

  test("an approved search still runs its tool after a relist renames its invocation name", async () => {
    const search = createFakeSearchManager();
    const runtime = createRuntime(search.manager, DEFAULT_APPROVAL_SETTINGS);
    const pending = await runtime.execute(searchCall(), { session: buildSession(), turn: buildTurn() });

    // Another tool now slugs alike, and this one became "<name>-2".
    search.setCapabilities([{ ...searchCapability(), invocationName: `${SEARCH_INVOCATION_NAME}-2` }]);
    const approved = await runtime.executeApproved(pending.toolCall, { session: buildSession(), turn: buildTurn() });

    expect(approved.toolCall.status).toBe("succeeded");
    expect(search.calls.map((call) => call.invocationName)).toEqual([`${SEARCH_INVOCATION_NAME}-2`]);
  });

  test("web_search with no search backend fails without asking for approval", async () => {
    const search = createFakeSearchManager();
    search.setCapabilities([]);
    const runtime = createRuntime(search.manager, DEFAULT_APPROVAL_SETTINGS);

    const result = await runtime.execute(searchCall(), { session: buildSession(), turn: buildTurn() });

    expect(result.approvalRequest).toBeUndefined();
    expect(result.toolCall.status).toBe("failed");
    expect(result.toolCall.error?.code).toBe("web_search_no_backend");
  });

  // mcp_read_resource and mcp_read_resource_template never ask, but they reach
  // a server, so a deny rule on that server applies. They used to skip the
  // policy entirely.
  test("the resource readers never ask, but a deny rule on their server refuses them", async () => {
    const search = createFakeSearchManager();
    const calls = [
      createToolCall({
        arguments: { serverName: "search", uri: "file:///docs/guide.md" },
        id: "tool-call.mcp.read.1",
        toolId: "tool.builtin.mcp_read_resource",
        toolName: "mcp_read_resource"
      }),
      createToolCall({
        arguments: { serverName: "search", uriTemplate: "docs://guides/{name}", variables: { name: "intro" } },
        id: "tool-call.mcp.template.2",
        toolId: "tool.builtin.mcp_read_resource_template",
        toolName: "mcp_read_resource_template"
      })
    ];
    const denyingRuntime = createRuntime(search.manager, {
      ...DEFAULT_APPROVAL_SETTINGS,
      rules: [
        ...DEFAULT_APPROVAL_SETTINGS.rules,
        { id: "rule.deny.search", mode: "deny", pattern: "^search$", targetKind: "mcp_server" }
      ]
    });

    for (const call of calls) {
      const allowed = await createRuntime(search.manager, DEFAULT_APPROVAL_SETTINGS).execute(call, {
        session: buildSession(),
        turn: buildTurn()
      });
      expect(allowed.approvalRequest, call.toolName).toBeUndefined();
      expect(allowed.toolCall.status, call.toolName).toBe("succeeded");

      const denied = await denyingRuntime.execute(call, { session: buildSession(), turn: buildTurn() });
      expect(denied.toolCall.status, call.toolName).toBe("failed");
      expect(denied.toolCall.error?.code, call.toolName).toBe("tool_execution_denied_by_policy");
    }
  });

  test("a path deny rule covers the URI a resource template expands to", async () => {
    // mcp_read_resource's uri is a path target; building the same URI from a
    // template must not get around a rule on it.
    const search = createFakeSearchManager();
    const runtime = createRuntime(search.manager, {
      ...DEFAULT_APPROVAL_SETTINGS,
      rules: [
        ...DEFAULT_APPROVAL_SETTINGS.rules,
        { id: "rule.deny.secrets", mode: "deny", pattern: "^/secrets/", targetKind: "path" }
      ]
    });
    const templateCall = (uriTemplate: string) =>
      createToolCall({
        arguments: { serverName: "search", uriTemplate, variables: { name: "id_rsa" } },
        id: "tool-call.mcp.template.1",
        toolId: "tool.builtin.mcp_read_resource_template",
        toolName: "mcp_read_resource_template"
      });

    const denied = await runtime.execute(templateCall("file:///secrets/{name}"), {
      session: buildSession(),
      turn: buildTurn()
    });
    expect(denied.toolCall.error).toMatchObject({
      code: "tool_execution_denied_by_policy",
      details: { matchedRuleId: "rule.deny.secrets", targetValue: "/secrets/id_rsa" }
    });

    // Another scheme names no local file, so the path rule has nothing to match.
    const allowed = await runtime.execute(templateCall("docs://secrets/{name}"), {
      session: buildSession(),
      turn: buildTurn()
    });
    expect(allowed.toolCall.status).toBe("succeeded");
  });
});

const SEARCH_INVOCATION_NAME = sanitizeMcpInvocationName("search", "web.search");

function searchCapability(overrides: { serverName?: string } = {}) {
  const serverName = overrides.serverName ?? "search";
  return {
    access: "model_and_api" as const,
    annotations: {
      readOnlyHint: true
    },
    description: "Search the web for documents.",
    displayName: "Web Search",
    execution: {},
    id: `mcp.tool.${serverName}.web.search`,
    inputSchema: {
      properties: {
        limit: {
          type: "integer"
        },
        query: {
          type: "string"
        }
      },
      type: "object"
    },
    invocationName: sanitizeMcpInvocationName(serverName, "web.search"),
    kind: "tool" as const,
    metadata: {},
    name: "web.search",
    rawName: "web.search",
    serverName,
    tags: ["mcp", "search", "web"]
  };
}

function createFakeSearchManager(options: { isError?: boolean } = {}) {
  const calls: Array<{
    arguments: Record<string, unknown>;
    context?: Record<string, unknown>;
    invocationName: string;
    serverName: string;
  }> = [];
  let capabilities = [searchCapability()];
  const manager = {
    callTool: async (
      serverName: string,
      toolName: string,
      args: Record<string, unknown>,
      context?: Record<string, unknown>
    ) => {
      calls.push({ arguments: args, context, invocationName: toolName, serverName });
      if (options.isError) {
        return { content: [{ text: "quota exceeded for this API key", type: "text" }], isError: true };
      }
      return {
        content: [
          {
            text: "AIAgent docs — https://example.com/docs",
            type: "text"
          }
        ],
        structuredContent: {
          results: [
            {
              snippet: "Docs for the local-first agent.",
              title: "AIAgent Docs",
              url: "https://example.com/docs"
            }
          ]
        }
      };
    },
    getGeneration: () => 1,
    getToolCapabilities: () => capabilities,
    waitForStartup: async () => undefined,
    readResource: async (_serverName: string, uri: string) => ({ contents: [{ text: "# Guide", uri }], uri }),
    readResourceTemplate: async (_serverName: string, uriTemplate: string) => ({
      contents: [{ text: "# Template", uri: uriTemplate }],
      uri: uriTemplate
    }),
    searchCapabilities: () => []
  } as unknown as MCPManager;
  return {
    calls,
    manager,
    setCapabilities: (next: Array<ReturnType<typeof searchCapability>>) => {
      capabilities = next;
    }
  };
}

function createRuntime(mcpManager: MCPManager, settings: typeof DEFAULT_APPROVAL_SETTINGS) {
  return new ToolRuntime({
    approvalDecider: createToolApprovalDecider({ settings }),
    registry: createDefaultToolRegistry({ mcpManager })
  });
}

function searchCall() {
  return createToolCall({
    id: "tool-call.web.search.1",
    inputText: "latest aiagent docs",
    toolName: "web_search"
  });
}

function buildSession() {
  return sessionRecordSchema.parse({
    createdAt: "2026-03-27T12:00:00.000Z",
    cwd: "/workspace",
    goal: "Exercise web tool coverage",
    id: "session.web.tools.1",
    lastActiveAt: "2026-03-27T12:00:00.000Z",
    metadata: {},
    status: "running_model",
    tags: [],
    title: "Web Tool Session",
    updatedAt: "2026-03-27T12:00:00.000Z"
  });
}

function buildTurn() {
  return turnRecordSchema.parse({
    approvalRequestIds: [],
    executedToolCallIds: [],
    id: "turn.web.tools.1",
    inputMessageIds: [],
    metadata: {},
    outputMessageIds: [],
    requestedToolCallIds: [],
    sequence: 0,
    sessionId: "session.web.tools.1",
    startedAt: "2026-03-27T12:00:00.000Z",
    status: "running",
    trigger: "user"
  });
}

function createToolCall(overrides: Partial<Parameters<typeof toolCallRecordSchema.parse>[0]> = {}) {
  return toolCallRecordSchema.parse({
    arguments: {},
    id: "tool-call.web.tools.default",
    metadata: {},
    sessionId: "session.web.tools.1",
    startedAt: "2026-03-27T12:00:00.000Z",
    status: "pending",
    toolId: "tool.builtin.web_fetch",
    toolName: "web_fetch",
    turnId: "turn.web.tools.1",
    ...overrides
  });
}
