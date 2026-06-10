import { z } from "zod";

import type { ToolDefinition } from "@/core/contracts";
import type { FileBackedMemoryService } from "@/core/memory";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

const inputSchema = z
  .object({
    lineCount: z.number().int().positive().optional(),
    path: z.string().min(1),
    startLine: z.number().int().positive().optional()
  })
  .strict();

export function createMemoryGetTool(params: { memoryService: FileBackedMemoryService }): RuntimeTool {
  return {
    definition: memoryGetToolDefinition,
    async execute(call): Promise<RuntimeToolResult> {
      const input = inputSchema.parse(call.arguments as unknown);
      return {
        result: await params.memoryService.getMemoryFile(input)
      };
    }
  };
}

export const memoryGetToolDefinition: ToolDefinition = {
  aliases: [],
  annotations: {
    idempotentHint: true,
    meta: {
      family: "memory"
    },
    openWorldHint: false,
    readOnlyHint: true,
    title: "Memory Get"
  },
  approvalMode: "never",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only reads allowed local memory Markdown files.",
    examples: [
      "Read MEMORY.md from the top.",
      "Read a specific session summary file from line 1 for 40 lines.",
      "After memory_search finds a note, read only the needed lines."
    ],
    purpose: "Read a specific allowed memory Markdown file by canonical memory path and optional line window.",
    sideEffectSummary: "Reads local memory files only and returns an empty payload instead of throwing when the target file does not exist yet.",
    whenNotToUse: ["Do not use when you need discovery; use memory_search first."],
    whenToUse: ["Use when you already know which memory file you need to inspect and want to keep context small."]
  },
  description:
    "Read a specific memory Markdown file from the allowed memory roots, optionally using a line window. Missing files return empty content instead of an error.",
  displayName: "Memory Get",
  execution: {
    inputMode: "json",
    resumable: false,
    taskSupport: "optional"
  },
  idempotent: true,
  inputSchema: {
    additionalProperties: false,
    properties: {
      lineCount: {
        type: "integer"
      },
      path: {
        type: "string"
      },
      startLine: {
        type: "integer"
      }
    },
    required: ["path"],
    type: "object"
  },
  invocationName: "memory_get",
  kind: "memory",
  metadata: {},
  name: "memory_get",
  outputKind: "json",
  outputSchema: {
    type: "object"
  },
  retryable: true,
  searchTags: ["memory", "read"],
  sideEffects: ["none"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.memory.get",
  usageGuidance:
    "Use after memory_search when you need a precise memory snippet. Missing files return empty content so the workflow can continue.",
  version: "1.0.0"
};
