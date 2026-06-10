import { describe, expect, test } from "vitest";

import { LMStudioLanguageModelAdapter, OllamaLanguageModelAdapter, type LanguageModelRequest } from "@/core";

describe("language-model adapter streaming", () => {
  test("parses LM Studio SSE responses into stream events", async () => {
    const adapter = new LMStudioLanguageModelAdapter({
      baseUrl: "http://localhost:1234/v1",
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(
                encoder.encode(
                  'data: {"id":"chatcmpl-1","model":"mistralai/devstral-small-2-2512","choices":[{"delta":{"content":"Hello"}}]}\n'
                )
              );
              controller.enqueue(
                encoder.encode(
                  'data: {"id":"chatcmpl-1","model":"mistralai/devstral-small-2-2512","choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n'
                )
              );
              controller.enqueue(encoder.encode("data: [DONE]\n"));
              controller.close();
            }
          }),
          { status: 200 }
        ),
      timeoutMs: 5_000
    });

    const events: unknown[] = [];
    for await (const event of adapter.stream(buildRequest())) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        delta: "Hello",
        kind: "response.delta"
      },
      expect.objectContaining({
        kind: "response.completed",
        response: expect.objectContaining({
          message: expect.objectContaining({
            parts: [{ kind: "text", text: "Hello" }]
          }),
          stopReason: "end_turn",
          usage: {
            inputTokens: 4,
            outputTokens: 2,
            totalTokens: 6
          }
        })
      })
    ]);
  });

  test("parses Ollama NDJSON responses into stream events", async () => {
    const adapter = new OllamaLanguageModelAdapter({
      baseUrl: "http://localhost:11434",
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(
                encoder.encode('{"model":"qwen2.5:14b","message":{"content":"Inspect"},"done":false}\n')
              );
              controller.enqueue(
                encoder.encode(
                  '{"model":"qwen2.5:14b","done":true,"done_reason":"stop","prompt_eval_count":7,"eval_count":3}\n'
                )
              );
              controller.close();
            }
          }),
          { status: 200 }
        ),
      timeoutMs: 5_000
    });

    const events: unknown[] = [];
    for await (const event of adapter.stream(buildRequest({ provider: "ollama" }))) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        delta: "Inspect",
        kind: "response.delta"
      },
      expect.objectContaining({
        kind: "response.completed",
        response: expect.objectContaining({
          message: expect.objectContaining({
            parts: [{ kind: "text", text: "Inspect" }]
          }),
          stopReason: "end_turn",
          usage: {
            inputTokens: 7,
            outputTokens: 3,
            totalTokens: 10
          }
        })
      })
    ]);
  });
});

function buildRequest(overrides: Partial<LanguageModelRequest> = {}): LanguageModelRequest {
  return {
    availableTools: [],
    id: "lm-request.stream.1",
    instructions: "Be concise.",
    messages: [
      {
        createdAt: "2026-03-27T12:00:00.000Z",
        id: "message.user.stream.1",
        metadata: {},
        parts: [{ kind: "text", text: "Inspect the workspace." }],
        role: "user",
        sessionId: "session.stream.1",
        source: "user",
        tags: [],
        turnId: "turn.stream.1",
        visibility: "default"
      }
    ],
    metadata: {},
    modelId: "mistralai/devstral-small-2-2512",
    provider: "lm_studio",
    responseFormat: {
      kind: "text"
    },
    sessionId: "session.stream.1",
    settings: {
      stopSequences: [],
      toolChoice: "auto"
    },
    turnId: "turn.stream.1",
    ...overrides
  };
}
