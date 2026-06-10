import { z } from "zod";

import { memoryEntrySchema, memoryKindSchema, memoryScopeSchema, type ToolDefinition } from "@/core/contracts";
import type { FileBackedMemoryService } from "@/core/memory";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

const memoryWriteInputSchema = z
  .object({
    confidence: z.number().min(0).max(1).default(0.8),
    content: z.string().min(1),
    kind: memoryKindSchema,
    recencyScore: z.number().min(0).max(1).default(0.5),
    scope: memoryScopeSchema.refine((value) => value !== "working", "Use update_plan for short-lived working memory."),
    staleAt: z.string().min(1).optional(),
    summary: z.string().min(1).optional(),
    tags: z.array(z.string().min(1).max(64)).max(16).default([])
  })
  .strict();

export function createMemoryWriteTool(params: { memoryService: FileBackedMemoryService }): RuntimeTool {
  return {
    definition: memoryWriteToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = memoryWriteInputSchema.parse(call.arguments as unknown);
      const now = new Date().toISOString();
      const entry = memoryEntrySchema.parse({
        confidence: input.confidence,
        content: input.content,
        createdAt: now,
        id: `memory.${input.scope}.${context.session.id}.${call.id}`,
        kind: input.kind,
        metadata: {},
        provenance: {
          messageIds: [],
          sourceLabel: "memory_write_tool",
          toolCallIds: [call.id]
        },
        recencyScore: input.recencyScore,
        scope: input.scope,
        ...(input.scope === "session" ? { sessionId: context.session.id } : {}),
        staleAt: input.staleAt,
        summary: input.summary,
        tags: input.tags,
        updatedAt: now
      });

      await params.memoryService.upsert(entry);

      return {
        display: [
          {
            kind: "text",
            text: `Saved ${entry.scope} memory: ${entry.summary ?? entry.kind}`
          }
        ],
        result: entry
      };
    }
  };
}

export const memoryWriteToolDefinition: ToolDefinition = {
  aliases: ["remember", "memory_upsert"],
  annotations: {
    idempotentHint: false,
    meta: {
      family: "memory"
    },
    openWorldHint: false,
    readOnlyHint: false,
    title: "Memory Write"
  },
  approvalMode: "never",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only updates local durable memory files and indexes.",
    examples: [
      "Use after confirming a durable workspace convention that should survive the current session.",
      "Use after the operator states a persistent preference that later tasks should remember."
    ],
    purpose: "Persist a durable memory entry for the workspace, the user, or the current session.",
    sideEffectSummary: "Writes local memory indexes and summary markdown files, including MEMORY.md and session summaries when applicable.",
    whenNotToUse: [
      "Do not use for temporary task scratch notes; use update_plan for short-lived working memory.",
      "Do not write speculative facts that are not yet verified."
    ],
    whenToUse: [
      "Use for durable facts, decisions, preferences, or instructions that future sessions should be able to recall.",
      "Use after verifying information that belongs in workspace, user-global, or session memory."
    ]
  },
  description:
    "Write a durable memory entry to the local memory store. Use this for verified facts, preferences, or decisions that should survive the current turn or session.",
  displayName: "Memory Write",
  execution: {
    inputMode: "json",
    resumable: false,
    taskSupport: "optional"
  },
  idempotent: false,
  inputSchema: {
    additionalProperties: false,
    properties: {
      confidence: {
        maximum: 1,
        minimum: 0,
        type: "number"
      },
      content: {
        type: "string"
      },
      kind: {
        enum: ["artifact", "decision", "fact", "instruction", "preference", "status", "summary"],
        type: "string"
      },
      recencyScore: {
        maximum: 1,
        minimum: 0,
        type: "number"
      },
      scope: {
        enum: ["session", "user_global", "workspace"],
        type: "string"
      },
      staleAt: {
        type: "string"
      },
      summary: {
        type: "string"
      },
      tags: {
        items: {
          type: "string"
        },
        type: "array"
      }
    },
    required: ["content", "kind", "scope"],
    type: "object"
  },
  invocationName: "memory_write",
  kind: "memory",
  metadata: {},
  name: "memory_write",
  outputKind: "json",
  outputSchema: {
    type: "object"
  },
  retryable: true,
  searchTags: ["durable-memory", "memory", "remember", "summary"],
  sideEffects: ["workspace_write"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.memory.write",
  usageGuidance:
    "Use this only for durable, verified information that should survive beyond the current task. Prefer workspace or user-global scope for long-lived facts and preferences.",
  version: "1.0.0"
};
