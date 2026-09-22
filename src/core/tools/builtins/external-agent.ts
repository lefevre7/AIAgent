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
  type ExternalAgentSessionService,
  type ExternalAgentSessionTurn,
  type ToolDefinition
} from "@/core/contracts";
import { buildExternalAgentArtifacts, readExternalAgentJobOutput } from "@/core/external-agents";
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

const startActionSchema = z
  .object({
    action: z.literal("start"),
    agentId: entityIdSchema,
    cwd: z.string().min(1).optional()
  })
  .strict();

const sendActionSchema = z
  .object({
    action: z.literal("send"),
    externalSessionId: entityIdSchema,
    noWait: z.boolean().default(false),
    text: z.string().min(1).max(100_000),
    timeoutMs: timeoutMsSchema
  })
  .strict();

const readActionSchema = z
  .object({
    action: z.literal("read"),
    externalSessionId: entityIdSchema,
    includeScrollback: z.boolean().default(false),
    maxLines: z.number().int().positive().max(5_000).optional()
  })
  .strict();

const stopActionSchema = z
  .object({
    action: z.literal("stop"),
    externalSessionId: entityIdSchema,
    signal: z.string().min(1).max(32).optional()
  })
  .strict();

const attachActionSchema = z
  .object({
    action: z.literal("attach"),
    externalSessionId: entityIdSchema
  })
  .strict();

const externalAgentInputSchema = z.discriminatedUnion("action", [
  attachActionSchema,
  cancelActionSchema,
  getActionSchema,
  listActionSchema,
  readActionSchema,
  resumeActionSchema,
  runActionSchema,
  sendActionSchema,
  startActionSchema,
  stopActionSchema
]);

export type ExternalAgentSessionHost = {
  attach(externalSessionId: string): Promise<{ command: string }>;
  service: ExternalAgentSessionService;
};

