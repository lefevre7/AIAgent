import { describe, expect, test } from "vitest";

import { WebPageFetcher, isPrivateIpAddress } from "@/core/research/fetch";

function fetchReturning(
  body: string,
  contentType: string,
  init: { status?: number; statusText?: string } = {}
): typeof fetch {
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
      fetchImpl: fetchReturning(
        "<html><head><title>Hello</title></head><body><h1>Hi</h1><p>World</p></body></html>",
        "text/html; charset=utf-8"
      )
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
    const fetcher = new WebPageFetcher({
      fetchImpl: fetchReturning("nope", "text/plain", { status: 404, statusText: "Not Found" })
    });
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

  test("follows redirects hop by hop and re-validates every target", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      seen.push(url);
      if (url === "https://example.com/start") {
        return new Response(null, { headers: { location: "/next" }, status: 302 });
      }
      if (url === "https://example.com/next") {
        return new Response(null, { headers: { location: "https://public.example.org/final" }, status: 301 });
      }
      return new Response("landed", { headers: { "content-type": "text/plain" }, status: 200 });
    }) as unknown as typeof fetch;

    const result = await new WebPageFetcher({ fetchImpl }).fetch({ url: "https://example.com/start" });
    expect(result.contentMarkdown).toBe("landed");
    expect(result.finalUrl).toBe("https://public.example.org/final");
    expect(seen).toEqual(["https://example.com/start", "https://example.com/next", "https://public.example.org/final"]);
  });

  test("refuses a redirect that points at a private or loopback host (SSRF)", async () => {
    for (const location of [
      "http://127.0.0.1:8080/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost/",
      "http://[::1]/"
    ]) {
      const fetchImpl = (async () =>
        new Response(null, { headers: { location }, status: 302 })) as unknown as typeof fetch;
      await expect(
        new WebPageFetcher({ fetchImpl }).fetch({ url: "https://example.com/redirect" })
      ).rejects.toMatchObject({
        code: "web_fetch_private_host_blocked"
      });
    }
  });

  test("stops after too many redirects and rejects a redirect without a Location", async () => {
    const looping = (async () =>
      new Response(null, {
        headers: { location: "https://example.com/loop" },
        status: 302
      })) as unknown as typeof fetch;
    await expect(
      new WebPageFetcher({ fetchImpl: looping, maxRedirects: 3 }).fetch({ url: "https://example.com/loop" })
    ).rejects.toMatchObject({
      code: "web_fetch_too_many_redirects"
    });

    const headless = (async () => new Response(null, { status: 302 })) as unknown as typeof fetch;
    await expect(
      new WebPageFetcher({ fetchImpl: headless }).fetch({ url: "https://example.com/x" })
    ).rejects.toMatchObject({
      code: "web_fetch_redirect_failed"
    });
  });

  test("refuses hostnames that resolve to private addresses and reports DNS failures", async () => {
    const fetchImpl = fetchReturning("should not be reached", "text/plain");

    await expect(
      new WebPageFetcher({ fetchImpl, resolveHost: async () => ["93.184.216.34", "10.0.0.7"] }).fetch({
        url: "https://evil.example.com/"
      })
    ).rejects.toMatchObject({ code: "web_fetch_private_host_blocked" });

    await expect(
      new WebPageFetcher({ fetchImpl, resolveHost: async () => ["::ffff:127.0.0.1"] }).fetch({
        url: "https://mapped.example.com/"
      })
    ).rejects.toMatchObject({ code: "web_fetch_private_host_blocked" });

    await expect(
      new WebPageFetcher({
        fetchImpl,
        resolveHost: async () => {
          throw new Error("ENOTFOUND");
        }
      }).fetch({ url: "https://missing.example.com/" })
    ).rejects.toMatchObject({ code: "web_fetch_dns_failed" });

    const ok = await new WebPageFetcher({
      fetchImpl,
      resolveHost: async () => ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]
    }).fetch({
      url: "https://example.com/"
    });
    expect(ok.contentMarkdown).toBe("should not be reached");
  });

  test("classifies private, loopback, link-local, and mapped addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::",
      "fd12::1",
      "fc00::1",
      "fe80::1",
      "ff02::1",
      "::ffff:192.168.1.1",
      "::ffff:c0a8:101"
    ]) {
      expect(isPrivateIpAddress(address), address).toBe(true);
    }
    for (const address of [
      "8.8.8.8",
      "93.184.216.34",
      "172.32.0.1",
      "100.128.0.1",
      "2606:4700:4700::1111",
      "::ffff:8.8.8.8"
    ]) {
      expect(isPrivateIpAddress(address), address).toBe(false);
    }
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
