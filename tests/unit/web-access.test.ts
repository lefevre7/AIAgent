import { EventEmitter } from "node:events";

import httpMocks from "node-mocks-http";
import { describe, expect, test, vi } from "vitest";

import {
  WEB_ACCESS_COOKIE_NAME,
  authorizeWebAccessRequest,
  createControlPlaneAccessMiddleware,
  createWebAccessMiddleware
} from "@/server/web-access";
import type { Request } from "express";

describe("web access auth", () => {
  test("allows loopback page requests when no token is configured", () => {
    const request = httpMocks.createRequest({
      method: "GET",
      url: "/"
    });
    Object.defineProperty(request.socket, "remoteAddress", {
      value: "127.0.0.1"
    });

    const result = authorizeWebAccessRequest(request);

    expect(result.ok).toBe(true);
  });

  test("rejects remote page requests when no token is configured", () => {
    const request = httpMocks.createRequest({
      method: "GET",
      url: "/"
    });
    Object.defineProperty(request.socket, "remoteAddress", {
      value: "10.0.0.24"
    });

    const result = authorizeWebAccessRequest(request);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.statusCode).toBe(401);
    expect(result.error.code).toBe("authentication_required");
  });

  test("accepts a valid token from the query string and requests a cookie-backed redirect", () => {
    const request = httpMocks.createRequest({
      method: "GET",
      query: {
        token: "secret-token"
      },
      url: "/?token=secret-token"
    });
    request.originalUrl = "/?token=secret-token";
    Object.defineProperty(request.socket, "remoteAddress", {
      value: "203.0.113.9"
    });

    const result = authorizeWebAccessRequest(request, {
      token: "secret-token"
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.redirectTo).toBe("/");
    expect(result.setCookie).toContain(`${WEB_ACCESS_COOKIE_NAME}=secret-token`);
  });
});

function buildRequest(options: {
  authorization?: string;
  cookie?: string;
  query?: Record<string, unknown>;
  remoteAddress?: string;
  url?: string;
  webToken?: string;
}): Request {
  const headers: Record<string, string> = {};
  if (options.authorization) headers.authorization = options.authorization;
  if (options.cookie) headers.cookie = options.cookie;
  if (options.webToken) headers["x-aia-web-token"] = options.webToken;
  const request = httpMocks.createRequest({ headers, method: "GET", query: options.query ?? {}, url: options.url ?? "/" });
  request.originalUrl = options.url ?? "/";
  Object.defineProperty(request.socket, "remoteAddress", { value: options.remoteAddress ?? "127.0.0.1" });
  return request as unknown as Request;
}

describe("authorizeWebAccessRequest token sources", () => {
  test("requires and validates the configured token across header, cookie, and custom header", () => {
    expect(authorizeWebAccessRequest(buildRequest({ remoteAddress: "10.0.0.5" }), { token: "secret" })).toMatchObject({ ok: false });
    expect(
      authorizeWebAccessRequest(buildRequest({ authorization: "Bearer wrong", remoteAddress: "10.0.0.5" }), { token: "secret" })
    ).toMatchObject({ ok: false });
    expect(authorizeWebAccessRequest(buildRequest({ authorization: "Bearer secret" }), { token: "secret" }).ok).toBe(true);
    expect(authorizeWebAccessRequest(buildRequest({ cookie: "aia_access_token=secret" }), { token: "secret" }).ok).toBe(true);
    expect(authorizeWebAccessRequest(buildRequest({ webToken: "secret" }), { token: "secret" }).ok).toBe(true);
  });

  test("api-mode query token sets a cookie without a redirect", () => {
    const result = authorizeWebAccessRequest(
      buildRequest({ query: { token: "secret" }, url: "/api?token=secret" }),
      { token: "secret" },
      "api"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.setCookie).toBeTruthy();
      expect(result.redirectTo).toBeUndefined();
    }
  });
});

function invokeMiddleware(handler: ReturnType<typeof createControlPlaneAccessMiddleware>, request: Request) {
  const response = httpMocks.createResponse({ eventEmitter: EventEmitter });
  const next = vi.fn();
  handler(request, response as never, next as never);
  return { next, response };
}

describe("web access middlewares", () => {
  test("control-plane middleware passes loopback and rejects remote with a JSON envelope", () => {
    const ok = invokeMiddleware(createControlPlaneAccessMiddleware(), buildRequest({ remoteAddress: "127.0.0.1" }));
    expect(ok.next).toHaveBeenCalledOnce();

    const denied = invokeMiddleware(createControlPlaneAccessMiddleware({ token: "secret" }), buildRequest({ remoteAddress: "10.0.0.5" }));
    expect(denied.next).not.toHaveBeenCalled();
    expect(denied.response.statusCode).toBe(401);
    expect(denied.response._getJSONData()).toMatchObject({ ok: false });
  });

  test("control-plane middleware appends a cookie for query-token access", () => {
    const { next, response } = invokeMiddleware(
      createControlPlaneAccessMiddleware({ token: "secret" }),
      buildRequest({ query: { token: "secret" }, remoteAddress: "10.0.0.5", url: "/api?token=secret" })
    );
    expect(next).toHaveBeenCalledOnce();
    expect(response.getHeader("Set-Cookie")).toBeTruthy();
  });

  test("page middleware renders an HTML lock screen on denial", () => {
    const { next, response } = invokeMiddleware(createWebAccessMiddleware({ token: "secret" }), buildRequest({ remoteAddress: "10.0.0.5" }));
    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(401);
    expect(response._getData()).toContain("Remote Access Locked");
  });

  test("page middleware redirects to strip a query token", () => {
    const { next, response } = invokeMiddleware(
      createWebAccessMiddleware({ token: "secret" }),
      buildRequest({ query: { token: "secret" }, remoteAddress: "10.0.0.5", url: "/?token=secret" })
    );
    expect(next).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(303);
    expect(response._getRedirectUrl()).toBe("/");
  });
});
