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
                  'data: {"id":"chatcmpl-1","model":"google/gemma-4-26b-a4b-qat","choices":[{"delta":{"content":"Hello"}}]}\n'
                )
              );
              controller.enqueue(
                encoder.encode(
                  'data: {"id":"chatcmpl-1","model":"google/gemma-4-26b-a4b-qat","choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n'
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

  test("emits reasoning_content deltas as response.reasoning events", async () => {
    const chunks = [
      'data: {"id":"c1","model":"m","choices":[{"delta":{"reasoning_content":"Let me think. "}}]}\n',
      'data: {"id":"c1","model":"m","choices":[{"delta":{"reasoning_content":"Mkdir then write."}}]}\n',
      'data: {"id":"c1","model":"m","choices":[{"delta":{"content":"Done."}}]}\n',
      'data: {"id":"c1","model":"m","choices":[{"finish_reason":"stop"}]}\n',
      "data: [DONE]\n"
    ];
    const adapter = new LMStudioLanguageModelAdapter({
      baseUrl: "http://localhost:1234/v1",
      fetchImpl: async () =>
        new Response(
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
        ),
      timeoutMs: 5_000
    });

    const events: Array<{ delta?: string; kind: string }> = [];
    for await (const event of adapter.stream(buildRequest())) {
      events.push(event as { delta?: string; kind: string });
    }

    const reasoning = events.filter((event) => event.kind === "response.reasoning").map((event) => event.delta);
    expect(reasoning.join("")).toBe("Let me think. Mkdir then write.");
    // Reasoning must not leak into the assistant answer content.
    const completed = events.find((event) => event.kind === "response.completed") as
      | { response: { message: { parts: Array<{ text?: string }> } } }
      | undefined;
    expect(completed?.response.message.parts).toEqual([{ kind: "text", text: "Done." }]);
  });

  test("reassembles tool-call arguments streamed across multiple SSE fragments", async () => {
    const chunks = [
      'data: {"id":"c1","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"shell_command","arguments":""}}]}}]}\n',
      'data: {"id":"c1","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"command\\":\\"mkdir "}}]}}]}\n',
      'data: {"id":"c1","model":"m","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"~/temp\\"}"}}]}}]}\n',
      'data: {"id":"c1","model":"m","choices":[{"finish_reason":"tool_calls"}]}\n',
      "data: [DONE]\n"
    ];
    const adapter = new LMStudioLanguageModelAdapter({
      baseUrl: "http://localhost:1234/v1",
      fetchImpl: async () =>
        new Response(
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
        ),
      timeoutMs: 5_000
    });

    const events: Array<{ kind: string; toolCall?: { arguments?: unknown; toolName?: string } }> = [];
    for await (const event of adapter.stream(buildRequest())) {
      events.push(event as { kind: string; toolCall?: { arguments?: unknown; toolName?: string } });
    }

    const toolCallEvent = events.find((event) => event.kind === "response.tool_call");
    expect(toolCallEvent?.toolCall?.toolName).toBe("shell_command");
    expect(toolCallEvent?.toolCall?.arguments).toEqual({ command: "mkdir ~/temp" });
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
    modelId: "google/gemma-4-26b-a4b-qat",
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
