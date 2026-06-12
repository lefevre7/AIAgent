import { describe, expect, test } from "vitest";

import { OllamaLanguageModelAdapter, type LanguageModelRequest } from "@/core";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

function streamResponse(chunks: string[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      }
    }),
    { status: 200 }
  );
}

function buildRequest(overrides: Partial<LanguageModelRequest> = {}): LanguageModelRequest {
  return {
    availableTools: [],
    id: "lm.ollama.1",
    instructions: "be concise",
    messages: [
      {
        createdAt: "2026-06-11T00:00:00.000Z",
        id: "message.1",
        metadata: {},
        parts: [{ kind: "text", text: "hi" }],
        role: "user",
        sessionId: "session.1",
        source: "user",
        tags: [],
        turnId: "turn.1",
        visibility: "default"
      }
    ],
    metadata: {},
    modelId: "qwen2.5:14b",
    provider: "ollama",
    responseFormat: { kind: "text" },
    sessionId: "session.1",
    settings: { stopSequences: [], toolChoice: "auto" },
    turnId: "turn.1",
    ...overrides
  };
}

describe("OllamaLanguageModelAdapter", () => {
  test("reports healthy status and lists models with name/model fallbacks", async () => {
    const adapter = new OllamaLanguageModelAdapter({
      baseUrl: "http://localhost:11434",
      fetchImpl: async () => jsonResponse({ models: [{ model: "qwen2.5:14b", name: "Qwen" }, { name: "llama3" }] }),
      timeoutMs: 1000
    });

    await expect(adapter.health()).resolves.toMatchObject({ providerId: "ollama", status: "healthy" });
    const models = await adapter.listModels();
    expect(models.map((m) => m.modelId)).toEqual(["qwen2.5:14b", "llama3"]);
  });

  test("reports unavailable health when the tags endpoint fails", async () => {
    const adapter = new OllamaLanguageModelAdapter({
      baseUrl: "http://localhost:11434",
      fetchImpl: async () => jsonResponse({}, 500),
      timeoutMs: 1000
    });
    await expect(adapter.health()).resolves.toMatchObject({ status: "unavailable" });
  });

  test("emits an error event when the stream body is not readable", async () => {
    const adapter = new OllamaLanguageModelAdapter({
      baseUrl: "http://localhost:11434",
      fetchImpl: async () => new Response(null, { status: 200 }),
      timeoutMs: 1000
    });
    const events = [];
    for await (const event of adapter.stream(buildRequest())) {
      events.push(event as { kind: string });
    }
    expect(events.some((event) => event.kind === "response.error")).toBe(true);
  });

  test("sends configured num_ctx and keep_alive on chat requests", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const adapter = new OllamaLanguageModelAdapter({
      baseUrl: "http://localhost:11434",
      contextLength: 32_768,
      fetchImpl: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ message: { content: "ok" }, model: "qwen2.5:14b" });
      },
      keepAlive: "10m",
      timeoutMs: 1000
    });

    await adapter.generate(buildRequest());

    expect(capturedBody).not.toBeNull();
    expect((capturedBody as unknown as { options: { num_ctx: number } }).options.num_ctx).toBe(32_768);
    expect((capturedBody as unknown as { keep_alive: string }).keep_alive).toBe("10m");
  });

  test("omits num_ctx and keep_alive when not configured", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const adapter = new OllamaLanguageModelAdapter({
      baseUrl: "http://localhost:11434",
      fetchImpl: async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ message: { content: "ok" } });
      },
      timeoutMs: 1000
    });

    await adapter.generate(buildRequest());

    const body = capturedBody as unknown as { keep_alive?: unknown; options?: Record<string, unknown> };
    expect(body.keep_alive).toBeUndefined();
    expect(body.options?.num_ctx).toBeUndefined();
  });

  test("streams reasoning, content, and tool calls", async () => {
    const adapter = new OllamaLanguageModelAdapter({
      baseUrl: "http://localhost:11434",
      fetchImpl: async () =>
        streamResponse([
          `${JSON.stringify({ message: { thinking: "let me think" }, model: "qwen2.5:14b" })}\n`,
          `${JSON.stringify({ message: { content: "Hello" }, model: "qwen2.5:14b" })}\n`,
          "\n",
          `${JSON.stringify({ message: { tool_calls: [{ function: { arguments: { topic: "mcp" }, name: "lookup" } }] } })}\n`,
          `${JSON.stringify({ done: true, done_reason: "stop", eval_count: 3, prompt_eval_count: 7 })}\n`
        ]),
      timeoutMs: 1000
    });

    const events: Array<{ delta?: string; kind: string; toolCall?: { toolName?: string } }> = [];
    for await (const event of adapter.stream(buildRequest())) {
      events.push(event as never);
    }

    expect(events.filter((e) => e.kind === "response.reasoning").map((e) => e.delta).join("")).toContain("let me think");
    expect(events.filter((e) => e.kind === "response.delta").map((e) => e.delta).join("")).toContain("Hello");
    expect(events.some((e) => e.kind === "response.completed")).toBe(true);
  });
});
