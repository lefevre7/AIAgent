import { z } from "zod";

import { entityIdSchema, isoTimestampSchema, metadataSchema } from "@/core/contracts/common";

export const approvalRequestIdSchema = entityIdSchema;
export const steeringInjectionIdSchema = entityIdSchema;

export const approvalTargetKindSchema = z.enum([
  "browser_action",
  "channel_message",
  "command",
  "external_agent",
  "mcp_server",
  "mcp_tool",
  "network",
  "path",
  "question",
  "tool",
  "voice_action"
]);

export const approvalStatusSchema = z.enum(["approved", "cancelled", "denied", "expired", "pending"]);
export const approvalDecisionSchema = z.enum(["approved", "cancelled", "denied", "expired"]);
export const approvalActorSchema = z.enum(["channel", "cli", "gateway", "sdk", "system", "web"]);
export const approvalPolicyModeSchema = z.enum(["allow", "ask", "deny"]);
export const steeringStateSchema = z.enum(["applied", "discarded", "queued"]);
export const steeringSourceSchema = z.enum(["channel", "operator", "sdk", "system", "user"]);

export const approvalRequestSchema = z
  .object({
    createdAt: isoTimestampSchema,
    id: approvalRequestIdSchema,
    justification: z.string().min(1),
    metadata: metadataSchema.default({}),
    riskSummary: z.string().min(1),
    sessionId: entityIdSchema,
    status: approvalStatusSchema,
    target: z
      .object({
        kind: approvalTargetKindSchema,
        label: z.string().min(1).max(512),
        value: z.string().min(1)
      })
      .strict(),
    toolCallId: entityIdSchema.optional(),
    turnId: entityIdSchema
  })
  .strict();

export const approvalResolutionSchema = z
  .object({
    actor: approvalActorSchema,
    comment: z.string().min(1).max(2000).optional(),
    decidedAt: isoTimestampSchema,
    decision: approvalDecisionSchema,
    id: entityIdSchema,
    metadata: metadataSchema.default({}),
    requestId: approvalRequestIdSchema
  })
  .strict();

export const approvalPolicyRuleSchema = z
  .object({
    id: entityIdSchema,
    mode: approvalPolicyModeSchema,
    notes: z.string().min(1).max(1000).optional(),
    pattern: z.string().min(1),
    targetKind: approvalTargetKindSchema
  })
  .strict();

export const steeringInjectionSchema = z
  .object({
    createdAt: isoTimestampSchema,
    id: steeringInjectionIdSchema,
    message: z.string().min(1),
    metadata: metadataSchema.default({}),
    sessionId: entityIdSchema,
    source: steeringSourceSchema,
    state: steeringStateSchema,
    turnId: entityIdSchema.optional()
  })
  .strict();

export interface ApprovalService {
  createRequest(request: ApprovalRequest): Promise<void>;
  resolve(resolution: ApprovalResolution): Promise<void>;
}

export type ApprovalActor = z.infer<typeof approvalActorSchema>;
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;
export type ApprovalPolicyMode = z.infer<typeof approvalPolicyModeSchema>;
export type ApprovalPolicyRule = z.infer<typeof approvalPolicyRuleSchema>;
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
export type ApprovalResolution = z.infer<typeof approvalResolutionSchema>;
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;
export type ApprovalTargetKind = z.infer<typeof approvalTargetKindSchema>;
export type SteeringInjection = z.infer<typeof steeringInjectionSchema>;
export type SteeringSource = z.infer<typeof steeringSourceSchema>;
export type SteeringState = z.infer<typeof steeringStateSchema>;
