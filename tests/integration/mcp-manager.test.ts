import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import type { AddressInfo } from "node:net";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { afterEach, describe, expect, test } from "vitest";

import {
  MCPManager,
  createDefaultAppConfig,
  createDefaultToolRuntime,
  createMcpManagerFromLoadedConfig,
  loadAIAgentConfig,
  sanitizeMcpInvocationName,
  sessionRecordSchema,
  toolCallRecordSchema,
  turnRecordSchema
} from "@/core";

const tempRoots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
const STDIO_FIXTURE_PATH = path.resolve("tests/fixtures/mcp/stdio-server.mjs");
const CAN_BIND_LOOPBACK = await canBindLoopback();
const httpTransportTest = CAN_BIND_LOOPBACK ? test : test.skip;

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

describe("MCP manager", () => {
  test("connects to a stdio server and exposes tools, resources, prompts, and templates", async () => {
    const config = createDefaultAppConfig({
      userStateDirectory: path.join(await createTempRoot(), "home", ".aia")
    });
    config.mcp.servers.docs = {
      args: [STDIO_FIXTURE_PATH],
      command: process.execPath,
      description: "Fixture stdio docs server",
      enabled: true,
      env: {},
      required: true,
      stderr: "pipe",
      tags: ["docs", "fixture"],
      type: "stdio"
    };

    const manager = new MCPManager({
      config,
      watch: false
    });
    cleanups.push(() => manager.close());

    await manager.initialize();

    const status = manager.getServerStatuses().find((entry) => entry.serverName === "docs");
    expect(status?.state).toBe("connected");
    expect(status?.capabilities).toMatchObject({
      prompts: 1,
      resourceTemplates: 1,
      resources: 1,
      tools: 1
    });

    const invocationName = sanitizeMcpInvocationName("docs", "docs.lookup");
    const toolCapability = manager.getToolCapabilities().find((capability) => capability.invocationName === invocationName);
    expect(toolCapability?.rawName).toBe("docs.lookup");
    expect(toolCapability?.annotations.readOnlyHint).toBe(true);

    const toolResult = await manager.callTool("docs", invocationName, {
      topic: "mcp"
    });
    expect(toolResult.structuredContent).toMatchObject({
      summary: "Documentation for mcp",
      topic: "mcp"
    });

    const fixedResource = await manager.readResource("docs", "file:///docs/guide.md");
    expect(fixedResource.contents[0]).toMatchObject({
      text: "# Guide\nStatic guide content.\n",
      uri: "file:///docs/guide.md"
    });

    const templatedResource = await manager.readResourceTemplate("docs", "file:///docs/{name}.md", {
      name: "api"
    });
    expect(templatedResource.uri).toBe("file:///docs/api.md");
    expect(templatedResource.contents[0]).toMatchObject({
      text: "# api\nDynamic content for api.\n"
    });

    const prompt = await manager.getPrompt("docs", "summarize_doc", {
      topic: "MCP"
    });
    expect(prompt.messages[0]).toMatchObject({
      content: {
        text: "Summarize the documentation for MCP.",
        type: "text"
      },
      role: "user"
    });

    const searchMatches = manager.searchCapabilities({
      kinds: ["tool", "resource", "resource_template", "prompt"],
      limit: 10,
      query: "docs"
    });
    expect(searchMatches.map((match) => match.capability.kind)).toEqual(
      expect.arrayContaining(["tool", "resource", "resource_template"])
    );
  });

  httpTransportTest("supports streamable HTTP and auto-fallback to SSE", async () => {
    const streamable = await startStreamableServer("streamable");
    const sse = await startSseServer("legacy");
    const config = createDefaultAppConfig({
      userStateDirectory: path.join(await createTempRoot(), "home", ".aia")
    });

    config.mcp.servers.streamable = {
      description: "Streamable fixture",
      enabled: true,
      headers: {},
      required: true,
      tags: ["remote", "streamable"],
      type: "streamable-http",
      url: streamable.url
    };
    config.mcp.servers.legacy = {
      description: "Legacy SSE fixture",
      enabled: true,
      headers: {},
      required: true,
      tags: ["legacy", "remote"],
      type: "auto",
      url: sse.url
    };

    const manager = new MCPManager({
      config,
      watch: false
    });
    cleanups.push(() => manager.close());

    await manager.initialize();

    const statusByName = Object.fromEntries(manager.getServerStatuses().map((status) => [status.serverName, status]));
    expect(statusByName.streamable?.transport).toBe("streamable-http");
    expect(statusByName.legacy?.transport).toBe("sse");

    const runtime = createDefaultToolRuntime({
      mcpManager: manager
    });

    const legacyInvocation = sanitizeMcpInvocationName("legacy", "docs.lookup");
    const runtimeResult = await runtime.execute(
      createToolCall({
        arguments: {
          topic: "fallback"
        },
        id: "tool-call.mcp.legacy.1",
        toolName: legacyInvocation
      }),
      {
        session: buildSession(),
        turn: buildTurn()
      }
    );

    expect(runtimeResult.toolCall.status).toBe("succeeded");
    expect(runtimeResult.toolCall.result).toMatchObject({
      isError: false,
      structuredContent: {
        summary: "Documentation for fallback",
        topic: "fallback"
      }
    });
    expect(runtime.listDefinitions().map((definition) => definition.invocationName)).toEqual(
      expect.arrayContaining([
        sanitizeMcpInvocationName("streamable", "docs.lookup"),
        sanitizeMcpInvocationName("legacy", "docs.lookup")
      ])
    );
  });

  test("merges imported config, installs templates, and refreshes runtime-visible MCP tools", async () => {
    const root = await createTempRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const importedConfigPath = path.join(workspace, ".roo", "mcp.json");

    await fs.mkdir(path.dirname(importedConfigPath), { recursive: true });
    await fs.mkdir(path.join(home, ".aia"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      importedConfigPath,
      JSON.stringify({
        mcpServers: {
          shared: {
            type: "auto",
            url: "http://127.0.0.1:9/mcp"
          }
        }
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(workspace, "aia.config.jsonc"),
      `{
        "mcp": {
          "imports": {
            "roo": {
              "enabled": true,
              "format": "roo_project",
              "path": "./.roo/mcp.json",
              "watch": true
            }
          },
          "servers": {
            "shared": {
              "type": "stdio",
              "command": "${escapeJsonString(process.execPath)}",
              "args": ["${escapeJsonString(STDIO_FIXTURE_PATH)}"],
              "enabled": true,
              "required": true,
              "stderr": "pipe",
              "env": {},
              "tags": ["native", "override"]
            }
          }
        }
      }`,
      "utf8"
    );

    const loaded = await loadAIAgentConfig({
      cwd: workspace,
      env: {},
      userHomeDirectory: home
    });
    const manager = createMcpManagerFromLoadedConfig({
      cwd: workspace,
      env: {},
      loaded,
      userHomeDirectory: home,
      watch: false
    });
    cleanups.push(() => manager.close());

    await manager.initialize();

    const sharedStatus = manager.getServerStatuses().find((status) => status.serverName === "shared");
    expect(sharedStatus?.state).toBe("connected");
    expect(sharedStatus?.transport).toBe("stdio");

    const templateMatches = manager.searchCapabilities({
      kinds: ["server_template"],
      limit: 10,
      query: "context7",
      scopes: ["templates"]
    });
    expect(templateMatches.some((match) => match.capability.name === "context7-remote")).toBe(true);

    const runtime = createDefaultToolRuntime({
      mcpManager: manager
    });
    const installedInvocation = sanitizeMcpInvocationName("installed_docs", "docs.lookup");
    expect(runtime.listDefinitions().map((definition) => definition.invocationName)).not.toContain(installedInvocation);

    await manager.installTemplate({
      destination: "workspace",
      overrides: {
        args: [STDIO_FIXTURE_PATH],
        command: process.execPath,
        description: "Installed from the custom stdio template",
        type: "stdio"
      },
      serverName: "installed_docs",
      templateId: "custom-stdio"
    });
    await manager.refresh();

    const toolSearchAfterRefresh = runtime.searchDefinitions({
      limit: 10,
      query: "installed_docs"
    });
    expect(toolSearchAfterRefresh.map((match) => match.definition.invocationName)).toContain(installedInvocation);

    const mcpSearchResult = await runtime.execute(
      createToolCall({
        arguments: {
          kinds: ["server_template", "tool"],
          limit: 20
        },
        id: "tool-call.mcp.search.1",
        toolName: "mcp_search"
      }),
      {
        session: buildSession(),
        turn: buildTurn()
      }
    );

    expect(mcpSearchResult.toolCall.status).toBe("succeeded");
    expect(mcpSearchResult.toolCall.result).toMatchObject({
      matches: expect.arrayContaining([
        expect.objectContaining({
          kind: "tool",
          serverName: "installed_docs"
        }),
        expect.objectContaining({
          kind: "server_template",
          name: "custom-stdio"
        })
      ])
    });
  });
});

async function startStreamableServer(serverName: string): Promise<{ close: () => Promise<void>; url: string }> {
  const app = createMcpExpressApp();

  app.post("/mcp", async (request, response) => {
    const server = createFixtureServer(serverName);

    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined
      });
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
      response.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch (error) {
      if (!response.headersSent) {
        response.status(500).json({
          error: String(error)
        });
      }
      await server.close().catch(() => undefined);
    }
  });

  app.get("/mcp", (_request, response) => {
    response.status(405).json({
      error: "Method not allowed"
    });
  });

  app.delete("/mcp", (_request, response) => {
    response.status(405).json({
      error: "Method not allowed"
    });
  });

  return startHttpServer(app, "/mcp");
}

async function startSseServer(serverName: string): Promise<{ close: () => Promise<void>; url: string }> {
  const app = createMcpExpressApp();
  const transports = new Map<string, { server: McpServer; transport: SSEServerTransport }>();

  app.get("/mcp", async (_request, response) => {
    const server = createFixtureServer(serverName);

    try {
      const transport = new SSEServerTransport("/messages", response);
      transports.set(transport.sessionId, {
        server,
        transport
      });
      transport.onclose = () => {
        transports.delete(transport.sessionId);
      };
      await server.connect(transport);
    } catch (error) {
      if (!response.headersSent) {
        response.status(500).send(String(error));
      }
      await server.close().catch(() => undefined);
    }
  });

  app.post("/messages", async (request, response) => {
    const sessionId = Array.isArray(request.query.sessionId) ? request.query.sessionId[0] : request.query.sessionId;
    if (typeof sessionId !== "string") {
      response.status(400).send("Missing sessionId");
      return;
    }

    const active = transports.get(sessionId);
    if (!active) {
      response.status(404).send("Session not found");
      return;
    }

    await active.transport.handlePostMessage(request, response, request.body);
  });

  const started = await startHttpServer(app, "/mcp");
  cleanups.push(async () => {
    for (const active of transports.values()) {
      await active.server.close().catch(() => undefined);
    }
    transports.clear();
  });
  return started;
}

function createFixtureServer(serverName: string): McpServer {
  const server = new McpServer({
    name: `${serverName}-fixture`,
    version: "1.0.0"
  });

  server.registerTool(
    "docs.lookup",
    {
      annotations: {
        idempotentHint: true,
        readOnlyHint: true,
        title: "Docs Lookup"
      },
      description: "Look up documentation by topic.",
      inputSchema: {
        topic: z.string().min(1)
      },
      outputSchema: {
        server: z.string(),
        summary: z.string(),
        topic: z.string()
      },
      title: "Docs Lookup"
    },
    async ({ topic }) => ({
      content: [
        {
          text: `${serverName}:${topic}`,
          type: "text"
        }
      ],
      structuredContent: {
        server: serverName,
        summary: `Documentation for ${topic}`,
        topic
      }
    })
  );

  server.registerPrompt(
    "summarize_doc",
    {
      argsSchema: {
        topic: z.string().min(1)
      },
      description: "Build a summary prompt for a topic."
    },
    async ({ topic }) => ({
      description: `Prompt for ${topic}`,
      messages: [
        {
          content: {
            text: `Summarize the documentation for ${topic}.`,
            type: "text"
          },
          role: "user"
        }
      ]
    })
  );

  server.registerResource(
    "guide",
    "file:///docs/guide.md",
    {
      description: "Static guide resource.",
      mimeType: "text/markdown",
      title: "Guide"
    },
    async (uri) => ({
      contents: [
        {
          mimeType: "text/markdown",
          text: `# Guide\n${serverName} guide content.\n`,
          uri: uri.toString()
        }
      ]
    })
  );

  server.registerResource(
    "doc-template",
    new ResourceTemplate("file:///docs/{name}.md", {
      list: undefined
    }),
    {
      description: "Dynamic document resource template.",
      mimeType: "text/markdown",
      title: "Document Template"
    },
    async (uri) => {
      const name = decodeURIComponent(uri.pathname.split("/").pop() ?? "unknown").replace(/\.md$/i, "");
      return {
        contents: [
          {
            mimeType: "text/markdown",
            text: `# ${name}\n${serverName} dynamic content for ${name}.\n`,
            uri: uri.toString()
          }
        ]
      };
    }
  );

  return server;
}

async function startHttpServer(
  app: ReturnType<typeof createMcpExpressApp>,
  endpointPath: string
): Promise<{ close: () => Promise<void>; url: string }> {
  const address = await new Promise<AddressInfo>((resolve, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => {
      void resolveTcpAddress(instance).then(resolve, reject);
    });
    instance.once("error", reject);
    cleanups.push(
      async () =>
        await new Promise<void>((cleanupResolve, cleanupReject) => {
          instance.close((error) => {
            if (error) {
              cleanupReject(error);
              return;
            }
            cleanupResolve();
          });
        })
    );
  });
  const url = `http://127.0.0.1:${address.port}${endpointPath}`;

  return {
    close: cleanups[cleanups.length - 1]!,
    url
  };
}

