import { describe, expect, test, vi } from "vitest";

import {
  EmbeddingRuntime,
  LMStudioEmbeddingAdapter,
  OllamaEmbeddingAdapter,
  type EmbeddingAdapter,
  type EmbeddingRequest,
  type EmbeddingResponse
} from "@/core";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status
  });
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
}

function buildRequest(overrides: Partial<EmbeddingRequest> = {}): EmbeddingRequest {
  return {
    id: "embedding.request.1",
    inputs: ["hello world"],
    metadata: {},
    modelId: "text-embedding",
    providerId: "lm_studio",
    ...overrides
  };
}

function stubAdapter(providerId: string, response: EmbeddingResponse): EmbeddingAdapter {
  return {
    createEmbeddings: vi.fn(async () => response),
    health: vi.fn(async () => ({
      checkedAt: "2026-06-10T00:00:00.000Z",
      details: {},
      providerId,
      status: "healthy" as const
    })),
    listModels: vi.fn(async () => [{ displayName: providerId, modelId: "m", providerId }]),
    providerId
  } as unknown as EmbeddingAdapter;
}

describe("EmbeddingRuntime", () => {
  const response: EmbeddingResponse = {
    dimensions: 2,
    id: "embedding.request.1",
    metadata: {},
    providerId: "lm_studio",
    vectors: [[0.1, 0.2]]
  };

  test("routes to the default provider and to explicit overrides", async () => {
    const primary = stubAdapter("lm_studio", response);
    const secondary = stubAdapter("ollama", { ...response, providerId: "ollama" });
    const runtime = new EmbeddingRuntime([primary, secondary], { defaultProvider: "lm_studio" });

    await runtime.createEmbeddings({ id: "r", inputs: ["a"], metadata: {}, modelId: "m" });
    expect(primary.createEmbeddings).toHaveBeenCalledTimes(1);

    await runtime.createEmbeddings({ id: "r", inputs: ["a"], metadata: {}, modelId: "m", providerId: "ollama" });
    expect(secondary.createEmbeddings).toHaveBeenCalledTimes(1);
  });

  test("health and listModels delegate to the resolved adapter", async () => {
    const primary = stubAdapter("lm_studio", response);
    const runtime = new EmbeddingRuntime([primary], { defaultProvider: "lm_studio" });
    await expect(runtime.health()).resolves.toMatchObject({ providerId: "lm_studio", status: "healthy" });
    await expect(runtime.listModels()).resolves.toEqual([
      { displayName: "lm_studio", modelId: "m", providerId: "lm_studio" }
    ]);
  });

  test("listModels throws when the adapter cannot discover models", async () => {
    const adapter = stubAdapter("lm_studio", response);
    delete (adapter as { listModels?: unknown }).listModels;
    const runtime = new EmbeddingRuntime([adapter], { defaultProvider: "lm_studio" });
    await expect(runtime.listModels()).rejects.toThrow(/does not support embedding model discovery/u);
  });

  test("registerAdapter and setDefaultProvider update routing", async () => {
    const primary = stubAdapter("lm_studio", response);
    const runtime = new EmbeddingRuntime([primary], { defaultProvider: "lm_studio" });
    const added = stubAdapter("ollama", { ...response, providerId: "ollama" });
    runtime.registerAdapter(added);
    runtime.setDefaultProvider("ollama");
    await runtime.createEmbeddings({ id: "r", inputs: ["a"], metadata: {}, modelId: "m" });
    expect(added.createEmbeddings).toHaveBeenCalledTimes(1);
  });

  test("getAdapter throws for unknown providers", () => {
    const runtime = new EmbeddingRuntime([stubAdapter("lm_studio", response)], { defaultProvider: "lm_studio" });
    expect(() => runtime.getAdapter("nope")).toThrow(/No embedding adapter is registered/u);
    expect(() => runtime.setDefaultProvider("nope")).toThrow(/No embedding adapter is registered/u);
  });
});

