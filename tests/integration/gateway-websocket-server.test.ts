import { EventEmitter } from "node:events";
import http from "node:http";
import { createRequire } from "node:module";
import net, { type AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { afterEach, describe, expect, test, vi } from "vitest";

import { gatewayResponseSchema, type GatewayRequest } from "@/core/contracts";
import { attachGatewayWebSocketServer, authorizeGatewayUpgradeRequest, type GatewayRuntimeLike } from "@/gateway";

type WsClientLike = {
  close(): void;
  on(event: "open" | "error" | "message" | "close", listener: (arg?: unknown) => void): void;
  send(data: string): void;
};

const loadModule = createRequire(import.meta.url);
const { WebSocket } = loadModule("ws") as { WebSocket: new (url: string) => WsClientLike };

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async (fn) => fn()));
});

function runtimeStub(): GatewayRuntimeLike {
  return {
    getApprovalRecord: async () => {
      throw new Error("not used");
    },
    getSessionSnapshot: async () => {
      throw new Error("not used");
    },
    listApprovalRecords: async () => [],
    replayEvents: async () => ({ events: [] }),
    request: async (request: GatewayRequest) =>
      gatewayResponseSchema.parse({
        createdAt: "2026-06-10T00:00:00.000Z",
        id: "gateway-response.health.1",
        metadata: {},
        ok: true,
        payload: { ok: true, status: "ready" },
        requestId: request.id,
        topic: request.topic
      }),
    subscribe: () => () => undefined
  } as unknown as GatewayRuntimeLike;
}

function fakeDuplex() {
  return { destroy: vi.fn(), end: vi.fn(), write: vi.fn() } as unknown as Duplex;
}

