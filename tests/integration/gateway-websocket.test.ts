import { describe, expect, test } from "vitest";

import { gatewayEventSchema, gatewayResponseSchema, type GatewayEvent } from "@/core/contracts";
import {
  bindGatewayWebSocketConnection,
  type GatewayRuntimeLike,
  type GatewayWebSocketLike
} from "@/gateway";

describe("gateway websocket", () => {
  test("returns request responses over the shared websocket transport", async () => {
    const runtime = createRuntimeStub();
    const socket = new FakeGatewaySocket();

    bindGatewayWebSocketConnection(socket, {
      requestTimeoutMs: 5_000,
      runtime
    });

    socket.emitMessage(
      JSON.stringify({
        createdAt: "2026-03-31T12:00:00.000Z",
        id: "gateway-request.health.1",
        metadata: {},
        payload: {},
        topic: "gateway.health"
      })
    );

    await waitFor(() => socket.sent.length === 1);

    expect(socket.takeJsonMessages()).toEqual([
      gatewayResponseSchema.parse({
        createdAt: "2026-03-31T12:00:00.000Z",
        id: "gateway-response.health.1",
        metadata: {},
        ok: true,
        payload: {
          ok: true,
          status: "ready"
        },
        requestId: "gateway-request.health.1",
        topic: "gateway.health"
      })
    ]);
  });

  test("replays stored events and streams live events after subscribe", async () => {
    const replayEvent = gatewayEventSchema.parse({
      createdAt: "2026-03-31T12:05:00.000Z",
      cursor: "cursor.1",
      id: "message-created.replay.1",
      metadata: {},
      payload: {
        createdAt: "2026-03-31T12:05:00.000Z",
        id: "message.replay.1",
        metadata: {},
        parts: [
          {
            kind: "text",
            text: "replayed"
          }
        ],
        role: "assistant",
        sessionId: "session.1",
        source: "assistant",
        tags: [],
        visibility: "default"
      },
      topic: "message.created"
    });
    const runtime = createRuntimeStub({
      replayEvents: async () => ({
        events: [replayEvent]
      })
    });
    const socket = new FakeGatewaySocket();

    bindGatewayWebSocketConnection(socket, {
      requestTimeoutMs: 5_000,
      runtime
    });

    socket.emitMessage(
      JSON.stringify({
        createdAt: "2026-03-31T12:00:00.000Z",
        id: "gateway-request.subscribe.1",
        metadata: {},
        payload: {
          cursor: "cursor.0",
          sessionId: "session.1",
          topics: ["message.created"]
        },
        topic: "gateway.subscribe"
      })
    );

    await waitFor(() => socket.sent.length === 2);

    const liveEvent = gatewayEventSchema.parse({
      createdAt: "2026-03-31T12:06:00.000Z",
      cursor: "cursor.2",
      id: "message-created.live.1",
      metadata: {},
      payload: {
        createdAt: "2026-03-31T12:06:00.000Z",
        id: "message.live.1",
        metadata: {},
        parts: [
          {
            kind: "text",
            text: "live"
          }
        ],
        role: "assistant",
        sessionId: "session.1",
        source: "assistant",
        tags: [],
        visibility: "default"
      },
      topic: "message.created"
    });

    runtime.emitEvent(
      gatewayEventSchema.parse({
        ...liveEvent,
        id: "message-created.other-session.1",
        payload: {
          ...liveEvent.payload,
          id: "message.other-session.1",
          sessionId: "session.2"
        }
      })
    );
    await flush();
    expect(socket.sent).toHaveLength(2);

    runtime.emitEvent(liveEvent);
    await waitFor(() => socket.sent.length === 3);

    expect(socket.takeJsonMessages()).toEqual([
      gatewayResponseSchema.parse({
        createdAt: "2026-03-31T12:00:01.000Z",
        id: "gateway-response.subscribe.1",
        metadata: {},
        ok: true,
        payload: {
          subscription: {
            cursor: "cursor.0",
            sessionId: "session.1",
            topics: ["message.created"]
          }
        },
        requestId: "gateway-request.subscribe.1",
        topic: "gateway.subscribe"
      }),
      replayEvent,
      liveEvent
    ]);
  });
});

function createRuntimeStub(overrides: {
  replayEvents?: GatewayRuntimeLike["replayEvents"];
  request?: GatewayRuntimeLike["request"];
} = {}): GatewayRuntimeLike & { emitEvent(event: GatewayEvent): void } {
  let listener: ((event: GatewayEvent) => void) | undefined;

  return {
    emitEvent(event) {
      listener?.(event);
    },
    getApprovalRecord: async () => {
      throw new Error("not used");
    },
    getSessionSnapshot: async () => {
      throw new Error("not used");
    },
    listApprovalRecords: async () => [],
    replayEvents:
      overrides.replayEvents ??
      (async () => ({
        events: []
      })),
    request:
      overrides.request ??
      (async (request) => {
        if (request.topic === "gateway.subscribe") {
          return gatewayResponseSchema.parse({
            createdAt: "2026-03-31T12:00:01.000Z",
            id: "gateway-response.subscribe.1",
            metadata: {},
            ok: true,
            payload: {
              subscription: request.payload
            },
            requestId: request.id,
            topic: request.topic
          });
        }

        return gatewayResponseSchema.parse({
          createdAt: "2026-03-31T12:00:00.000Z",
          id: "gateway-response.health.1",
          metadata: {},
          ok: true,
          payload: {
            ok: true,
            status: "ready"
          },
          requestId: request.id,
          topic: request.topic
        });
      }),
    subscribe: (nextListener) => {
      listener = nextListener;
      return () => {
        if (listener === nextListener) {
          listener = undefined;
        }
      };
    }
  };
}

class FakeGatewaySocket implements GatewayWebSocketLike {
  readonly sent: string[] = [];
  readyState = 1;
  private readonly listeners = {
    close: [] as Array<() => void>,
    error: [] as Array<(error: Error) => void>,
    message: [] as Array<(data: unknown, isBinary: boolean) => void>
  };

  close(): void {
    this.readyState = 3;
    for (const listener of this.listeners.close) {
      listener();
    }
  }

  emitError(error: Error): void {
    for (const listener of this.listeners.error) {
      listener(error);
    }
  }

  emitMessage(data: unknown, isBinary = false): void {
    for (const listener of this.listeners.message) {
      listener(data, isBinary);
    }
  }

  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): void;
  on(
    event: "close" | "error" | "message",
    listener: (() => void) | ((error: Error) => void) | ((data: unknown, isBinary: boolean) => void)
  ): void {
    if (event === "close") {
      this.listeners.close.push(listener as () => void);
      return;
    }
    if (event === "error") {
      this.listeners.error.push(listener as (error: Error) => void);
      return;
    }
    this.listeners.message.push(listener as (data: unknown, isBinary: boolean) => void);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  takeJsonMessages(): unknown[] {
    return this.sent.splice(0).map((message) => JSON.parse(message) as unknown);
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Condition was not met before the timeout.");
    }
    await flush();
  }
}
