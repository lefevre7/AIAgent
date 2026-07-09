import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, test } from "vitest";

import { shouldFallbackToSse } from "@/core";

describe("shouldFallbackToSse", () => {
  test("falls back only on a 4xx StreamableHTTPError that is not an auth failure", () => {
    // Server does not speak Streamable HTTP -> fall back to legacy SSE.
    expect(shouldFallbackToSse(new StreamableHTTPError(405, "method not allowed"))).toBe(true);
    expect(shouldFallbackToSse(new StreamableHTTPError(404, "not found"))).toBe(true);
    expect(shouldFallbackToSse(new StreamableHTTPError(400, "bad request"))).toBe(true);
  });

  test("does not fall back on auth failures", () => {
    expect(shouldFallbackToSse(new StreamableHTTPError(401, "unauthorized"))).toBe(false);
    expect(shouldFallbackToSse(new StreamableHTTPError(403, "forbidden"))).toBe(false);
  });

  test("does not fall back on server errors, transport errors, or non-Streamable errors", () => {
    // A real Streamable-HTTP server returning 5xx should surface its own error,
    // not be masked by a second, misleading SSE connection attempt.
    expect(shouldFallbackToSse(new StreamableHTTPError(500, "server error"))).toBe(false);
    // Unexpected content type is coded -1 by the SDK; not a "wrong transport".
    expect(shouldFallbackToSse(new StreamableHTTPError(-1, "unexpected content type"))).toBe(false);
    expect(shouldFallbackToSse(new StreamableHTTPError(undefined, "no code"))).toBe(false);
    expect(shouldFallbackToSse(new Error("network unreachable"))).toBe(false);
    expect(shouldFallbackToSse(new TypeError("fetch failed"))).toBe(false);
    expect(shouldFallbackToSse("weird")).toBe(false);
  });
});
