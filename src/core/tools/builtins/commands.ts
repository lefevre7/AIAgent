import path from "node:path";

import { z } from "zod";

import type { ArtifactReference, JsonSchemaDocument, ToolDefinition } from "@/core/contracts";
import { createArtifactReferenceFromFile } from "@/core/io/artifacts";
import { type CommandRuntime, type CommandSessionRecord } from "@/core/tools/builtins/command-runtime";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

const localPathSchema = z.string().min(1).max(4096);
const sessionIdSchema = z.string().min(1).max(256);

const shellCommandInputSchema = z
  .object({
    command: z.string().min(1).max(20_000),
    cwd: localPathSchema.optional(),
    timeoutMs: z.number().int().positive().max(3_600_000).optional()
  })
  .strict();

const execCommandInputSchema = z
  .object({
    args: z.array(z.string().max(8_192)).max(256).optional(),
    cols: z.number().int().positive().max(500).optional(),
    command: z.string().min(1).max(4_096),
    cwd: localPathSchema.optional(),
    rows: z.number().int().positive().max(500).optional()
  })
  .strict();

const readCommandOutputInputSchema = z
  .object({
    maxChars: z.number().int().positive().max(200_000).optional(),
    offset: z.number().int().min(0).max(10_000_000).optional(),
    query: z.string().min(1).max(4_096).optional(),
    sessionId: sessionIdSchema,
    stream: z.enum(["combined", "stderr", "stdout"]).optional()
  })
  .strict();

const writeStdinInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    submit: z.boolean().optional(),
    text: z.string().max(100_000)
  })
  .strict();

const waitCommandInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    timeoutMs: z.number().int().positive().max(3_600_000).optional()
  })
  .strict();

const killCommandInputSchema = z
  .object({
    sessionId: sessionIdSchema,
    signal: z.string().min(1).max(64).optional(),
    timeoutMs: z.number().int().positive().max(60_000).optional()
  })
  .strict();

const listCommandSessionsInputSchema = z
  .object({
    limit: z.number().int().positive().max(1_000).optional()
  })
  .strict();

const genericObjectSchema: JsonSchemaDocument = {
  type: "object"
};

const shellCommandJsonSchema: JsonSchemaDocument = {
  additionalProperties: false,
  properties: {
    command: { type: "string" },
    cwd: { type: "string" },
    timeoutMs: { type: "integer" }
  },
  required: ["command"],
  type: "object"
};

const execCommandJsonSchema: JsonSchemaDocument = {
  additionalProperties: false,
  properties: {
    args: {
      items: { type: "string" },
      type: "array"
    },
    cols: { type: "integer" },
    command: { type: "string" },
    cwd: { type: "string" },
    rows: { type: "integer" }
  },
  required: ["command"],
  type: "object"
};

const readCommandOutputJsonSchema: JsonSchemaDocument = {
  additionalProperties: false,
  properties: {
    maxChars: { type: "integer" },
    offset: { type: "integer" },
    query: { type: "string" },
    sessionId: { type: "string" },
    stream: {
      enum: ["combined", "stderr", "stdout"],
      type: "string"
    }
  },
  required: ["sessionId"],
  type: "object"
};

const writeStdinJsonSchema: JsonSchemaDocument = {
  additionalProperties: false,
  properties: {
    sessionId: { type: "string" },
    submit: { type: "boolean" },
    text: { type: "string" }
  },
  required: ["sessionId", "text"],
  type: "object"
};

const waitCommandJsonSchema: JsonSchemaDocument = {
  additionalProperties: false,
  properties: {
    sessionId: { type: "string" },
    timeoutMs: { type: "integer" }
  },
  required: ["sessionId"],
  type: "object"
};

const killCommandJsonSchema: JsonSchemaDocument = {
  additionalProperties: false,
  properties: {
    sessionId: { type: "string" },
    signal: { type: "string" },
    timeoutMs: { type: "integer" }
  },
  required: ["sessionId"],
  type: "object"
};

