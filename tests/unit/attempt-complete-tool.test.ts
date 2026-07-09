import { describe, expect, test } from "vitest";

import { attemptCompleteToolDefinition } from "@/core/tools/builtins/attempt-complete";

// The completion-contract pass (2026-06-15) strengthened the tool's
// usageGuidance specifically to address local models that finished work but
// stopped with a prose-only "I'm done" instead of emitting the tool call.
// These assertions defend that wording: if the guidance is softened or the
// "do not send the summary as chat text" cue is removed, the failure mode the
// pass was meant to prevent comes back, so update intentionally — and update
// docs/AGENT_LOOP.md alongside.
describe("attempt_complete tool definition", () => {
  test("usageGuidance tells the model that prose does not end the task", () => {
    const guidance = attemptCompleteToolDefinition.usageGuidance;
    expect(guidance).toMatch(/ONLY way to end the task/u);
    expect(guidance).toMatch(/does not end it/u);
    expect(guidance).toMatch(/summary.+argument/iu);
    expect(guidance).toMatch(/by itself|do not combine/iu);
  });

  test("invocation name and aliases stay stable", () => {
    expect(attemptCompleteToolDefinition.invocationName).toBe(
      "attempt_complete"
    );
    expect(attemptCompleteToolDefinition.aliases).toContain("task_complete");
  });

  test("summary remains a required argument", () => {
    expect(attemptCompleteToolDefinition.inputSchema).toMatchObject({
      required: ["summary"]
    });
  });
});
