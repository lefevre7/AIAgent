import { z } from "zod";

import {
  entityIdSchema,
  isoTimestampSchema,
  jsonSchemaDocumentSchema,
  jsonValueSchema,
  metadataSchema,
  structuredErrorSchema
} from "@/core/contracts/common";
import { messageSchema } from "@/core/contracts/messages";
import {
  toolDefinitionSchema,
  toolInvocationNameSchema
} from "@/core/contracts/tools";

export const providerKindSchema = z.enum([
  "embedding",
  "image",
  "language_model",
  "voice"
]);
export const providerIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9_-]{0,127}$/);
export const languageModelProviderSchema = providerIdSchema;
export const providerHealthStatusSchema = z.enum([
  "degraded",
  "healthy",
  "unavailable"
]);
export const languageModelQueueJobStatusSchema = z.enum([
  "cancelled",
  "completed",
  "failed",
  "queued",
  "running"
]);
export const languageModelStopReasonSchema = z.enum([
  "cancelled",
  "content_filter",
  "end_turn",
  "error",
  "length",
  "tool_calls"
]);

export const providerHealthSchema = z
  .object({
    checkedAt: isoTimestampSchema,
    details: metadataSchema.default({}),
    providerId: z.string().min(1).max(128),
    status: providerHealthStatusSchema
  })
  .strict();

export const languageModelDescriptorSchema = z
  .object({
    contextWindow: z.number().int().positive().optional(),
    displayName: z.string().min(1).max(256),
    modelId: z.string().min(1).max(256),
    provider: languageModelProviderSchema,
    toolCalling: z.boolean()
  })
  .strict();

export const languageModelSettingsSchema = z
  .object({
    frequencyPenalty: z.number().min(-2).max(2).optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    minP: z.number().min(0).max(1).optional(),
    presencePenalty: z.number().min(-2).max(2).optional(),
    repetitionPenalty: z.number().min(0).max(2).optional(),
    stopSequences: z.array(z.string().min(1)).default([]),
    temperature: z.number().min(0).max(2).optional(),
    toolChoice: z.enum(["auto", "none", "required"]).default("auto"),
    topK: z.number().int().min(0).max(1000).optional(),
    topP: z.number().min(0).max(1).optional()
  })
  .strict();

export const languageModelResponseFormatSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text")
    })
    .strict(),
  z
    .object({
      kind: z.literal("json_object")
    })
    .strict(),
  z
    .object({
      kind: z.literal("json_schema"),
      name: z.string().min(1).max(128),
      schema: jsonSchemaDocumentSchema
    })
    .strict()
]);

export const modelToolCallProposalSchema = z
  .object({
    arguments: z.record(z.string(), jsonValueSchema).default({}),
    callId: entityIdSchema,
    inputText: z.string().min(1).optional(),
    toolId: entityIdSchema.optional(),
    toolName: toolInvocationNameSchema
  })
  .strict();

export const languageModelRequestSchema = z
  .object({
    availableTools: z.array(toolDefinitionSchema).default([]),
    id: entityIdSchema,
    instructions: z.string().min(1),
    messages: z.array(messageSchema).default([]),
    metadata: metadataSchema.default({}),
    modelId: z.string().min(1).max(256),
    provider: languageModelProviderSchema,
    responseFormat: languageModelResponseFormatSchema.default({ kind: "text" }),
    sessionId: entityIdSchema.optional(),
    settings: languageModelSettingsSchema,
    turnId: entityIdSchema.optional()
  })
  .strict();

export const languageModelUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().default(0),
    outputTokens: z.number().int().nonnegative().default(0),
    totalTokens: z.number().int().nonnegative().default(0)
  })
  .strict();

export const languageModelResponseSchema = z
  .object({
    error: structuredErrorSchema.optional(),
    id: entityIdSchema,
    message: messageSchema.optional(),
    metadata: metadataSchema.default({}),
    modelId: z.string().min(1).max(256),
    provider: languageModelProviderSchema,
    stopReason: languageModelStopReasonSchema,
    toolCalls: z.array(modelToolCallProposalSchema).default([]),
    usage: languageModelUsageSchema
  })
  .strict();

