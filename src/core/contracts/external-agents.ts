import { z } from "zod";

import {
  artifactReferenceSchema,
  entityIdSchema,
  isoTimestampSchema,
  jsonSchemaDocumentSchema,
  jsonValueSchema,
  metadataSchema,
  structuredErrorSchema
} from "@/core/contracts/common";

export const externalAgentKindSchema = z.enum(["claude", "codex", "mistral_vibe"]);
export const externalAgentExecutionModeSchema = z.enum(["blocking", "detached"]);
export const externalAgentJobStatusSchema = z.enum([
  "awaiting_resume",
  "cancelled",
  "failed",
  "queued",
  "running",
  "succeeded"
]);
export const externalAgentMonitorStateSchema = z.enum(["attached", "recovered", "unattached"]);

export const externalAgentDefinitionSchema = z
  .object({
    command: z.string().min(1),
    defaultArgs: z.array(z.string().min(1)).default([]),
    displayName: z.string().min(1).max(128),
    id: entityIdSchema,
    /**
     * Extra argv an interactive `start` appends to `defaultArgs`.
     *
     * Carried on the definition so the approval prompt can show the command
     * that will actually be spawned. These are the preset's bypass flags
     * (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`),
     * so an approval that omitted them asked the operator to consent to
     * something materially safer than what runs.
     */
    interactiveArgs: z.array(z.string().min(1)).default([]),
    kind: externalAgentKindSchema,
    metadata: metadataSchema.default({}),
    resumeSupported: z.boolean().default(false),
    structuredOutputSupported: z.boolean().default(false)
  })
  .strict();

export const externalAgentJobRequestSchema = z
  .object({
    agentId: entityIdSchema,
    args: z.array(z.string().min(1)).default([]),
    cwd: z.string().min(1),
    id: entityIdSchema,
    instructions: z.string().min(1),
    metadata: metadataSchema.default({}),
    mode: externalAgentExecutionModeSchema.default("blocking"),
    resultSchema: jsonSchemaDocumentSchema.optional(),
    sessionId: entityIdSchema.optional(),
    timeoutMs: z.number().int().positive().max(3_600_000).optional()
  })
  .strict();

export const externalAgentJobRecordSchema = z
  .object({
    attempts: z.number().int().nonnegative().default(0),
    completedAt: isoTimestampSchema.optional(),
    createdAt: isoTimestampSchema,
    error: structuredErrorSchema.optional(),
    exitCode: z.number().int().optional(),
    id: entityIdSchema,
    logPaths: z
      .object({
        result: z.string().min(1).optional(),
        stderr: z.string().min(1).optional(),
        stdout: z.string().min(1).optional(),
        summary: z.string().min(1).optional()
      })
      .strict()
      .default({}),
    metadata: metadataSchema.default({}),
    monitorState: externalAgentMonitorStateSchema.optional(),
    nativeSessionId: z.string().min(1).max(256).optional(),
    pid: z.number().int().positive().optional(),
    request: externalAgentJobRequestSchema,
    resultArtifact: artifactReferenceSchema.optional(),
    startedAt: isoTimestampSchema.optional(),
    status: externalAgentJobStatusSchema,
    structuredResult: jsonValueSchema.optional(),
    summary: z.string().min(1).optional(),
    updatedAt: isoTimestampSchema
  })
  .strict();

/**
 * A long-lived interactive external-agent session.
 *
 * This sits beside the one-shot job model rather than replacing it: a job is
 * "run this instruction and tell me what happened", while a session is a real
 * terminal the agent and a human can both drive until it is explicitly stopped.
 */
export const externalAgentSessionStatusSchema = z.enum(["exited", "failed", "running", "stopped"]);

export const externalAgentSessionRecordSchema = z
  .object({
    agentId: entityIdSchema,
    args: z.array(z.string()),
    /** Set when a human last typed into the shared terminal; gates agent writes. */
    attachedAt: isoTimestampSchema.optional(),
    command: z.string().min(1),
    createdAt: isoTimestampSchema,
    cwd: z.string().min(1),
    endedAt: isoTimestampSchema.optional(),
    error: structuredErrorSchema.optional(),
    exitCode: z.number().int().optional(),
    id: entityIdSchema,
    lastHumanInputAt: isoTimestampSchema.optional(),
    /** Path to the durable raw byte log for this session. */
    logPath: z.string().min(1),
    /** True when the child got a real terminal device. */
    pty: z.boolean(),
    sessionId: entityIdSchema.optional(),
    status: externalAgentSessionStatusSchema,
    turnCount: z.number().int().nonnegative(),
    updatedAt: isoTimestampSchema
  })
  .strict();

export const externalAgentSessionStartRequestSchema = z
  .object({
    agentId: entityIdSchema,
    cwd: z.string().min(1).optional(),
    sessionId: entityIdSchema.optional()
  })
  .strict();

export const externalAgentSessionSendRequestSchema = z
  .object({
    externalSessionId: entityIdSchema,
    /** Skip waiting for the turn to finish; use `read` to poll instead. */
    noWait: z.boolean().default(false),
    text: z.string().min(1).max(100_000),
    timeoutMs: z.number().int().positive().max(3_600_000).optional()
  })
  .strict();

