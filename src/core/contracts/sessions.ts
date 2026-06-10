import { z } from "zod";

import { approvalRequestSchema, approvalResolutionSchema, steeringInjectionSchema } from "@/core/contracts/approvals";
import { entityIdSchema, isoTimestampSchema, metadataSchema, structuredErrorSchema, tagsSchema } from "@/core/contracts/common";
import { messageSchema } from "@/core/contracts/messages";
import { toolCallRecordSchema } from "@/core/contracts/tools";
import { voiceCaptureRecordSchema, voicePlaybackRecordSchema, voiceTranscriptionRecordSchema } from "@/core/contracts/voice";

export const sessionIdSchema = entityIdSchema;
export const turnIdSchema = entityIdSchema;

export const sessionStatusSchema = z.enum([
  "applying_memory_compaction",
  "attempting_completion",
  "awaiting_approval",
  "awaiting_tool_execution",
  "awaiting_user",
  "cancelled",
  "completed",
  "completion_blocked",
  "failed",
  "idle",
  "running_model",
  "validating_completion"
]);

export const turnTriggerSchema = z.enum([
  "approval_resolution",
  "compaction",
  "gateway_request",
  "recovery",
  "resume",
  "steering",
  "system_nudge",
  "tool_result",
  "user"
]);

export const turnStatusSchema = z.enum([
  "awaiting_model_output",
  "cancelled",
  "completed",
  "failed",
  "pending",
  "running",
  "waiting_for_approval",
  "waiting_for_tool"
]);

export const sessionRecordSchema = z
  .object({
    activePlanId: entityIdSchema.optional(),
    activeTurnId: turnIdSchema.optional(),
    channelThreadId: z.string().min(1).max(256).optional(),
    createdAt: isoTimestampSchema,
    cwd: z.string().min(1),
    goal: z.string().min(1),
    id: sessionIdSchema,
    lastActiveAt: isoTimestampSchema,
    lastError: structuredErrorSchema.optional(),
    metadata: metadataSchema.default({}),
    status: sessionStatusSchema,
    tags: tagsSchema.default([]),
    title: z.string().min(1).max(256),
    updatedAt: isoTimestampSchema,
    userId: z.string().min(1).max(256).optional()
  })
  .strict();

export const turnRecordSchema = z
  .object({
    approvalRequestIds: z.array(entityIdSchema).default([]),
    completedAt: isoTimestampSchema.optional(),
    executedToolCallIds: z.array(entityIdSchema).default([]),
    id: turnIdSchema,
    inputMessageIds: z.array(entityIdSchema).default([]),
    metadata: metadataSchema.default({}),
    outputMessageIds: z.array(entityIdSchema).default([]),
    requestedToolCallIds: z.array(entityIdSchema).default([]),
    sequence: z.number().int().nonnegative(),
    sessionId: sessionIdSchema,
    startedAt: isoTimestampSchema,
    status: turnStatusSchema,
    summary: z.string().min(1).optional(),
    trigger: turnTriggerSchema
  })
  .strict();

export const sessionResumeMetadataSchema = z
  .object({
    activeTurnId: entityIdSchema.optional(),
    lastMessageId: entityIdSchema.optional(),
    pendingApprovalIds: z.array(entityIdSchema).default([]),
    pendingToolCallIds: z.array(entityIdSchema).default([]),
    statusSummary: z.string().min(1).optional(),
    surface: z.enum(["channel", "cli", "gateway", "sdk", "web"]),
    updatedAt: isoTimestampSchema
  })
  .strict();

export const sessionSnapshotSchema = z
  .object({
    approvalRequests: z.array(approvalRequestSchema),
    approvalResolutions: z.array(approvalResolutionSchema),
    messages: z.array(messageSchema),
    resumeMetadata: sessionResumeMetadataSchema.nullable(),
    session: sessionRecordSchema,
    steeringInjections: z.array(steeringInjectionSchema),
    toolCalls: z.array(toolCallRecordSchema),
    turns: z.array(turnRecordSchema),
    voiceCaptures: z.array(voiceCaptureRecordSchema),
    voicePlaybacks: z.array(voicePlaybackRecordSchema),
    voiceTranscriptions: z.array(voiceTranscriptionRecordSchema)
  })
  .strict();

export interface SessionRepository {
  appendTurn(turn: TurnRecord): Promise<void>;
  getSession(sessionId: SessionId): Promise<SessionRecord | null>;
  listSessions(): Promise<SessionRecord[]>;
  saveSession(session: SessionRecord): Promise<void>;
}

export type SessionId = z.infer<typeof sessionIdSchema>;
export type SessionRecord = z.infer<typeof sessionRecordSchema>;
export type SessionResumeMetadata = z.infer<typeof sessionResumeMetadataSchema>;
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type TurnId = z.infer<typeof turnIdSchema>;
export type TurnRecord = z.infer<typeof turnRecordSchema>;
export type TurnStatus = z.infer<typeof turnStatusSchema>;
export type TurnTrigger = z.infer<typeof turnTriggerSchema>;
