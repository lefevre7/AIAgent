import type { Request, RequestHandler, Response } from "express";

import { isLoopbackAddress } from "@/gateway/auth";
import { createGatewayError } from "@/gateway/errors";

export const WEB_ACCESS_COOKIE_NAME = "aia_access_token";

export type WebAccessOptions = {
  cookieName?: string;
  token?: string;
};

type WebAccessAuthorizationResult =
  | {
      ok: true;
      redirectTo?: string;
      setCookie?: string;
    }
  | {
      error: ReturnType<typeof createGatewayError>;
      ok: false;
      statusCode: number;
    };

export function authorizeWebAccessRequest(
  request: Request,
  options: WebAccessOptions = {},
  mode: "api" | "page" = "page"
): WebAccessAuthorizationResult {
  const cookieName = options.cookieName ?? WEB_ACCESS_COOKIE_NAME;
  const cookies = parseCookieHeader(request.headers.cookie);
  const queryToken = readQueryValue(request.query.token);
  const presentedToken =
    extractAuthorizationToken(request.headers.authorization) ??
    firstHeaderValue(request.headers["x-aia-gateway-token"]) ??
    firstHeaderValue(request.headers["x-aia-web-token"]) ??
    cookies[cookieName] ??
    queryToken;

  if (options.token) {
    if (!presentedToken) {
      return {
        error: createGatewayError("authentication_required", "A gateway authentication token is required for remote access."),
        ok: false,
        statusCode: 401
      };
    }

    if (presentedToken !== options.token) {
      return {
        error: createGatewayError("unauthorized", "The supplied gateway authentication token is invalid."),
        ok: false,
        statusCode: 401
      };
    }

    const result: Extract<WebAccessAuthorizationResult, { ok: true }> = {
      ok: true
    };

    if (queryToken === options.token) {
      result.setCookie = serializeCookie(cookieName, options.token, request);
      if (mode === "page") {
        result.redirectTo = stripTokenFromUrl(request.originalUrl || request.url);
      }
    }

    return result;
  }

  const requestAddress = firstHeaderValue(request.headers["x-forwarded-for"])?.split(",")[0]?.trim() || request.socket.remoteAddress;
  if (isLoopbackAddress(requestAddress)) {
    return {
      ok: true
    };
  }

  return {
    error: createGatewayError(
      "authentication_required",
      "Remote access is disabled without gateway.auth.token. Use loopback access or configure a token."
    ),
    ok: false,
    statusCode: 401
  };
}

export function createControlPlaneAccessMiddleware(options: WebAccessOptions = {}): RequestHandler {
  return (request, response, next) => {
    const authorization = authorizeWebAccessRequest(request, options, "api");
    if (!authorization.ok) {
      response.status(authorization.statusCode).json({
        error: authorization.error,
        ok: false
      });
      return;
    }

    if (authorization.setCookie) {
      response.append("Set-Cookie", authorization.setCookie);
    }
    next();
  };
}

export function createWebAccessMiddleware(options: WebAccessOptions = {}): RequestHandler {
  return (request, response, next) => {
    const authorization = authorizeWebAccessRequest(request, options, "page");
    if (!authorization.ok) {
      respondUnauthorizedHtml(response, authorization.statusCode, authorization.error.message);
      return;
    }

    if (authorization.setCookie) {
      response.append("Set-Cookie", authorization.setCookie);
    }
    if (authorization.redirectTo && authorization.redirectTo !== request.originalUrl) {
      response.redirect(303, authorization.redirectTo);
      return;
    }

    next();
  };
}

function extractAuthorizationToken(value: string | string[] | undefined): string | undefined {
  const raw = firstHeaderValue(value);
  if (!raw) {
    return undefined;
  }

  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? raw;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseCookieHeader(value: string | undefined): Record<string, string> {
  if (!value) {
    return {};
  }

  const entries = value
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separatorIndex = entry.indexOf("=");
      if (separatorIndex <= 0) {
        return null;
      }

      return [
        decodeURIComponent(entry.slice(0, separatorIndex)),
        decodeURIComponent(entry.slice(separatorIndex + 1))
      ] as const;
    })
    .filter((entry): entry is readonly [string, string] => entry !== null);

  return Object.fromEntries(entries);
}

function readQueryValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.find((entry): entry is string => typeof entry === "string" && entry.length > 0);
  }

  return undefined;
}

function respondUnauthorizedHtml(response: Response, statusCode: number, message: string): void {
  response.status(statusCode).type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AIAgent Remote Access</title>
    <style>
      body { font-family: "IBM Plex Sans", sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f1e7; color: #1d261f; }
      main { max-width: 36rem; margin: 2rem; padding: 2rem; border-radius: 1rem; background: rgba(255,255,255,0.92); box-shadow: 0 20px 60px rgba(29,38,31,0.12); }
      h1 { margin-top: 0; }
      p { margin-bottom: 0; line-height: 1.6; }
    </style>
  </head>
  <body>
    <main>
      <h1>Remote Access Locked</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`);
}

function serializeCookie(name: string, value: string, request: Request): string {
  const secure =
    request.secure ||
    firstHeaderValue(request.headers["x-forwarded-proto"])?.split(",")[0]?.trim().toLowerCase() === "https";
  return [
    `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=2592000",
    ...(secure ? ["Secure"] : [])
  ].join("; ");
}

function stripTokenFromUrl(value: string): string {
  const url = new URL(value, "http://localhost");
  url.searchParams.delete("token");
  return `${url.pathname}${url.search}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