export const externalAgentSessionReadRequestSchema = z
  .object({
    externalSessionId: entityIdSchema,
    includeScrollback: z.boolean().default(false),
    maxLines: z.number().int().positive().max(5_000).optional()
  })
  .strict();

export const externalAgentSessionStopRequestSchema = z
  .object({
    externalSessionId: entityIdSchema,
    signal: z.string().min(1).max(32).optional()
  })
  .strict();

export const externalAgentSessionTurnSchema = z
  .object({
    record: externalAgentSessionRecordSchema,
    /** The rendered terminal screen after the turn settled. */
    screen: z.string(),
    /** Prose summary of what the agent did, when a model was available to write one. */
    summary: z.string().optional(),
    turnEndReason: z.enum(["exited", "idle", "ready_pattern", "timeout"]).optional()
  })
  .strict();

export const externalAgentJobListQuerySchema = z
  .object({
    agentId: entityIdSchema.optional(),
    limit: z.number().int().positive().max(200).default(50),
    sessionId: entityIdSchema.optional(),
    status: externalAgentJobStatusSchema.optional()
  })
  .strict();

export const externalAgentJobCancelRequestSchema = z
  .object({
    jobId: entityIdSchema
  })
  .strict();

export const externalAgentJobResumeRequestSchema = z
  .object({
    instructions: z.string().min(1).optional(),
    jobId: entityIdSchema,
    mode: externalAgentExecutionModeSchema.default("blocking"),
    timeoutMs: z.number().int().positive().max(3_600_000).optional()
  })
  .strict();

export interface ExternalAgentAdapter {
  getDefinition(agentId: string): Promise<ExternalAgentDefinition | null>;
  run(request: ExternalAgentJobRequest): Promise<ExternalAgentJobRecord>;
}

export interface ExternalAgentService extends ExternalAgentAdapter {
  cancel(request: ExternalAgentJobCancelRequest): Promise<ExternalAgentJobRecord>;
  getJob(jobId: string): Promise<ExternalAgentJobRecord | null>;
  listDefinitions(): Promise<ExternalAgentDefinition[]>;
  listJobs(query?: ExternalAgentJobListQuery): Promise<ExternalAgentJobRecord[]>;
  resume(request: ExternalAgentJobResumeRequest): Promise<ExternalAgentJobRecord>;
}

/**
 * Interactive sessions are a separate capability so a host that only needs
 * one-shot delegation is not forced to implement a terminal.
 */
export interface ExternalAgentSessionService {
  listSessions(): Promise<ExternalAgentSessionRecord[]>;
  /** Marks a session as watched by a terminal window. */
  noteAttached(externalSessionId: string): Promise<void>;
  readSession(request: ExternalAgentSessionReadRequest): Promise<ExternalAgentSessionTurn>;
  sendToSession(request: ExternalAgentSessionSendRequest): Promise<ExternalAgentSessionTurn>;
  startSession(request: ExternalAgentSessionStartRequest): Promise<ExternalAgentSessionRecord>;
  stopSession(request: ExternalAgentSessionStopRequest): Promise<ExternalAgentSessionRecord>;
  /**
   * Relays a raw keystroke from an attached human terminal.
   *
   * Separate from `sendToSession` because a human's bytes are not a turn: they
   * are not summarized, not counted, and they soft-lock agent writes instead of
   * being blocked by that lock.
   */
  writeHumanInput(externalSessionId: string, text: string): Promise<void>;
}

export type ExternalAgentDefinition = z.infer<typeof externalAgentDefinitionSchema>;
export type ExternalAgentExecutionMode = z.infer<typeof externalAgentExecutionModeSchema>;
export type ExternalAgentJobCancelRequest = z.infer<typeof externalAgentJobCancelRequestSchema>;
export type ExternalAgentJobListQuery = z.infer<typeof externalAgentJobListQuerySchema>;
export type ExternalAgentJobRecord = z.infer<typeof externalAgentJobRecordSchema>;
export type ExternalAgentJobRequest = z.infer<typeof externalAgentJobRequestSchema>;
export type ExternalAgentJobResumeRequest = z.infer<typeof externalAgentJobResumeRequestSchema>;
export type ExternalAgentJobStatus = z.infer<typeof externalAgentJobStatusSchema>;
export type ExternalAgentKind = z.infer<typeof externalAgentKindSchema>;
export type ExternalAgentMonitorState = z.infer<typeof externalAgentMonitorStateSchema>;
export type ExternalAgentSessionReadRequest = z.infer<typeof externalAgentSessionReadRequestSchema>;
export type ExternalAgentSessionRecord = z.infer<typeof externalAgentSessionRecordSchema>;
export type ExternalAgentSessionSendRequest = z.infer<typeof externalAgentSessionSendRequestSchema>;
export type ExternalAgentSessionStartRequest = z.infer<typeof externalAgentSessionStartRequestSchema>;
export type ExternalAgentSessionStatus = z.infer<typeof externalAgentSessionStatusSchema>;
export type ExternalAgentSessionStopRequest = z.infer<typeof externalAgentSessionStopRequestSchema>;
export type ExternalAgentSessionTurn = z.infer<typeof externalAgentSessionTurnSchema>;
