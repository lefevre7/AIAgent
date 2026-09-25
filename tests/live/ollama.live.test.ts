import { describe, expect } from "vitest";

import { OllamaLanguageModelAdapter } from "@/core";
import { languageModelRequestSchema } from "@/core/contracts";
import { createLiveTestHarness, envFlag } from "./helpers";

const baseUrl = process.env.AIA_LIVE_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const requestedModel = process.env.AIA_LIVE_OLLAMA_MODEL;
// A reasoning model thinks before it answers, and that thinking counts against
// this budget. At 64 tokens it never reached the answer.
const maxOutputTokens = Number(process.env.AIA_LIVE_OLLAMA_MAX_OUTPUT_TOKENS ?? 2048);
const { liveTest } = createLiveTestHarness({
  enabled: envFlag("AIA_RUN_LIVE_OLLAMA_TESTS"),
  prefix: "aiagent-live-ollama-"
});

describe("Ollama adapter (live)", () => {
  liveTest("lists models and produces a non-empty completion", async () => {
    const adapter = new OllamaLanguageModelAdapter({
      baseUrl,
      timeoutMs: 120_000
    });

    const health = await adapter.health();
    expect(health.status).not.toBe("unavailable");

    const models = await adapter.listModels();
    expect(models.length).toBeGreaterThan(0);

    const response = await adapter.generate(
      languageModelRequestSchema.parse({
        availableTools: [],
        id: "ollama.live.1",
        instructions: "Reply with a short live health-check sentence for AIAgent.",
        messages: [
          {
            createdAt: new Date().toISOString(),
            id: "message.user.ollama.live.1",
            metadata: {},
            parts: [{ kind: "text", text: "Say the local Ollama path is reachable." }],
            role: "user",
            sessionId: "session.ollama.live.1",
            source: "user",
            tags: [],
            visibility: "default"
          }
        ],
        metadata: {},
        modelId: requestedModel ?? models[0]!.modelId,
        provider: "ollama",
        settings: {
          maxOutputTokens,
          stopSequences: [],
          temperature: 0,
          toolChoice: "none"
        }
      })
    );

    expect(response.provider).toBe("ollama");
    // Any text part will do: a reasoning model's first part need not be the answer.
    const answer = (response.message?.parts ?? [])
      .flatMap((part) => (part.kind === "text" ? [part.text] : []))
      .join("");
    expect(
      answer.trim().length,
      `no answer within ${maxOutputTokens} output tokens (stop reason: ${response.stopReason})`
    ).toBeGreaterThan(0);
  });
});
