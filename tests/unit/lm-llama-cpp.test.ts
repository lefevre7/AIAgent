import { describe, expect, test } from "vitest";

import {
  CONTEXT_WINDOW_EXCEEDED_ERROR_CODE,
  LlamaCppLanguageModelAdapter,
  type LanguageModelRequest,
  type LanguageModelStreamEvent
} from "@/core";

const BASE_URL = "http://127.0.0.1:8080/v1";

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

/** A fake llama-server: one handler per URL, and a record of every request. */
function fakeServer(routes: Record<string, Route>) {
  const requests: Array<{ body: unknown; headers: Headers; url: string }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    requests.push({
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: new Headers(init?.headers),
      url
    });
    const route = routes[url];
    if (!route) {
      return json({ error: { code: 404, message: "File Not Found", type: "not_found_error" } }, 404);
    }
    return route(init);
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

function sse(lines: string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const line of lines) {
          controller.enqueue(encoder.encode(`${line}\n`));
        }
        controller.close();
      }
    }),
    { status: 200 }
  );
}

function adapter(
  fetchImpl: typeof fetch,
  options: Partial<ConstructorParameters<typeof LlamaCppLanguageModelAdapter>[0]> = {}
) {
  return new LlamaCppLanguageModelAdapter({
    baseUrl: BASE_URL,
    fetchImpl,
    maxRetries: 0,
    timeoutMs: 5_000,
    ...options
  });
}

