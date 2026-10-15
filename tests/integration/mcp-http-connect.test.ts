import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as z from "zod";

import { connectMcpClient, createDefaultAppConfig, MCPManager, type MCPServerStatus } from "@/core";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
});

/** An SSE endpoint that opens the stream and then says nothing, ever. */
async function silentSseServer(): Promise<string> {
  const server = http.createServer((request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "cache-control": "no-cache", "content-type": "text/event-stream" });
      response.write(": connected\n\n");
      return;
    }
    response.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/sse`;
}

describe("connecting to an HTTP MCP server", () => {
  // The SDK's timeout covers the initialize request, not the transport's start,
  // so a server that never sent its endpoint event held the connect forever.
  test("gives up on an SSE stream that never names its endpoint, within startupTimeoutMs", async () => {
    const url = await silentSseServer();
    const startedAt = Date.now();

    await expect(
      connectMcpClient({
        elicitation: false,
        fetchImpl: fetch,
        globalPassEnv: [],
        serverConfig: {
          enabled: true,
          headers: {},
          required: false,
          startupTimeoutMs: 500,
          tags: [],
          type: "sse",
          url
        },
        serverName: "silent"
      })
    ).rejects.toThrow("Did not finish connecting within 500 ms (startupTimeoutMs).");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});

/** A stateless Streamable HTTP MCP server with an `echo` tool, on `port` (0: any). */
async function startHttpMcpServer(port = 0): Promise<{ port: number; stop: () => Promise<void> }> {
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    const mcp = new McpServer({ name: "http-fixture", version: "1.0.0" });
    mcp.registerTool("echo", { description: "Echo.", inputSchema: { text: z.string() } }, async ({ text }) => ({
      content: [{ text: `echo:${text}`, type: "text" }]
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    await transport.handleRequest(request, response, JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
    response.on("close", () => {
      void transport.close();
      void mcp.close();
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const stop = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, stop };
}

describe("an HTTP MCP server that goes away", () => {
  // Only a close was watched, and an HTTP server that stops answering never
  // closes anything: it stayed "connected", every call failing, until restart.
  test("is marked failed when a call cannot reach it, and reconnects once it is back", async () => {
    const first = await startHttpMcpServer();
    const config = createDefaultAppConfig({ userStateDirectory: "/tmp/aia-http-gone/.aia" });
    config.mcp.servers.web = {
      enabled: true,
      headers: {},
      required: true,
      tags: [],
      type: "streamable-http",
      url: `http://127.0.0.1:${first.port}/mcp`
    };
    const manager = new MCPManager({ config, reconnectBaseDelayMs: 20, watch: false });
    try {
      await manager.initialize();
      const states: string[] = [];
      manager.on("server_updated", ({ status }: { status: MCPServerStatus }) => states.push(status.state));

      await first.stop();
      await expect(manager.callTool("web", "echo", { text: "hi" })).rejects.toThrow();
      const lost = manager.getServerStatuses().find((status) => status.serverName === "web");
      expect(lost).toMatchObject({ error: { code: "mcp_connection_lost" }, state: "failed" });

      await startHttpMcpServer(first.port);
      const deadline = Date.now() + 10_000;
      while (manager.getServerStatuses()[0]?.state !== "connected" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(manager.getServerStatuses()[0]?.state).toBe("connected");
      const result = await manager.callTool("web", "echo", { text: "back" });
      expect(JSON.stringify(result)).toContain("echo:back");
      expect(states).toContain("connecting");
    } finally {
      await manager.close();
    }
  });
});

/**
 * A stateful Streamable HTTP MCP server. `expire()` forgets the current
 * session the slow way: each POST on it waits, the session announces a changed
 * tool list meanwhile, and then the POST is answered 404. `counts()` says how
 * many sessions were initialized and how many times `echo` ran.
 */