const listCommandSessionsJsonSchema: JsonSchemaDocument = {
  additionalProperties: false,
  properties: {
    limit: { type: "integer" }
  },
  type: "object"
};

export function createCommandTools(params: { commandRuntime: CommandRuntime }): RuntimeTool[] {
  return [
    createShellCommandTool(params),
    createExecCommandTool(params),
    createReadCommandOutputTool(params),
    createWriteStdinTool(params),
    createWaitCommandTool(params),
    createKillCommandTool(params),
    createListCommandSessionsTool(params)
  ];
}

export function createShellCommandTool(params: { commandRuntime: CommandRuntime }): RuntimeTool {
  return {
    definition: shellCommandToolDefinition,
    async execute(call): Promise<RuntimeToolResult> {
      const input = shellCommandInputSchema.parse(call.arguments as unknown);
      const result = await params.commandRuntime.runShellCommand({
        command: input.command,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs
      });
      const combinedPreview = truncateForDisplay(result.combinedOutput, 12_000);
      const artifacts = await createCommandArtifacts(result.record);

      return {
        artifacts,
        display: [
          {
            kind: "status",
            state: result.record.status,
            summary: summarizeCommandRecord(result.record)
          },
          ...(combinedPreview.text.length > 0
            ? [
                {
                  kind: "text" as const,
                  text: combinedPreview.text
                }
              ]
            : [])
        ],
        result: {
          combinedOutput: combinedPreview.text,
          commandLine: result.record.commandLine,
          cwd: result.record.cwd,
          exitCode: result.record.exitCode ?? null,
          sessionId: result.record.id,
          signal: result.record.signal ?? null,
          status: result.record.status,
          timedOut: result.record.timedOut ?? false,
          truncated: combinedPreview.truncated
        }
      };
    }
  };
}

export function createExecCommandTool(params: { commandRuntime: CommandRuntime }): RuntimeTool {
  return {
    definition: execCommandToolDefinition,
    async execute(call): Promise<RuntimeToolResult> {
      const input = execCommandInputSchema.parse(call.arguments as unknown);
      const record = await params.commandRuntime.startExecCommand({
        args: input.args ?? [],
        cols: input.cols,
        command: input.command,
        cwd: input.cwd,
        rows: input.rows
      });

      return {
        artifacts: await createCommandArtifacts(record),
        display: [
          {
            kind: "status",
            state: "running",
            summary: summarizeCommandRecord(record)
          }
        ],
        result: summarizeRecordForJson(record)
      };
    }
  };
}

export function createReadCommandOutputTool(params: { commandRuntime: CommandRuntime }): RuntimeTool {
  return {
    definition: readCommandOutputToolDefinition,
    async execute(call): Promise<RuntimeToolResult> {
      const input = readCommandOutputInputSchema.parse(call.arguments as unknown);
      const result = await params.commandRuntime.readCommandOutput({
        maxChars: input.maxChars,
        offset: input.offset,
        query: input.query,
        sessionId: input.sessionId,
        stream: input.stream
      });

      return {
        artifacts: result.artifact ? [result.artifact] : [],
        display: [
          {
            kind: "status",
            state: result.record.status,
            summary: summarizeCommandRecord(result.record)
          },
          ...(result.output.length > 0
            ? [
                {
                  kind: "text" as const,
                  text: result.output
                }
              ]
            : [])
        ],
        result: {
          matchCount: result.matchCount,
          nextOffset: result.nextOffset,
          offset: result.offset,
          output: result.output,
          sessionId: result.record.id,
          status: result.record.status,
          stream: result.stream,
          totalChars: result.totalChars,
          truncated: result.truncated
        }
      };
    }
  };
}

