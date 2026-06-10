import { describe, expect, test } from "vitest";

import {
  createDefaultToolRuntime,
  sanitizeMcpInvocationName,
  sessionRecordSchema,
  toolCallRecordSchema,
  turnRecordSchema,
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

  test("web_search selects an MCP-backed search tool and normalizes results", async () => {
    const invocationName = sanitizeMcpInvocationName("search", "web.search");
    let capturedCall: {
      arguments: Record<string, unknown>;
      invocationName: string;
      serverName: string;
    } | null = null;

    const fakeManager = {
      callTool: async (serverName: string, toolName: string, args: Record<string, unknown>) => {
        capturedCall = {
          arguments: args,
          invocationName: toolName,
          serverName
        };
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
      getToolCapabilities: () => [
        {
          access: "model_and_api" as const,
          annotations: {
            readOnlyHint: true
          },
          description: "Search the web for documents.",
          displayName: "Web Search",
          execution: {},
          id: "mcp.tool.search.web.search",
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
          invocationName,
          kind: "tool" as const,
          metadata: {},
          name: "web.search",
          rawName: "web.search",
          serverName: "search",
          tags: ["mcp", "search", "web"]
        }
      ],
      readResource: async () => {
        throw new Error("not used");
      },
      readResourceTemplate: async () => {
        throw new Error("not used");
      },
      searchCapabilities: () => []
    } as unknown as MCPManager;

    const runtime = createDefaultToolRuntime({
      mcpManager: fakeManager
    });
    const result = await runtime.execute(
      createToolCall({
        id: "tool-call.web.search.1",
        inputText: "latest aiagent docs",
        toolName: "web_search"
      }),
      {
        session: buildSession(),
        turn: buildTurn()
      }
    );

    expect(capturedCall).toEqual({
      arguments: {
        limit: 8,
        query: "latest aiagent docs"
      },
      invocationName,
      serverName: "search"
    });
    expect(result.toolCall.status).toBe("succeeded");
    expect(result.toolCall.result).toMatchObject({
      provider: {
        invocationName,
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
});

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