export function createExternalAgentTool(params: {
  externalAgentService: ExternalAgentService;
  sessionHost?: ExternalAgentSessionHost;
}): RuntimeTool {
  return {
    definition: externalAgentToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = externalAgentInputSchema.parse(call.arguments as unknown);

      switch (input.action) {
        case "attach": {
          const host = requireSessionHost(params.sessionHost);
          const { command } = await host.attach(input.externalSessionId);
          return {
            display: [
              {
                kind: "status",
                state: "attached",
                summary: `Opened a terminal window attached to ${input.externalSessionId}.`
              }
            ],
            result: { action: "attach", command, externalSessionId: input.externalSessionId }
          };
        }
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
          const sessionId = input.allSessions ? undefined : (input.sessionId ?? context.session.id);
          const [definitions, jobs, interactiveSessions] = await Promise.all([
            params.externalAgentService.listDefinitions(),
            params.externalAgentService.listJobs({
              agentId: input.agentId,
              limit: input.limit ?? 50,
              sessionId,
              status: input.status
            }),
            params.sessionHost?.service.listSessions() ?? Promise.resolve([])
          ]);

          const liveCount = interactiveSessions.filter((entry) => entry.status === "running").length;
          return {
            display: [
              {
                kind: "status",
                state: "listed",
                summary: `Found ${jobs.length} external-agent job(s), ${liveCount} live interactive session(s), and ${definitions.length} configured agent(s).`
              }
            ],
            result: {
              action: "list",
              definitions,
              jobs,
              sessions: interactiveSessions
            }
          };
        }
        case "read": {
          const host = requireSessionHost(params.sessionHost);
          const turn = await host.service.readSession({
            externalSessionId: input.externalSessionId,
            includeScrollback: input.includeScrollback,
            ...(input.maxLines === undefined ? {} : { maxLines: input.maxLines })
          });
          return buildTurnResult("read", turn);
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
        case "send": {
          const host = requireSessionHost(params.sessionHost);
          const turn = await host.service.sendToSession({
            externalSessionId: input.externalSessionId,
            noWait: input.noWait,
            text: input.text,
            ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs })
          });
          return buildTurnResult("send", turn);
        }
        case "start": {
          const host = requireSessionHost(params.sessionHost);
          const record = await host.service.startSession({
            agentId: input.agentId,
            cwd: input.cwd ?? context.session.cwd,
            sessionId: context.session.id
          });
          return {
            display: [
              {
                kind: "status",
                state: record.status,
                summary: `Started interactive session ${record.id} for ${record.agentId}. Send it work with action "send"; open a shared window with action "attach".`
              }
            ],
            result: { action: "start", session: record }
          };
        }
        case "stop": {
          const host = requireSessionHost(params.sessionHost);
          const record = await host.service.stopSession({
            externalSessionId: input.externalSessionId,
            ...(input.signal === undefined ? {} : { signal: input.signal })
          });
          return {
            display: [
              {
                kind: "status",
                state: record.status,
                summary: `Interactive session ${record.id} is ${record.status}.`
              }
            ],
            result: { action: "stop", session: record }
          };
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
      "List the current session's external-agent jobs before resuming an interrupted one.",
      "Start an interactive Claude session, send it a follow-up question, then read the screen."
    ],
    purpose:
      "Run configured external coding agents such as Codex CLI or Mistral Vibe, persist their jobs, drive long-lived interactive sessions, and manage resume or cancellation.",
    sideEffectSummary:
      "May spawn local child processes (including long-lived terminals), write logs and result artifacts under .aia/external-agents, open a terminal window on request, and append compact lifecycle messages to the active session.",
    whenNotToUse: [
      "Do not use for ordinary local commands or scripts that should be executed directly through a lower-level command tool.",
      "Do not use if the requested agent is not enabled in configuration."
    ],
    whenToUse: [
      "Use when you need to delegate a bounded task to a configured external agent CLI and capture its output as a persisted job.",
      "Use start/send/read/stop when the work needs a back-and-forth conversation with the external agent instead of a single instruction.",
      "Use list, get, cancel, or resume to inspect and manage existing external-agent jobs."
    ]
  },
  description:
    "Run, inspect, list, cancel, or resume configured external-agent jobs, and drive long-lived interactive external-agent terminal sessions.",
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
        enum: ["run", "get", "list", "cancel", "resume", "start", "send", "read", "stop", "attach"],
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
      externalSessionId: {
        type: "string"
      },
      includeScrollback: {
        type: "boolean"
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
      maxLines: {
        type: "integer"
      },
      metadata: {
        type: "object"
      },
      mode: {
        enum: ["blocking", "detached"],
        type: "string"
      },
      noWait: {
        type: "boolean"
      },
      resultSchema: {
        type: "object"
      },
      sessionId: {
        type: "string"
      },
      signal: {
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
    "Use run to start a configured external agent for a single bounded instruction. Prefer blocking mode when you need the result immediately. Use list/get to inspect persisted jobs and resume to continue interrupted sessions that captured a native session id. For work that needs a conversation, use start to open an interactive terminal session, send to give it an instruction and wait for its reply, read to re-check the screen, and stop when finished; interactive sessions stay alive until you stop them. Use attach only when the operator asks to see the session in a terminal window.",
  version: "1.0.0"
};

function buildGeneratedJobId(agentId: string): string {
  return `external-agent.${agentId}.${crypto.randomUUID()}`;
}

function requireSessionHost(host: ExternalAgentSessionHost | undefined): ExternalAgentSessionHost {
  if (!host) {
    throw createExternalAgentToolError(
      "external_agent_sessions_unavailable",
      "Interactive external-agent sessions are not available in this runtime."
    );
  }

  return host;
}

/**
 * Reports an interactive turn.
 *
 * The rendered screen is always included as text. A summary, when a model was
 * available to write one, leads: a 40-line TUI screen is expensive context, and
 * the prose is usually the only part the calling model needs.
 */
function buildTurnResult(action: "read" | "send", turn: ExternalAgentSessionTurn): RuntimeToolResult {
  return {
    display: [
      {
        kind: "status" as const,
        state: turn.record.status,
        summary:
          turn.summary ??
          `Interactive session ${turn.record.id} is ${turn.record.status} after ${turn.record.turnCount} turn(s).`
      },
      {
        kind: "text" as const,
        text: turn.screen
      }
    ],
    displayedResultKeys: ["screen"],
    result: {
      action,
      screen: turn.screen,
      session: turn.record,
      ...(turn.summary ? { summary: turn.summary } : {}),
      ...(turn.turnEndReason ? { turnEndReason: turn.turnEndReason } : {})
    }
  };
}

async function buildJobResult(action: "cancel" | "get" | "resume" | "run", job: ExternalAgentJobRecord) {
  const output = await readExternalAgentJobOutput(job);
  const sections = [
    output.stdout.length > 0 ? `--- stdout ---\n${output.stdout}` : undefined,
    output.stderr.length > 0 ? `--- stderr ---\n${output.stderr}` : undefined
  ].filter((section): section is string => section !== undefined);

  return {
    artifacts: await buildExternalAgentArtifacts(job),
    display: [
      {
        kind: "status" as const,
        state: job.status,
        summary: summarizeJob(job)
      },
      // The job record says whether the agent exited cleanly; only the captured
      // streams say what it actually did. Reporting status alone is what made
      // delegated work invisible to both the model and the operator.
      ...(sections.length > 0
        ? [
            {
              kind: "text" as const,
              text: sections.join("\n\n")
            }
          ]
        : [])
    ],
    displayedResultKeys: ["output"],
    result: {
      action,
      job,
      output
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
