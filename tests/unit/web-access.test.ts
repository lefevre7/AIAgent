import httpMocks from "node-mocks-http";
import { describe, expect, test } from "vitest";

import { WEB_ACCESS_COOKIE_NAME, authorizeWebAccessRequest } from "@/server/web-access";

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
