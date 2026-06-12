import { describe, expect, test } from "vitest";

import {
  LMStudioLanguageModelAdapter,
  OllamaLanguageModelAdapter,
  type LanguageModelRequest
} from "@/core";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200
  });
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

function buildStreamRequest(
  provider: "lm_studio" | "ollama"
): LanguageModelRequest {
  return {
    availableTools: [],
    id: "lm.ctx.1",
    instructions: "be concise",
    messages: [
      {
        createdAt: "2026-06-12T00:00:00.000Z",
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
    modelId: "test-model",
    provider,
    responseFormat: { kind: "text" },
    sessionId: "session.1",
    settings: { stopSequences: [], toolChoice: "auto" },
    turnId: "turn.1"
  };
}

describe("getModelContextWindow", () => {
  test("LM Studio reads loaded/max context from the native /api/v0/models endpoint", async () => {
    let requestedUrl = "";
    const adapter = new LMStudioLanguageModelAdapter({
      baseUrl: "http://localhost:1234/v1",
      fetchImpl: async (url) => {
        requestedUrl = String(url);
        return jsonResponse({
          data: [
            {
              id: "test-model",
              loaded_context_length: 16384,
              max_context_length: 32768
            }
          ]
        });
      },
      timeoutMs: 1000
    });

    await expect(adapter.getModelContextWindow("test-model")).resolves.toBe(
      16384
    );
    expect(requestedUrl).toBe("http://localhost:1234/api/v0/models");
  });

  test("LM Studio falls back to the loaded model's loaded_context_length when the id does not match", async () => {
    const adapter = new LMStudioLanguageModelAdapter({
      baseUrl: "http://localhost:1234/v1",
      fetchImpl: async () =>
        jsonResponse({
          data: [
            {
              id: "some-other-model",
              max_context_length: 32768,
              state: "not-loaded"
            },
            {
              id: "actually-loaded",
              loaded_context_length: 8192,
              max_context_length: 131072,
              state: "loaded"
            }
          ]
        }),
      timeoutMs: 1000
    });

    await expect(
      adapter.getModelContextWindow("configured-name-that-differs")
    ).resolves.toBe(8192);
  });

  test("Ollama reads the arch-prefixed context_length from /api/show model_info", async () => {
    const adapter = new OllamaLanguageModelAdapter({
      baseUrl: "http://localhost:11434",
      fetchImpl: async () =>
        jsonResponse({
          model_info: {
            "qwen3.context_length": 40960,
            "general.architecture": "qwen3"
          }
        }),
      timeoutMs: 1000
    });

    await expect(adapter.getModelContextWindow("qwen3:30b")).resolves.toBe(
      40960
    );
  });

  test("returns undefined (caller falls back) when the lookup fails", async () => {
    const adapter = new OllamaLanguageModelAdapter({
      baseUrl: "http://localhost:11434",
      fetchImpl: async () => jsonResponse({ model_info: {} }),
      timeoutMs: 1000
    });
    await expect(
      adapter.getModelContextWindow("missing")
    ).resolves.toBeUndefined();
  });
});

describe("LM Studio streaming usage", () => {
  test("requests usage in the stream so token metrics are populated", async () => {
    let body: Record<string, unknown> = {};
    const adapter = new LMStudioLanguageModelAdapter({
      baseUrl: "http://localhost:1234/v1",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return streamResponse([
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n',
          'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34,"total_tokens":46}}\n',
          "data: [DONE]\n"
        ]);
      },
      streamIdleTimeoutMs: 0,
      timeoutMs: 1000
    });

    let completed;
    for await (const event of adapter.stream(buildStreamRequest("lm_studio"))) {
      if (event.kind === "response.completed") {
        completed = event.response;
      }
    }

    expect(body.stream_options).toEqual({ include_usage: true });
    expect(completed?.usage.inputTokens).toBe(12);
    expect(completed?.usage.outputTokens).toBe(34);
  });
});
