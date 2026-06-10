import crypto from "node:crypto";

import { z } from "zod";

import {
  entityIdSchema,
  externalAgentExecutionModeSchema,
  externalAgentJobStatusSchema,
  jsonSchemaDocumentSchema,
  metadataSchema,
  type ExternalAgentJobRecord,
  type ExternalAgentService,
  type ToolDefinition
} from "@/core/contracts";
import { buildExternalAgentArtifacts } from "@/core/external-agents";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

const timeoutMsSchema = z.number().int().positive().max(3_600_000).optional();

const listActionSchema = z
  .object({
    action: z.literal("list"),
    agentId: entityIdSchema.optional(),
    allSessions: z.boolean().optional(),
    limit: z.number().int().positive().max(200).optional(),
    sessionId: entityIdSchema.optional(),
    status: externalAgentJobStatusSchema.optional()
  })
  .strict();

const getActionSchema = z
  .object({
    action: z.literal("get"),
    jobId: entityIdSchema
  })
  .strict();

const cancelActionSchema = z
  .object({
    action: z.literal("cancel"),
    jobId: entityIdSchema
  })
  .strict();

const resumeActionSchema = z
  .object({
    action: z.literal("resume"),
    instructions: z.string().min(1).optional(),
    jobId: entityIdSchema,
    mode: externalAgentExecutionModeSchema.default("blocking"),
    timeoutMs: timeoutMsSchema
  })
  .strict();

const runActionSchema = z
  .object({
    action: z.literal("run"),
    agentId: entityIdSchema,
    args: z.array(z.string().min(1)).max(128).default([]),
    cwd: z.string().min(1).optional(),
    instructions: z.string().min(1),
    jobId: entityIdSchema.optional(),
    metadata: metadataSchema.default({}),
    mode: externalAgentExecutionModeSchema.default("blocking"),
    resultSchema: jsonSchemaDocumentSchema.optional(),
    timeoutMs: timeoutMsSchema
  })
  .strict();

const externalAgentInputSchema = z.discriminatedUnion("action", [
  cancelActionSchema,
  getActionSchema,
  listActionSchema,
  resumeActionSchema,
  runActionSchema
]);

export function createExternalAgentTool(params: { externalAgentService: ExternalAgentService }): RuntimeTool {
  return {
    definition: externalAgentToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = externalAgentInputSchema.parse(call.arguments as unknown);

      switch (input.action) {
        case "cancel": {
          const job = await params.externalAgentService.cancel({
            jobId: input.jobId
          });
          return buildJobResult("cancel", job);
        }
        case "get": {
          const job = await params.externalAgentService.getJob(input.jobId);
          if (!job) {
            throw createExternalAgentToolError(
              "external_agent_job_not_found",
              `External-agent job "${input.jobId}" was not found.`
            );
          }
          return buildJobResult("get", job);
        }
        case "list": {
          const sessionId = input.allSessions ? undefined : input.sessionId ?? context.session.id;
          const [definitions, jobs] = await Promise.all([
            params.externalAgentService.listDefinitions(),
            params.externalAgentService.listJobs({
              agentId: input.agentId,
              limit: input.limit ?? 50,
              sessionId,
              status: input.status
            })
          ]);

          return {
            display: [
              {
                kind: "status",
                state: "listed",
                summary: `Found ${jobs.length} external-agent job(s) and ${definitions.length} configured agent(s).`
              }
            ],
            result: {
              action: "list",
              definitions,
              jobs
            }
          };
        }
        case "resume": {
          const job = await params.externalAgentService.resume({
            instructions: input.instructions,
            jobId: input.jobId,
            mode: input.mode,
            timeoutMs: input.timeoutMs
          });
          return buildJobResult("resume", job);
        }
        case "run": {
          const job = await params.externalAgentService.run({
            agentId: input.agentId,
            args: input.args,
            cwd: input.cwd ?? context.session.cwd,
            id: input.jobId ?? buildGeneratedJobId(input.agentId),
            instructions: input.instructions,
            metadata: input.metadata,
            mode: input.mode,
            resultSchema: input.resultSchema,
            sessionId: context.session.id,
            timeoutMs: input.timeoutMs
          });
          return buildJobResult("run", job);
        }
      }
    }
  };
}

