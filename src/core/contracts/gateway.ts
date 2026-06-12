import { z } from "zod";

import {
  approvalActorSchema,
  approvalDecisionSchema,
  approvalRequestSchema,
  approvalResolutionSchema,
  steeringInjectionSchema
} from "@/core/contracts/approvals";
import {
  channelKindSchema,
  channelMessageSchema,
  channelRuntimeStatusSchema,
  channelSendRequestSchema
} from "@/core/contracts/channels";
import {
  entityIdSchema,
  isoTimestampSchema,
  jsonValueSchema,
  metadataSchema,
  structuredErrorSchema
} from "@/core/contracts/common";
import {
  externalAgentDefinitionSchema,
  externalAgentJobCancelRequestSchema,
  externalAgentJobListQuerySchema,
  externalAgentJobRecordSchema,
  externalAgentJobRequestSchema,
  externalAgentJobResumeRequestSchema
} from "@/core/contracts/external-agents";
import { memoryHitSchema, memoryQuerySchema } from "@/core/contracts/memory";
import { messagePartSchema, messageSchema } from "@/core/contracts/messages";
import { taskStateSnapshotSchema } from "@/core/contracts/plans";
import {
  providerHealthSchema,
  providerIdSchema
} from "@/core/contracts/providers";
import {
  sessionRecordSchema,
  sessionSnapshotSchema,
  sessionStatusSchema,
  turnRecordSchema
} from "@/core/contracts/sessions";
import {
  toolCallRecordSchema,
  toolDefinitionSchema,
  toolInvocationNameSchema,
  toolSearchQuerySchema
} from "@/core/contracts/tools";

export const gatewayRunKindSchema = z.enum([
  "session_cancel",
  "session_create",
  "session_message",
  "session_resume",
  "tool_execute"
]);

export const gatewayRunStatusSchema = z.enum([
  "cancelled",
  "completed",
  "failed",
  "queued",
  "running"
]);

export const gatewayRunCompletionReasonSchema = z.enum([
  "session_awaiting_approval",
  "session_cancelled",
  "session_completed",
  "session_completion_blocked",
  "session_created",
  "session_failed",
  "tool_awaiting_approval",
  "tool_failed",
  "tool_succeeded"
]);

export const gatewayRunRecordSchema = z
  .object({
    approvalRequestIds: z.array(entityIdSchema).default([]),
    completedAt: isoTimestampSchema.optional(),
    completionReason: gatewayRunCompletionReasonSchema.optional(),
    createdAt: isoTimestampSchema,
    error: structuredErrorSchema.optional(),
    id: entityIdSchema,
    kind: gatewayRunKindSchema,
    messageIds: z.array(entityIdSchema).default([]),
    metadata: metadataSchema.default({}),
    requestId: entityIdSchema.optional(),
    sessionId: entityIdSchema,
    status: gatewayRunStatusSchema,
    toolCallIds: z.array(entityIdSchema).default([]),
    turnIds: z.array(entityIdSchema).default([]),
    updatedAt: isoTimestampSchema
  })
  .strict();

export const gatewayApprovalRecordSchema = z
  .object({
    request: approvalRequestSchema,
    resolution: approvalResolutionSchema.optional()
  })
  .strict();

export const gatewaySessionSnapshotSchema = z
  .object({
    snapshot: sessionSnapshotSchema,
    taskState: taskStateSnapshotSchema.nullable()
  })
  .strict();

const gatewayMessageInputBaseSchema = z
  .object({
    metadata: metadataSchema.default({}),
    parts: z.array(messagePartSchema).min(1).optional(),
    tags: z.array(z.string().min(1).max(128)).max(64).default([]),
    text: z.string().min(1).optional()
  })
  .strict();

export const gatewayMessageInputSchema =
  gatewayMessageInputBaseSchema.superRefine((value, context) => {
    if (value.text || value.parts?.length) {
      return;
    }

    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Expected either "text" or "parts" for the message input.'
    });
  });

export const gatewayEventTopicSchema = z.enum([
  "approval.requested",
  "approval.resolved",
  "channel.message",
  "external_agent.updated",
  "gateway.status",
  "log.emitted",
  "memory.updated",
  "message.created",
  "message.delta",
  "message.reasoning",
  "run.updated",
  "session.updated",
  "tool.updated",
  "turn.updated"
]);