describe("LMStudioEmbeddingAdapter", () => {
  test("posts a single input and parses vectors", async () => {
    let capturedBody: unknown;
    const adapter = new LMStudioEmbeddingAdapter({
      baseUrl: "http://localhost:1234/v1/",
      fetchImpl: fakeFetch((url, init) => {
        expect(url).toBe("http://localhost:1234/v1/embeddings");
        capturedBody = JSON.parse(String(init?.body));
        return jsonResponse({ data: [{ embedding: [1, 2, 3] }] });
      }),
      providerId: "lm_studio",
      timeoutMs: 1000
    });

    const result = await adapter.createEmbeddings(buildRequest({ inputs: ["solo"] }));
    expect(result.dimensions).toBe(3);
    expect(result.vectors).toEqual([[1, 2, 3]]);
    expect(capturedBody).toMatchObject({ input: "solo" });
  });

  test("sends arrays unchanged and throws on non-ok and empty responses", async () => {
    const okMulti = new LMStudioEmbeddingAdapter({
      baseUrl: "http://localhost:1234/v1",
      fetchImpl: fakeFetch((_url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.input).toEqual(["a", "b"]);
        return jsonResponse({ data: [{ embedding: [1] }, { embedding: [2] }] });
      }),
      providerId: "lm_studio",
      timeoutMs: 1000
    });
    await expect(okMulti.createEmbeddings(buildRequest({ inputs: ["a", "b"] }))).resolves.toMatchObject({
      dimensions: 1
    });

    const failing = new LMStudioEmbeddingAdapter({
      baseUrl: "http://localhost:1234/v1",
      fetchImpl: fakeFetch(() => jsonResponse({}, 500)),
      providerId: "lm_studio",
      timeoutMs: 1000
    });
    await expect(failing.createEmbeddings(buildRequest())).rejects.toThrow(/failed with 500/u);

    const empty = new LMStudioEmbeddingAdapter({
      baseUrl: "http://localhost:1234/v1",
      fetchImpl: fakeFetch(() => jsonResponse({ data: [] })),
      providerId: "lm_studio",
      timeoutMs: 1000
    });
    await expect(empty.createEmbeddings(buildRequest())).rejects.toThrow(/no embeddings/u);
  });

  test("reports health states and lists models", async () => {
    const healthy = new LMStudioEmbeddingAdapter({
      baseUrl: "http://localhost:1234/v1",
      fetchImpl: fakeFetch(() => jsonResponse({ data: [{ id: "model-a" }, { id: "  " }, {}] })),
      providerId: "lm_studio",
      timeoutMs: 1000
    });
    await expect(healthy.health()).resolves.toMatchObject({ status: "healthy" });
    await expect(healthy.listModels()).resolves.toEqual([
      { displayName: "model-a", modelId: "model-a", providerId: "lm_studio" }
    ]);

    const degraded = new LMStudioEmbeddingAdapter({
      baseUrl: "http://localhost:1234/v1",
      fetchImpl: fakeFetch(() => jsonResponse({}, 503)),
      providerId: "lm_studio",
      timeoutMs: 1000
    });
    await expect(degraded.health()).resolves.toMatchObject({ status: "degraded" });
    await expect(degraded.listModels()).rejects.toThrow(/model listing failed with 503/u);

    const unavailable = new LMStudioEmbeddingAdapter({
      baseUrl: "http://localhost:1234/v1",
      fetchImpl: fakeFetch(() => {
        throw new Error("connection refused");
      }),
      providerId: "lm_studio",
      timeoutMs: 1000
    });
    await expect(unavailable.health()).resolves.toMatchObject({ status: "unavailable" });
  });
});

describe("OllamaEmbeddingAdapter", () => {
  test("posts to /api/embed and parses embeddings", async () => {
    const adapter = new OllamaEmbeddingAdapter({
      baseUrl: "http://localhost:11434/",
      fetchImpl: fakeFetch((url) => {
        expect(url).toBe("http://localhost:11434/api/embed");
        return jsonResponse({ embeddings: [[4, 5]] });
      }),
      providerId: "ollama",
      timeoutMs: 1000
    });
    await expect(adapter.createEmbeddings(buildRequest({ providerId: "ollama" }))).resolves.toMatchObject({
      dimensions: 2,
      providerId: "ollama"
    });
  });

  test("throws on non-ok and empty responses", async () => {
    const failing = new OllamaEmbeddingAdapter({
      baseUrl: "http://localhost:11434",
      fetchImpl: fakeFetch(() => jsonResponse({}, 500)),
      providerId: "ollama",
      timeoutMs: 1000
    });
    await expect(failing.createEmbeddings(buildRequest({ providerId: "ollama" }))).rejects.toThrow(/failed with 500/u);

    const empty = new OllamaEmbeddingAdapter({
      baseUrl: "http://localhost:11434",
      fetchImpl: fakeFetch(() => jsonResponse({ embeddings: [] })),
      providerId: "ollama",
      timeoutMs: 1000
    });
    await expect(empty.createEmbeddings(buildRequest({ providerId: "ollama" }))).rejects.toThrow(/no embeddings/u);
  });

  test("reports health states and lists models by model or name", async () => {
    const healthy = new OllamaEmbeddingAdapter({
      baseUrl: "http://localhost:11434",
      fetchImpl: fakeFetch(() => jsonResponse({ models: [{ model: "qwen" }, { name: "llama" }, {}] })),
      providerId: "ollama",
      timeoutMs: 1000
    });
    await expect(healthy.health()).resolves.toMatchObject({ status: "healthy" });
    await expect(healthy.listModels()).resolves.toEqual([
      { displayName: "qwen", modelId: "qwen", providerId: "ollama" },
      { displayName: "llama", modelId: "llama", providerId: "ollama" }
    ]);

    const degraded = new OllamaEmbeddingAdapter({
      baseUrl: "http://localhost:11434",
      fetchImpl: fakeFetch(() => jsonResponse({}, 503)),
      providerId: "ollama",
      timeoutMs: 1000
    });
    await expect(degraded.health()).resolves.toMatchObject({ status: "degraded" });
    await expect(degraded.listModels()).rejects.toThrow(/model listing failed with 503/u);

    const unavailable = new OllamaEmbeddingAdapter({
      baseUrl: "http://localhost:11434",
      fetchImpl: fakeFetch(() => {
        throw new Error("refused");
      }),
      providerId: "ollama",
      timeoutMs: 1000
    });
    await expect(unavailable.health()).resolves.toMatchObject({ status: "unavailable" });
  });
});
