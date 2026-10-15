import type { ApprovalRequest, JsonValue } from "@/core/contracts";

/** A choice offered with a question; `value` is what a choice stands for when it differs from its label. */
export type QuestionOption = { description?: string; label: string; value?: string };

/**
 * A question put to the operator as a pending approval (target kind
 * `question`): the agent's `ask_user_question`, or an MCP server's mid-call
 * question. Both are built here, so every surface reads the same shape: the
 * question in `justification`, the choices in `metadata.options`
 * (`{ label, description?, value? }`), and the answer coming back as the
 * resolution's comment.
 */
export function buildQuestionApproval(params: {
  id: string;
  /** `metadata.interaction`: how the answer is used ("question", "elicitation"). */
  interaction: string;
  metadata?: Record<string, JsonValue>;
  options: QuestionOption[];
  question: string;
  riskSummary: string;
  sessionId: string;
  target: { label: string; value: string };
  toolCallId?: string;
  turnId: string;
}): ApprovalRequest {
  return {
    createdAt: new Date().toISOString(),
    id: params.id,
    justification: params.question,
    metadata: {
      ...params.metadata,
      interaction: params.interaction,
      options: params.options.map((option) => ({
        ...(option.description ? { description: option.description } : {}),
        label: option.label,
        ...(option.value !== undefined ? { value: option.value } : {})
      }))
    },
    riskSummary: params.riskSummary,
    sessionId: params.sessionId,
    status: "pending",
    target: { kind: "question", ...params.target },
    ...(params.toolCallId ? { toolCallId: params.toolCallId } : {}),
    turnId: params.turnId
  };
}

/** The choices a question approval offers (its `metadata.options`), skipping any that are malformed. */
export function readQuestionOptions(raw: unknown): QuestionOption[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((option: unknown) => {
    if (typeof option !== "object" || option === null || Array.isArray(option)) {
      return [];
    }
    const { description, label, value } = option as { description?: unknown; label?: unknown; value?: unknown };
    if (typeof label !== "string" || label.length === 0) {
      return [];
    }
    return [
      {
        ...(typeof description === "string" && description.length > 0 ? { description } : {}),
        label,
        ...(typeof value === "string" ? { value } : {})
      }
    ];
  });
}

/**
 * The option an answer picks, the same way on every surface: the option whose
 * value or label it is (ignoring case), else the one at the position it names
 * (1-based). A label that is itself a number ("5" story points) is matched as
 * a label first, so a surface that sends the label is not read as a position.
 */
export function matchQuestionOption<T extends QuestionOption>(options: readonly T[], answer: string): T | undefined {
  const trimmed = answer.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const lowered = trimmed.toLowerCase();
  const exact = options.find(
    (option) => option.value?.toLowerCase() === lowered || option.label.toLowerCase() === lowered
  );
  if (exact) {
    return exact;
  }
  return /^\d+$/u.test(trimmed) ? options[Number.parseInt(trimmed, 10) - 1] : undefined;
}