export const gatewaySubscriptionSchema = z
  .object({
    cursor: z.string().min(1).optional(),
    sessionId: entityIdSchema.optional(),
    topics: z.array(gatewayEventTopicSchema).max(64).optional()
  })
  .strict();

export const gatewayEventReplayQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.number().int().positive().max(500).default(100),
    sessionId: entityIdSchema.optional(),
    topics: z.array(gatewayEventTopicSchema).max(64).optional()
  })
  .strict();

export const gatewayEventBaseSchema = z
  .object({
    createdAt: isoTimestampSchema,
    cursor: z.string().min(1).optional(),
    id: entityIdSchema,
    metadata: metadataSchema.default({})
  })
  .strict();

export const gatewayEventSchema = z.discriminatedUnion("topic", [
  gatewayEventBaseSchema
    .extend({
      payload: approvalRequestSchema,
      topic: z.literal("approval.requested")
    })
    .strict(),
  gatewayEventBaseSchema
    .extend({
      payload: approvalResolutionSchema,
      topic: z.literal("approval.resolved")
    })
    .strict(),
  gatewayEventBaseSchema
    .extend({
      payload: channelMessageSchema,
      topic: z.literal("channel.message")
    })
    .strict(),
  gatewayEventBaseSchema
    .extend({
      payload: externalAgentJobRecordSchema,
      topic: z.literal("external_agent.updated")
    })
    .strict(),
  gatewayEventBaseSchema
    .extend({
      payload: z
        .object({
          metrics: z
            .object({
              contextWindowPercentage: z.number().min(0).optional(),
              elapsedSeconds: z.number().min(0),
              tokensUsed: z.number().int().min(0).optional()
            })
            .strict()
            .optional(),
          ok: z.boolean(),
          status: z.string().min(1)
        })
        .strict(),
      topic: z.literal("gateway.status")
    })
    .strict(),
  gatewayEventBaseSchema
    .extend({
      payload: z
        .object({
          level: z.enum(["debug", "error", "info", "warn"]),
          message: z.string().min(1)
        })
        .strict(),
      topic: z.literal("log.emitted")
    })
    .strict(),
  gatewayEventBaseSchema
    .extend({
      payload: z
        .object({ entryId: entityIdSchema, scope: z.string().min(1) })
        .strict(),
      topic: z.literal("memory.updated")
    })
    .strict(),
  gatewayEventBaseSchema
    .extend({
      payload: toolCallRecordSchema.extend({
        resultMessageId: entityIdSchema.optional()
      }),
      topic: z.literal("tool.updated")
    })
    .strict(),
  gatewayEventBaseSchema
    .extend({
      payload: sessionRecordSchema,
      topic: z.literal("session.updated")
    })
    .strict(),
  gatewayEventBaseSchema
    .extend({
      payload: gatewayRunRecordSchema,
      topic: z.literal("run.updated")
    })
    .strict(),
  gatewayEventBaseSchema
    .extend({
      payload: messageSchema,
      topic: z.literal("message.created")
    })
    .strict(),
  gatewayEventBaseSchema
    .extend({
      payload: z
        .object({
          delta: z.string(),
          sessionId: entityIdSchema,
          turnId: entityIdSchema
        })
        .strict(),
      topic: z.literal("message.delta")
    })
    .strict(),
  gatewayEventBaseSchema
    .extend({
      payload: z
        .object({
          delta: z.string(),
          sessionId: entityIdSchema,
          turnId: entityIdSchema
        })
        .strict(),
      topic: z.literal("message.reasoning")
    })
    .strict(),
  gatewayEventBaseSchema
    .extend({
      payload: turnRecordSchema,
      topic: z.literal("turn.updated")
    })
    .strict()
]);

export const gatewayEventPageSchema = z
  .object({
    events: z.array(gatewayEventSchema),
    nextCursor: z.string().min(1).optional()
  })
  .strict();

export const gatewaySessionCreateRequestSchema = z
  .object({
    channelThreadId: z.string().min(1).max(256).optional(),
    cwd: z.string().min(1),
    goal: z.string().min(1),
    initialMessage: gatewayMessageInputSchema.optional(),
    metadata: metadataSchema.default({}),
    modelId: z.string().min(1).max(256).optional(),
    provider: providerIdSchema.optional(),
    tags: z.array(z.string().min(1).max(128)).max(64).default([]),
    title: z.string().min(1).max(256),
    userId: z.string().min(1).max(256).optional()
  })
  .strict();

