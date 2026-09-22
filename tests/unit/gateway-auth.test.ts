import type { IncomingMessage } from "node:http";

import httpMocks from "node-mocks-http";
import { describe, expect, test } from "vitest";

import {
  assertGatewayExposureIsAuthenticated,
  authorizeGatewayHttpRequest,
  authorizeGatewayUpgradeRequest,
  isLoopbackAddress
} from "@/gateway";

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

  // Security review H2. This previously asserted the opposite ("honors the
  // first x-forwarded-for hop"), which is exactly the bypass: the header is
  // client-supplied, so trusting it let any remote caller claim to be loopback.
  test("ignores a spoofed x-forwarded-for and refuses the real remote address", () => {
    const request = httpMocks.createRequest({
      headers: { "x-forwarded-for": "127.0.0.1, 10.0.0.9" },
      method: "GET",
      url: "/x"
    });
    Object.defineProperty(request.socket, "remoteAddress", { value: "10.0.0.9" });

    const result = authorizeGatewayHttpRequest(request);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.statusCode).toBe(401);
  });

  test("ignores a spoofed x-forwarded-for on WebSocket upgrades too", () => {
    const result = authorizeGatewayUpgradeRequest(
      upgradeRequest({
        headers: { host: "localhost", "x-forwarded-for": "127.0.0.1" },
        remoteAddress: "10.0.0.9",
        url: "/ws"
      })
    );
    expect(result.ok).toBe(false);
  });

  // Security review M13: this used to be a warning, so the insecure
  // configuration still came up and served traffic.
  describe("assertGatewayExposureIsAuthenticated", () => {
    test("allows an untokened gateway only on loopback with no tunnel", () => {
      expect(() => assertGatewayExposureIsAuthenticated({ hostname: "127.0.0.1", tunnelEnabled: false })).not.toThrow();
    });

    test("refuses an untokened gateway bound to a routable address", () => {
      expect(() => assertGatewayExposureIsAuthenticated({ hostname: "192.168.1.20", tunnelEnabled: false })).toThrow(
        /gateway\.auth\.token/u
      );
    });

    test("refuses an untokened gateway bound to every interface", () => {
      expect(() => assertGatewayExposureIsAuthenticated({ hostname: "0.0.0.0", tunnelEnabled: false })).toThrow(
        /every interface/u
      );
      expect(() => assertGatewayExposureIsAuthenticated({ hostname: "::", tunnelEnabled: false })).toThrow(
        /every interface/u
      );
    });

    // The case header handling cannot catch: the tunnel terminates in front of
    // us and forwards to the loopback socket, so remote traffic is genuinely
    // loopback by the time we see it.
    test("refuses an untokened loopback gateway when a tunnel is enabled", () => {
      expect(() => assertGatewayExposureIsAuthenticated({ hostname: "127.0.0.1", tunnelEnabled: true })).toThrow(
        /tunnel is enabled/u
      );
    });

    test("allows any exposure once a token is configured", () => {
      expect(() =>
        assertGatewayExposureIsAuthenticated({ hostname: "0.0.0.0", token: "secret", tunnelEnabled: true })
      ).not.toThrow();
    });
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