async function startStatefulHttpMcpServer(): Promise<{
  counts: () => { echoes: number; initializations: number };
  expire: () => void;
  url: string;
}> {
  const sessions = new Map<string, { mcp: McpServer; transport: StreamableHTTPServerTransport }>();
  const doomed = new Set<string>();
  const announced = new Set<string>();
  let echoes = 0;
  let initializations = 0;
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    const body = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown) : undefined;
    const sessionId = request.headers["mcp-session-id"];
    if (typeof sessionId === "string") {
      const session = sessions.get(sessionId);
      if (request.method === "POST" && session && doomed.has(sessionId)) {
        if (!announced.has(sessionId)) {
          announced.add(sessionId);
          session.mcp.registerTool("extra", { description: "Added late." }, async () => ({
            content: [{ text: "extra", type: "text" }]
          }));
        }
        await new Promise((resolve) => setTimeout(resolve, 900));
        sessions.delete(sessionId);
        response.writeHead(404).end("Session not found");
        return;
      }
      if (!session) {
        response.writeHead(404).end("Session not found");
        return;
      }
      await session.transport.handleRequest(request, response, body);
      return;
    }
    if ((body as { method?: unknown } | undefined)?.method === "initialize") {
      initializations += 1;
    }
    const mcp = new McpServer({ name: "stateful-fixture", version: "1.0.0" });
    mcp.registerTool("echo", { description: "Echo.", inputSchema: { text: z.string() } }, async ({ text }) => {
      echoes += 1;
      return { content: [{ text: `echo:${text}`, type: "text" }] };
    });
    const transport = new StreamableHTTPServerTransport({
      onsessioninitialized: (id) => {
        sessions.set(id, { mcp, transport });
      },
      sessionIdGenerator: () => crypto.randomUUID()
    });
    await mcp.connect(transport);
    await transport.handleRequest(request, response, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return {
    counts: () => ({ echoes, initializations }),
    expire: () => {
      const current = [...sessions.keys()].at(-1);
      if (current) {
        doomed.add(current);
      }
    },
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
  };
}

describe("an HTTP MCP server that forgets the session", () => {
  // Recovery compared connection records, and a relist (the tool list changed)
  // replaces the record: a 404 that arrived after one was replayed on the
  // expired session instead of connecting again.
  async function connectTo(fixture: { url: string }): Promise<MCPManager> {
    const config = createDefaultAppConfig({ userStateDirectory: "/tmp/aia-http-expired/.aia" });
    config.mcp.servers.web = {
      enabled: true,
      headers: {},
      required: true,
      tags: [],
      type: "streamable-http",
      url: fixture.url
    };
    const manager = new MCPManager({ config, watch: false });
    await manager.initialize();
    return manager;
  }

  test("connects again and replays the call, even when the tool list changed meanwhile", async () => {
    const fixture = await startStatefulHttpMcpServer();
    const manager = await connectTo(fixture);
    const warn = vi.spyOn(console, "warn");
    try {
      fixture.expire();

      const result = await manager.callTool("web", "echo", { text: "again" });

      expect(JSON.stringify(result)).toContain("echo:again");
      expect(manager.getServerStatuses()[0]?.state).toBe("connected");
      // Replayed once, on one new session: a 404 means the call never ran.
      expect(fixture.counts()).toEqual({ echoes: 1, initializations: 2 });
      // The relist the changed list asked for failed on the forgotten
      // session; that connection was replaced, so it is not worth a warning.
      expect(warn.mock.calls.flat().join("\n")).not.toContain("AIA_MCP_RELIST_FAILED");
    } finally {
      warn.mockRestore();
      await manager.close();
    }
  });

  test("calls that find the session gone together share one new session", async () => {
    const fixture = await startStatefulHttpMcpServer();
    const manager = await connectTo(fixture);
    try {
      fixture.expire();

      const results = await Promise.all(
        ["one", "two", "three"].map((text) => manager.callTool("web", "echo", { text }))
      );

      expect(results.map((result) => JSON.stringify(result))).toEqual([
        expect.stringContaining("echo:one"),
        expect.stringContaining("echo:two"),
        expect.stringContaining("echo:three")
      ]);
      expect(fixture.counts()).toEqual({ echoes: 3, initializations: 2 });
    } finally {
      await manager.close();
    }
  });
});
