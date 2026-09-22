import { describe, expect, test } from "vitest";

import { DEFAULT_APP_CONFIG } from "@/core/config";
import { createExternalAgentTurnSummarizer } from "@/core/external-agents/turn-summary";
import type { LanguageModelResponse } from "@/core/contracts";

function createResponse(text: string): LanguageModelResponse {
  return {
    id: "response.1",
    metadata: {},
    message: {
      createdAt: new Date().toISOString(),
      id: "message.1",
      metadata: {},
      parts: [{ kind: "text", text }],
      role: "assistant",
      sessionId: "session.1",
      source: "assistant",
      tags: [],
      visibility: "default"
    },
    modelId: "test",
    provider: "lm_studio",
    stopReason: "stop",
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  } as unknown as LanguageModelResponse;
}

describe("createExternalAgentTurnSummarizer", () => {
  test("turns a terminal screen into prose and never offers tools to the summary model", async () => {
    const requests: Array<{ instructions: string; settings: { toolChoice: string } }> = [];
    const summarize = createExternalAgentTurnSummarizer({
      config: DEFAULT_APP_CONFIG,
      modelRuntime: {
        generate: async (request) => {
          requests.push(request as never);
          return createResponse("  Codex added the retry and the tests pass.  ");
        }
      }
    });

    const summary = await summarize({
      agentId: "codex",
      instruction: "add a retry",
      screen: "> add a retry\nrunning tests...\nOK"
    });

    expect(summary).toBe("Codex added the retry and the tests pass.");
    expect(requests).toHaveLength(1);
    // A summarizer that could call tools would be a second agent loop, not a
    // summary.
    expect(requests[0]?.settings.toolChoice).toBe("none");
  });

  test("skips the model call entirely for an empty screen", async () => {
    let calls = 0;
    const summarize = createExternalAgentTurnSummarizer({
      config: DEFAULT_APP_CONFIG,
      modelRuntime: {
        generate: async () => {
          calls += 1;
          return createResponse("unused");
        }
      }
    });

    expect(await summarize({ agentId: "codex", instruction: "x", screen: "   \n\n " })).toBeUndefined();
    expect(calls).toBe(0);
  });

  test("returns undefined when the model produced no usable text", async () => {
    const summarize = createExternalAgentTurnSummarizer({
      config: DEFAULT_APP_CONFIG,
      modelRuntime: {
        generate: async () => createResponse("   ")
      }
    });

    expect(await summarize({ agentId: "codex", instruction: "x", screen: "something" })).toBeUndefined();
  });
});
