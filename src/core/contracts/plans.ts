import { z } from "zod";

import { entityIdSchema, isoTimestampSchema, metadataSchema, tagsSchema } from "@/core/contracts/common";

export const planIdSchema = entityIdSchema;
export const planItemStatusSchema = z.enum(["blocked", "cancelled", "completed", "in_progress", "pending"]);
export const workingMemoryNoteKindSchema = z.enum(["blocker", "fact", "next_step", "recent_attempt", "status"]);

export const planItemSchema = z
  .object({
    blockedReason: z.string().min(1).max(1000).optional(),
    id: entityIdSchema,
    metadata: metadataSchema.default({}),
    notes: z.string().min(1).max(4000).optional(),
    order: z.number().int().nonnegative(),
    status: planItemStatusSchema,
    title: z.string().min(1).max(500)
  })
  .strict();

export const planRecordSchema = z
  .object({
    createdAt: isoTimestampSchema,
    id: planIdSchema,
    items: z.array(planItemSchema).default([]),
    metadata: metadataSchema.default({}),
    sessionId: entityIdSchema,
    summary: z.string().min(1).max(4000).optional(),
    tags: tagsSchema.default([]),
    title: z.string().min(1).max(256),
    updatedAt: isoTimestampSchema
  })
  .strict();

export const workingMemoryNoteSchema = z
  .object({
    createdAt: isoTimestampSchema,
    id: entityIdSchema,
    kind: workingMemoryNoteKindSchema,
    metadata: metadataSchema.default({}),
    priority: z.enum(["high", "low", "medium"]),
    sessionId: entityIdSchema,
    text: z.string().min(1),
    turnId: entityIdSchema.optional()
  })
  .strict();

export const taskProgressSchema = z
  .object({
    blocked: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    completed: z.number().int().nonnegative(),
    inProgress: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    total: z.number().int().nonnegative()
  })
  .strict();

export const taskStateSnapshotSchema = z
  .object({
    activePlanId: entityIdSchema.optional(),
    blockers: z.array(workingMemoryNoteSchema).default([]),
    nextStep: workingMemoryNoteSchema.optional(),
    plan: planRecordSchema.nullable(),
    progress: taskProgressSchema,
    recentAttempts: z.array(workingMemoryNoteSchema).default([]),
    sessionId: entityIdSchema,
    summary: z.string().min(1).max(4000).optional(),
    updatedAt: isoTimestampSchema,
    workingMemory: z.array(workingMemoryNoteSchema).default([])
  })
  .strict();

export type PlanId = z.infer<typeof planIdSchema>;
export type PlanItem = z.infer<typeof planItemSchema>;
export type PlanItemStatus = z.infer<typeof planItemStatusSchema>;
export type PlanRecord = z.infer<typeof planRecordSchema>;
export type TaskProgress = z.infer<typeof taskProgressSchema>;
export type TaskStateSnapshot = z.infer<typeof taskStateSnapshotSchema>;
export type WorkingMemoryNote = z.infer<typeof workingMemoryNoteSchema>;
export type WorkingMemoryNoteKind = z.infer<typeof workingMemoryNoteKindSchema>;
