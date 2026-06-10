import { z } from "zod";

import { memoryQuerySchema, type ToolDefinition } from "@/core/contracts";
import type { FileBackedMemoryService } from "@/core/memory";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

const inputSchema = memoryQuerySchema.extend({
  text: z.string().min(1)
});

export function createMemorySearchTool(params: { memoryService: FileBackedMemoryService }): RuntimeTool {
  return {
    definition: memorySearchToolDefinition,
    async execute(call): Promise<RuntimeToolResult> {
      const input = inputSchema.parse(call.arguments as unknown);
      const search = await params.memoryService.queryDetailed(input);
      const hits = search.hits;

      return {
        citations: hits
          .map((hit) => ({
            locator: typeof hit.entry.metadata.citation === "string" ? hit.entry.metadata.citation : undefined,
            title:
              typeof hit.entry.summary === "string"
                ? hit.entry.summary
                : typeof hit.entry.metadata.filePath === "string"
                  ? hit.entry.metadata.filePath
                  : hit.entry.id,
            uri: hit.entry.provenance.uri
          }))
          .slice(0, 8),
        result: {
          disabled: false,
          fallbackUsed: search.retrieval.fallbackUsed,
          hits: hits.map((hit) => ({
            citation: hit.entry.metadata.citation ?? null,
            explanation: hit.explanation,
            endLine: hit.entry.metadata.endLine ?? null,
            path: hit.entry.metadata.filePath ?? null,
            providerId: search.retrieval.providerId,
            score: hit.score,
            snippet: hit.entry.content,
            startLine: hit.entry.metadata.startLine ?? null,
            summary: hit.entry.summary ?? null
          })),
          mode: search.retrieval.activeMode,
          modelId: search.retrieval.modelId,
          providerId: search.retrieval.providerId,
          semanticAvailable: search.retrieval.semanticAvailable,
          semanticStatus: search.retrieval.semanticStatus,
          warning: search.retrieval.warning
        }
      };
    }
  };
}

export const memorySearchToolDefinition: ToolDefinition = {
  aliases: [],
  annotations: {
    idempotentHint: true,
    meta: {
      family: "memory"
    },
    openWorldHint: false,
    readOnlyHint: true,
    title: "Memory Search"
  },
  approvalMode: "never",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only searches the local memory corpus.",
    examples: [
      "Search memory for a prior decision or repo convention.",
      "Before answering a question about past work, recall relevant notes from durable memory."
    ],
    purpose:
      "Mandatory recall step for durable context: search the indexed memory corpus with hybrid retrieval when embeddings are healthy and lexical fallback otherwise.",
    sideEffectSummary: "Reads the local memory index and transparently falls back to lexical retrieval if semantic retrieval is degraded.",
    whenNotToUse: ["Do not use when you already know the exact memory file and line range you need; use memory_get instead."],
    whenToUse: [
      "Use when you need to recall prior work, decisions, preferences, dates, or TODO context from durable memory.",
      "Use before answering questions that depend on MEMORY.md, memory/, user-memory/, or chat-session-memory/."
    ]
  },
  description:
    "Mandatory recall step: semantically search local durable memory and return concise relevant snippets with file and line locators.",
  displayName: "Memory Search",
  execution: {
    inputMode: "json",
    resumable: false,
    taskSupport: "optional"
  },
  idempotent: true,
  inputSchema: {
    additionalProperties: false,
    properties: {
      includeKinds: {
        items: {
          enum: ["artifact", "decision", "fact", "instruction", "preference", "status", "summary"],
          type: "string"
        },
        type: "array"
      },
      limit: {
        type: "integer"
      },
      minConfidence: {
        type: "number"
      },
      scopes: {
        items: {
          enum: ["session", "user_global", "working", "workspace"],
          type: "string"
        },
        type: "array"
      },
      text: {
        type: "string"
      }
    },
    required: ["text"],
    type: "object"
  },
  invocationName: "memory_search",
  kind: "memory",
  metadata: {},
  name: "memory_search",
  outputKind: "json",
  outputSchema: {
    type: "object"
  },
  retryable: true,
  searchTags: ["memory", "rag", "recall", "search", "semantic"],
  sideEffects: ["none"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.memory.search",
  usageGuidance:
    "Use before answering questions about prior work, decisions, preferences, or dates. If semantic retrieval is degraded, surface that briefly and continue with lexical results.",
  version: "1.0.0"
};