export function createWriteStdinTool(params: { commandRuntime: CommandRuntime }): RuntimeTool {
  return {
    definition: writeStdinToolDefinition,
    async execute(call): Promise<RuntimeToolResult> {
      const input = writeStdinInputSchema.parse(call.arguments as unknown);
      const record = await params.commandRuntime.writeStdin({
        sessionId: input.sessionId,
        submit: input.submit,
        text: input.text
      });

      return {
        display: [
          {
            kind: "status",
            state: record.status,
            summary: `Wrote stdin to ${record.id}.`
          }
        ],
        result: summarizeRecordForJson(record)
      };
    }
  };
}

export function createWaitCommandTool(params: { commandRuntime: CommandRuntime }): RuntimeTool {
  return {
    definition: waitCommandToolDefinition,
    async execute(call): Promise<RuntimeToolResult> {
      const input = waitCommandInputSchema.parse(call.arguments as unknown);
      const result = await params.commandRuntime.waitForCommand({
        sessionId: input.sessionId,
        timeoutMs: input.timeoutMs
      });

      return {
        artifacts: result.timedOut ? [] : await createCommandArtifacts(result.record),
        display: [
          {
            kind: "status",
            state: result.timedOut ? "timeout" : result.record.status,
            summary: result.timedOut
              ? `Command session ${result.record.id} is still running.`
              : summarizeCommandRecord(result.record)
          }
        ],
        result: {
          ...summarizeRecordForJson(result.record),
          timedOut: result.timedOut
        }
      };
    }
  };
}

export function createKillCommandTool(params: { commandRuntime: CommandRuntime }): RuntimeTool {
  return {
    definition: killCommandToolDefinition,
    async execute(call): Promise<RuntimeToolResult> {
      const input = killCommandInputSchema.parse(call.arguments as unknown);
      const result = await params.commandRuntime.killCommand({
        sessionId: input.sessionId,
        signal: input.signal,
        timeoutMs: input.timeoutMs
      });

      return {
        artifacts: result.timedOut ? [] : await createCommandArtifacts(result.record),
        display: [
          {
            kind: "status",
            state: result.timedOut ? "timeout" : result.record.status,
            summary: result.timedOut
              ? `Kill signal sent to ${result.record.id}; the process is still running.`
              : summarizeCommandRecord(result.record)
          }
        ],
        result: {
          ...summarizeRecordForJson(result.record),
          timedOut: result.timedOut
        }
      };
    }
  };
}

export function createListCommandSessionsTool(params: { commandRuntime: CommandRuntime }): RuntimeTool {
  return {
    definition: listCommandSessionsToolDefinition,
    async execute(call): Promise<RuntimeToolResult> {
      const input = listCommandSessionsInputSchema.parse(call.arguments as unknown);
      const sessions = await params.commandRuntime.listCommandSessions({
        limit: input.limit
      });

      return {
        display: [
          {
            kind: "markdown",
            markdown: renderSessionList(sessions)
          }
        ],
        result: {
          sessions: sessions.map((record) => summarizeRecordForJson(record))
        }
      };
    }
  };
}

const shellCommandToolDefinition: ToolDefinition = createCommandDefinition({
  aliases: ["run_shell_command"],
  approvalMode: "ask",
  definitionName: "shell_command",
  description:
    "Run a one-shot shell command string in a local shell, capture stdout and stderr, persist logs, and return a bounded preview.",
  descriptor: {
    approvalNotes: "Approval is required because this tool executes a local shell command.",
    examples: ["Run `git status --short` in the current repo.", "Run a one-shot build or test command with a timeout."],
    purpose: "Execute a short-lived shell command when a shell string is the most direct fit.",
    sideEffectSummary: "Executes a local shell command and persists local command logs.",
    whenNotToUse: [
      "Do not use it for interactive workflows that need stdin after launch; use exec_command.",
      "Do not use it when argv-based execution is clearer than a shell string."
    ],
    whenToUse: [
      "Use for one-shot shell commands.",
      "Use when shell features like pipes or glob expansion are intentionally required."
    ]
  },
  displayName: "Shell Command",
  idempotent: false,
  inputSchema: shellCommandJsonSchema,
  outputSchema: genericObjectSchema,
  retryable: false,
  searchTags: ["command", "process", "pty", "shell", "terminal"],
  sideEffects: ["local_process"],
  usageGuidance:
    "Use this for one-shot local shell commands. Prefer exec_command when the process should stay alive, receive stdin later, or avoid shell parsing."
});

