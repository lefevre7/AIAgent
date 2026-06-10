import type { IncomingMessage } from "node:http";

import type { Request } from "express";

import { createGatewayError } from "@/gateway/errors";

export type GatewayAuthOptions = {
  token?: string;
};

export type GatewayAuthorizationResult =
  | {
      ok: true;
    }
  | {
      error: ReturnType<typeof createGatewayError>;
      ok: false;
      statusCode: number;
    };

export function authorizeGatewayHttpRequest(request: Request, options: GatewayAuthOptions = {}): GatewayAuthorizationResult {
  return authorizeGatewayAccess({
    configuredToken: options.token,
    forwardedFor: firstHeaderValue(request.headers["x-forwarded-for"]),
    remoteAddress: request.socket.remoteAddress,
    presentedToken:
      extractAuthorizationToken(request.headers.authorization) ??
      firstHeaderValue(request.headers["x-aia-gateway-token"]) ??
      firstQueryValue(request.query.token)
  });
}

export function authorizeGatewayUpgradeRequest(
  request: IncomingMessage,
  options: GatewayAuthOptions = {}
): GatewayAuthorizationResult {
  const url = request.url ? new URL(request.url, `http://${request.headers.host ?? "localhost"}`) : null;
  return authorizeGatewayAccess({
    configuredToken: options.token,
    forwardedFor: firstHeaderValue(request.headers["x-forwarded-for"]),
    remoteAddress: request.socket.remoteAddress,
    presentedToken:
      extractAuthorizationToken(request.headers.authorization) ??
      firstHeaderValue(request.headers["x-aia-gateway-token"]) ??
      url?.searchParams.get("token") ??
      undefined
  });
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }

  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  const withoutScope = normalized.split("%")[0] ?? normalized;
  const withoutPrefix = withoutScope.startsWith("::ffff:") ? withoutScope.slice("::ffff:".length) : withoutScope;

  return withoutPrefix === "127.0.0.1" || withoutPrefix === "::1" || withoutPrefix === "localhost";
}

function authorizeGatewayAccess(params: {
  configuredToken?: string;
  forwardedFor?: string;
  presentedToken?: string;
  remoteAddress?: string;
}): GatewayAuthorizationResult {
  if (params.configuredToken) {
    if (!params.presentedToken) {
      return {
        error: createGatewayError("authentication_required", "Gateway authentication token is required."),
        ok: false,
        statusCode: 401
      };
    }

    if (params.presentedToken !== params.configuredToken) {
      return {
        error: createGatewayError("unauthorized", "Gateway authentication token is invalid."),
        ok: false,
        statusCode: 401
      };
    }

    return {
      ok: true
    };
  }

  const requestAddress = params.forwardedFor?.split(",")[0]?.trim() || params.remoteAddress;
  if (isLoopbackAddress(requestAddress)) {
    return {
      ok: true
    };
  }

  return {
    error: createGatewayError(
      "authentication_required",
      "Gateway authentication token is required for non-loopback access."
    ),
    ok: false,
    statusCode: 401
  };
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function extractAuthorizationToken(value: string | string[] | undefined): string | undefined {
  const raw = firstHeaderValue(value);
  if (!raw) {
    return undefined;
  }

  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? raw;
}

function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (Array.isArray(value)) {
    const first = value.find((entry): entry is string => typeof entry === "string" && entry.length > 0);
    return first;
  }

  return undefined;
}
