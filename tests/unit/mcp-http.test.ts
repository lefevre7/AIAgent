import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, test } from "vitest";

import {
  createMcpFetch,
  isMcpAuthorizationError,
  isMcpSessionExpired,
  isTransientMcpError,
  McpCallTimer,
  retryTransientMcpFailures
} from "@/core";

type Recorded = { body: unknown; headers: Headers; method: string; redirect: RequestRedirect | undefined; url: string };

function recordingFetch(responses: Array<(url: string) => Response>) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      body: init?.body ?? null,
      headers: new Headers(init?.headers),
      method: init?.method ?? "GET",
      redirect: init?.redirect,
      url
    });
    const next = responses.shift();
    if (!next) {
      throw new Error("unexpected request");
    }
    return next(url);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const redirect =
  (location: string, status = 307) =>
  () =>
    new Response(null, { headers: { location }, status });
const ok = () => new Response("{}", { status: 200 });
const SERVER = "https://mcp.example.com/mcp";

describe("createMcpFetch", () => {
  test("adds the configured headers and aia's User-Agent without replacing the SDK's own", async () => {
    const { calls, fetchImpl } = recordingFetch([ok]);
    const mcpFetch = createMcpFetch({
      fetchImpl,
      headers: { "x-api-key": "k", "content-type": "text/plain" },
      serverUrl: SERVER
    });

    await mcpFetch("https://mcp.example.com/mcp", { headers: { "content-type": "application/json" }, method: "POST" });

    expect(calls[0]?.headers.get("x-api-key")).toBe("k");
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(calls[0]?.headers.get("user-agent")).toMatch(/^aia-mcp-client\//u);
  });

  // The SDK fetches an OAuth authorization server's metadata, registers a
  // client and exchanges tokens through this same fetch, and the MCP server
  // chooses which authorization server that is: an API key from config must
  // not go along.
  test("sends the configured headers only to the server's own origin", async () => {
    const { calls, fetchImpl } = recordingFetch([ok, ok, ok]);
    const mcpFetch = createMcpFetch({ fetchImpl, headers: { "x-api-key": "secret-key" }, serverUrl: SERVER });

    await mcpFetch("https://mcp.example.com/.well-known/oauth-protected-resource");
    await mcpFetch("https://login.example.org/.well-known/oauth-authorization-server");
    await mcpFetch("http://mcp.example.com/mcp");

    expect(calls[0]?.headers.get("x-api-key")).toBe("secret-key");
    expect(calls[1]?.headers.has("x-api-key")).toBe(false);
    // Same host, another scheme: another origin.
    expect(calls[2]?.headers.has("x-api-key")).toBe(false);
    expect(calls[1]?.headers.get("user-agent")).toMatch(/^aia-mcp-client\//u);
  });

  // Without "manual", Node's fetch follows a cross-origin redirect by itself,
  // carrying custom headers, before this code ever sees it.
  test("never lets fetch follow redirects on its own", async () => {
    const { calls, fetchImpl } = recordingFetch([redirect("/v2/mcp"), ok]);
    await createMcpFetch({ fetchImpl, serverUrl: SERVER })(SERVER, { redirect: "follow" });
    expect(calls.map((call) => call.redirect)).toEqual(["manual", "manual"]);
  });

  test("follows a redirect within the same origin, keeping method and body for a 307", async () => {
    const { calls, fetchImpl } = recordingFetch([redirect("/v2/mcp"), ok]);
    const response = await createMcpFetch({ fetchImpl, serverUrl: SERVER })("https://mcp.example.com/mcp", {
      body: '{"jsonrpc":"2.0"}',
      method: "POST"
    });

    expect(response.status).toBe(200);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST https://mcp.example.com/mcp",
      "POST https://mcp.example.com/v2/mcp"
    ]);
    expect(calls[1]?.body).toBe('{"jsonrpc":"2.0"}');
  });

  test("continues a 303, or a 302 answering a POST, as a GET without a body", async () => {
    const { calls, fetchImpl } = recordingFetch([redirect("/next", 303), ok]);
    await createMcpFetch({ fetchImpl, serverUrl: SERVER })("https://mcp.example.com/mcp", {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    expect(calls[1]).toMatchObject({ body: null, method: "GET" });
    expect(calls[1]?.headers.has("content-type")).toBe(false);
  });

  test("refuses a redirect to another origin, and a downgrade to http", async () => {
    const elsewhere = recordingFetch([redirect("https://evil.example.net/steal")]);
    await expect(
      createMcpFetch({ fetchImpl: elsewhere.fetchImpl, serverUrl: SERVER })("https://mcp.example.com/mcp")
    ).rejects.toThrow("only redirects within the same origin are followed");
    const downgrade = recordingFetch([redirect("http://mcp.example.com/mcp")]);
    await expect(
      createMcpFetch({ fetchImpl: downgrade.fetchImpl, serverUrl: SERVER })("https://mcp.example.com/mcp")
    ).rejects.toThrow("only redirects within the same origin");
  });

  test("stops after ten redirects", async () => {
    const { fetchImpl } = recordingFetch(Array.from({ length: 11 }, (_, index) => redirect(`/hop-${index}`)));
    await expect(createMcpFetch({ fetchImpl, serverUrl: SERVER })("https://mcp.example.com/mcp")).rejects.toThrow(
      "redirected more than 10 times"
    );
  });
});

describe("MCP failure classification", () => {
  test("retries network failures and 408/429/5xx, never authorization failures", () => {
    expect(isTransientMcpError(new StreamableHTTPError(503, "unavailable"))).toBe(true);
    expect(isTransientMcpError(new StreamableHTTPError(429, "slow down"))).toBe(true);
    expect(isTransientMcpError(new StreamableHTTPError(401, "who are you"))).toBe(false);
    expect(isTransientMcpError(new StreamableHTTPError(403, "no"))).toBe(false);
    expect(isTransientMcpError(new StreamableHTTPError(404, "gone"))).toBe(false);
    expect(isTransientMcpError(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }))).toBe(true);
    expect(isTransientMcpError(new Error("unexpected token"))).toBe(false);
  });

  test("tells a forgotten session and a needed login apart", () => {
    expect(isMcpSessionExpired(new StreamableHTTPError(404, "Session not found"))).toBe(true);
    expect(isMcpSessionExpired(new StreamableHTTPError(500, "oops"))).toBe(false);
    expect(isMcpAuthorizationError(new StreamableHTTPError(401, "login"))).toBe(true);
    // The SDK's own class, as auth() throws it: its constructor never sets
    // `name`, so a check on the name never matched.
    expect(isMcpAuthorizationError(new UnauthorizedError("Unauthorized"))).toBe(true);
    expect(new UnauthorizedError("x").name).toBe("Error");
  });

  test("tries a transient failure again after each delay, then gives up", async () => {
    const slept: number[] = [];
    let attempts = 0;
    const flaky = () => {
      attempts += 1;
      return attempts < 3 ? Promise.reject(new StreamableHTTPError(502, "bad gateway")) : Promise.resolve("ok");
    };
    await expect(retryTransientMcpFailures(flaky, { sleep: async (ms) => void slept.push(ms) })).resolves.toBe("ok");
    expect(slept).toEqual([250, 1_000]);

    attempts = 0;
    await expect(
      retryTransientMcpFailures(() => Promise.reject(new StreamableHTTPError(401, "no")), { sleep: async () => {} })
    ).rejects.toThrow("no");
  });
});

describe("McpCallTimer", () => {
  test("fires after the timeout, restarts on progress, and stops while paused", async () => {
    let fired = 0;
    const timer = new McpCallTimer(80, () => {
      fired += 1;
    });
    timer.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    timer.reset();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fired).toBe(0);

    timer.pause();
    timer.pause();
    await new Promise((resolve) => setTimeout(resolve, 120));
    timer.resume();
    expect(fired).toBe(0);
    timer.resume();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(fired).toBe(1);

    timer.reset();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(fired).toBe(1);
  });
});