const execCommandToolDefinition: ToolDefinition = createCommandDefinition({
  aliases: ["start_command_session"],
  approvalMode: "ask",
  definitionName: "exec_command",
  description:
    "Start a PTY-backed local command session using a command plus argv array, persist its output, and return a session id for later lifecycle tools.",
  descriptor: {
    approvalNotes: "Approval is required because this tool starts a local process that can continue running after the tool returns.",
    examples: ["Start `npm` with `['run', 'dev']` in a project directory.", "Launch an interactive CLI and then send input with write_stdin."],
    purpose: "Start a long-lived or interactive local command session with explicit argv semantics.",
    sideEffectSummary: "Starts a local PTY-backed process and persists command logs.",
    whenNotToUse: [
      "Do not use it for simple one-shot shell strings; use shell_command.",
      "Do not use it when you need shell parsing features like pipes or redirection."
    ],
    whenToUse: [
      "Use for long-running commands.",
      "Use for interactive or PTY-sensitive programs."
    ]
  },
  displayName: "Exec Command",
  idempotent: false,
  inputSchema: execCommandJsonSchema,
  outputSchema: genericObjectSchema,
  retryable: false,
  searchTags: ["argv", "command", "exec", "process", "pty"],
  sideEffects: ["local_process"],
  usageGuidance:
    "Use this to start a PTY-backed local process with explicit argv input. Follow up with read_command_output, write_stdin, wait_command, or kill_command using the returned session id."
});

const readCommandOutputToolDefinition: ToolDefinition = createCommandDefinition({
  aliases: ["command_output"],
  approvalMode: "never",
  definitionName: "read_command_output",
  description: "Read persisted output for a command session, optionally paged by offset or filtered by a query substring.",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only reads persisted local command logs.",
    examples: ["Read the next chunk of combined output from a running session.", "Filter a command log for lines containing 'error'."],
    purpose: "Inspect output from one-shot or live local command sessions without rerunning the command.",
    sideEffectSummary: "Reads persisted local command logs only.",
    whenNotToUse: ["Do not use it before you have a session id.", "Do not use it to wait for completion; use wait_command."],
    whenToUse: ["Use to tail or paginate command logs.", "Use to inspect stdout, stderr, or combined output from a stored session."]
  },
  displayName: "Read Command Output",
  idempotent: false,
  inputSchema: readCommandOutputJsonSchema,
  outputSchema: genericObjectSchema,
  retryable: true,
  searchTags: ["command", "logs", "output", "read", "stdout"],
  sideEffects: ["none"],
  usageGuidance:
    "Use this to inspect persisted command output incrementally. Use offset and maxChars for paging, or query to filter matching lines."
});

const writeStdinToolDefinition: ToolDefinition = createCommandDefinition({
  aliases: ["command_stdin"],
  approvalMode: "ask",
  definitionName: "write_stdin",
  description: "Write text to the stdin of a running PTY command session, optionally submitting an Enter key afterward.",
  descriptor: {
    approvalNotes: "Approval is required because this tool can drive a live local process.",
    examples: ["Answer a prompt in an interactive CLI.", "Send a command followed by Enter to a running REPL."],
    purpose: "Drive an interactive local command session after it has started.",
    sideEffectSummary: "Writes to a running local process through its PTY.",
    whenNotToUse: ["Do not use it for one-shot commands that are already complete.", "Do not use it to terminate a process; use kill_command."],
    whenToUse: ["Use when a running command prompts for input.", "Use when an interactive session needs additional commands."]
  },
  displayName: "Write Stdin",
  idempotent: false,
  inputSchema: writeStdinJsonSchema,
  outputSchema: genericObjectSchema,
  retryable: false,
  searchTags: ["command", "input", "interactive", "stdin", "terminal"],
  sideEffects: ["local_process"],
  usageGuidance:
    "Use this only with a running exec_command session. Set submit to true when the target program expects an Enter key after the text."
});

