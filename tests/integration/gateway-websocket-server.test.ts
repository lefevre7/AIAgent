import { EventEmitter } from "node:events";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { afterEach, describe, expect, test, vi } from "vitest";

import { gatewayResponseSchema, type GatewayRequest } from "@/core/contracts";
import { attachGatewayWebSocketServer, type GatewayRuntimeLike } from "@/gateway";

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

  test("destroys upgrades on a non-matching path when there is no fallback", () => {
    const server = new EventEmitter();
    const attached = attachGatewayWebSocketServer({
      runtime: runtimeStub(),
      server: server as unknown as http.Server,
      websocketPath: "/api/gateway/ws"
    });
    cleanups.push(async () => attached.close());

    const socket = fakeDuplex();
    server.emit("upgrade", { headers: {}, socket: { remoteAddress: "127.0.0.1" }, url: "/other" }, socket, Buffer.alloc(0));
    expect(socket.destroy).toHaveBeenCalled();
  });

  test("delegates non-matching upgrades to a fallback handler when provided", () => {
    const server = new EventEmitter();
    const fallback = vi.fn();
    const attached = attachGatewayWebSocketServer({
      fallbackUpgradeHandler: fallback,
      runtime: runtimeStub(),
      server: server as unknown as http.Server,
      websocketPath: "/api/gateway/ws"
    });
    cleanups.push(async () => attached.close());

    const socket = fakeDuplex();
    server.emit("upgrade", { headers: {}, socket: { remoteAddress: "127.0.0.1" }, url: "/other" }, socket, Buffer.alloc(0));
    expect(fallback).toHaveBeenCalledOnce();
  });
});
