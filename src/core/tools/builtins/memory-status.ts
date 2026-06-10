import type { ToolDefinition } from "@/core/contracts";
import type { FileBackedMemoryService } from "@/core/memory";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

export function createMemoryStatusTool(params: { memoryService: FileBackedMemoryService }): RuntimeTool {
  return {
    definition: memoryStatusToolDefinition,
    async execute(): Promise<RuntimeToolResult> {
      return {
        result: await params.memoryService.getMemoryStatus()
      };
    }
  };
}

export const memoryStatusToolDefinition: ToolDefinition = {
  aliases: [],
  annotations: {
    idempotentHint: true,
    meta: {
      family: "memory"
    },
    openWorldHint: false,
    readOnlyHint: true,
    title: "Memory Status"
  },
  approvalMode: "never",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only reports local memory-system health and index state.",
    examples: ["Check whether semantic retrieval is healthy before relying on it heavily."],
    purpose: "Report retrieval/index health, embedding readiness, and index statistics for the local memory subsystem.",
    sideEffectSummary: "Reads local retrieval status only.",
    whenNotToUse: ["Do not use as a substitute for memory_search when you need actual memory content."],
    whenToUse: ["Use when you need to know whether hybrid search is healthy or degraded."]
  },
  description: "Report the current health and index status of the local memory subsystem.",
  displayName: "Memory Status",
  execution: {
    inputMode: "json",
    resumable: false,
    taskSupport: "optional"
  },
  idempotent: true,
  inputSchema: {
    additionalProperties: false,
    properties: {},
    type: "object"
  },
  invocationName: "memory_status",
  kind: "memory",
  metadata: {},
  name: "memory_status",
  outputKind: "json",
  outputSchema: {
    type: "object"
  },
  retryable: true,
  searchTags: ["health", "index", "memory", "status"],
  sideEffects: ["none"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.memory.status",
  usageGuidance: "Use to inspect whether lexical and semantic memory retrieval are healthy, dirty, or degraded.",
  version: "1.0.0"
};