describe("llama.cpp adapter", () => {
  test("reports healthy, loading (degraded), and unreachable servers from /health", async () => {
    const healthy = fakeServer({ "http://127.0.0.1:8080/health": () => json({ status: "ok" }) });
    await expect(adapter(healthy.fetchImpl).health()).resolves.toMatchObject({
      providerId: "llama_cpp",
      status: "healthy"
    });

    const loading = fakeServer({
      "http://127.0.0.1:8080/health": () =>
        json({ error: { code: 503, message: "Loading model", type: "unavailable_error" } }, 503)
    });
    await expect(adapter(loading.fetchImpl).health()).resolves.toMatchObject({
      details: { error: "Loading model", loading: true },
      status: "degraded"
    });

    const down = (async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    }) as unknown as typeof fetch;
    const unavailable = await adapter(down).health();
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.details.error).toContain("ECONNREFUSED");
  });

  test("lists router-mode models with their load status and loaded context window", async () => {
    const server = fakeServer({
      [`${BASE_URL}/models`]: () =>
        json({
          data: [
            { id: "gemma-4-e4b", meta: { n_ctx: 8192, n_ctx_train: 131072 }, status: { value: "loaded" } },
            { id: "qwen3-coder", status: { value: "unloaded" } }
          ]
        })
    });

    await expect(adapter(server.fetchImpl).listModels()).resolves.toEqual([
      {
        contextWindow: 8192,
        displayName: "gemma-4-e4b",
        modelId: "gemma-4-e4b",
        provider: "llama_cpp",
        toolCalling: true
      },
      { displayName: "qwen3-coder (unloaded)", modelId: "qwen3-coder", provider: "llama_cpp", toolCalling: true }
    ]);
  });

  test("reads the loaded context window from /v1/models by id, alias, or the one running model", async () => {
    const server = fakeServer({
      [`${BASE_URL}/models`]: () =>
        json({ data: [{ aliases: ["gemma"], id: "/models/gemma-4.gguf", meta: { n_ctx: 16384 } }] })
    });
    const llama = adapter(server.fetchImpl);

    await expect(llama.getModelContextWindow("/models/gemma-4.gguf")).resolves.toBe(16384);
    await expect(llama.getModelContextWindow("gemma")).resolves.toBe(16384);
    // A single-model server answers whatever model a request names.
    await expect(llama.getModelContextWindow("qwen3.8-27b-mlx")).resolves.toBe(16384);
  });

  test("falls back to /props, and ignores a router's own n_ctx of 0", async () => {
    const single = fakeServer({
      [`${BASE_URL}/models`]: () => json({ data: [{ id: "model" }] }),
      "http://127.0.0.1:8080/props": () => json({ default_generation_settings: { n_ctx: 4096 } })
    });
    await expect(adapter(single.fetchImpl).getModelContextWindow("model")).resolves.toBe(4096);

    const router = fakeServer({
      [`${BASE_URL}/models`]: () => json({ data: [{ id: "a", status: { value: "unloaded" } }] }),
      "http://127.0.0.1:8080/props": () => json({ default_generation_settings: { n_ctx: 0 }, role: "router" })
    });
    await expect(adapter(router.fetchImpl).getModelContextWindow("a")).resolves.toBeUndefined();
  });

  test("sends cache_prompt and requestExtras, but extras never replace the protocol fields", async () => {
    const server = fakeServer({
      [`${BASE_URL}/chat/completions`]: () =>
        json({ choices: [{ finish_reason: "stop", message: { content: "hi" } }], model: "m" })
    });
    const llama = adapter(server.fetchImpl, {
      requestExtras: {
        chat_template_kwargs: { enable_thinking: false },
        model: "attacker-model",
        stream: true,
        temperature: 0.2
      }
    });

    await llama.generate(buildRequest({ temperature: 0.9 }));

    expect(server.requests[0]?.body).toMatchObject({
      cache_prompt: true,
      chat_template_kwargs: { enable_thinking: false },
      model: "local-model",
      stream: false,
      temperature: 0.2
    });
  });

  test("never lets requestExtras add a protocol field the request left out", async () => {
    // Without tools, `tools` and `tool_choice` are left out of the request,
    // and an extra used to put them in.
    const server = fakeServer({
      [`${BASE_URL}/chat/completions`]: () =>
        json({ choices: [{ finish_reason: "stop", message: { content: "hi" } }], model: "m" })
    });
    const llama = adapter(server.fetchImpl, {
      requestExtras: {
        stream_options: { include_usage: false },
        tool_choice: "required",
        tools: [{ function: { name: "exfiltrate", parameters: { type: "object" } }, type: "function" }]
      }
    });

    await llama.generate(buildRequest());

    const body = server.requests[0]?.body as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.stream_options).toBeUndefined();
  });

  test("surfaces an error the server sends mid-stream instead of an empty answer", async () => {
    const server = fakeServer({
      [`${BASE_URL}/chat/completions`]: () =>
        sse([
          'data: {"choices":[{"delta":{"content":"Partial"}}]}',
          ": ping",
          "data: not json at all",
          'data: {"error":{"code":500,"message":"The model produced output that does not match the expected peg-native format","type":"server_error"}}'
        ])
    });

    const events: LanguageModelStreamEvent[] = [];
    for await (const event of adapter(server.fetchImpl).stream(buildRequest())) {
      events.push(event);
    }

    expect(events.map((event) => event.kind)).toEqual(["response.delta", "response.error"]);
    expect(events[1]).toMatchObject({
      error: {
        code: "provider_stream_error",
        details: { provider: "llama_cpp", type: "server_error" },
        message: "The model produced output that does not match the expected peg-native format"
      }
    });
  });

  test("treats an error field only with a value as a failure, and an SSE error frame as one", async () => {
    // Some servers put "error": null in every chunk; that used to end the
    // stream as a failure. An `event: error` frame's data used to be read as
    // an ordinary chunk without choices, and the failure as an empty answer.
    const withNullErrors = fakeServer({
      [`${BASE_URL}/chat/completions`]: () =>
        sse([
          'data: {"choices":[{"delta":{"content":"Fine"}}],"error":null}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"error":null}',
          "data: [DONE]"
        ])
    });
    const fine: LanguageModelStreamEvent[] = [];
    for await (const event of adapter(withNullErrors.fetchImpl).stream(buildRequest())) {
      fine.push(event);
    }
    expect(fine.map((event) => event.kind)).toEqual(["response.delta", "response.completed"]);

    for (const frame of ['data: {"message":"upstream overloaded"}', "data: upstream overloaded"]) {
      const failing = fakeServer({
        [`${BASE_URL}/chat/completions`]: () =>
          sse(['data: {"choices":[{"delta":{"content":"Pa"}}]}', "", "event: error", frame, ""])
      });
      const events: LanguageModelStreamEvent[] = [];
      for await (const event of adapter(failing.fetchImpl).stream(buildRequest())) {
        events.push(event);
      }
      expect(events.map((event) => event.kind)).toEqual(["response.delta", "response.error"]);
      expect(events[1]).toMatchObject({ error: { code: "provider_stream_error", message: "upstream overloaded" } });
    }
  });

  test("classifies a context overflow reported before or during the stream", async () => {
    const early = fakeServer({
      [`${BASE_URL}/chat/completions`]: () =>
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
    });
    await expect(async () => {
      for await (const _event of adapter(early.fetchImpl).stream(buildRequest())) {
        // drain
      }
    }).rejects.toMatchObject({
      structuredError: {
        code: CONTEXT_WINDOW_EXCEEDED_ERROR_CODE,
        details: { contextWindowTokens: 32768, promptTokens: 40123 },
        retriable: false
      }
    });

    const midStream = fakeServer({
      [`${BASE_URL}/chat/completions`]: () =>
        sse([
          'data: {"error":{"code":400,"message":"input (9000 tokens) is larger than the max context size (8192 tokens). skipping","type":"exceed_context_size_error"}}'
        ])
    });
    const events: LanguageModelStreamEvent[] = [];
    for await (const event of adapter(midStream.fetchImpl).stream(buildRequest())) {
      events.push(event);
    }
    expect(events).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ code: CONTEXT_WINDOW_EXCEEDED_ERROR_CODE }) })
    ]);
  });
});

function buildRequest(settings: Partial<LanguageModelRequest["settings"]> = {}): LanguageModelRequest {
  return {
    availableTools: [],
    id: "lm-request.llama.1",
    instructions: "Be brief.",
    messages: [],
    metadata: {},
    modelId: "local-model",
    provider: "llama_cpp",
    responseFormat: { kind: "text" },
    sessionId: "session.llama.1",
    settings: { stopSequences: [], toolChoice: "auto", ...settings },
    turnId: "turn.llama.1"
  };
}
