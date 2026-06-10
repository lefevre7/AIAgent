import { z } from "zod";

import {
  artifactReferenceSchema,
  entityIdSchema,
  isoTimestampSchema,
  jsonSchemaDocumentSchema,
  jsonValueSchema,
  metadataSchema,
  structuredErrorSchema,
  tagsSchema,
  uriSchema
} from "@/core/contracts/common";

export const toolKindSchema = z.enum([
  "browser",
  "built_in",
  "channel",
  "external_agent",
  "image",
  "mcp",
  "memory",
  "skill",
  "voice"
]);

export const toolSideEffectSchema = z.enum([
  "channel_io",
  "local_process",
  "network_read",
  "network_write",
  "none",
  "remote_mutation",
  "workspace_read",
  "workspace_write"
]);

export const toolApprovalModeSchema = z.enum(["always", "ask", "never"]);
export const toolStreamingModeSchema = z.enum(["chunked", "none", "progress"]);
export const toolOutputKindSchema = z.enum(["artifact", "json", "markdown", "mixed", "text"]);
export const toolInputModeSchema = z.enum(["either", "json", "text"]);
export const toolTaskSupportSchema = z.enum(["forbidden", "optional", "required"]);
export const toolSourceKindSchema = z.enum(["built_in", "config", "external", "mcp", "skill"]);
export const toolInvocationNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/u);
export const toolCallStatusSchema = z.enum([
  "awaiting_approval",
  "cancelled",
  "failed",
  "pending",
  "running",
  "succeeded"
]);

export const toolDescriptorSchema = z
  .object({
    approvalNotes: z.string().min(1).max(2000).optional(),
    examples: z.array(z.string().min(1).max(500)).max(8).default([]),
    purpose: z.string().min(1).max(2000),
    sideEffectSummary: z.string().min(1).max(2000).optional(),
    whenNotToUse: z.array(z.string().min(1).max(500)).max(12).default([]),
    whenToUse: z.array(z.string().min(1).max(500)).min(1).max(12)
  })
  .strict();

export const toolAnnotationsSchema = z
  .object({
    destructiveHint: z.boolean().optional(),
    idempotentHint: z.boolean().optional(),
    meta: metadataSchema.default({}),
    openWorldHint: z.boolean().optional(),
    readOnlyHint: z.boolean().optional(),
    title: z.string().min(1).max(256).optional()
  })
  .strict();

export const toolExecutionSchema = z
  .object({
    inputMode: toolInputModeSchema.default("json"),
    resumable: z.boolean().default(false),
    taskSupport: toolTaskSupportSchema.default("forbidden"),
    timeoutMs: z.number().int().positive().optional()
  })
  .strict();

export const toolSourceSchema = z
  .object({
    adapterId: z.string().min(1).max(128).optional(),
    displayName: z.string().min(1).max(128).optional(),
    kind: toolSourceKindSchema,
    serverName: z.string().min(1).max(128).optional(),
    uri: uriSchema.optional()
  })
  .strict();

export const toolDefinitionSchema = z
  .object({
    aliases: z.array(z.string().min(1).max(128)).max(32).default([]),
    annotations: toolAnnotationsSchema.default({ meta: {} }),
    approvalMode: toolApprovalModeSchema,
    deprecationMessage: z.string().min(1).max(1000).optional(),
    descriptor: toolDescriptorSchema,
    description: z.string().min(1),
    displayName: z.string().min(1).max(128),
    execution: toolExecutionSchema.default({
      inputMode: "json",
      resumable: false,
      taskSupport: "forbidden"
    }),
    idempotent: z.boolean(),
    inputSchema: jsonSchemaDocumentSchema,
    invocationName: toolInvocationNameSchema,
    kind: toolKindSchema,
    metadata: metadataSchema.default({}),
    name: z.string().min(1).max(128),
    outputKind: toolOutputKindSchema,
    outputSchema: jsonSchemaDocumentSchema.optional(),
    retryable: z.boolean(),
    searchTags: tagsSchema.default([]),
    sideEffects: z.array(toolSideEffectSchema).min(1),
    source: toolSourceSchema,
    streamingMode: toolStreamingModeSchema,
    toolId: entityIdSchema,
    usageGuidance: z.string().min(1),
    version: z.string().min(1).max(64)
  })
  .strict();

