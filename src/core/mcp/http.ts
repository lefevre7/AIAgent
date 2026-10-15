import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { sleep } from "@/core/io/files";
import { fetchFollowingSameOriginRedirects, isTransientNetworkError, TRANSIENT_HTTP_STATUSES } from "@/core/io/http";
import { readPackageVersion } from "@/core/package-info";

// Codex's schedule: a transient failure of the handshake or a listing is
// tried again after 250 ms, then after 1 s.
export const MCP_TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [250, 1_000];

export function mcpUserAgent(): string {
  return `aia-mcp-client/${readPackageVersion()}`;
}

/**
 * The fetch every HTTP MCP transport uses, the OAuth flow's included.
 *
 * - `headers` (static ones from config, such as an API key) reach every request
 *   to the server's own origin (`serverUrl`), the SSE stream's GET included,
 *   without replacing a header the SDK set. They never reach another origin:
 *   the SDK fetches an authorization server's metadata, registers a client and
 *   exchanges tokens through this same fetch, and the server chooses which
 *   authorization server that is.
 * - A `User-Agent` names aia and its version.
 * - Redirects are followed by hand, only within the request's own origin (see
 *   `fetchFollowingSameOriginRedirects`).
 */
export function createMcpFetch(params: {
  fetchImpl: typeof fetch;
  headers?: Record<string, string>;
  /** The configured server URL: its origin is the only one the static headers go to. */
  serverUrl: string;
}): typeof fetch {
  const staticHeaders = Object.entries(params.headers ?? {});
  const serverOrigin = new URL(params.serverUrl).origin;
  const userAgent = mcpUserAgent();
  return async (input, init) => {
    // The SDK passes a URL and an init; a Request's own headers and method
    // still count if one arrives.
    const request = typeof Request !== "undefined" && input instanceof Request ? input : undefined;
    const url = new URL(request ? request.url : String(input));
    const headers = new Headers(request?.headers);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    if (url.origin === serverOrigin) {
      for (const [key, value] of staticHeaders) {
        if (!headers.has(key)) {
          headers.set(key, value);
        }
      }
    }
    if (!headers.has("user-agent")) {
      headers.set("user-agent", userAgent);
    }

    return fetchFollowingSameOriginRedirects({
      fetchImpl: params.fetchImpl,
      init: {
        ...(request ? { method: request.method } : {}),
        ...init,
        headers
      },
      label: "The MCP server",
      url
    });
  };
}

/**
 * Whether a failure is worth trying again: a network error, or a 408, 429, or
 * temporary 5xx from the server (the same rule model requests use). Never an
 * authorization failure (401/403): trying again cannot fix a credential.
 */
export function isTransientMcpError(error: unknown): boolean {
  if (error instanceof StreamableHTTPError) {
    return typeof error.code === "number" && TRANSIENT_HTTP_STATUSES.has(error.code);
  }
  const status = readHttpStatus(error);
  if (status !== undefined) {
    return TRANSIENT_HTTP_STATUSES.has(status);
  }
  return isTransientNetworkError(error);
}

/** A 404 for a request carrying a session id: the server forgot the session. */
export function isMcpSessionExpired(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 404;
}

/** A 401 (or a 403 challenge) from an HTTP MCP server: it wants credentials. */
export function isMcpAuthorizationError(error: unknown): boolean {
  if (error instanceof StreamableHTTPError) {
    return error.code === 401;
  }
  // The SDK's auth() throws this when a server needs a sign-in it cannot do
  // by itself (its constructor never sets `name`, so match the class).
  if (error instanceof UnauthorizedError) {
    return true;
  }
  return readHttpStatus(error) === 401;
}

/**
 * Runs `operation`, and again after each delay while it fails transiently.
 * `factory` style (each attempt builds what it needs) so a failed handshake
 * never reuses a half-closed client.
 */
export async function retryTransientMcpFailures<T>(
  operation: () => Promise<T>,
  options: { delaysMs?: readonly number[]; sleep?: (ms: number) => Promise<void> } = {}
): Promise<T> {
  const delays = options.delaysMs ?? MCP_TRANSIENT_RETRY_DELAYS_MS;
  const pause = options.sleep ?? sleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= delays.length || !isTransientMcpError(error)) {
        throw error;
      }
      await pause(delays[attempt]!);
    }
  }
}

function readHttpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  // The SSE transport reports the stream's status as `code`.
  const candidate = (error as { code?: unknown; status?: unknown }).status ?? (error as { code?: unknown }).code;
  return typeof candidate === "number" && candidate >= 100 && candidate < 600 ? candidate : undefined;
}
