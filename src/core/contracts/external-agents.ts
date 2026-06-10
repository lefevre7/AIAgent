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

export const externalAgentKindSchema = z.enum(["codex", "mistral_vibe"]);
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