export const toolSearchQuerySchema = z
  .object({
    approvalModes: z.array(toolApprovalModeSchema).max(8).optional(),
    kinds: z.array(toolKindSchema).max(16).optional(),
    limit: z.number().int().positive().max(100).default(10),
    query: z.string().min(1).max(500).optional(),
    sideEffects: z.array(toolSideEffectSchema).max(16).optional()
  })
  .strict();

export const toolSearchMatchSchema = z
  .object({
    definition: toolDefinitionSchema,
    matchedOn: z.array(z.string().min(1).max(128)).max(16).default([]),
    score: z.number().nonnegative()
  })
  .strict();

export const toolCallRecordSchema = z
  .object({
    approvalRequestId: entityIdSchema.optional(),
    arguments: z.record(z.string(), jsonValueSchema),
    completedAt: isoTimestampSchema.optional(),
    error: structuredErrorSchema.optional(),
    id: entityIdSchema,
    inputText: z.string().min(1).optional(),
    metadata: metadataSchema.default({}),
    result: jsonValueSchema.optional(),
    sessionId: entityIdSchema,
    startedAt: isoTimestampSchema,
    status: toolCallStatusSchema,
    toolId: entityIdSchema.optional(),
    toolName: toolInvocationNameSchema,
    turnId: entityIdSchema
  })
  .strict();

export const toolCitationSchema = z
  .object({
    locator: z.string().min(1).max(512).optional(),
    title: z.string().min(1).max(512),
    uri: uriSchema.optional()
  })
  .strict();

export const toolProgressUpdateSchema = z
  .object({
    state: z.string().min(1).max(128),
    summary: z.string().min(1).max(2000)
  })
  .strict();

export const toolResultEnvelopeSchema = z
  .object({
    artifacts: z.array(artifactReferenceSchema).max(32).default([]),
    citations: z.array(toolCitationSchema).max(32).default([]),
    display: z
      .array(
        z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("json"), value: jsonValueSchema }).strict(),
          z.object({ kind: z.literal("markdown"), markdown: z.string().min(1) }).strict(),
          z.object({ kind: z.literal("status"), state: z.string().min(1).max(128), summary: z.string().min(1) }).strict(),
          z.object({ kind: z.literal("text"), text: z.string().min(1) }).strict()
        ])
      )
      .max(64)
      .default([]),
    metadata: metadataSchema.default({}),
    progress: z.array(toolProgressUpdateSchema).max(32).default([]),
    result: jsonValueSchema.optional()
  })
  .strict();

export interface ToolRegistry {
  getDefinition(toolName: string): ToolDefinition | null;
  listDefinitions(): ToolDefinition[];
  searchDefinitions(query: ToolSearchQuery): ToolSearchMatch[];
}

export interface ToolHandler {
  readonly definition: ToolDefinition;

  execute(call: ToolCallRecord): Promise<ToolCallRecord>;
}

export type ToolApprovalMode = z.infer<typeof toolApprovalModeSchema>;
export type ToolAnnotations = z.infer<typeof toolAnnotationsSchema>;
export type ToolCallRecord = z.infer<typeof toolCallRecordSchema>;
export type ToolCallStatus = z.infer<typeof toolCallStatusSchema>;
export type ToolCitation = z.infer<typeof toolCitationSchema>;
export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>;
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;
export type ToolExecution = z.infer<typeof toolExecutionSchema>;
export type ToolInputMode = z.infer<typeof toolInputModeSchema>;
export type ToolKind = z.infer<typeof toolKindSchema>;
export type ToolOutputKind = z.infer<typeof toolOutputKindSchema>;
export type ToolProgressUpdate = z.infer<typeof toolProgressUpdateSchema>;
export type ToolResultEnvelope = z.infer<typeof toolResultEnvelopeSchema>;
export type ToolSearchMatch = z.infer<typeof toolSearchMatchSchema>;
export type ToolSearchQuery = z.infer<typeof toolSearchQuerySchema>;
export type ToolSideEffect = z.infer<typeof toolSideEffectSchema>;
export type ToolSource = z.infer<typeof toolSourceSchema>;
export type ToolSourceKind = z.infer<typeof toolSourceKindSchema>;
export type ToolStreamingMode = z.infer<typeof toolStreamingModeSchema>;
export type ToolTaskSupport = z.infer<typeof toolTaskSupportSchema>;
