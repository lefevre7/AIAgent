import { describe, expect, test } from "vitest";

import { buildQuestionApproval, matchQuestionOption, readQuestionOptions } from "@/core/approvals";

describe("matchQuestionOption", () => {
  const options = [
    { label: "United States", value: "us" },
    { label: "Europe", value: "eu" }
  ];

  test("matches an option's label or value, ignoring case and surrounding space", () => {
    expect(matchQuestionOption(options, " europe ")?.value).toBe("eu");
    expect(matchQuestionOption(options, "US")?.label).toBe("United States");
  });

  test("reads a number as the option at that position, counting from 1", () => {
    expect(matchQuestionOption(options, "2")?.value).toBe("eu");
    expect(matchQuestionOption(options, "3")).toBeUndefined();
    expect(matchQuestionOption(options, "0")).toBeUndefined();
  });

  test("a label that is itself a number is that option, not a position", () => {
    const points = [{ label: "5" }, { label: "1" }];
    expect(matchQuestionOption(points, "1")?.label).toBe("1");
    expect(matchQuestionOption(points, "2")?.label).toBe("1");
  });

  test("nothing matches an empty answer or free text", () => {
    expect(matchQuestionOption(options, "  ")).toBeUndefined();
    expect(matchQuestionOption(options, "Asia")).toBeUndefined();
  });
});

describe("question approvals", () => {
  test("every question approval carries its options in one shape, which readQuestionOptions reads back", () => {
    const approval = buildQuestionApproval({
      id: "approval.q.1",
      interaction: "question",
      metadata: { toolKind: "builtin" },
      options: [
        { description: "plain HTTP", label: "REST" },
        { label: "Europe", value: "eu" }
      ],
      question: "Which?",
      riskSummary: "Answer it.",
      sessionId: "session.1",
      target: { label: "Ask", value: "ask_user_question" },
      turnId: "turn.1"
    });

    expect(approval).toMatchObject({
      justification: "Which?",
      metadata: { interaction: "question", toolKind: "builtin" },
      status: "pending",
      target: { kind: "question", label: "Ask", value: "ask_user_question" }
    });
    expect(approval).not.toHaveProperty("toolCallId");
    expect(readQuestionOptions(approval.metadata.options)).toEqual([
      { description: "plain HTTP", label: "REST" },
      { label: "Europe", value: "eu" }
    ]);
  });

  test("readQuestionOptions skips what is not an option", () => {
    expect(readQuestionOptions([{ label: "" }, "REST", null, { label: "ok", description: 5 }])).toEqual([
      { label: "ok" }
    ]);
    expect(readQuestionOptions(undefined)).toEqual([]);
  });
});
