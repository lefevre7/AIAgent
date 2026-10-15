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

/**
 * One thing an approval is weighed on (a command line, a path, an MCP server
 * a call reaches, the external agent it starts): the approval policy's rules
 * match on these, and a request names the one that decided.
 */
export const approvalTargetSchema = z
  .object({
    kind: approvalTargetKindSchema,
    label: z.string().min(1).max(512),
    value: z.string().min(1)
  })
  .strict();

export const approvalRequestSchema = z
  .object({
    createdAt: isoTimestampSchema,
    id: approvalRequestIdSchema,
    justification: z.string().min(1),
    metadata: metadataSchema.default({}),
    riskSummary: z.string().min(1),
    sessionId: entityIdSchema,
    status: approvalStatusSchema,
    target: approvalTargetSchema,
    toolCallId: entityIdSchema.optional(),
    turnId: entityIdSchema
  })
  .strict();

/** Where an approval request lists every target the policy evaluated. */
export const APPROVAL_TARGETS_METADATA_KEY = "evaluatedTargets";

/**
 * Every target an approval request was evaluated on (the command line with
 * its argv, each path, the tool…), for showing the operator what they are
 * approving. Requests recorded before these were kept list only the target
 * that decided.
 */
export function readApprovalTargets(
  request: Pick<ApprovalRequest, "metadata" | "target">
): Array<ApprovalRequest["target"]> {
  const recorded = request.metadata?.[APPROVAL_TARGETS_METADATA_KEY];
  const targets = Array.isArray(recorded)
    ? recorded.flatMap((entry) => {
        const parsed = approvalTargetSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  return targets.length > 0 ? targets : [request.target];
}

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

// Approval patterns come from operator config (including a cloned repo's
// workspace approvals file) and are matched against model-influenced strings,
// so they are validated up front: bounded length, must compile, and no
// quantified group that itself contains a quantifier (the classic catastrophic
// backtracking shape such as `(a+)+` or `(\w*\s+)*`). Security review H8.
export const APPROVAL_PATTERN_MAX_LENGTH = 512;

const NESTED_QUANTIFIER_PATTERN = /\((?:[^()\\]|\\.)*(?:[+*]|\{\d+(?:,\d*)?\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d)/u;

export function validateApprovalPattern(pattern: string): string | null {
  if (pattern.length === 0) {
    return "must not be empty";
  }
  if (pattern.length > APPROVAL_PATTERN_MAX_LENGTH) {
    return `must be at most ${APPROVAL_PATTERN_MAX_LENGTH} characters long`;
  }
  if (NESTED_QUANTIFIER_PATTERN.test(pattern)) {
    return "must not nest a quantifier inside a quantified group (catastrophic backtracking risk)";
  }
  try {
    new RegExp(pattern, "u");
  } catch (error) {
    return `is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

export const approvalPatternSchema = z
  .string()
  .min(1)
  .max(APPROVAL_PATTERN_MAX_LENGTH)
  .superRefine((value, context) => {
    const problem = validateApprovalPattern(value);
    if (problem) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Approval pattern ${problem}.`
      });
    }
  });

export const approvalPolicyRuleSchema = z
  .object({
    id: entityIdSchema,
    mode: approvalPolicyModeSchema,
    notes: z.string().min(1).max(1000).optional(),
    pattern: approvalPatternSchema,
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
export type ApprovalTarget = z.infer<typeof approvalTargetSchema>;
export type SteeringInjection = z.infer<typeof steeringInjectionSchema>;
export type SteeringSource = z.infer<typeof steeringSourceSchema>;
export type SteeringState = z.infer<typeof steeringStateSchema>;