async function resolveTcpAddress(server: ReturnType<ReturnType<typeof createMcpExpressApp>["listen"]>): Promise<AddressInfo> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const address = server.address();
    if (address && typeof address !== "string") {
      return address;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("MCP fixture server did not expose a TCP address.");
}

function buildSession() {
  return sessionRecordSchema.parse({
    createdAt: "2026-03-27T12:00:00.000Z",
    cwd: "/workspace",
    goal: "Exercise MCP runtime coverage",
    id: "session.mcp.integration.1",
    lastActiveAt: "2026-03-27T12:00:00.000Z",
    metadata: {},
    status: "running_model",
    tags: [],
    title: "MCP Integration Session",
    updatedAt: "2026-03-27T12:00:00.000Z"
  });
}

function buildTurn() {
  return turnRecordSchema.parse({
    approvalRequestIds: [],
    executedToolCallIds: [],
    id: "turn.mcp.integration.1",
    inputMessageIds: [],
    metadata: {},
    outputMessageIds: [],
    requestedToolCallIds: [],
    sequence: 0,
    sessionId: "session.mcp.integration.1",
    startedAt: "2026-03-27T12:00:00.000Z",
    status: "running",
    trigger: "user"
  });
}

function createToolCall(overrides: Partial<Parameters<typeof toolCallRecordSchema.parse>[0]> = {}) {
  return toolCallRecordSchema.parse({
    arguments: {},
    id: "tool-call.mcp.default",
    metadata: {},
    sessionId: "session.mcp.integration.1",
    startedAt: "2026-03-27T12:00:00.000Z",
    status: "pending",
    toolId: "tool.mcp.placeholder",
    toolName: "mcp_search",
    turnId: "turn.mcp.integration.1",
    ...overrides
  });
}

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-mcp-"));
  tempRoots.push(root);
  return root;
}

function escapeJsonString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function canBindLoopback(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.listen(0, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}
