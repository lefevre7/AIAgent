import { describe, expect, test } from "vitest";

import { CONTEXT_WINDOW_EXCEEDED_ERROR_CODE } from "@/core/contracts";
import {
  buildStreamedProviderError,
  computeBackoffDelay,
  fetchJson,
  parseRetryAfterMs,
  ProviderRequestError
} from "@/core/lm/http";
import { classifyContextOverflow, classifyThrownContextOverflow } from "@/core/lm/overflow";

/** Answers each call with the next response (or throws the next error). */
function scripted(steps: Array<Error | Response>) {
  let calls = 0;
  const fetchImpl = (async () => {
    const step = steps[Math.min(calls, steps.length - 1)]!;
    calls += 1;
    if (step instanceof Error) {
      throw step;
    }
    return step.clone();
  }) as unknown as typeof fetch;
  return { calls: () => calls, fetchImpl };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers }, status });
}

function recordingSleep() {
  const delays: number[] = [];
  return { delays, sleepImpl: async (ms: number) => void delays.push(ms) };
}

describe("provider retry policy", () => {
  test("backs off exponentially from 200ms with ±10% jitter, capped", () => {
    expect(computeBackoffDelay(1, () => 0.5)).toBe(200);
    expect(computeBackoffDelay(2, () => 0.5)).toBe(400);
    expect(computeBackoffDelay(3, () => 0.5)).toBe(800);
    expect(computeBackoffDelay(1, () => 0)).toBe(180);
    expect(computeBackoffDelay(1, () => 1)).toBe(220);
    expect(computeBackoffDelay(20, () => 0.5)).toBe(8_000);
  });

  test("reads Retry-After as seconds or an HTTP date, and caps it", () => {
    const now = Date.parse("2026-09-30T12:00:00Z");
    expect(parseRetryAfterMs("2", now)).toBe(2_000);
    expect(parseRetryAfterMs("1.5", now)).toBe(1_500);
    expect(parseRetryAfterMs("Wed, 30 Sep 2026 12:00:05 GMT", now)).toBe(5_000);
    expect(parseRetryAfterMs("3600", now)).toBe(60_000);
    expect(parseRetryAfterMs("soon", now)).toBeUndefined();
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
  });

  test("retries 5xx and network failures up to maxAttempts, honouring Retry-After", async () => {
    const server = scripted([
      json({ error: "busy" }, 429, { "retry-after": "1" }),
      new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }),
      json({ ok: true })
    ]);
    const sleep = recordingSleep();

    const result = await fetchJson<{ ok: boolean }>({
      fetchImpl: server.fetchImpl,
      maxAttempts: 3,
      sleepImpl: sleep.sleepImpl,
      timeoutMs: 1_000,
      url: "http://provider.test/v1/chat/completions"
    });

    expect(result.data).toEqual({ ok: true });
    expect(server.calls()).toBe(3);
    expect(sleep.delays[0]).toBe(1_000);
    expect(sleep.delays[1]).toBeGreaterThanOrEqual(360);
    expect(sleep.delays[1]).toBeLessThanOrEqual(440);
  });

  test("never retries a 4xx it cannot fix by waiting", async () => {
    const server = scripted([json({ error: { message: "bad request" } }, 400), json({ ok: true })]);
    await expect(
      fetchJson({
        fetchImpl: server.fetchImpl,
        maxAttempts: 4,
        sleepImpl: async () => undefined,
        timeoutMs: 1_000,
        url: "u"
      })
    ).rejects.toMatchObject({ structuredError: { message: "bad request", retriable: false } });
    expect(server.calls()).toBe(1);
  });

  test("keeps waiting on a server that is still loading its model, within its budget", async () => {
    const loading = json({ error: { code: 503, message: "Loading model", type: "unavailable_error" } }, 503);
    const server = scripted([loading, loading, loading, loading, loading, json({ ok: true })]);

    const result = await fetchJson<{ ok: boolean }>({
      fetchImpl: server.fetchImpl,
      maxAttempts: 2,
      retryUnavailableForMs: 60_000,
      sleepImpl: async () => undefined,
      timeoutMs: 1_000,
      url: "u"
    });

    expect(result.data).toEqual({ ok: true });
    expect(server.calls()).toBe(6);
  });

  test("gives up on a loading server once its budget is spent", async () => {
    const loading = json({ error: { message: "Loading model" } }, 503);
    const server = scripted([loading]);

    await expect(
      fetchJson({
        fetchImpl: server.fetchImpl,
        maxAttempts: 1,
        retryUnavailableForMs: 30,
        sleepImpl: async (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10))),
        timeoutMs: 1_000,
        url: "u"
      })
    ).rejects.toMatchObject({ structuredError: { details: { status: 503 }, message: "Loading model" } });
    expect(server.calls()).toBeGreaterThan(1);
  });
});

