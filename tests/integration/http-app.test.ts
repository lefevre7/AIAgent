import { EventEmitter } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";

import httpMocks from "node-mocks-http";

import type { GatewayRuntimeLike } from "@/gateway";
import { createHttpApp } from "@/server/create-http-app";

const gatewayRuntimeStub: GatewayRuntimeLike = {
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
  request: async () => {
    throw new Error("not used");
  },
  subscribe: () => () => undefined
};

async function invoke(app: ReturnType<typeof createHttpApp>, url: string) {
  const request = httpMocks.createRequest({
    method: "GET",
    url
  });
  Object.defineProperty(request.socket, "remoteAddress", {
    value: "127.0.0.1"
  });
  const response = httpMocks.createResponse({
    eventEmitter: EventEmitter
  });

  await new Promise<void>((resolve, reject) => {
    response.on("end", resolve);
    response.on("finish", resolve);

    app.handle(request, response, (error: unknown) => {
      reject(error);
    });
  });

  return response;
}

describe("createHttpApp", () => {
  it("serves the server health payload", async () => {
    const app = createHttpApp((_request, response) => {
      response.status(200).send("next-handler");
    });

    const response = await invoke(app, "/api/health");

    expect(response.statusCode).toBe(200);
    expect(response._getJSONData().ok).toBe(true);
    expect(response._getJSONData().surface).toBe("server");
    expect(response._getJSONData().bootstrap.name).toBe("AIAgent");
  });

  it("serves the gateway health payload", async () => {
    const app = createHttpApp(
      (_request, response) => {
        response.status(200).send("next-handler");
      },
      {
        gateway: {
          runtime: gatewayRuntimeStub
        }
      }
    );

    const response = await invoke(app, "/api/gateway/health");

    expect(response.statusCode).toBe(200);
    expect(response._getJSONData()).toEqual({
      ok: true,
      phase: "bootstrap",
      surface: "gateway"
    });
  });

  it("delegates unmatched routes to the next request handler", async () => {
    const app = createHttpApp((_request, response) => {
      response.status(200).send("handled-by-next");
    });

    const response = await invoke(app, "/anything");

    expect(response.statusCode).toBe(200);
    expect(response._getData()).toBe("handled-by-next");
  });

  // Malformed JSON used to get Express's HTML error page (with a stack trace in
  // development) instead of the JSON envelope API clients parse.
  it("answers an unreadable body with the JSON error envelope", async () => {
    const app = createHttpApp(
      (_request, response) => {
        response.status(200).send("next-handler");
      },
      { gateway: { runtime: gatewayRuntimeStub } }
    );
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const post = async (body: string) =>
        fetch(`http://127.0.0.1:${port}/api/gateway/request`, {
          body,
          headers: { "content-type": "application/json" },
          method: "POST"
        });

      const malformed = await post('{"topic": "gateway.health", ');
      expect(malformed.status).toBe(400);
      expect(malformed.headers.get("content-type")).toContain("application/json");
      expect(await malformed.json()).toEqual({
        error: {
          code: "invalid_request",
          details: {},
          message: "The request body is not valid JSON.",
          retriable: false
        },
        ok: false
      });

      const oversized = await post(JSON.stringify({ padding: "x".repeat(1_100_000) }));
      expect(oversized.status).toBe(413);
      expect((await oversized.json()).error.code).toBe("invalid_request");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