export const languageModelQueueJobSchema = z
  .object({
    attempts: z.number().int().nonnegative().default(0),
    completedAt: isoTimestampSchema.optional(),
    createdAt: isoTimestampSchema,
    error: structuredErrorSchema.optional(),
    id: entityIdSchema,
    logPaths: z
      .object({
        error: z.string().min(1).optional(),
        request: z.string().min(1).optional(),
        response: z.string().min(1).optional()
      })
      .strict()
      .default({}),
    metadata: metadataSchema.default({}),
    providerId: z.string().min(1).max(128),
    queueKey: z.string().min(1).max(128).default("default"),
    request: languageModelRequestSchema,
    response: languageModelResponseSchema.optional(),
    startedAt: isoTimestampSchema.optional(),
    status: languageModelQueueJobStatusSchema,
    updatedAt: isoTimestampSchema
  })
  .strict();

export const languageModelStreamEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("response.completed"),
      response: languageModelResponseSchema
    })
    .strict(),
  z
    .object({
      delta: z.string(),
      kind: z.literal("response.delta")
    })
    .strict(),
  z
    .object({
      delta: z.string(),
      kind: z.literal("response.reasoning")
    })
    .strict(),
  z
    .object({
      kind: z.literal("response.error"),
      error: structuredErrorSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal("response.tool_call"),
      toolCall: modelToolCallProposalSchema
    })
    .strict()
]);

export const embeddingRequestSchema = z
  .object({
    id: entityIdSchema,
    inputs: z.array(z.string().min(1)).min(1),
    metadata: metadataSchema.default({}),
    modelId: z.string().min(1).max(256),
    providerId: z.string().min(1).max(128)
  })
  .strict();

export const embeddingResponseSchema = z
  .object({
    dimensions: z.number().int().positive(),
    id: entityIdSchema,
    metadata: metadataSchema.default({}),
    providerId: z.string().min(1).max(128),
    vectors: z.array(z.array(z.number())).min(1)
  })
  .strict();

export const embeddingModelDescriptorSchema = z
  .object({
    displayName: z.string().min(1).max(256),
    modelId: z.string().min(1).max(256),
    providerId: z.string().min(1).max(128)
  })
  .strict();

export interface EmbeddingAdapter {
  readonly providerId: string;

  createEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse>;
  health(): Promise<ProviderHealth>;
  listModels?(): Promise<EmbeddingModelDescriptor[]>;
}

export interface LanguageModelAdapter {
  readonly provider: LanguageModelProvider;
  readonly providerId: string;

  generate(request: LanguageModelRequest): Promise<LanguageModelResponse>;
  getModelContextWindow?(modelId: string): Promise<number | undefined>;
  health(): Promise<ProviderHealth>;
  listModels(): Promise<LanguageModelDescriptor[]>;
  stream?(
    request: LanguageModelRequest
  ): AsyncIterable<LanguageModelStreamEvent>;
}

export type EmbeddingRequest = z.infer<typeof embeddingRequestSchema>;
export type EmbeddingResponse = z.infer<typeof embeddingResponseSchema>;
export type EmbeddingModelDescriptor = z.infer<
  typeof embeddingModelDescriptorSchema
>;
export type LanguageModelDescriptor = z.infer<
  typeof languageModelDescriptorSchema
>;
export type LanguageModelProvider = z.infer<typeof languageModelProviderSchema>;
export type LanguageModelQueueJob = z.infer<typeof languageModelQueueJobSchema>;
export type LanguageModelQueueJobStatus = z.infer<
  typeof languageModelQueueJobStatusSchema
>;
export type LanguageModelRequest = z.infer<typeof languageModelRequestSchema>;
export type LanguageModelResponse = z.infer<typeof languageModelResponseSchema>;
export type LanguageModelResponseFormat = z.infer<
  typeof languageModelResponseFormatSchema
>;
export type LanguageModelSettings = z.infer<typeof languageModelSettingsSchema>;
export type LanguageModelStopReason = z.infer<
  typeof languageModelStopReasonSchema
>;
export type LanguageModelStreamEvent = z.infer<
  typeof languageModelStreamEventSchema
>;
export type ModelToolCallProposal = z.infer<typeof modelToolCallProposalSchema>;
export type ProviderHealth = z.infer<typeof providerHealthSchema>;
export type ProviderHealthStatus = z.infer<typeof providerHealthStatusSchema>;
