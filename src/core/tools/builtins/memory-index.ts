import type { ToolDefinition } from "@/core/contracts";
import type { FileBackedMemoryService } from "@/core/memory";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

export function createMemoryIndexTool(params: { memoryService: FileBackedMemoryService }): RuntimeTool {
  return {
    definition: memoryIndexToolDefinition,
    async execute(): Promise<RuntimeToolResult> {
      return {
        result: await params.memoryService.reindexMemory()
      };
    }
  };
}

export const memoryIndexToolDefinition: ToolDefinition = {
  aliases: [],
  annotations: {
    idempotentHint: false,
    meta: {
      family: "memory"
    },
    openWorldHint: false,
    readOnlyHint: false,
    title: "Memory Index"
  },
  approvalMode: "never",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only rebuilds the local memory index.",
    examples: ["Force a memory reindex after changing many memory files at once."],
    purpose: "Force a rebuild of the local memory retrieval index from the current memory files.",
    sideEffectSummary: "Writes the local SQLite memory index.",
    whenNotToUse: ["Do not use before every search; the runtime handles normal sync itself."],
    whenToUse: ["Use when you need to force an immediate memory reindex after large out-of-band edits."]
  },
  description: "Force a rebuild of the local memory retrieval index from the current memory corpus.",
  displayName: "Memory Index",
  execution: {
    inputMode: "json",
    resumable: false,
    taskSupport: "optional"
  },
  idempotent: false,
  inputSchema: {
    additionalProperties: false,
    properties: {},
    type: "object"
  },
  invocationName: "memory_index",
  kind: "memory",
  metadata: {},
  name: "memory_index",
  outputKind: "json",
  outputSchema: {
    type: "object"
  },
  retryable: true,
  searchTags: ["index", "memory", "rebuild"],
  sideEffects: ["workspace_write"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.memory.index",
  usageGuidance: "Use sparingly to force a full memory reindex when the normal sync path is not enough.",
  version: "1.0.0"
};
