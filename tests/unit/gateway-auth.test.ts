import httpMocks from "node-mocks-http";
import { describe, expect, test } from "vitest";

import { authorizeGatewayHttpRequest } from "@/gateway";

describe("gateway auth", () => {
  test("allows loopback HTTP requests when no token is configured", () => {
    const request = httpMocks.createRequest({
      headers: {},
      method: "GET",
      url: "/api/gateway/health"
    });
    Object.defineProperty(request.socket, "remoteAddress", {
      value: "127.0.0.1"
    });

    const result = authorizeGatewayHttpRequest(request);

    expect(result.ok).toBe(true);
  });

  test("rejects non-loopback HTTP requests when no token is configured", () => {
    const request = httpMocks.createRequest({
      headers: {},
      method: "GET",
      url: "/api/gateway/health"
    });
    Object.defineProperty(request.socket, "remoteAddress", {
      value: "10.0.0.24"
    });

    const result = authorizeGatewayHttpRequest(request);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.statusCode).toBe(401);
    expect(result.error.code).toBe("authentication_required");
  });

  test("requires the configured token even on loopback", () => {
    const request = httpMocks.createRequest({
      headers: {
        authorization: "Bearer wrong-token"
      },
      method: "GET",
      url: "/api/gateway/health"
    });
    Object.defineProperty(request.socket, "remoteAddress", {
      value: "::1"
    });

    const result = authorizeGatewayHttpRequest(request, {
      token: "secret-token"
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.statusCode).toBe(401);
    expect(result.error.code).toBe("unauthorized");
  });
});