export const externalAgentToolDefinition: ToolDefinition = {
  aliases: ["external-agent", "external_agent_job"],
  annotations: {
    meta: {
      family: "external-agent"
    },
    title: "External Agent"
  },
  approvalMode: "always",
  descriptor: {
    approvalNotes:
      "Runs or manages configured external agent CLIs, which can launch local processes and write job artifacts under the workspace state directory.",
    examples: [
      "Run Codex in blocking mode and collect the result artifact.",
      "List the current session's external-agent jobs before resuming an interrupted one."
    ],
    purpose:
      "Run configured external coding agents such as Codex CLI or Mistral Vibe, persist their jobs, and manage resume or cancellation.",
    sideEffectSummary:
      "May spawn local child processes, write logs and result artifacts under .aia/external-agents, and append compact lifecycle messages to the active session.",
    whenNotToUse: [
      "Do not use for ordinary local commands or scripts that should be executed directly through a lower-level command tool.",
      "Do not use if the requested agent is not enabled in configuration."
    ],
    whenToUse: [
      "Use when you need to delegate a bounded task to a configured external agent CLI and capture its output as a persisted job.",
      "Use list, get, cancel, or resume to inspect and manage existing external-agent jobs."
    ]
  },
  description:
    "Run, inspect, list, cancel, or resume configured external-agent jobs backed by local CLI adapters and persisted job state.",
  displayName: "External Agent",
  execution: {
    inputMode: "json",
    resumable: true,
    taskSupport: "optional"
  },
  idempotent: false,
  inputSchema: {
    additionalProperties: false,
    properties: {
      action: {
        enum: ["run", "get", "list", "cancel", "resume"],
        type: "string"
      },
      agentId: {
        type: "string"
      },
      allSessions: {
        type: "boolean"
      },
      args: {
        items: {
          type: "string"
        },
        type: "array"
      },
      cwd: {
        type: "string"
      },
      instructions: {
        type: "string"
      },
      jobId: {
        type: "string"
      },
      limit: {
        type: "integer"
      },
      metadata: {
        type: "object"
      },
      mode: {
        enum: ["blocking", "detached"],
        type: "string"
      },
      resultSchema: {
        type: "object"
      },
      sessionId: {
        type: "string"
      },
      status: {
        enum: ["awaiting_resume", "cancelled", "failed", "queued", "running", "succeeded"],
        type: "string"
      },
      timeoutMs: {
        type: "integer"
      }
    },
    required: ["action"],
    type: "object"
  },
  invocationName: "external_agent",
  kind: "external_agent",
  metadata: {},
  name: "external_agent",
  outputKind: "mixed",
  outputSchema: {
    type: "object"
  },
  retryable: true,
  searchTags: ["agent", "claude", "codex", "delegate", "external", "job", "mistral", "resume"],
  sideEffects: ["local_process", "workspace_write"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.external-agent",
  usageGuidance:
    "Use run to start a configured external agent. Prefer blocking mode when you need the result immediately. Use list/get to inspect persisted jobs and resume to continue interrupted sessions that captured a native session id.",
  version: "1.0.0"
};

function buildGeneratedJobId(agentId: string): string {
  return `external-agent.${agentId}.${crypto.randomUUID()}`;
}

async function buildJobResult(action: "cancel" | "get" | "resume" | "run", job: ExternalAgentJobRecord) {
  return {
    artifacts: await buildExternalAgentArtifacts(job),
    display: [
      {
        kind: "status" as const,
        state: job.status,
        summary: summarizeJob(job)
      }
    ],
    result: {
      action,
      job
    }
  };
}

function summarizeJob(job: ExternalAgentJobRecord): string {
  if (job.summary) {
    return job.summary;
  }
  switch (job.status) {
    case "awaiting_resume":
      return `Job ${job.id} stopped before completion and can be resumed.`;
    case "cancelled":
      return `Job ${job.id} was cancelled.`;
    case "failed":
      return job.error?.message ?? `Job ${job.id} failed.`;
    case "queued":
      return `Job ${job.id} is queued.`;
    case "running":
      return `Job ${job.id} is running via ${job.request.agentId}.`;
    case "succeeded":
      return `Job ${job.id} completed successfully.`;
  }
}

function createExternalAgentToolError(code: string, message: string) {
  return {
    code,
    details: {},
    message,
    retriable: false
  } as const;
}
