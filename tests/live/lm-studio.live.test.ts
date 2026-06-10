import { describe, expect } from "vitest";

import { LMStudioLanguageModelAdapter } from "@/core";
import { languageModelRequestSchema } from "@/core/contracts";
import { createLiveTestHarness, envFlag } from "./helpers";

const baseUrl = process.env.AIA_LIVE_LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1";
const requestedModel = process.env.AIA_LIVE_LM_STUDIO_MODEL;
const { liveTest } = createLiveTestHarness({
  enabled: envFlag("AIA_RUN_LIVE_LM_STUDIO_TESTS"),
  prefix: "aiagent-live-lm-studio-"
});

describe("LM Studio adapter (live)", () => {
  liveTest("lists models and produces a non-empty completion", async () => {
    const adapter = new LMStudioLanguageModelAdapter({
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
        id: "lm-studio.live.1",
        instructions: "Reply with a short live health-check sentence for AIAgent.",
        messages: [
          {
            createdAt: new Date().toISOString(),
            id: "message.user.lm-studio.live.1",
            metadata: {},
            parts: [{ kind: "text", text: "Say the local LM Studio path is reachable." }],
            role: "user",
            sessionId: "session.lm-studio.live.1",
            source: "user",
            tags: [],
            visibility: "default"
          }
        ],
        metadata: {},
        modelId: requestedModel ?? models[0]!.modelId,
        provider: "lm_studio",
        settings: {
          maxOutputTokens: 64,
          stopSequences: [],
          temperature: 0,
          toolChoice: "none"
        }
      })
    );

    const firstPart = response.message?.parts[0];
    expect(response.provider).toBe("lm_studio");
    expect(firstPart && "text" in firstPart ? firstPart.text.trim().length : 0).toBeGreaterThan(0);
  });
});