const waitCommandToolDefinition: ToolDefinition = createCommandDefinition({
  aliases: ["wait_for_command"],
  approvalMode: "never",
  definitionName: "wait_command",
  description: "Wait for a command session to finish, optionally returning early after a timeout if it is still running.",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only observes command-session state.",
    examples: ["Wait for a background dev server build to settle.", "Poll a live command with a short timeout."],
    purpose: "Observe command completion without reissuing the original command.",
    sideEffectSummary: "Reads local command-session state only.",
    whenNotToUse: ["Do not use it to inspect logs; use read_command_output.", "Do not use it to stop a process; use kill_command."],
    whenToUse: ["Use to wait for a command to finish.", "Use a bounded timeout when you only need a quick completion check."]
  },
  displayName: "Wait Command",
  idempotent: false,
  inputSchema: waitCommandJsonSchema,
  outputSchema: genericObjectSchema,
  retryable: true,
  searchTags: ["command", "poll", "process", "status", "wait"],
  sideEffects: ["none"],
  usageGuidance:
    "Use this to wait for a known command session by id. If you need logs while it is still running, pair it with read_command_output."
});

const killCommandToolDefinition: ToolDefinition = createCommandDefinition({
  aliases: ["stop_command"],
  approvalMode: "ask",
  definitionName: "kill_command",
  description: "Send a signal to a running command session and optionally wait for it to exit.",
  descriptor: {
    approvalNotes: "Approval is required because this tool can terminate a local process.",
    examples: ["Stop a runaway dev server.", "Send SIGTERM to a background command and wait for exit."],
    purpose: "Terminate a running local command session when it should no longer continue.",
    sideEffectSummary: "Signals a running local process and may terminate it.",
    whenNotToUse: ["Do not use it for completed sessions.", "Do not use it when the process only needs more input; use write_stdin."],
    whenToUse: ["Use to stop background or interactive processes.", "Use when a running session must be terminated before proceeding."]
  },
  displayName: "Kill Command",
  idempotent: false,
  inputSchema: killCommandJsonSchema,
  outputSchema: genericObjectSchema,
  retryable: false,
  searchTags: ["command", "kill", "process", "signal", "stop"],
  sideEffects: ["local_process"],
  usageGuidance:
    "Use this to stop a running command session by id. Prefer the least-forceful signal that will end the process cleanly."
});

const listCommandSessionsToolDefinition: ToolDefinition = createCommandDefinition({
  aliases: ["list_commands"],
  approvalMode: "never",
  definitionName: "list_command_sessions",
  description: "List recent command sessions, including both still-running sessions and completed persisted runs.",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only reads persisted local command metadata.",
    examples: ["List recent commands to find a session id.", "Inspect which command sessions are still running."],
    purpose: "Discover available command sessions and their current state before reading logs or managing them.",
    sideEffectSummary: "Reads local command-session metadata only.",
    whenNotToUse: ["Do not use it when you already know the exact session id.", "Do not use it to inspect detailed logs; use read_command_output."],
    whenToUse: ["Use to discover session ids.", "Use to see whether prior commands are still running or already completed."]
  },
  displayName: "List Command Sessions",
  idempotent: false,
  inputSchema: listCommandSessionsJsonSchema,
  outputSchema: genericObjectSchema,
  retryable: true,
  searchTags: ["command", "history", "list", "sessions", "terminal"],
  sideEffects: ["none"],
  usageGuidance:
    "Use this to discover live and completed command sessions before reading output, waiting, or killing a specific run."
});

