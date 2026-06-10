import { describe, expect, test } from "vitest";

import { WebPageFetcher } from "@/core/research/fetch";

function fetchReturning(body: string, contentType: string, init: { status?: number; statusText?: string } = {}): typeof fetch {
  return (async () =>
    new Response(body, {
      headers: { "content-type": contentType },
      status: init.status ?? 200,
      statusText: init.statusText ?? "OK"
    })) as unknown as typeof fetch;
}

describe("WebPageFetcher", () => {
  test("converts HTML to markdown and extracts the title", async () => {
    const fetcher = new WebPageFetcher({
      fetchImpl: fetchReturning("<html><head><title>Hello</title></head><body><h1>Hi</h1><p>World</p></body></html>", "text/html; charset=utf-8")
    });
    const result = await fetcher.fetch({ url: "https://example.com/page" });

    expect(result.contentType).toBe("text/html");
    expect(result.title).toBe("Hello");
    expect(result.contentMarkdown).toContain("World");
    expect(result.truncated).toBe(false);
  });

  test("pretty-prints JSON responses inside a fenced block", async () => {
    const fetcher = new WebPageFetcher({ fetchImpl: fetchReturning('{"a":1}', "application/json") });
    const result = await fetcher.fetch({ url: "https://example.com/data.json" });
    expect(result.contentMarkdown).toContain("```json");
    expect(result.contentMarkdown).toContain('"a": 1');
  });

  test("passes through markdown and plain text", async () => {
    const md = await new WebPageFetcher({ fetchImpl: fetchReturning("# Title\n", "text/markdown") }).fetch({
      url: "https://example.com/readme.md"
    });
    expect(md.contentMarkdown).toBe("# Title");

    const text = await new WebPageFetcher({ fetchImpl: fetchReturning("plain body", "text/plain") }).fetch({
      url: "https://example.com/file.txt"
    });
    expect(text.contentMarkdown).toBe("plain body");
  });

  test("truncates long content and reports it", async () => {
    const fetcher = new WebPageFetcher({ fetchImpl: fetchReturning("x".repeat(500), "text/plain") });
    const result = await fetcher.fetch({ maxChars: 100, url: "https://example.com/big.txt" });
    expect(result.truncated).toBe(true);
    expect(result.contentMarkdown.endsWith("...[truncated]")).toBe(true);
  });

  test("extracts query snippets and counts matches", async () => {
    const body = "Intro paragraph. The runtime exposes a shared gateway. More text about the gateway here.";
    const fetcher = new WebPageFetcher({ fetchImpl: fetchReturning(body, "text/plain") });
    const result = await fetcher.fetch({ query: "gateway", url: "https://example.com/notes" });
    expect(result.query).toBe("gateway");
    expect(result.queryMatchCount).toBeGreaterThan(0);
    expect(result.snippets[0]).toContain("gateway");
  });

  test("throws structured errors for HTTP failures", async () => {
    const fetcher = new WebPageFetcher({ fetchImpl: fetchReturning("nope", "text/plain", { status: 404, statusText: "Not Found" }) });
    await expect(fetcher.fetch({ url: "https://example.com/missing" })).rejects.toMatchObject({
      code: "web_fetch_http_error"
    });
  });

  test("rejects invalid URLs, unsupported protocols, and private hosts", async () => {
    const fetcher = new WebPageFetcher({ fetchImpl: fetchReturning("", "text/plain") });
    await expect(fetcher.fetch({ url: "not a url" })).rejects.toMatchObject({ code: "web_fetch_invalid_url" });
    await expect(fetcher.fetch({ url: "ftp://example.com" })).rejects.toMatchObject({
      code: "web_fetch_unsupported_protocol"
    });
    await expect(fetcher.fetch({ url: "http://localhost:3000/" })).rejects.toMatchObject({
      code: "web_fetch_private_host_blocked"
    });
    await expect(fetcher.fetch({ url: "http://192.168.1.10/" })).rejects.toMatchObject({
      code: "web_fetch_private_host_blocked"
    });
  });

  test("wraps unexpected fetch failures", async () => {
    const fetcher = new WebPageFetcher({
      fetchImpl: (async () => {
        throw new Error("socket hang up");
      }) as unknown as typeof fetch
    });
    await expect(fetcher.fetch({ url: "https://example.com/down" })).rejects.toMatchObject({
      code: "web_fetch_failed",
      message: "socket hang up"
    });
  });
});