describe("provider request safety", () => {
  test("follows a redirect within the provider's origin, and refuses one to another origin", async () => {
    const calls: Array<{ headers: Headers; url: string }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ headers: new Headers(init?.headers), url: String(url) });
      if (String(url).endsWith("/v1/chat/completions")) {
        return new Response(null, { headers: { location: "/v2/chat/completions" }, status: 308 });
      }
      if (String(url).endsWith("/v2/chat/completions")) {
        return new Response(null, { headers: { location: "http://elsewhere.test/collect" }, status: 307 });
      }
      return json({ ok: true });
    }) as unknown as typeof fetch;

    const failure = await fetchJson({
      body: { prompt: "hi" },
      fetchImpl,
      headers: { "x-api-key": "sk-provider-secret" },
      maxAttempts: 3,
      sleepImpl: async () => undefined,
      timeoutMs: 1_000,
      url: "http://provider.test/v1/chat/completions"
    }).catch((error: unknown) => error);

    // Node's fetch would have sent the x-api-key header, and on a 307 the
    // whole prompt, to the other origin.
    expect(calls.map((call) => call.url)).toEqual([
      "http://provider.test/v1/chat/completions",
      "http://provider.test/v2/chat/completions"
    ]);
    expect(calls[1]?.headers.get("x-api-key")).toBe("sk-provider-secret");
    expect(failure).toBeInstanceOf(ProviderRequestError);
    expect((failure as ProviderRequestError).structuredError).toMatchObject({
      message: expect.stringContaining("redirected to http://elsewhere.test"),
      retriable: false
    });
  });

  test("keeps header values out of the error fetch raises for an invalid header", async () => {
    const server = scripted([new TypeError('Headers.append: "Bearer sk-live-123456\n" is an invalid header value.')]);
    const failure = await fetchJson({
      fetchImpl: server.fetchImpl,
      headers: { authorization: "Bearer sk-live-123456\n" },
      maxAttempts: 1,
      timeoutMs: 1_000,
      url: "u"
    }).catch((error: unknown) => error);

    const message = (failure as ProviderRequestError).structuredError.message;
    expect(message).not.toContain("sk-live-123456");
    expect(message).toContain("<redacted>");
  });

  test("a cancel ends the wait before a retry instead of sitting out Retry-After", async () => {
    const server = scripted([json({ error: "busy" }, 503, { "retry-after": "60" }), json({ ok: true })]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const startedAt = Date.now();

    await expect(
      fetchJson({
        cancelSignal: controller.signal,
        fetchImpl: server.fetchImpl,
        maxAttempts: 3,
        timeoutMs: 1_000,
        url: "u"
      })
    ).rejects.toMatchObject({ structuredError: { code: "provider_request_cancelled" } });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(server.calls()).toBe(1);
  });

  test("a Retry-After of 0 still waits the base delay, so a loading server is not hammered", async () => {
    const server = scripted([json({ error: "busy" }, 429, { "retry-after": "0" }), json({ ok: true })]);
    const sleep = recordingSleep();
    await fetchJson({
      fetchImpl: server.fetchImpl,
      maxAttempts: 2,
      sleepImpl: sleep.sleepImpl,
      timeoutMs: 1_000,
      url: "u"
    });
    expect(sleep.delays).toEqual([200]);
  });

  test("does not retry what waiting cannot fix: 501, or a server that took minutes and then timed out", async () => {
    const notImplemented = scripted([json({ error: "no" }, 501), json({ ok: true })]);
    await expect(
      fetchJson({
        fetchImpl: notImplemented.fetchImpl,
        maxAttempts: 3,
        sleepImpl: async () => undefined,
        timeoutMs: 1_000,
        url: "u"
      })
    ).rejects.toMatchObject({ structuredError: { retriable: false } });
    expect(notImplemented.calls()).toBe(1);

    const headersTimeout = scripted([
      new TypeError("fetch failed", { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }),
      json({ ok: true })
    ]);
    await expect(
      fetchJson({
        fetchImpl: headersTimeout.fetchImpl,
        maxAttempts: 3,
        sleepImpl: async () => undefined,
        timeoutMs: 1_000,
        url: "u"
      })
    ).rejects.toBeInstanceOf(ProviderRequestError);
    expect(headersTimeout.calls()).toBe(1);

    // A dropped socket is worth another try.
    const socket = scripted([new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } }), json({ ok: true })]);
    await fetchJson({
      fetchImpl: socket.fetchImpl,
      maxAttempts: 3,
      sleepImpl: async () => undefined,
      timeoutMs: 1_000,
      url: "u"
    });
    expect(socket.calls()).toBe(2);
  });
});

