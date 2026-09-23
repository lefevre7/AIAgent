import type { IncomingMessage, Server } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";

import {
  gatewayEventReplayQuerySchema,
  gatewayRequestSchema,
  gatewaySubscriptionSchema,
  type GatewaySubscription
} from "@/core/contracts";
import { authorizeGatewayUpgradeRequest, type GatewayAuthOptions } from "@/gateway/auth";
import { handleGatewayRequest } from "@/gateway/router";
import { eventMatchesGatewaySubscription, type GatewayRuntimeLike } from "@/gateway/runtime";

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws") as {
  WebSocketServer: new (options: { noServer: true }) => GatewayWebSocketServer;
};

export type GatewayWebSocketLike = {
  close(code?: number, reason?: string): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): void;
  readyState: number;
  send(data: string): void;
};

type GatewayWebSocketServer = {
  close(callback?: () => void): void;
  emit(event: "connection", socket: GatewayWebSocketLike, request: IncomingMessage): void;
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (socket: GatewayWebSocketLike, request: IncomingMessage) => void
  ): void;
};

export type GatewayUpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;

export type AttachGatewayWebSocketServerOptions = {
  auth?: GatewayAuthOptions;
  fallbackUpgradeHandler?: GatewayUpgradeHandler;
  requestTimeoutMs?: number;
  runtime: GatewayRuntimeLike;
  server: Server;
  websocketPath: string;
};

export function attachGatewayWebSocketServer(options: AttachGatewayWebSocketServerOptions): { close(): Promise<void> } {
  const server = new WebSocketServer({
    noServer: true
  });
  const upgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = request.url
      ? new URL(request.url, `http://${request.headers.host ?? "localhost"}`).pathname
      : null;
    if (pathname !== options.websocketPath) {
      if (options.fallbackUpgradeHandler) {
        void Promise.resolve(options.fallbackUpgradeHandler(request, socket, head)).catch(() => {
          socket.destroy();
        });
      } else {
        socket.destroy();
      }
      return;
    }

    const authorization = authorizeGatewayUpgradeRequest(request, options.auth);
    if (!authorization.ok) {
      writeUpgradeRejection(socket, authorization.statusCode, authorization.error.message);
      return;
    }

    server.handleUpgrade(request, socket, head, (websocket, upgradedRequest) => {
      server.emit("connection", websocket, upgradedRequest);
      bindGatewayWebSocketConnection(websocket, {
        requestTimeoutMs: options.requestTimeoutMs ?? 120_000,
        runtime: options.runtime
      });
    });
  };

  options.server.on("upgrade", upgradeHandler);

  return {
    close: async () =>
      await new Promise<void>((resolve) => {
        options.server.off("upgrade", upgradeHandler);
        server.close(() => resolve());
      })
  };
}

export function bindGatewayWebSocketConnection(
  websocket: GatewayWebSocketLike,
  options: {
    requestTimeoutMs: number;
    runtime: GatewayRuntimeLike;
  }
): void {
  let subscription: GatewaySubscription | null = null;
  // While a backlog catch-up sweep (below) is in flight for the current
  // subscription, a persisted event delivered live would duplicate whatever
  // the sweep is about to deliver for it — the sweep re-queries "from cursor
  // to now" repeatedly until a page comes back empty, so it will always catch
  // up to anything appended mid-sweep on its own. Non-persisted events (no
  // `cursor`, e.g. `message.delta`) were never part of any backlog, so they
  // are never gated. `sweepGeneration` guards against a client resubscribing
  // again before an earlier sweep's `finally` runs, so that earlier sweep
  // cannot clear the gate out from under the newer one.
  let liveGateActive = false;
  let sweepGeneration = 0;
  const unsubscribe = options.runtime.subscribe((event) => {
    if (!subscription || !eventMatchesGatewaySubscription(event, subscription) || websocket.readyState !== 1) {
      return;
    }
    if (liveGateActive && event.cursor) {
      return;
    }

    websocket.send(JSON.stringify(event));
  });

  websocket.on("message", (data, isBinary) => {
    if (isBinary) {
      websocket.close(1003, "Binary gateway messages are not supported.");
      return;
    }

    void handleGatewayWebSocketMessage(websocket, normalizeWebSocketMessage(data), {
      onSubscriptionChanged: async (nextSubscription) => {
        subscription = nextSubscription;
        liveGateActive = true;
        const generation = ++sweepGeneration;
        try {
          let cursor = nextSubscription.cursor;
          while (true) {
            const replay = await options.runtime.replayEvents(
              gatewayEventReplayQuerySchema.parse({
                ...nextSubscription,
                cursor,
                limit: 500
              })
            );
            for (const event of replay.events) {
              if (websocket.readyState !== 1) {
                return;
              }
              websocket.send(JSON.stringify(event));
            }
            if (!replay.nextCursor) {
              return;
            }
            cursor = replay.nextCursor;
          }
        } finally {
          if (sweepGeneration === generation) {
            liveGateActive = false;
          }
        }
      },
      requestTimeoutMs: options.requestTimeoutMs,
      runtime: options.runtime
    });
  });

  websocket.on("close", () => {
    unsubscribe();
  });

  websocket.on("error", () => {
    unsubscribe();
  });
}

async function handleGatewayWebSocketMessage(
  websocket: GatewayWebSocketLike,
  messageText: string | null,
  options: {
    onSubscriptionChanged: (subscription: GatewaySubscription) => Promise<void>;
    requestTimeoutMs: number;
    runtime: GatewayRuntimeLike;
  }
): Promise<void> {
  if (!messageText) {
    websocket.close(1007, "Gateway messages must be valid UTF-8 JSON text.");
    return;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(messageText) as unknown;
  } catch {
    websocket.close(1007, "Gateway messages must be valid JSON.");
    return;
  }

  const parsedRequest = gatewayRequestSchema.safeParse(parsedJson);
  if (!parsedRequest.success) {
    websocket.close(1008, "Gateway messages must match the request contract.");
    return;
  }

  const response = await handleGatewayRequest(parsedRequest.data, {
    requestTimeoutMs: options.requestTimeoutMs,
    runtime: options.runtime
  });

  if (websocket.readyState !== 1) {
    return;
  }

  websocket.send(JSON.stringify(response));

  if (!response.ok || parsedRequest.data.topic !== "gateway.subscribe") {
    return;
  }

  await options.onSubscriptionChanged(gatewaySubscriptionSchema.parse(parsedRequest.data.payload));
}

function normalizeWebSocketMessage(data: unknown): string | null {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data) && data.every((entry) => Buffer.isBuffer(entry))) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return null;
}

function writeUpgradeRejection(socket: Duplex, statusCode: number, message: string): void {
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusCode === 401 ? "Unauthorized" : "Forbidden"}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(message, "utf8")}\r\n` +
      "\r\n" +
      message
  );
  socket.destroy();
}
