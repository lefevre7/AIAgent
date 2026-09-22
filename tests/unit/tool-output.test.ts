import { describe, expect, test } from "vitest";

import { truncateToolOutput } from "@/core/tools/output";

describe("truncateToolOutput", () => {
  test("returns content unchanged when it fits the budget", () => {
    const result = truncateToolOutput({ content: "short", maxChars: 10 });

    expect(result).toEqual({
      omittedChars: 0,
      text: "short",
      totalChars: 5,
      truncated: false
    });
  });

  // A bare "[truncated]" marker tells the model something is missing but not
  // how to get it, so it either gives up or re-runs the whole command.
  test("names the follow-up call and the artifact path when it clips", () => {
    const result = truncateToolOutput({
      artifactPath: "/state/commands/runs/command.1/combined.log",
      content: "0123456789abcdef",
      followUp: 'read_command_output(sessionId: "command.1", offset: 8)',
      maxChars: 8
    });

    expect(result.truncated).toBe(true);
    expect(result.omittedChars).toBe(8);
    expect(result.totalChars).toBe(16);
    expect(result.text).toBe(
      '01234567\n\n[output truncated: 8 of 16 characters omitted; read the rest with read_command_output(sessionId: "command.1", offset: 8); full output: /state/commands/runs/command.1/combined.log]'
    );
  });

  test("omits directions it was not given", () => {
    const result = truncateToolOutput({
      content: "0123456789",
      maxChars: 4
    });

    expect(result.text).toBe("0123\n\n[output truncated: 6 of 10 characters omitted]");
  });
});