describe("attachGatewayWebSocketServer", () => {
  test("upgrades loopback connections and answers gateway requests", async () => {
    const server = http.createServer();
    const attached = attachGatewayWebSocketServer({
      requestTimeoutMs: 5_000,
      runtime: runtimeStub(),
      server,
      websocketPath: "/api/gateway/ws"
    });
    cleanups.push(async () => attached.close());
    cleanups.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const client = new WebSocket(`ws://127.0.0.1:${port}/api/gateway/ws`);
    cleanups.push(() => client.close());

    const response = await new Promise<unknown>((resolve, reject) => {
      client.on("error", reject);
      client.on("open", () => {
        client.send(
          JSON.stringify({
            createdAt: "2026-06-10T00:00:00.000Z",
            id: "gateway-request.health.1",
            metadata: {},
            payload: {},
            topic: "gateway.health"
          })
        );
      });
      client.on("message", (data) => resolve(JSON.parse(Buffer.from(data as Buffer).toString("utf8"))));
    });

    expect(response).toMatchObject({ ok: true, payload: { status: "ready" }, topic: "gateway.health" });
  });

  test("rejects upgrades that fail authentication with a 401 handshake", () => {
    const server = new EventEmitter();
    const attached = attachGatewayWebSocketServer({
      auth: { token: "secret" },
      runtime: runtimeStub(),
      server: server as unknown as http.Server,
      websocketPath: "/api/gateway/ws"
    });
    cleanups.push(async () => attached.close());

    const socket = fakeDuplex();
    server.emit(
      "upgrade",
      { headers: { host: "localhost" }, socket: { remoteAddress: "10.0.0.9" }, url: "/api/gateway/ws" },
      socket,
      Buffer.alloc(0)
    );

    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining("401 Unauthorized"));
    expect(socket.destroy).toHaveBeenCalled();
  });

  // Next's custom server adds its own upgrade listener to the HTTP server on
  // its first request, and that listener answers the dev hot-reload socket.
  // Handing the upgrade to `nextApp.getUpgradeHandler()` as well did nothing:
  // that is Next's production handler, and it is empty.
  describe("Next's hot-reload upgrades", () => {
    const attachWithNext = (authorize: () => ReturnType<typeof authorizeGatewayUpgradeRequest>) => {
      const server = new EventEmitter();
      const attached = attachGatewayWebSocketServer({
        nextUpgrades: { authorize },
        runtime: runtimeStub(),
        server: server as unknown as http.Server,
        websocketPath: "/api/gateway/ws"
      });
      cleanups.push(async () => attached.close());
      // What Next's custom server adds, after the gateway's own listener.
      const seenByNext: Array<{ destroyed: boolean }> = [];
      server.on("upgrade", (_request, socket: Duplex) => {
        seenByNext.push({
          destroyed: (socket.destroy as unknown as { mock: { calls: unknown[] } }).mock.calls.length > 0
        });
      });
      return { seenByNext, server };
    };

    test("leaves an allowed one to Next's own listener", () => {
      const { seenByNext, server } = attachWithNext(() => ({ ok: true }));
      const socket = fakeDuplex();
      server.emit(
        "upgrade",
        { headers: { host: "127.0.0.1:3000" }, socket: { remoteAddress: "127.0.0.1" }, url: "/_next/webpack-hmr" },
        socket,
        Buffer.alloc(0)
      );
      expect(socket.write).not.toHaveBeenCalled();
      expect(socket.destroy).not.toHaveBeenCalled();
      expect(seenByNext).toEqual([{ destroyed: false }]);
    });

    test("closes a refused one before Next's listener sees it", () => {
      const { seenByNext, server } = attachWithNext(() => ({
        error: { code: "forbidden", details: {}, message: "no", retriable: false },
        ok: false,
        statusCode: 403
      }));
      const socket = fakeDuplex();
      server.emit(
        "upgrade",
        { headers: {}, socket: { remoteAddress: "127.0.0.1" }, url: "/_next/webpack-hmr" },
        socket,
        Buffer.alloc(0)
      );
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining("HTTP/1.1 403 Forbidden"));
      expect(seenByNext).toEqual([{ destroyed: true }]);
    });
  });

  // Every non-gateway upgrade used to be handed on and never answered, so an
  // unknown path hung until the client gave up.
  test.each([
    ["any other path", "/other", true],
    ["any other path when Next is not being served", "/other", false],
    ["a /_next/ path when Next is not being served", "/_next/webpack-hmr", false]
  ])("answers %s 404", (_label, url, withNext) => {
    const server = new EventEmitter();
    const attached = attachGatewayWebSocketServer({
      ...(withNext ? { nextUpgrades: { authorize: () => ({ ok: true as const }) } } : {}),
      runtime: runtimeStub(),
      server: server as unknown as http.Server,
      websocketPath: "/api/gateway/ws"
    });
    cleanups.push(async () => attached.close());

    const socket = fakeDuplex();
    server.emit("upgrade", { headers: {}, socket: { remoteAddress: "127.0.0.1" }, url }, socket, Buffer.alloc(0));
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining("HTTP/1.1 404 Not Found"));
    expect(socket.destroy).toHaveBeenCalled();
  });

  // Without a token any loopback connection used to be accepted, and a web
  // page on another site opens its WebSocket from loopback: it could drive
  // the gateway (read files, run tools) from the operator's own browser.
  describe("without a gateway token", () => {
    const upgradeWith = (headers: Record<string, string>) => {
      const server = new EventEmitter();
      const attached = attachGatewayWebSocketServer({
        runtime: runtimeStub(),
        server: server as unknown as http.Server,
        websocketPath: "/api/gateway/ws"
      });
      cleanups.push(async () => attached.close());
      const socket = fakeDuplex();
      server.emit(
        "upgrade",
        { headers, socket: { remoteAddress: "127.0.0.1" }, url: "/api/gateway/ws" },
        socket,
        Buffer.alloc(0)
      );
      return socket;
    };

    test.each([
      ["a page on another site", { host: "127.0.0.1:3000", origin: "https://attacker.example" }],
      ["a sandboxed or file:// page", { host: "127.0.0.1:3000", origin: "null" }],
      ["another local port", { host: "127.0.0.1:3000", origin: "http://localhost:5173" }],
      ["a DNS-rebound name", { host: "attacker.example:3000", origin: "http://attacker.example:3000" }],
      ["a rebound name with no Origin", { host: "attacker.example:3000" }]
    ])("refuses %s", (_label, headers) => {
      const socket = upgradeWith(headers);
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining("HTTP/1.1 403 Forbidden"));
      expect(socket.destroy).toHaveBeenCalled();
    });

    test.each([
      ["a client that is not a browser", { host: "127.0.0.1:3000" }],
      ["this server's own page", { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" }],
      ["its own page under another loopback name", { host: "127.0.0.1:3000", origin: "http://localhost:3000" }]
    ])("accepts %s", (_label, headers) => {
      expect(
        authorizeGatewayUpgradeRequest({
          headers,
          socket: { remoteAddress: "127.0.0.1" },
          url: "/api/gateway/ws"
        } as unknown as http.IncomingMessage)
      ).toEqual({ ok: true });
    });
  });

  // The listener resolved the request target against the client's Host header,
  // so one malformed header threw out of it and took the process down before
  // auth ran. The REPL's attach listener has no framework handler to catch it.
  test.each(["localhost:99999", "a b", "[::1"])("survives an upgrade whose Host header is %s", (host) => {
    const server = new EventEmitter();
    const attached = attachGatewayWebSocketServer({
      auth: { token: "secret" },
      runtime: runtimeStub(),
      server: server as unknown as http.Server,
      websocketPath: "/api/gateway/ws"
    });
    cleanups.push(async () => attached.close());

    const socket = fakeDuplex();
    expect(() =>
      server.emit(
        "upgrade",
        { headers: { host }, socket: { remoteAddress: "10.0.0.9" }, url: "/api/gateway/ws" },
        socket,
        Buffer.alloc(0)
      )
    ).not.toThrow();
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining("401 Unauthorized"));
  });

  // ws reports the server closed only once every client has left, and nothing
  // ended them: an attached `aia attach` window held the REPL's /exit open.
  describe("close()", () => {
    async function listen() {
      const server = http.createServer();
      const attached = attachGatewayWebSocketServer({
        runtime: runtimeStub(),
        server,
        websocketPath: "/api/gateway/ws"
      });
      cleanups.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      return { attached, port: (server.address() as AddressInfo).port };
    }

    test("tells connected clients the gateway is going away instead of waiting on them", async () => {
      const { attached, port } = await listen();
      const client = new WebSocket(`ws://127.0.0.1:${port}/api/gateway/ws`);
      await new Promise<void>((resolve, reject) => {
        client.on("open", () => resolve());
        client.on("error", reject);
      });
      const closeCode = new Promise<unknown>((resolve) => client.on("close", (code) => resolve(code)));

      const started = Date.now();
      await attached.close();

      expect(Date.now() - started).toBeLessThan(3_000);
      await expect(closeCode).resolves.toBe(1001);
    });

    test("drops a client that never answers the close handshake", async () => {
      const { attached, port } = await listen();
      const raw = net.connect(port, "127.0.0.1");
      cleanups.push(() => {
        raw.destroy();
      });
      await new Promise<void>((resolve) => raw.once("connect", () => resolve()));
      raw.write(
        [
          "GET /api/gateway/ws HTTP/1.1",
          "Host: 127.0.0.1",
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "",
          ""
        ].join("\r\n")
      );
      await new Promise<void>((resolve) => raw.once("data", () => resolve()));

      const started = Date.now();
      await attached.close();

      expect(Date.now() - started).toBeLessThan(3_000);
    });
  });
});