function createCommandDefinition(params: {
  aliases: string[];
  approvalMode: ToolDefinition["approvalMode"];
  definitionName: string;
  description: string;
  descriptor: ToolDefinition["descriptor"];
  displayName: string;
  idempotent: boolean;
  inputSchema: JsonSchemaDocument;
  outputSchema: JsonSchemaDocument;
  retryable: boolean;
  searchTags: string[];
  sideEffects: ToolDefinition["sideEffects"];
  usageGuidance: string;
}): ToolDefinition {
  const readOnly = params.sideEffects.every((effect) => effect === "none");
  return {
    aliases: params.aliases,
    annotations: {
      destructiveHint: params.definitionName === "kill_command",
      idempotentHint: params.idempotent,
      meta: {
        family: "command"
      },
      openWorldHint: false,
      readOnlyHint: readOnly,
      title: params.displayName
    },
    approvalMode: params.approvalMode,
    descriptor: params.descriptor,
    description: params.description,
    displayName: params.displayName,
    execution: {
      inputMode: "json",
      resumable: false,
      taskSupport: "forbidden"
    },
    idempotent: params.idempotent,
    inputSchema: params.inputSchema,
    invocationName: params.definitionName,
    kind: "built_in",
    metadata: {},
    name: params.definitionName,
    outputKind: "json",
    outputSchema: params.outputSchema,
    retryable: params.retryable,
    searchTags: params.searchTags,
    sideEffects: params.sideEffects,
    source: {
      displayName: "Built-in Tools",
      kind: "built_in"
    },
    streamingMode: "none",
    toolId: `tool.command.${params.definitionName}`,
    usageGuidance: params.usageGuidance,
    version: "1.0.0"
  };
}

async function createCommandArtifacts(record: CommandSessionRecord): Promise<ArtifactReference[]> {
  const artifacts: ArtifactReference[] = [];
  artifacts.push(
    await createArtifactReferenceFromFile(record.logPaths.combined, "log", {
      name: `${record.id}-${path.basename(record.logPaths.combined)}`
    })
  );
  if (record.logPaths.stdout) {
    artifacts.push(
      await createArtifactReferenceFromFile(record.logPaths.stdout, "log", {
        name: `${record.id}-${path.basename(record.logPaths.stdout)}`
      })
    );
  }
  if (record.logPaths.stderr) {
    artifacts.push(
      await createArtifactReferenceFromFile(record.logPaths.stderr, "log", {
        name: `${record.id}-${path.basename(record.logPaths.stderr)}`
      })
    );
  }
  return artifacts;
}

function summarizeRecordForJson(record: CommandSessionRecord) {
  return {
    attached: record.attached,
    command: record.command,
    commandLine: record.commandLine,
    cwd: record.cwd,
    endedAt: record.endedAt ?? null,
    exitCode: record.exitCode ?? null,
    kind: record.kind,
    pty: record.pty,
    sessionId: record.id,
    signal: record.signal ?? null,
    startedAt: record.startedAt,
    status: record.status,
    timedOut: record.timedOut ?? false,
    updatedAt: record.updatedAt
  };
}

function summarizeCommandRecord(record: CommandSessionRecord): string {
  if (record.status === "running") {
    return `Running ${record.commandLine} in ${record.cwd} as ${record.id}.`;
  }

  const exitText = typeof record.exitCode === "number" ? `exit code ${record.exitCode}` : "no exit code";
  return `${record.status} ${record.commandLine} in ${record.cwd} as ${record.id} (${exitText}).`;
}

function renderSessionList(sessions: CommandSessionRecord[]): string {
  if (sessions.length === 0) {
    return "No command sessions recorded.";
  }

  return sessions
    .map((record) => {
      const endedAt = record.endedAt ? ` ended ${record.endedAt}` : "";
      return `- ${record.id} | ${record.status} | ${record.commandLine} | ${record.cwd} | started ${record.startedAt}${endedAt}`;
    })
    .join("\n");
}

function truncateForDisplay(content: string, maxChars: number): {
  text: string;
  truncated: boolean;
} {
  if (content.length <= maxChars) {
    return {
      text: content,
      truncated: false
    };
  }

  return {
    text: `${content.slice(0, maxChars)}\n\n[output truncated; use read_command_output for the full log]`,
    truncated: true
  };
}