export const gatewaySessionListQuerySchema = z
  .object({
    limit: z.number().int().positive().max(500).default(100),
    status: sessionStatusSchema.optional()
  })
  .strict();

export const gatewaySessionMessageRequestSchema = gatewayMessageInputBaseSchema
  .extend({
    sessionId: entityIdSchema
  })
  .strict();

export const gatewaySessionResumeRequestSchema = z
  .object({
    sessionId: entityIdSchema
  })
  .strict();

export const gatewaySessionSnapshotRequestSchema = z
  .object({
    sessionId: entityIdSchema
  })
  .strict();

export const gatewaySessionCancelRequestSchema = z
  .object({
    sessionId: entityIdSchema
  })
  .strict();

export const gatewayRunCancelRequestSchema = z
  .object({
    runId: entityIdSchema
  })
  .strict();

export const gatewayApprovalGetRequestSchema = z
  .object({
    requestId: entityIdSchema
  })
  .strict();

export const gatewayApprovalListQuerySchema = z
  .object({
    limit: z.number().int().positive().max(500).default(100),
    pendingOnly: z.boolean().default(false),
    sessionId: entityIdSchema.optional()
  })
  .strict();

export const gatewayApprovalResolveRequestSchema = z
  .object({
    actor: approvalActorSchema.optional(),
    comment: z.string().min(1).max(2000).optional(),
    decision: approvalDecisionSchema,
    requestId: entityIdSchema
  })
  .strict();

export const gatewayToolExecuteRequestSchema = z
  .object({
    arguments: z.record(z.string(), jsonValueSchema).default({}),
    inputText: z.string().min(1).optional(),
    metadata: metadataSchema.default({}),
    sessionId: entityIdSchema,
    toolName: toolInvocationNameSchema
  })
  .strict();

export const gatewayRequestTopicSchema = z.enum([
  "approval.get",
  "approval.list",
  "approval.resolve",
  "channel.health",
  "channel.list",
  "channel.send",
  "external_agent.cancel",
  "external_agent.get",
  "external_agent.list",
  "external_agent.resume",
  "external_agent.run",
  "gateway.health",
  "gateway.subscribe",
  "memory.query",
  "model.health",
  "run.cancel",
  "session.cancel",
  "session.create",
  "session.list",
  "session.message",
  "session.resume",
  "session.snapshot",
  "steering.inject",
  "tool.execute",
  "tool.search"
]);

export const gatewayRequestSchema = z
  .object({
    createdAt: isoTimestampSchema,
    id: entityIdSchema,
    metadata: metadataSchema.default({}),
    payload: z.unknown(),
    topic: gatewayRequestTopicSchema
  })
  .strict();

export const gatewayResponseSchema = z
  .object({
    createdAt: isoTimestampSchema,
    error: structuredErrorSchema.optional(),
    id: entityIdSchema,
    metadata: metadataSchema.default({}),
    ok: z.boolean(),
    payload: z.unknown().optional(),
    requestId: entityIdSchema,
    topic: gatewayRequestTopicSchema
  })
  .strict();

export const gatewayRequestPayloadSchemas = {
  "approval.get": gatewayApprovalGetRequestSchema,
  "approval.list": gatewayApprovalListQuerySchema,
  "approval.resolve": gatewayApprovalResolveRequestSchema,
  "channel.health": z
    .object({
      channel: channelKindSchema.optional()
    })
    .strict(),
  "channel.list": z.object({}).strict(),
  "channel.send": channelSendRequestSchema,
  "external_agent.cancel": externalAgentJobCancelRequestSchema,
  "external_agent.get": z.object({ jobId: entityIdSchema }).strict(),
  "external_agent.list": externalAgentJobListQuerySchema,
  "external_agent.resume": externalAgentJobResumeRequestSchema,
  "external_agent.run": externalAgentJobRequestSchema,
  "gateway.health": z.object({}).strict(),
  "gateway.subscribe": gatewaySubscriptionSchema,
  "memory.query": memoryQuerySchema,
  "model.health": z.object({ provider: providerIdSchema.optional() }).strict(),
  "run.cancel": gatewayRunCancelRequestSchema,
  "session.cancel": gatewaySessionCancelRequestSchema,
  "session.create": gatewaySessionCreateRequestSchema,
  "session.list": gatewaySessionListQuerySchema,
  "session.message": gatewaySessionMessageRequestSchema,
  "session.resume": gatewaySessionResumeRequestSchema,
  "session.snapshot": gatewaySessionSnapshotRequestSchema,
  "steering.inject": steeringInjectionSchema,
  "tool.execute": gatewayToolExecuteRequestSchema,
  "tool.search": toolSearchQuerySchema
} as const;

