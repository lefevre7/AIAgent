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

export const messagePartSchema = z.discriminatedUnion("kind", [
  audioPartSchema,
  citationPartSchema,
  filePartSchema,
  imagePartSchema,
  jsonPartSchema,
  markdownPartSchema,
  statusPartSchema,
  textPartSchema
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