describe("context overflow classification", () => {
  // The shared HTTP client reports what the server said; the model adapters
  // classify it (classifyContextOverflow), since ComfyUI uses the client too.
  async function failureOf(response: Response): Promise<ProviderRequestError> {
    const server = scripted([response]);
    const failure = await fetchJson({ fetchImpl: server.fetchImpl, maxAttempts: 3, timeoutMs: 1_000, url: "u" }).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(ProviderRequestError);
    // Waiting cannot make a prompt fit, and a 400 is not retried.
    expect(server.calls()).toBe(1);
    return failure as ProviderRequestError;
  }

  test("recognizes llama.cpp's typed error, keeps both token counts, and adds the provider's remedy", async () => {
    const failure = await failureOf(
      json(
        {
          error: {
            code: 400,
            message: "request (40123 tokens) exceeds the available context size (32768 tokens), try increasing it",
            n_ctx: 32768,
            n_prompt_tokens: 40123,
            type: "exceed_context_size_error"
          }
        },
        400
      )
    );
    expect(failure.structuredError.code).toBe("provider_http_error");

    expect(classifyThrownContextOverflow(failure, "Start llama-server with a larger context (-c)")).toMatchObject({
      structuredError: {
        code: CONTEXT_WINDOW_EXCEEDED_ERROR_CODE,
        details: {
          contextWindowTokens: 32768,
          promptTokens: 40123,
          remedy: "Start llama-server with a larger context (-c)",
          status: 400
        },
        retriable: false
      }
    });
  });

  test("recognizes OpenAI's code and the plain messages other servers send", async () => {
    const cases = [
      json({ error: { code: "context_length_exceeded", message: "too long" } }, 400),
      json({ error: { message: "This model's maximum context length is 8192 tokens." } }, 400),
      json({ error: "Trying to keep the first 5000 tokens when context the overflows." }, 400)
    ];
    for (const response of cases) {
      expect(classifyContextOverflow((await failureOf(response)).structuredError)).toMatchObject({
        code: CONTEXT_WINDOW_EXCEEDED_ERROR_CODE
      });
    }
  });

  test("does not mistake a server error that mentions context for an overflow", async () => {
    const server = scripted([
      json({ error: { message: "failed to load context: exceeds the available context" } }, 500)
    ]);
    const failure = await fetchJson({ fetchImpl: server.fetchImpl, maxAttempts: 1, timeoutMs: 1_000, url: "u" }).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(ProviderRequestError);
    expect(classifyContextOverflow((failure as ProviderRequestError).structuredError).code).toBe("provider_http_error");
    expect(classifyThrownContextOverflow(failure)).toBe(failure);
  });

  test("builds a streamed error in the same shape, and classifies one the same way", () => {
    expect(buildStreamedProviderError({ message: "boom", type: "server_error" }, "llama_cpp")).toEqual({
      code: "provider_stream_error",
      details: { provider: "llama_cpp", response: { message: "boom", type: "server_error" }, type: "server_error" },
      message: "boom",
      retriable: true
    });
    const streamed = buildStreamedProviderError(
      { message: "input (9000 tokens) is larger than the max context size (8192 tokens)", n_ctx: 8192 },
      "llama_cpp"
    );
    expect(classifyContextOverflow(streamed)).toMatchObject({
      code: CONTEXT_WINDOW_EXCEEDED_ERROR_CODE,
      details: { contextWindowTokens: 8192 },
      retriable: false
    });
  });
});
