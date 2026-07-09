import type { ToolDefinition } from "@/core/contracts";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

export function createAttemptCompleteTool(): RuntimeTool {
  return {
    definition: attemptCompleteToolDefinition,
    async execute(call): Promise<RuntimeToolResult> {
      const status = typeof call.arguments.status === "string" ? call.arguments.status : "success";
      const summary = typeof call.arguments.summary === "string" ? call.arguments.summary : "Completion requested.";

      return {
        result: {
          completionRequested: true,
          status,
          summary
        }
      };
    }
  };
}

export const attemptCompleteToolDefinition: ToolDefinition = {
  aliases: ["task_complete"],
  annotations: {
    idempotentHint: false,
    meta: {
      family: "completion"
    },
    openWorldHint: false,
    readOnlyHint: true,
    title: "Attempt Complete"
  },
  approvalMode: "never",
  descriptor: {
    approvalNotes: "No operator approval is required, but the runtime will reject completion if required work remains unresolved.",
    examples: [
      "Use after tests pass and the requested change is done.",
      "Use after you can clearly summarize what changed and any remaining caveats."
    ],
    purpose: "Finish the active task through the runtime-controlled completion gate.",
    sideEffectSummary: "This tool does not change the workspace. It asks the runtime to validate whether the task can end.",
    whenNotToUse: [
      "Do not use it together with other tool calls in the same turn.",
      "Do not use it if approvals, errors, or obvious remaining steps still exist."
    ],
    whenToUse: [
      "Use only when the requested work is actually complete.",
      "Use after you can explain what you changed, what you tried, and any remaining caveats."
    ]
  },
  description:
    "Request runtime-controlled task completion. This is the only supported way to finish a task. The runtime will validate that no required work remains unresolved before accepting it.",
  displayName: "Attempt Complete",
  execution: {
    inputMode: "json",
    resumable: false,
    taskSupport: "forbidden"
  },
  idempotent: false,
  inputSchema: {
    additionalProperties: false,
    properties: {
      remainingCaveats: {
        items: {
          type: "string"
        },
        type: "array"
      },
      status: {
        default: "success",
        enum: ["success", "partial", "failed"],
        type: "string"
      },
      summary: {
        description: "A concise explanation of what you finished, what changed, and any remaining caveats.",
        type: "string"
      }
    },
    required: ["summary"],
    type: "object"
  },
  invocationName: "attempt_complete",
  kind: "built_in",
  metadata: {},
  name: "attempt_complete",
  outputKind: "json",
  outputSchema: {
    additionalProperties: false,
    properties: {
      completionRequested: {
        type: "boolean"
      },
      status: {
        type: "string"
      },
      summary: {
        type: "string"
      }
    },
    required: ["completionRequested", "status", "summary"],
    type: "object"
  },
  retryable: true,
  searchTags: ["complete", "done", "finish", "finalize", "summary"],
  sideEffects: ["none"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.builtin.attempt_complete",
  usageGuidance:
    "This tool is the ONLY way to end the task. Saying you are done in chat does not end it — the runtime only stops when you call this tool and the gate accepts it. If you are about to send a final summary message, send that paragraph as the `summary` argument of this tool call instead of as chat text. Call it by itself; do not combine it with other tool calls in the same turn. Before calling, make sure you can explain what you accomplished, what you tried, and any remaining caveats.",
  version: "1.0.0"
};
