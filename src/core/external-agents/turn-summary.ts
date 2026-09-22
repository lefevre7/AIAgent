import crypto from "node:crypto";

import type { AppConfig } from "@/core/config";
import type { ExternalAgentTurnSummarizer } from "@/core/external-agents/sessions";
import type { LanguageModelRuntime } from "@/core/lm/runtime";

const SUMMARY_INSTRUCTIONS = [
  "You summarize the output of an external coding agent's terminal for another AI agent.",
  "Write one short paragraph in plain prose. No bullet points, no markdown headings, no preamble.",
  "Say what the external agent did, what it concluded, and anything it is waiting on or blocked by.",
  "If the screen shows an error or an unanswered prompt, say so explicitly.",
  "Never invent work that the screen does not show."
].join(" ");

const MAX_SCREEN_CHARS = 12_000;

/**
 * Turns a terminal screen into a paragraph the calling model can actually use.
 *
 * A raw 40-line TUI screen is expensive context and mostly chrome: box drawing,
 * status bars, and a spinner's last frame. Spending one small model call to
 * reduce it to prose is far cheaper than paying for that chrome on every turn
 * of the outer conversation for the rest of the session.
 *
 * Failure is never fatal — the caller still reports the screen verbatim.
 */
export function createExternalAgentTurnSummarizer(params: {
  config: AppConfig;
  modelRuntime: Pick<LanguageModelRuntime, "generate">;
}): ExternalAgentTurnSummarizer {
  return async ({ agentId, instruction, screen }) => {
    const trimmed = screen.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    const clipped =
      trimmed.length > MAX_SCREEN_CHARS
        ? `[earlier screen omitted]\n${trimmed.slice(trimmed.length - MAX_SCREEN_CHARS)}`
        : trimmed;
    const now = new Date().toISOString();
    const sessionId = `external-agent-summary.${crypto.randomUUID()}`;

    const response = await params.modelRuntime.generate({
      availableTools: [],
      id: `external-agent-summary.${crypto.randomUUID()}`,
      instructions: SUMMARY_INSTRUCTIONS,
      messages: [
        {
          createdAt: now,
          id: `message.${crypto.randomUUID()}`,
          metadata: {},
          parts: [
            {
              kind: "text",
              text: [
                `External agent: ${agentId}`,
                `Instruction sent: ${instruction}`,
                "Terminal screen after the agent finished its turn:",
                "---",
                clipped,
                "---"
              ].join("\n")
            }
          ],
          role: "user",
          sessionId,
          source: "system",
          tags: [],
          visibility: "default"
        }
      ],
      metadata: {},
      responseFormat: { kind: "text" },
      settings: {
        ...params.config.runtime.modelSettings,
        // A paragraph, not an essay. Also caps the cost of a looping model.
        maxOutputTokens: 400,
        stopSequences: [],
        toolChoice: "none"
      }
    });

    const text = (response.message?.parts ?? [])
      .filter((part): part is { kind: "text"; text: string } => part.kind === "text")
      .map((part) => part.text.trim())
      .filter((part) => part.length > 0)
      .join("\n")
      .trim();

    return text.length > 0 ? text : undefined;
  };
}
