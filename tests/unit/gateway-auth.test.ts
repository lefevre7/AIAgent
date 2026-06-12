import type { IncomingMessage } from "node:http";

import httpMocks from "node-mocks-http";
import { describe, expect, test } from "vitest";

import { authorizeGatewayHttpRequest, authorizeGatewayUpgradeRequest, isLoopbackAddress } from "@/gateway";

function upgradeRequest(params: {
  headers?: Record<string, string | string[]>;
  remoteAddress?: string;
  url?: string;
}): IncomingMessage {
  return {
    headers: params.headers ?? {},
    socket: { remoteAddress: params.remoteAddress },
    url: params.url
  } as unknown as IncomingMessage;
}

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

  test("requires a token when one is configured but none is presented", () => {
    const request = httpMocks.createRequest({ headers: {}, method: "GET", url: "/x" });
    Object.defineProperty(request.socket, "remoteAddress", { value: "127.0.0.1" });
    const result = authorizeGatewayHttpRequest(request, { token: "secret" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("authentication_required");
    }
  });

  test("accepts a valid token via the Authorization header", () => {
    const request = httpMocks.createRequest({ headers: { authorization: "Bearer secret" }, method: "GET", url: "/x" });
    Object.defineProperty(request.socket, "remoteAddress", { value: "10.0.0.9" });
    expect(authorizeGatewayHttpRequest(request, { token: "secret" }).ok).toBe(true);
  });

  test("accepts a token via the x-aia-gateway-token header and the query string", () => {
    const headerRequest = httpMocks.createRequest({
      headers: { "x-aia-gateway-token": ["secret"] },
      method: "GET",
      url: "/x"
    });
    Object.defineProperty(headerRequest.socket, "remoteAddress", { value: "10.0.0.9" });
    expect(authorizeGatewayHttpRequest(headerRequest, { token: "secret" }).ok).toBe(true);

    const queryRequest = httpMocks.createRequest({ method: "GET", query: { token: "secret" }, url: "/x?token=secret" });
    Object.defineProperty(queryRequest.socket, "remoteAddress", { value: "10.0.0.9" });
    expect(authorizeGatewayHttpRequest(queryRequest, { token: "secret" }).ok).toBe(true);
  });

  test("honors the first x-forwarded-for hop for loopback detection", () => {
    const request = httpMocks.createRequest({
      headers: { "x-forwarded-for": "127.0.0.1, 10.0.0.9" },
      method: "GET",
      url: "/x"
    });
    Object.defineProperty(request.socket, "remoteAddress", { value: "10.0.0.9" });
    expect(authorizeGatewayHttpRequest(request).ok).toBe(true);
  });

  test("authorizes WebSocket upgrades by token query, loopback, and rejects others", () => {
    expect(authorizeGatewayUpgradeRequest(upgradeRequest({ remoteAddress: "127.0.0.1", url: "/ws" })).ok).toBe(true);

    const tokened = authorizeGatewayUpgradeRequest(
      upgradeRequest({ headers: { host: "localhost" }, remoteAddress: "10.0.0.9", url: "/ws?token=secret" }),
      { token: "secret" }
    );
    expect(tokened.ok).toBe(true);

    const bearer = authorizeGatewayUpgradeRequest(
      upgradeRequest({ headers: { authorization: "Bearer secret" }, remoteAddress: "10.0.0.9", url: "/ws" }),
      { token: "secret" }
    );
    expect(bearer.ok).toBe(true);

    const rejected = authorizeGatewayUpgradeRequest(upgradeRequest({ remoteAddress: "10.0.0.9", url: "/ws" }));
    expect(rejected.ok).toBe(false);

    // No url present → falls back to undefined token, loopback still wins.
    expect(authorizeGatewayUpgradeRequest(upgradeRequest({ remoteAddress: "::1" })).ok).toBe(true);
  });

  test("isLoopbackAddress normalizes IPv6, scopes, and mapped addresses", () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("[::1]")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("localhost")).toBe(true);
    expect(isLoopbackAddress("fe80::1%eth0")).toBe(false);
    expect(isLoopbackAddress("10.0.0.9")).toBe(false);
  });
});
