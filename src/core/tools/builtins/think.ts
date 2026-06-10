import { z } from "zod";

import type { ToolDefinition } from "@/core/contracts";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

const thinkInputSchema = z
  .object({
    thought: z.string().min(1).max(20_000)
  })
  .strict();

export function createThinkTool(): RuntimeTool {
  return {
    definition: thinkToolDefinition,
    async execute(call): Promise<RuntimeToolResult> {
      const input = thinkInputSchema.parse(call.arguments as unknown);
      return {
        display: [
          {
            kind: "status",
            state: "thinking",
            summary: input.thought
          }
        ],
        result: {
          acknowledged: true,
          thought: input.thought
        }
      };
    }
  };
}

export const thinkToolDefinition: ToolDefinition = {
  aliases: ["reason", "scratchpad"],
  annotations: {
    idempotentHint: true,
    meta: {
      family: "reasoning"
    },
    openWorldHint: false,
    readOnlyHint: true,
    title: "Think"
  },
  approvalMode: "never",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool records a thought without taking any action.",
    examples: [
      "Lay out the steps for a multi-file change before editing anything.",
      "Pause to reason about an unexpected tool result before deciding the next action."
    ],
    purpose: "Record reasoning, a plan sketch, or analysis without changing the workspace or calling other tools.",
    sideEffectSummary: "This tool does not change anything. It only records the thought in the transcript.",
    whenNotToUse: [
      "Do not use it to perform work; use action tools for that.",
      "Do not use it to ask the operator a question."
    ],
    whenToUse: [
      "Use to think through a hard decision or sequence steps before acting.",
      "Use to capture analysis of a tool result when the next action is not obvious."
    ]
  },
  description:
    "Record a private reasoning note without taking any action. Use it to plan, analyze a result, or think through a decision. It never changes the workspace and never calls other tools.",
  displayName: "Think",
  execution: {
    inputMode: "json",
    resumable: false,
    taskSupport: "forbidden"
  },
  idempotent: true,
  inputSchema: {
    additionalProperties: false,
    properties: {
      thought: {
        description: "The reasoning, plan, or analysis to record.",
        type: "string"
      }
    },
    required: ["thought"],
    type: "object"
  },
  invocationName: "think",
  kind: "built_in",
  metadata: {},
  name: "think",
  outputKind: "json",
  outputSchema: {
    additionalProperties: false,
    properties: {
      acknowledged: {
        type: "boolean"
      },
      thought: {
        type: "string"
      }
    },
    required: ["acknowledged", "thought"],
    type: "object"
  },
  retryable: true,
  searchTags: ["analysis", "plan", "reason", "reflect", "think"],
  sideEffects: ["none"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.builtin.think",
  usageGuidance:
    "Use this to reason or plan without acting. It does not change anything and does not replace action tools. Do not use it to finish a task or to ask the operator a question.",
  version: "1.0.0"
};
