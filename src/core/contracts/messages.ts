import { z } from "zod";

import {
  artifactReferenceSchema,
  entityIdSchema,
  isoTimestampSchema,
  jsonValueSchema,
  metadataSchema,
  uriSchema
} from "@/core/contracts/common";

export const messageIdSchema = entityIdSchema;
/**
 * Marks the assistant message carrying an accepted `attempt_complete` summary —
 * the run's final answer.
 *
 * `attempt_complete` is a runtime completion gate rather than an executed tool,
 * so its `summary` argument produces no tool result and never streams. The loop
 * persists it as an ordinary assistant message instead, and surfaces use this
 * tag to render it distinctly from streamed narration on the same turn. Lives
 * in contracts so the agent loop, the memory service, and the CLI can all
 * reference one spelling without importing each other.
 */
export const COMPLETION_SUMMARY_MESSAGE_TAG = "completion-summary";

export const messageRoleSchema = z.enum(["approval", "assistant", "status", "system", "tool", "user"]);
export const messageVisibilitySchema = z.enum(["compact", "default", "hidden"]);
export const messageSourceSchema = z.enum([
  "approval_runtime",
  "assistant",
  "channel",
  "external_agent",
  "memory",
  "operator",
  "system",
  "tool_runtime",
  "user"
]);

export const textPartSchema = z
  .object({
    kind: z.literal("text"),
    text: z.string().min(1)
  })
  .strict();

export const markdownPartSchema = z
  .object({
    kind: z.literal("markdown"),
    markdown: z.string().min(1)
  })
  .strict();

export const jsonPartSchema = z
  .object({
    kind: z.literal("json"),
    value: jsonValueSchema
  })
  .strict();

export const audioPartSchema = z
  .object({
    artifact: artifactReferenceSchema.optional(),
    durationMs: z.number().int().positive().optional(),
    kind: z.literal("audio"),
    title: z.string().min(1).max(256).optional(),
    transcript: z.string().min(1).optional(),
    uri: uriSchema,
    voice: z.string().min(1).max(128).optional(),
    waveform: z.array(z.number().min(0).max(1)).max(512).optional()
  })
  .strict();

export const filePartSchema = z
  .object({
    artifact: artifactReferenceSchema.optional(),
    kind: z.literal("file"),
    title: z.string().min(1).max(256).optional(),
    uri: uriSchema
  })
  .strict();

export const imagePartSchema = z
  .object({
    alt: z.string().max(512).optional(),
    artifact: artifactReferenceSchema.optional(),
    kind: z.literal("image"),
    uri: uriSchema
  })
  .strict();

export const citationPartSchema = z
  .object({
    kind: z.literal("citation"),
    locator: z.string().min(1).max(512).optional(),
    title: z.string().min(1).max(512),
    uri: uriSchema.optional()
  })
  .strict();

export const statusPartSchema = z
  .object({
    kind: z.literal("status"),
    state: z.string().min(1).max(128),
    summary: z.string().min(1)
  })
  .strict();

/**
 * Model "thinking" kept out of the answer.
 *
 * Reasoning is useful to a human reading the transcript and to the model within
 * the turn that produced it, but replaying older turns' indecision back into the
 * context both wastes the window and reinforces loops. Keeping it in its own
 * part (rather than inline in a text part) is what lets the serializer drop it
 * by age without touching the answer.
 */
export const reasoningPartSchema = z
  .object({
    kind: z.literal("reasoning"),
    text: z.string().min(1)
  })
  .strict();

export const toolCallPartSchema = z
  .object({
    arguments: z.record(z.string(), jsonValueSchema).default({}),
    callId: entityIdSchema,
    inputText: z.string().min(1).optional(),
    kind: z.literal("tool_call"),
    toolName: z.string().min(1).max(128)
  })
  .strict();

export const messagePartSchema = z.discriminatedUnion("kind", [
  audioPartSchema,
  citationPartSchema,
  filePartSchema,
  imagePartSchema,
  jsonPartSchema,
  markdownPartSchema,
  reasoningPartSchema,
  statusPartSchema,
  textPartSchema,
  toolCallPartSchema
]);

export const messageSchema = z
  .object({
    createdAt: isoTimestampSchema,
    id: messageIdSchema,
    metadata: metadataSchema.default({}),
    parts: z.array(messagePartSchema).min(1),
    role: messageRoleSchema,
    sessionId: entityIdSchema,
    source: messageSourceSchema,
    tags: z.array(z.string().min(1).max(128)).max(64).default([]),
    turnId: entityIdSchema.optional(),
    visibility: messageVisibilitySchema.default("default")
  })
  .strict();

export type Message = z.infer<typeof messageSchema>;
export type MessageId = z.infer<typeof messageIdSchema>;
export type MessagePart = z.infer<typeof messagePartSchema>;
export type MessageRole = z.infer<typeof messageRoleSchema>;
export type MessageSource = z.infer<typeof messageSourceSchema>;
