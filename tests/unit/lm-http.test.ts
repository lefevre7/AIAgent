import { describe, expect, test } from "vitest";

import { ProviderRequestError, fetchJson, fetchStream, normalizeUnknownProviderError } from "@/core/lm/http";

function jsonResponse(body: string, init: { status?: number } = {}): typeof fetch {
  return (async () =>
    new Response(body, {
      headers: { "content-type": "application/json" },
      status: init.status ?? 200
    })) as unknown as typeof fetch;
}

describe("lm http fetchJson", () => {
  test("parses JSON bodies and returns metadata", async () => {
    const result = await fetchJson<{ ok: boolean }>({
      fetchImpl: jsonResponse('{"ok":true}'),
      timeoutMs: 1000,
      url: "https://provider.test/chat"
    });
    expect(result.data).toEqual({ ok: true });
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toContain("application/json");
  });

  test("returns null data for empty bodies", async () => {
    const result = await fetchJson<unknown>({
      fetchImpl: jsonResponse(""),
      timeoutMs: 1000,
      url: "https://provider.test/empty"
    });
    expect(result.data).toBeNull();
  });

  test("sends a POST with a JSON body when a body is provided", async () => {
    let captured: { body?: string; method?: string } = {};
    const fetchImpl = (async (_url: string, init: { body?: string; method?: string }) => {
      captured = { body: init.body, method: init.method };
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await fetchJson({ body: { prompt: "hi" }, fetchImpl, timeoutMs: 1000, url: "https://provider.test/x" });
    expect(captured.method).toBe("POST");
    expect(captured.body).toBe('{"prompt":"hi"}');
  });

  test("maps HTTP errors to structured provider errors and extracts messages", async () => {
    await expect(
      fetchJson({
        fetchImpl: jsonResponse('{"error":"bad input"}', { status: 400 }),
        maxAttempts: 1,
        timeoutMs: 1000,
        url: "u"
      })
    ).rejects.toMatchObject({
      structuredError: { code: "provider_http_error", message: "bad input", retriable: false }
    });

    await expect(
      fetchJson({
        fetchImpl: jsonResponse('{"error":{"message":"deep"}}', { status: 503 }),
        maxAttempts: 1,
        timeoutMs: 1000,
        url: "u"
      })
    ).rejects.toMatchObject({ structuredError: { message: "deep", retriable: true } });

    await expect(
      fetchJson({
        fetchImpl: jsonResponse("plain failure", { status: 418 }),
        maxAttempts: 1,
        timeoutMs: 1000,
        url: "u"
      })
    ).rejects.toMatchObject({ structuredError: { code: "provider_http_error" } });
  });

  test("fetchStream returns the raw response", async () => {
    const response = await fetchStream({
      fetchImpl: jsonResponse("stream", { status: 200 }),
      timeoutMs: 1000,
      url: "u"
    });
    expect(await response.text()).toBe("stream");
  });

  test("retries retriable failures up to maxAttempts", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new Error("ECONNREFUSED connecting to provider");
    }) as unknown as typeof fetch;

    await expect(fetchJson({ fetchImpl, maxAttempts: 2, timeoutMs: 1000, url: "u" })).rejects.toBeInstanceOf(
      ProviderRequestError
    );
    expect(calls).toBe(2);
  });

  test("a cancelled request fails as cancelled and is never retried", async () => {
    let calls = 0;
    const controller = new AbortController();
    const fetchImpl = (async (_url: string, init: { signal: AbortSignal }) => {
      calls += 1;
      return await new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const abort = new Error("This operation was aborted");
          abort.name = "AbortError";
          reject(abort);
        });
        controller.abort();
      });
    }) as unknown as typeof fetch;

    await expect(
      fetchJson({ cancelSignal: controller.signal, fetchImpl, maxAttempts: 3, timeoutMs: 5_000, url: "u" })
    ).rejects.toMatchObject({
      structuredError: { code: "provider_request_cancelled", message: "The request was cancelled.", retriable: false }
    });
    expect(calls).toBe(1);
  });

  // Node's fetch reports every connection failure as a bare "fetch failed".
  test("names the address and the cause when the provider cannot be reached", async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;

    await expect(
      fetchJson({ fetchImpl, maxAttempts: 1, timeoutMs: 1000, url: "http://127.0.0.1:1234/v1/chat/completions" })
    ).rejects.toMatchObject({
      structuredError: {
        code: "provider_request_error",
        message:
          "Could not reach http://127.0.0.1:1234/v1/chat/completions (ECONNREFUSED). Check that the provider is running and that its base URL is right."
      }
    });
  });
});

describe("normalizeUnknownProviderError", () => {
  test("passes through ProviderRequestError", () => {
    const original = new ProviderRequestError({ code: "x", details: {}, message: "m", retriable: false });
    expect(normalizeUnknownProviderError(original)).toBe(original.structuredError);
  });

  test("flags abort and network errors as retriable", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(normalizeUnknownProviderError(abort).retriable).toBe(true);
    expect(normalizeUnknownProviderError(new Error("read ECONNRESET")).retriable).toBe(true);
  });

  test("treats other errors as non-retriable and handles non-errors", () => {
    expect(normalizeUnknownProviderError(new Error("boom"))).toMatchObject({
      code: "provider_request_error",
      message: "boom",
      retriable: false
    });
    expect(normalizeUnknownProviderError("weird")).toMatchObject({ code: "provider_unknown_error", message: "weird" });
  });
});
