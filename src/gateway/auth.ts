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
    remoteAddress: request.socket.remoteAddress,
    presentedToken:
      extractAuthorizationToken(request.headers.authorization) ??
      firstHeaderValue(request.headers["x-aia-gateway-token"]) ??
      url?.searchParams.get("token") ??
      undefined
  });
}

/**
 * Refuses to start an exposed gateway that has no token.
 *
 * Dropping `X-Forwarded-For` (H2) closes header spoofing but not the shape that
 * actually bites: a tunnel or reverse proxy terminating in front of us forwards
 * to the loopback socket, so every remote request *is* genuinely loopback and
 * the loopback allowance hands it full access. The only reliable signal is our
 * own configuration — if we bind somewhere routable, or a tunnel is enabled,
 * remote traffic is possible and a token is mandatory.
 *
 * Previously this was only a warning (security review M13), which meant the
 * insecure configuration still came up and served traffic.
 */
export function assertGatewayExposureIsAuthenticated(params: {
  hostname: string;
  token?: string;
  tunnelEnabled: boolean;
}): void {
  if (params.token) {
    return;
  }

  const reasons: string[] = [];
  if (!isLoopbackAddress(params.hostname) && !isUnspecifiedAddress(params.hostname)) {
    reasons.push(`the server binds to the routable address "${params.hostname}"`);
  } else if (isUnspecifiedAddress(params.hostname)) {
    reasons.push(`the server binds to "${params.hostname}", which accepts connections on every interface`);
  }
  if (params.tunnelEnabled) {
    reasons.push("a tunnel is enabled, so requests can arrive from outside this machine");
  }

  if (reasons.length === 0) {
    return;
  }

  throw new Error(
    `Refusing to start without "gateway.auth.token": ${reasons.join(" and ")}. ` +
      "Any client reaching the gateway would get unauthenticated access to sessions, tools, and approvals. " +
      'Set gateway.auth.token in aia.config.jsonc (or bind to "127.0.0.1" and disable the tunnel).'
  );
}

/**
 * `0.0.0.0` / `::` bind every interface, so they are routable in practice even
 * though they are not themselves a remote address.
 */
function isUnspecifiedAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "0.0.0.0" || normalized === "::" || normalized === "*";
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

  // The peer address comes from the socket only. `X-Forwarded-For` is
  // client-supplied: honouring it let any remote caller present
  // `X-Forwarded-For: 127.0.0.1` and be treated as loopback (security review
  // H2). A real reverse-proxy deployment is not loopback and must configure
  // `gateway.auth.token`, which `assertGatewayExposureIsAuthenticated`
  // now requires up front.
  if (isLoopbackAddress(params.remoteAddress)) {
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
