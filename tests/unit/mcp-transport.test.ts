import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, test } from "vitest";

import { connectMcpClient, shouldFallbackToSse } from "@/core";

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

describe("connectMcpClient URL checks", () => {
  const httpServer = (url: string) => ({
    enabled: true,
    headers: {},
    required: false,
    startupTimeoutMs: 1_000,
    tags: [],
    type: "streamable-http" as const,
    url
  });
  // Fails at once, so each case only exercises the checks before a request.
  const refuse = (async () => {
    throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
  }) as unknown as typeof fetch;
  const connect = (serverName: string, url: string) =>
    connectMcpClient({
      elicitation: false,
      fetchImpl: refuse,
      globalPassEnv: [],
      serverConfig: httpServer(url),
      serverName
    });

  async function warningsDuring(run: () => Promise<unknown>): Promise<string[]> {
    const warnings: string[] = [];
    const listener = (warning: Error & { code?: string }) => {
      if (warning.code === "AIA_MCP_INSECURE_URL") {
        warnings.push(warning.message);
      }
    };
    process.on("warning", listener);
    try {
      await run().catch(() => undefined);
      // process warnings are delivered on a later tick.
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("warning", listener);
    }
    return warnings;
  }

  test("warns once about plain http to another machine, and not about this one or https", async () => {
    const remote = await warningsDuring(async () => {
      await connect("plain-remote", "http://mcp.internal.example:8080/mcp").catch(() => undefined);
      await connect("plain-remote", "http://mcp.internal.example:8080/mcp");
    });
    expect(remote).toHaveLength(1);
    expect(remote[0]).toContain(
      'MCP server "plain-remote" is reached over plain http (http://mcp.internal.example:8080)'
    );

    const quiet = await warningsDuring(async () => {
      await connect("loopback", "http://127.0.0.1:8931/mcp").catch(() => undefined);
      await connect("localhost", "http://localhost:8931/mcp").catch(() => undefined);
      await connect("ipv6", "http://[::1]:8931/mcp").catch(() => undefined);
      await connect("secure", "https://mcp.example.com/mcp");
    });
    expect(quiet).toEqual([]);
  });

  test("refuses a URL that is not http(s), which an imported server could carry past the schema", async () => {
    await expect(connect("imported", "file:///etc/passwd")).rejects.toThrow(
      'MCP server "imported" must be reached over http:// or https://, not file:'
    );
  });
});
