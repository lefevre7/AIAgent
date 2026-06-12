import { describe, expect, test } from "vitest";

import {
  LMStudioLanguageModelAdapter,
  OllamaLanguageModelAdapter,
  type LanguageModelRequest,
  type LanguageModelSettings
} from "@/core";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

function buildRequest(
  settings: Partial<LanguageModelSettings>,
  provider: "lm_studio" | "ollama"
): LanguageModelRequest {
  return {
    availableTools: [],
    id: "lm.sampling.1",
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
    settings: { stopSequences: [], toolChoice: "auto", ...settings },
    turnId: "turn.1"
  };
}

const SAMPLING: Partial<LanguageModelSettings> = {
  frequencyPenalty: 0.2,
  maxOutputTokens: 8192,
  minP: 0.05,
  presencePenalty: 0.5,
  repetitionPenalty: 1.1,
  topK: 40,
  topP: 0.8
};

describe("sampling-control passthrough", () => {
  test("LM Studio forwards every sampling control to the OpenAI-compatible payload", async () => {
    let body: Record<string, unknown> = {};
    const adapter = new LMStudioLanguageModelAdapter({
      baseUrl: "http://localhost:1234/v1",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse({
          choices: [{ finish_reason: "stop", message: { content: "ok" } }]
        });
      },
      timeoutMs: 1000
    });

    await adapter.generate(buildRequest(SAMPLING, "lm_studio"));

    expect(body.max_tokens).toBe(8192);
    expect(body.repeat_penalty).toBe(1.1);
    expect(body.presence_penalty).toBe(0.5);
    expect(body.frequency_penalty).toBe(0.2);
    expect(body.top_k).toBe(40);
    expect(body.min_p).toBe(0.05);
    expect(body.top_p).toBe(0.8);
  });

  test("Ollama forwards every sampling control into options", async () => {
    let body: { options?: Record<string, unknown> } = {};
    const adapter = new OllamaLanguageModelAdapter({
      baseUrl: "http://localhost:11434",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse({
          done_reason: "stop",
          message: { content: "ok" }
        });
      },
      timeoutMs: 1000
    });

    await adapter.generate(buildRequest(SAMPLING, "ollama"));

    expect(body.options?.num_predict).toBe(8192);
    expect(body.options?.repeat_penalty).toBe(1.1);
    expect(body.options?.presence_penalty).toBe(0.5);
    expect(body.options?.frequency_penalty).toBe(0.2);
    expect(body.options?.top_k).toBe(40);
    expect(body.options?.min_p).toBe(0.05);
  });

  test("omits sampling fields that are not configured", async () => {
    let body: Record<string, unknown> = {};
    const adapter = new LMStudioLanguageModelAdapter({
      baseUrl: "http://localhost:1234/v1",
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return jsonResponse({
          choices: [{ finish_reason: "stop", message: { content: "ok" } }]
        });
      },
      timeoutMs: 1000
    });

    await adapter.generate(buildRequest({}, "lm_studio"));

    expect(body).not.toHaveProperty("repeat_penalty");
    expect(body).not.toHaveProperty("presence_penalty");
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("top_k");
  });
});
