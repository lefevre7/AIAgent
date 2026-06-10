import { z } from "zod";

import type { JsonSchemaDocument, JsonValue, ToolDefinition } from "@/core/contracts";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

const askUserQuestionInputSchema = z
  .object({
    options: z
      .array(
        z
          .object({
            description: z.string().max(2000).optional(),
            label: z.string().min(1).max(200)
          })
          .strict()
      )
      .max(12)
      .optional(),
    question: z.string().min(1).max(4000)
  })
  .strict();

// The runtime threads the operator's approval-resolution comment (the answer)
// onto the resumed tool call's metadata under this key. See
// executeApprovedPendingToolCall in src/gateway/runtime.ts.
const ANSWER_METADATA_KEY = "approvalResolutionComment";

export function createAskUserQuestionTool(): RuntimeTool {
  return {
    definition: askUserQuestionToolDefinition,
    async execute(call): Promise<RuntimeToolResult> {
      const input = askUserQuestionInputSchema.parse(call.arguments as unknown);
      const rawAnswer = call.metadata[ANSWER_METADATA_KEY];
      const answer = typeof rawAnswer === "string" ? rawAnswer.trim() : "";
      const selectedOption = matchSelectedOption(answer, input.options);

      return {
        display: [
          {
            kind: "status",
            state: "answered",
            summary: answer.length > 0 ? `Operator answered: ${answer}` : "Operator answered without additional text."
          }
        ],
        result: {
          answer,
          answered: true,
          question: input.question,
          ...(selectedOption ? { selectedOption } : {})
        }
      };
    }
  };
}

function matchSelectedOption(answer: string, options?: Array<{ label: string }>): string | undefined {
  if (!options || answer.length === 0) {
    return undefined;
  }
  const normalized = answer.toLowerCase();
  return options.find((option) => option.label.toLowerCase() === normalized)?.label;
}

const askUserQuestionOutputSchema: JsonSchemaDocument = {
  additionalProperties: false,
  properties: {
    answer: { type: "string" },
    answered: { type: "boolean" },
    question: { type: "string" },
    selectedOption: { type: "string" }
  },
  required: ["answer", "answered", "question"],
  type: "object"
};

export const askUserQuestionToolDefinition: ToolDefinition = {
  aliases: ["ask_followup_question", "request_user_input"],
  annotations: {
    idempotentHint: false,
    meta: {
      // Marks this tool so the approval decider surfaces the question + options
      // as the approval request instead of a generic risk prompt.
      family: "interaction",
      interaction: "question" as JsonValue
    },
    openWorldHint: false,
    readOnlyHint: true,
    title: "Ask User Question"
  },
  // "always" guarantees the run pauses for the operator regardless of the
  // configured default approval mode; the operator's answer is the resolution.
  approvalMode: "always",
  descriptor: {
    approvalNotes:
      "This tool pauses the run and surfaces the question to the operator. The operator's resolution comment is returned as the answer.",
    examples: [
      "Ask which of two API designs to implement when the request is ambiguous.",
      "Confirm a destructive assumption before proceeding.",
      "Ask for a missing value (an account id, a target environment) that only the operator knows."
    ],
    purpose: "Ask the operator a question and wait for their answer before continuing.",
    sideEffectSummary: "Pauses the run for operator input. Does not change the workspace.",
    whenNotToUse: [
      "Do not use it to finish the task; finish only when the work is actually done.",
      "Do not use it for information you can obtain yourself with other tools.",
      "Do not ask several questions at once when one will do."
    ],
    whenToUse: [
      "Use when the request is genuinely ambiguous and a wrong guess would waste work.",
      "Use when only the operator can supply a required value or decision."
    ]
  },
  description:
    "Ask the operator a question (optionally with suggested choices) and pause until they answer. The run resumes once the operator resolves the prompt, and their answer is returned as the tool result.",
  displayName: "Ask User Question",
  execution: {
    inputMode: "json",
    resumable: true,
    taskSupport: "forbidden"
  },
  idempotent: false,
  inputSchema: {
    additionalProperties: false,
    properties: {
      options: {
        description: "Optional suggested choices. The operator may pick one or answer freely.",
        items: {
          additionalProperties: false,
          properties: {
            description: { type: "string" },
            label: { type: "string" }
          },
          required: ["label"],
          type: "object"
        },
        type: "array"
      },
      question: {
        description: "The question to ask the operator.",
        type: "string"
      }
    },
    required: ["question"],
    type: "object"
  },
  invocationName: "ask_user_question",
  kind: "built_in",
  metadata: {},
  name: "ask_user_question",
  outputKind: "json",
  outputSchema: askUserQuestionOutputSchema,
  retryable: false,
  searchTags: ["ask", "clarify", "confirm", "followup", "input", "operator", "question"],
  sideEffects: ["none"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.builtin.ask_user_question",
  usageGuidance:
    "Use this only when the request is genuinely ambiguous or needs operator-only information. It pauses the run until the operator answers; keep questions specific and offer options when the choices are known.",
  version: "1.0.0"
};
