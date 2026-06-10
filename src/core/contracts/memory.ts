import { z } from "zod";

import {
  artifactReferenceSchema,
  entityIdSchema,
  isoTimestampSchema,
  metadataSchema,
  structuredErrorSchema,
  tagsSchema
} from "@/core/contracts/common";

export const memoryEntryIdSchema = entityIdSchema;
export const memoryScopeSchema = z.enum(["session", "user_global", "working", "workspace"]);
export const memoryKindSchema = z.enum([
  "artifact",
  "decision",
  "fact",
  "instruction",
  "preference",
  "status",
  "summary"
]);

export const memoryProvenanceSchema = z
  .object({
    artifact: artifactReferenceSchema.optional(),
    messageIds: z.array(entityIdSchema).default([]),
    sourceLabel: z.string().min(1).max(256),
    toolCallIds: z.array(entityIdSchema).default([]),
    uri: z.string().min(1).optional()
  })
  .strict();

export const memoryEntrySchema = z
  .object({
    confidence: z.number().min(0).max(1),
    content: z.string().min(1),
    createdAt: isoTimestampSchema,
    id: memoryEntryIdSchema,
    kind: memoryKindSchema,
    lastAccessedAt: isoTimestampSchema.optional(),
    metadata: metadataSchema.default({}),
    provenance: memoryProvenanceSchema,
    recencyScore: z.number().min(0).max(1).default(0),
    scope: memoryScopeSchema,
    sessionId: entityIdSchema.optional(),
    staleAt: isoTimestampSchema.optional(),
    summary: z.string().min(1).optional(),
    tags: tagsSchema.default([]),
    updatedAt: isoTimestampSchema
  })
  .strict();

export const memoryQuerySchema = z
  .object({
    includeKinds: z.array(memoryKindSchema).default([]),
    limit: z.number().int().positive().max(100).default(10),
    minConfidence: z.number().min(0).max(1).default(0),
    scopes: z.array(memoryScopeSchema).min(1).default(["workspace", "session", "user_global"]),
    sessionId: entityIdSchema.optional(),
    text: z.string().min(1)
  })
  .strict();

export const memoryHitSchema = z
  .object({
    entry: memoryEntrySchema,
    explanation: z.string().min(1),
    score: z.number().min(0)
  })
  .strict();

export interface MemoryStore {
  query(query: MemoryQuery): Promise<MemoryHit[]>;
  remove(entryId: string): Promise<void>;
  upsert(entry: MemoryEntry): Promise<void>;
}

export interface RetrievalHealthReport {
  checkHealth(): Promise<{ errors: z.infer<typeof structuredErrorSchema>[]; ok: boolean }>;
}

export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export type MemoryHit = z.infer<typeof memoryHitSchema>;
export type MemoryKind = z.infer<typeof memoryKindSchema>;
export type MemoryQuery = z.infer<typeof memoryQuerySchema>;
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
