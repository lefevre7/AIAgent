import { EventEmitter } from "node:events";

import httpMocks from "node-mocks-http";
import { describe, expect, test } from "vitest";

import { gatewayResponseSchema } from "@/core/contracts";
import { createGatewayHealthSnapshot, createGatewayRouter, handleGatewayRequest, type GatewayRuntimeLike } from "@/gateway";

type Captured = { approvalsQuery?: unknown; eventsQuery?: unknown; snapshotId?: string; approvalId?: string };

function buildRuntime(overrides: Partial<GatewayRuntimeLike> = {}): { runtime: GatewayRuntimeLike; captured: Captured } {
  const captured: Captured = {};
  const runtime: GatewayRuntimeLike = {
    getApprovalRecord: async (requestId: string) => {
      captured.approvalId = requestId;
      return { request: { id: requestId } } as never;
    },
    getSessionSnapshot: async (sessionId: string) => {
      captured.snapshotId = sessionId;
      return { found: true, sessionId } as never;
    },
    listApprovalRecords: async (query: unknown) => {
      captured.approvalsQuery = query;
      return [];
    },
    replayEvents: async (query: unknown) => {
      captured.eventsQuery = query;
      return { events: [] };
    },
    request: async (request) =>
      gatewayResponseSchema.parse({
        createdAt: "2026-06-10T12:00:00.000Z",
        id: "gateway-response.1",
        metadata: {},
        ok: true,
        payload: {},
        requestId: request.id,
        topic: request.topic
      }),
    subscribe: () => () => undefined,
    ...overrides
  };
  return { captured, runtime };
}

async function invoke(
  router: ReturnType<typeof createGatewayRouter>,
  options: { body?: Record<string, unknown>; method: string; query?: Record<string, unknown>; url: string }
) {
  const request = httpMocks.createRequest({
    body: options.body,
    headers: { "content-type": "application/json" },
    method: options.method as "GET",
    query: options.query,
    url: options.url
  });
  Object.defineProperty(request.socket, "remoteAddress", { value: "127.0.0.1" });
  const response = httpMocks.createResponse({ eventEmitter: EventEmitter });

  await new Promise<void>((resolve, reject) => {
    response.on("end", resolve);
    response.on("finish", resolve);
    (router as unknown as { handle: (req: unknown, res: unknown, next: (e?: unknown) => void) => void }).handle(
      request,
      response,
      (error?: unknown) => (error ? reject(error) : resolve())
    );
  });

  return response;
}

describe("gateway router endpoints", () => {
  test("createGatewayHealthSnapshot reports the gateway surface", () => {
    expect(createGatewayHealthSnapshot()).toMatchObject({ ok: true, surface: "gateway" });
  });

  test("serves /health and /status", async () => {
    const router = createGatewayRouter({ runtime: buildRuntime().runtime });
    const health = await invoke(router, { method: "GET", url: "/health" });
    expect(health._getJSONData()).toMatchObject({ ok: true, surface: "gateway" });

    const status = await invoke(router, { method: "GET", url: "/status" });
    expect(status._getJSONData()).toEqual({ ok: true, status: "ready" });
  });

  test("rejects malformed request envelopes with 400", async () => {
    const router = createGatewayRouter({ runtime: buildRuntime().runtime });
    const response = await invoke(router, { body: { not: "valid" }, method: "POST", url: "/request" });
    expect(response.statusCode).toBe(400);
    expect(response._getJSONData().ok).toBe(false);
    expect(response._getJSONData().error.code).toBe("invalid_request");
  });

  test("reads a session snapshot and passes the id through", async () => {
    const { captured, runtime } = buildRuntime();
    const router = createGatewayRouter({ runtime });
    const response = await invoke(router, { method: "GET", url: "/sessions/session.abc/snapshot" });
    expect(response._getJSONData()).toMatchObject({ found: true, sessionId: "session.abc" });
    expect(captured.snapshotId).toBe("session.abc");
  });

  test("maps runtime errors to HTTP status codes", async () => {
    const router = createGatewayRouter({
      runtime: buildRuntime({
        getSessionSnapshot: async () => {
          throw { code: "not_found", details: {}, message: "missing", retriable: false };
        }
      }).runtime
    });
    const response = await invoke(router, { method: "GET", url: "/sessions/missing/snapshot" });
    expect(response.statusCode).toBe(404);
    expect(response._getJSONData().error.code).toBe("not_found");
  });

  test("parses approval list query parameters", async () => {
    const { captured, runtime } = buildRuntime();
    const router = createGatewayRouter({ runtime });
    const response = await invoke(router, {
      method: "GET",
      query: { limit: "5", pendingOnly: "true", sessionId: "session.x" },
      url: "/approvals"
    });
    expect(response._getJSONData()).toEqual({ approvals: [] });
    expect(captured.approvalsQuery).toMatchObject({ limit: 5, pendingOnly: true, sessionId: "session.x" });
  });

  test("reads a single approval record", async () => {
    const { captured, runtime } = buildRuntime();
    const router = createGatewayRouter({ runtime });
    const response = await invoke(router, { method: "GET", url: "/approvals/approval.42" });
    expect(response._getJSONData()).toMatchObject({ request: { id: "approval.42" } });
    expect(captured.approvalId).toBe("approval.42");
  });

  test("parses event replay query parameters including topic lists", async () => {
    const { captured, runtime } = buildRuntime();
    const router = createGatewayRouter({ runtime });
    const response = await invoke(router, {
      method: "GET",
      query: { cursor: "c1", limit: "2", topics: "message.created,run.updated" },
      url: "/events"
    });
    expect(response._getJSONData()).toEqual({ events: [] });
    expect(captured.eventsQuery).toMatchObject({ cursor: "c1", limit: 2, topics: ["message.created", "run.updated"] });
  });
});

describe("handleGatewayRequest", () => {
  const requestEnvelope = {
    createdAt: "2026-06-10T12:00:00.000Z",
    id: "gateway-request.1",
    metadata: {},
    payload: {},
    topic: "gateway.health" as const
  };

  test("returns the runtime response on success", async () => {
    const response = await handleGatewayRequest(requestEnvelope, { runtime: buildRuntime().runtime });
    expect(response.ok).toBe(true);
    expect(response.topic).toBe("gateway.health");
  });

  test("converts thrown runtime errors into error responses", async () => {
    const response = await handleGatewayRequest(requestEnvelope, {
      runtime: buildRuntime({
        request: async () => {
          throw new Error("runtime exploded");
        }
      }).runtime
    });
    expect(response.ok).toBe(false);
    expect(response.error?.message).toContain("runtime exploded");
  });
});
