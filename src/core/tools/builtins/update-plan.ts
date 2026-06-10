import { z } from "zod";

import {
  planItemStatusSchema,
  taskStateSnapshotSchema,
  workingMemoryNoteKindSchema,
  type JsonSchemaDocument,
  type ToolDefinition
} from "@/core/contracts";
import type { TaskStateService } from "@/core/plans";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

const updatePlanInputSchema = z
  .object({
    explanation: z.string().min(1).max(2000).optional(),
    items: z
      .array(
        z
          .object({
            blockedReason: z.string().min(1).max(1000).optional(),
            id: z.string().min(1).optional(),
            notes: z.string().min(1).max(4000).optional(),
            status: planItemStatusSchema,
            title: z.string().min(1).max(500)
          })
          .strict()
      )
      .max(64)
      .optional(),
    replaceWorkingMemory: z.boolean().default(false),
    summary: z.string().min(1).max(4000).optional(),
    title: z.string().min(1).max(256).optional(),
    workingMemory: z
      .array(
        z
          .object({
            id: z.string().min(1).optional(),
            kind: workingMemoryNoteKindSchema,
            priority: z.enum(["high", "medium", "low"]),
            text: z.string().min(1).max(4000)
          })
          .strict()
      )
      .max(64)
      .optional()
  })
  .strict()
  .refine((value) => Boolean(value.items || value.summary || value.title || value.workingMemory), {
    message: "Provide plan items, working memory, or a summary/title change."
  });

export function createUpdatePlanTool(params: { taskStateService: TaskStateService }): RuntimeTool {
  return {
    definition: updatePlanToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = updatePlanInputSchema.parse(call.arguments as unknown);
      const taskState = await params.taskStateService.updateTaskState({
        explanation: input.explanation,
        items: input.items,
        replaceWorkingMemory: input.replaceWorkingMemory,
        sessionId: context.session.id,
        summary: input.summary,
        title: input.title,
        turnId: context.turn.id,
        workingMemory: input.workingMemory
      });

      return {
        display: [
          {
            kind: "text",
            text: renderTaskState(taskState)
          }
        ],
        result: taskStateSnapshotSchema.parse(taskState)
      };
    }
  };
}

const updatePlanOutputSchema: JsonSchemaDocument = {
  additionalProperties: false,
  properties: {
    activePlanId: {
      type: "string"
    },
    blockers: {
      items: {
        type: "object"
      },
      type: "array"
    },
    nextStep: {
      type: "object"
    },
    plan: {
      type: ["object", "null"]
    },
    progress: {
      additionalProperties: false,
      properties: {
        blocked: { type: "integer" },
        cancelled: { type: "integer" },
        completed: { type: "integer" },
        inProgress: { type: "integer" },
        pending: { type: "integer" },
        total: { type: "integer" }
      },
      required: ["blocked", "cancelled", "completed", "inProgress", "pending", "total"],
      type: "object"
    },
    recentAttempts: {
      items: {
        type: "object"
      },
      type: "array"
    },
    sessionId: {
      type: "string"
    },
    summary: {
      type: "string"
    },
    updatedAt: {
      type: "string"
    },
    workingMemory: {
      items: {
        type: "object"
      },
      type: "array"
    }
  },
  required: ["blockers", "progress", "recentAttempts", "sessionId", "updatedAt", "workingMemory"],
  type: "object"
};

export const updatePlanToolDefinition: ToolDefinition = {
  aliases: ["todo", "update_todo_list"],
  annotations: {
    idempotentHint: false,
    meta: {
      family: "planning"
    },
    openWorldHint: false,
    readOnlyHint: false,
    title: "Update Plan"
  },
  approvalMode: "never",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only updates the agent's local task state for the current session.",
    examples: [
      "Use after the task goal becomes clear and you need a concrete checklist.",
      "Use after a failed attempt to record the blocker, next step, and revised plan."
    ],
    purpose: "Maintain the canonical task plan and short-lived working memory for the active session.",
    sideEffectSummary: "Writes plan and working-memory state under the local session directory so later turns and surfaces share the same task view.",
    whenNotToUse: [
      "Do not use it for durable facts that belong in long-term memory.",
      "Do not use multiple overlapping planning tools when this one canonical task-state path is available."
    ],
    whenToUse: [
      "Use when you need to create or revise the current checklist, blockers, recent attempts, or next step.",
      "Use when the operator asked for progress tracking or when the task direction changed materially."
    ]
  },
  description:
    "Update the canonical task plan and working memory for the current session. Use this to track checklist items, blockers, recent attempts, and the next step so the runtime and future surfaces stay in sync.",
  displayName: "Update Plan",
  execution: {
    inputMode: "json",
    resumable: false,
    taskSupport: "required"
  },
  idempotent: false,
  inputSchema: {
    additionalProperties: false,
    properties: {
      explanation: {
        description: "Optional short explanation of why the plan changed.",
        type: "string"
      },
      items: {
        items: {
          additionalProperties: false,
          properties: {
            blockedReason: { type: "string" },
            id: { type: "string" },
            notes: { type: "string" },
            status: {
              enum: ["blocked", "cancelled", "completed", "in_progress", "pending"],
              type: "string"
            },
            title: { type: "string" }
          },
          required: ["status", "title"],
          type: "object"
        },
        type: "array"
      },
      replaceWorkingMemory: {
        default: false,
        type: "boolean"
      },
      summary: {
        description: "Optional short summary of the current plan.",
        type: "string"
      },
      title: {
        description: "Optional plan title.",
        type: "string"
      },
      workingMemory: {
        items: {
          additionalProperties: false,
          properties: {
            id: { type: "string" },
            kind: {
              enum: ["blocker", "fact", "next_step", "recent_attempt", "status"],
              type: "string"
            },
            priority: {
              enum: ["high", "medium", "low"],
              type: "string"
            },
            text: { type: "string" }
          },
          required: ["kind", "priority", "text"],
          type: "object"
        },
        type: "array"
      }
    },
    type: "object"
  },
  invocationName: "update_plan",
  kind: "built_in",
  metadata: {},
  name: "update_plan",
  outputKind: "json",
  outputSchema: updatePlanOutputSchema,
  retryable: true,
  searchTags: ["blocker", "plan", "progress", "status", "todo", "working-memory"],
  sideEffects: ["none"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.builtin.update_plan",
  usageGuidance:
    "Use this as the single source of truth for the active checklist and short-lived task memory. Keep it concise, accurate, and updated after meaningful progress, blockers, or direction changes.",
  version: "1.0.0"
};

function renderTaskState(taskState: z.infer<typeof taskStateSnapshotSchema>): string {
  const parts = [
    `Plan progress: ${taskState.progress.completed}/${taskState.progress.total} completed, ${taskState.progress.inProgress} in progress, ${taskState.progress.pending} pending, ${taskState.progress.blocked} blocked.`,
    taskState.nextStep ? `Next step: ${taskState.nextStep.text}` : undefined,
    taskState.blockers.length > 0 ? `Blockers: ${taskState.blockers.map((note) => note.text).join("; ")}` : undefined,
    taskState.recentAttempts.length > 0
      ? `Recent attempts: ${taskState.recentAttempts.map((note) => note.text).join("; ")}`
      : undefined
  ];

  return parts.filter((part): part is string => Boolean(part)).join(" ");
}
