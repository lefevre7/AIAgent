import { afterEach, describe, expect, test, vi } from "vitest";

import {
  LlamaCppLanguageModelAdapter,
  OllamaLanguageModelAdapter,
  type LanguageModelRequest,
  type LanguageModelStreamEvent
} from "@/core";

afterEach(() => {
  vi.useRealTimers();
});

function buildRequest(provider: LanguageModelRequest["provider"]): LanguageModelRequest {
  return {
    availableTools: [],
    id: "lm-request.cleanup.1",
    instructions: "Be brief.",
    messages: [],
    metadata: {},
    modelId: "local-model",
    provider,
    responseFormat: { kind: "text" },
    sessionId: "session.cleanup.1",
    settings: { stopSequences: [], toolChoice: "auto" },
    turnId: "turn.cleanup.1"
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

/** A response that sends one line and then stays open, and records being cancelled. */
function openStream(line: string) {
  const state = { cancelled: false };
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${line}\n`));
      },
      cancel() {
        state.cancelled = true;
      }
    }),
    { status: 200 }
  );
  return { response, state };
}

async function drain(stream: AsyncIterable<LanguageModelStreamEvent>): Promise<void> {
  for await (const _event of stream) {
    // drain
  }
}

const adapters = {
  llama_cpp: (fetchImpl: typeof fetch) =>
    new LlamaCppLanguageModelAdapter({
      baseUrl: "http://127.0.0.1:8080/v1",
      fetchImpl,
      maxRetries: 0,
      streamFirstTokenTimeoutMs: 1_800_000,
      streamIdleTimeoutMs: 60_000,
      timeoutMs: 5_000
    }),
  ollama: (fetchImpl: typeof fetch) =>
    new OllamaLanguageModelAdapter({
      baseUrl: "http://127.0.0.1:11434",
      fetchImpl,
      maxRetries: 0,
      streamFirstTokenTimeoutMs: 1_800_000,
      streamIdleTimeoutMs: 60_000,
      timeoutMs: 5_000
    })
} as const;

const firstLine = {
  llama_cpp: 'data: {"choices":[{"delta":{"content":"Hi"}}]}',
  ollama: '{"message":{"content":"Hi"},"model":"local-model"}'
} as const;

describe.each(["llama_cpp", "ollama"] as const)("%s streaming cleanup", (provider) => {
  // The first-token timer (30 minutes by default) was armed before the
  // request and never cleared when it failed, so `aia --prompt` printed the
  // failure and then sat there until the timer ran out.
  test("a request that fails before streaming leaves no timer behind", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const adapter = adapters[provider](async () => json({ error: { message: "bad request" } }, 400));

    await expect(drain(adapter.stream(buildRequest(provider)))).rejects.toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a consumer that stops reading closes the response, and the timer with it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stream = openStream(firstLine[provider]);
    const adapter = adapters[provider](async () => stream.response);

    for await (const event of adapter.stream(buildRequest(provider))) {
      expect(event.kind).toBe("response.delta");
      break;
    }

    expect(stream.state.cancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
