import { EventEmitter } from "node:events";

import httpMocks from "node-mocks-http";
import { describe, expect, test } from "vitest";

import { gatewayResponseSchema } from "@/core/contracts";
import type { GatewayRuntimeLike } from "@/gateway";
import { createGatewayRouter } from "@/gateway";

describe("gateway router", () => {
  test("dispatches request envelopes through the shared gateway runtime", async () => {
    const runtime: GatewayRuntimeLike = {
      getApprovalRecord: async () => {
        throw new Error("not used");
      },
      getSessionSnapshot: async () => {
        throw new Error("not used");
      },
      listApprovalRecords: async () => [],
      replayEvents: async () => ({
        events: []
      }),
      request: async (request) =>
        gatewayResponseSchema.parse({
          createdAt: "2026-03-31T12:00:00.000Z",
          id: "gateway-response.external-agent.1",
          metadata: {},
          ok: true,
          payload: {
            definitions: [
              {
                command: "codex",
                defaultArgs: [],
                displayName: "Codex CLI",
                id: "codex",
                kind: "codex",
                metadata: {},
                resumeSupported: true,
                structuredOutputSupported: true
              }
            ],
            jobs: []
          },
          requestId: request.id,
          topic: request.topic
        }),
      subscribe: () => () => undefined
    };
    const router = createGatewayRouter({
      requestTimeoutMs: 5_000,
      runtime
    });

    const request = httpMocks.createRequest({
      body: {
        createdAt: "2026-03-31T12:00:00.000Z",
        id: "gateway-request.external-agent.1",
        metadata: {},
        payload: {
          limit: 10
        },
        topic: "external_agent.list"
      },
      headers: {
        "content-type": "application/json"
      },
      method: "POST",
      url: "/request"
    });
    Object.defineProperty(request.socket, "remoteAddress", {
      value: "127.0.0.1"
    });
    const response = httpMocks.createResponse({
      eventEmitter: EventEmitter
    });
    const handler = router as unknown as {
      handle: (request: unknown, response: unknown, next: (error?: unknown) => void) => void;
    };

    await new Promise<void>((resolve, reject) => {
      response.on("end", resolve);
      response.on("finish", resolve);

      handler.handle(request, response, (error: unknown) => {
        reject(error);
      });
    });

    expect(response.statusCode).toBe(200);
    expect(response._getJSONData().ok).toBe(true);
    expect(response._getJSONData().topic).toBe("external_agent.list");
    expect(response._getJSONData().payload).toMatchObject({
      definitions: [
        {
          id: "codex"
        }
      ],
      jobs: []
    });
  });
});
