import { EventEmitter } from "node:events";

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
    const app = createHttpApp((_request, response) => {
      response.status(200).send("next-handler");
    }, {
      gateway: {
        runtime: gatewayRuntimeStub
      }
    });

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
});