export const gatewayResponsePayloadSchemas = {
  "approval.get": gatewayApprovalRecordSchema,
  "approval.list": z
    .object({ approvals: z.array(gatewayApprovalRecordSchema) })
    .strict(),
  "approval.resolve": z
    .object({
      approval: gatewayApprovalRecordSchema,
      steeringInjection: steeringInjectionSchema.optional()
    })
    .strict(),
  "channel.health": z
    .object({ channels: z.array(channelRuntimeStatusSchema) })
    .strict(),
  "channel.list": z
    .object({ channels: z.array(channelRuntimeStatusSchema) })
    .strict(),
  "channel.send": channelMessageSchema,
  "external_agent.cancel": externalAgentJobRecordSchema,
  "external_agent.get": externalAgentJobRecordSchema,
  "external_agent.list": z
    .object({
      definitions: z.array(externalAgentDefinitionSchema),
      jobs: z.array(externalAgentJobRecordSchema)
    })
    .strict(),
  "external_agent.resume": externalAgentJobRecordSchema,
  "external_agent.run": externalAgentJobRecordSchema,
  "gateway.health": z
    .object({ ok: z.boolean(), status: z.string().min(1) })
    .strict(),
  "gateway.subscribe": z
    .object({
      subscription: gatewaySubscriptionSchema
    })
    .strict(),
  "memory.query": z.object({ hits: z.array(memoryHitSchema) }).strict(),
  "model.health": providerHealthSchema,
  "run.cancel": z.object({ run: gatewayRunRecordSchema }).strict(),
  "session.cancel": z.object({ run: gatewayRunRecordSchema }).strict(),
  "session.create": z
    .object({
      run: gatewayRunRecordSchema.optional(),
      session: sessionRecordSchema
    })
    .strict(),
  "session.list": z.object({ sessions: z.array(sessionRecordSchema) }).strict(),
  "session.message": z
    .object({
      run: gatewayRunRecordSchema,
      sessionId: entityIdSchema
    })
    .strict(),
  "session.resume": z
    .object({
      run: gatewayRunRecordSchema,
      sessionId: entityIdSchema
    })
    .strict(),
  "session.snapshot": gatewaySessionSnapshotSchema,
  "steering.inject": steeringInjectionSchema,
  "tool.execute": z
    .object({
      run: gatewayRunRecordSchema,
      sessionId: entityIdSchema
    })
    .strict(),
  "tool.search": z.object({ tools: z.array(toolDefinitionSchema) }).strict()
} as const;

export interface GatewayTransportClient {
  request(request: GatewayRequest): Promise<GatewayResponse>;
  subscribe(
    listener: (event: GatewayEvent) => void
  ): Promise<() => Promise<void> | void>;
}

export type GatewayApprovalRecord = z.infer<typeof gatewayApprovalRecordSchema>;
export type GatewayEvent = z.infer<typeof gatewayEventSchema>;
export type GatewayEventPage = z.infer<typeof gatewayEventPageSchema>;
export type GatewayEventReplayQuery = z.infer<
  typeof gatewayEventReplayQuerySchema
>;
export type GatewayEventTopic = z.infer<typeof gatewayEventTopicSchema>;
export type GatewayRequest = z.infer<typeof gatewayRequestSchema>;
export type GatewayRequestTopic = z.infer<typeof gatewayRequestTopicSchema>;
export type GatewayResponse = z.infer<typeof gatewayResponseSchema>;
export type GatewayRunCompletionReason = z.infer<
  typeof gatewayRunCompletionReasonSchema
>;
export type GatewayRunKind = z.infer<typeof gatewayRunKindSchema>;
export type GatewayRunRecord = z.infer<typeof gatewayRunRecordSchema>;
export type GatewayRunStatus = z.infer<typeof gatewayRunStatusSchema>;
export type GatewaySessionSnapshot = z.infer<
  typeof gatewaySessionSnapshotSchema
>;
export type GatewaySubscription = z.infer<typeof gatewaySubscriptionSchema>;
