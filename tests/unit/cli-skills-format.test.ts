import { describe, expect, test } from "vitest";

import { formatSkillList } from "@/commands/skills";
import type { SkillSummary } from "@/core";

function summary(overrides: Partial<SkillSummary>): SkillSummary {
  return {
    description: "Does a thing.",
    directory: "/work/.agents/skills/thing",
    disableModelInvocation: false,
    enabled: true,
    filePath: "/work/.agents/skills/thing/SKILL.md",
    name: "thing",
    scope: "project",
    ...overrides
  } as SkillSummary;
}

describe("formatSkillList", () => {
  test("prints names, descriptions and paths from SKILL.md files so they cannot drive the terminal", () => {
    const text = formatSkillList({
      diagnostics: [
        {
          kind: "invalid",
          message: "bad \u001b[31mYAML\u001b[0m",
          path: "/work/.agents/skills/x\rSKILL.md",
          severity: "error"
        }
      ],
      skills: [summary({ description: "Line one\nLine two \u001b]52;c;ZXZpbA==\u0007", name: "thing\u202e" })]
    });

    for (const raw of ["\u001b", "\u0007", "\u202e", "\r"]) {
      expect(text).not.toContain(raw);
    }
    expect(text).toContain("thing\\u202e  [project]  Line one\\nLine two \\x1b]52;c;ZXZpbA==\\x07");
    expect(text).toContain("error: /work/.agents/skills/x\\rSKILL.md: bad \\x1b[31mYAML\\x1b[0m");
  });

  test("cuts a long description at 120 characters without splitting an emoji", () => {
    const description = `${"a".repeat(118)}👍👍 and more`;
    const text = formatSkillList({ diagnostics: [], skills: [summary({ description })] });
    expect(text).toContain(`  ${"a".repeat(118)}👍…`);
  });
});
