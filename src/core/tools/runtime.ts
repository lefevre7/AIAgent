import crypto from "node:crypto";

import { toJsonRecord, toJsonValue } from "@/core/contracts";
import type {
  ApprovalRequest,
  ApprovalTargetKind,
  JsonValue,
  MessagePart,
  Message,
  SessionRecord,
  StructuredError,
  ToolCallRecord,
  ToolDefinition,
  ToolResultEnvelope,
  TurnRecord
} from "@/core/contracts";
import type { AgentLoopToolExecutionResult, AgentLoopToolExecutor } from "@/core/agent";
import type { ExecutableToolRegistry } from "@/core/tools/registry";

export type RuntimeToolContext = {
  registry: ExecutableToolRegistry;
  runtime: ToolRuntime;
  session: SessionRecord;
  turn: TurnRecord;
};

export type RuntimeToolResult = Partial<ToolResultEnvelope> & {
  /**
   * Result keys whose content is already rendered verbatim in a display part.
   *
   * The transcript always carries the tool's `result` so a tool cannot hide its
   * own output behind a friendly status line, but a tool that already prints a
   * large blob as readable text should not pay for it twice in the context
   * window. Keys listed here are dropped from the model-facing JSON part only;
   * the persisted `toolCall.result` keeps them.
   */
  displayedResultKeys?: string[];
  result?: JsonValue;
};

export interface RuntimeTool {
  readonly definition: ToolDefinition;

  execute(call: ToolCallRecord, context: RuntimeToolContext): Promise<RuntimeToolResult>;
}

export type ToolApprovalDecision =
  | {
      mode: "execute";
    }
  | {
      error: StructuredError;
      metadata?: Record<string, JsonValue>;
      mode: "deny";
    }
  | {
      mode: "request";
      request: ApprovalRequest;
    };

export type ToolApprovalDeciderParams = {
  call: ToolCallRecord;
  definition: ToolDefinition;
  session: SessionRecord;
  turn: TurnRecord;
};

export type ToolApprovalDecider = (params: ToolApprovalDeciderParams) => Promise<ToolApprovalDecision>;

type ToolRuntimeOptions = {
  approvalDecider?: ToolApprovalDecider;
  registry: ExecutableToolRegistry;
};

export class ToolRuntime implements AgentLoopToolExecutor {
  constructor(private readonly options: ToolRuntimeOptions) {}

  getDefinition(toolName: string): ToolDefinition | null {
    return this.options.registry.getDefinition(toolName);
  }

  listDefinitions(): ToolDefinition[] {
    return this.options.registry.listDefinitions();
  }

  searchDefinitions(query: Parameters<ExecutableToolRegistry["searchDefinitions"]>[0]) {
    return this.options.registry.searchDefinitions(query);
  }

  async execute(
    call: ToolCallRecord,
    context: { session: SessionRecord; turn: TurnRecord }
  ): Promise<AgentLoopToolExecutionResult> {
    return this.executeInternal(call, context);
  }

  async executeApproved(
    call: ToolCallRecord,
    context: { session: SessionRecord; turn: TurnRecord }
  ): Promise<AgentLoopToolExecutionResult> {
    return this.executeInternal(call, context, {
      skipApproval: true
    });
  }

  private async executeInternal(
    call: ToolCallRecord,
    context: { session: SessionRecord; turn: TurnRecord },
    options: {
      skipApproval?: boolean;
    } = {}
  ): Promise<AgentLoopToolExecutionResult> {
    const tool = this.options.registry.getTool(call.toolName);
    if (!tool) {
      const failedCall = this.completeFailure(call, {
        code: "tool_not_found",
        details: {
          toolName: call.toolName
        },
        message: `No tool named "${call.toolName}" is registered. Use the exact invocation name of an available tool, or call tool_search to discover the right tool.`,
        retriable: false
      });

      return {
        resultMessage: createToolResultMessage(call.sessionId, call.turnId, failedCall),
        toolCall: failedCall
      };
    }

    const approvalDecision = options.skipApproval
      ? {
          mode: "execute" as const
        }
      : await (this.options.approvalDecider ?? defaultApprovalDecider)({
          call,
          definition: tool.definition,
          session: context.session,
          turn: context.turn
        });

    if (approvalDecision.mode === "deny") {
      const deniedCall = this.completeFailure(call, approvalDecision.error, approvalDecision.metadata);
      return {
        resultMessage: createToolResultMessage(call.sessionId, call.turnId, deniedCall),
        toolCall: deniedCall
      };
    }

    if (approvalDecision.mode === "request") {
      const awaitingApprovalCall: ToolCallRecord = {
        ...call,
        approvalRequestId: approvalDecision.request.id,
        completedAt: new Date().toISOString(),
        metadata: {
          ...call.metadata,
          toolId: tool.definition.toolId,
          approvalMode: tool.definition.approvalMode
        },
        status: "awaiting_approval"
      };

      return {
        approvalRequest: approvalDecision.request,
        toolCall: awaitingApprovalCall
      };
    }

    try {
      const result = await tool.execute(call, {
        registry: this.options.registry,
        runtime: this,
        session: context.session,
        turn: context.turn
      });
      // Tool results are arbitrary values from arbitrary tools (MCP servers
      // included), and anything with a key set to an explicit `undefined`
      // fails the strict JsonValue contract the moment the record is put on
      // an event. Normalize once here, at the single boundary every tool
      // result crosses, instead of trusting each tool to be careful.
      const completedCall: ToolCallRecord = {
        ...call,
        completedAt: new Date().toISOString(),
        metadata: toJsonRecord({
          ...call.metadata,
          ...(result.metadata ?? {}),
          citations: result.citations ?? [],
          progress: result.progress ?? [],
          toolId: tool.definition.toolId
        }),
        result: toJsonValue(result.result),
        status: "succeeded"
      };

      return {
        resultMessage: createToolResultMessage(call.sessionId, call.turnId, completedCall, result),
        toolCall: completedCall
      };
    } catch (error) {
      const failedCall = this.completeFailure(call, normalizeRuntimeError(error));
      return {
        resultMessage: createToolResultMessage(call.sessionId, call.turnId, failedCall),
        toolCall: failedCall
      };
    }
  }

  private completeFailure(
    call: ToolCallRecord,
    error: StructuredError,
    metadata?: Record<string, JsonValue>
  ): ToolCallRecord {
    return {
      ...call,
      completedAt: new Date().toISOString(),
      error,
      metadata: toJsonRecord({
        ...call.metadata,
        ...(metadata ?? {})
      }),
      status: "failed"
    };
  }
}

export function createToolResultMessage(
  sessionId: string,
  turnId: string,
  toolCall: ToolCallRecord,
  result?: RuntimeToolResult
): Message {
  const parts = buildToolResultMessageParts(toolCall, result);

  return {
    createdAt: new Date().toISOString(),
    id: `message.tool.${toolCall.id}`,
    metadata: {
      toolCallId: toolCall.id
    },
    parts,
    role: "tool",
    sessionId,
    source: "tool_runtime",
    tags: [],
    turnId,
    visibility: "default"
  };
}

async function defaultApprovalDecider(params: ToolApprovalDeciderParams): Promise<ToolApprovalDecision> {
  if (params.definition.approvalMode === "never") {
    return {
      mode: "execute"
    };
  }

  const request: ApprovalRequest = {
    createdAt: new Date().toISOString(),
    id: `approval.${params.call.id}.${crypto.randomUUID()}`,
    justification: `The tool "${params.definition.name}" requires approval before it can run.`,
    metadata: {
      approvalMode: params.definition.approvalMode,
      toolKind: params.definition.kind
    },
    riskSummary: buildRiskSummary(params.definition),
    sessionId: params.session.id,
    status: "pending",
    target: {
      kind: resolveApprovalTargetKind(params.definition),
      label: params.definition.displayName,
      value: params.definition.name
    },
    toolCallId: params.call.id,
    turnId: params.turn.id
  };

  return {
    mode: "request",
    request
  };
}

function buildRiskSummary(definition: ToolDefinition): string {
  if (definition.annotations.destructiveHint) {
    return "This tool is marked as potentially destructive.";
  }
  if (definition.annotations.openWorldHint) {
    return "This tool can interact with external systems beyond the local workspace.";
  }
  if (definition.annotations.readOnlyHint) {
    return "This tool is marked read-only, but approval is still required by policy.";
  }
  if (definition.sideEffects.includes("workspace_write")) {
    return "This tool can modify workspace files.";
  }
  if (definition.sideEffects.includes("local_process")) {
    return "This tool can run or affect local processes.";
  }
  if (definition.sideEffects.includes("network_write") || definition.sideEffects.includes("remote_mutation")) {
    return "This tool can make remote or networked changes.";
  }
  if (definition.sideEffects.includes("channel_io")) {
    return "This tool can send or relay messages externally.";
  }

  return `This tool requires approval because its approval mode is "${definition.approvalMode}".`;
}

function resolveApprovalTargetKind(definition: ToolDefinition): ApprovalTargetKind {
  switch (definition.kind) {
    case "browser":
      return "browser_action";
    case "external_agent":
      return "external_agent";
    case "voice":
      return definition.annotations.meta.voiceAction === true ? "voice_action" : "tool";
    case "mcp":
      return "mcp_tool";
    default:
      return "tool";
  }
}

function normalizeRuntimeError(error: unknown): StructuredError {
  if (isStructuredError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return {
      code: "tool_runtime_error",
      details: {
        name: error.name
      },
      message: error.message,
      retriable: false
    };
  }

  return {
    code: "tool_runtime_error",
    details: {},
    message: String(error),
    retriable: false
  };
}

function buildToolResultMessageParts(toolCall: ToolCallRecord, result?: RuntimeToolResult): MessagePart[] {
  const displayParts = (result?.display ?? []).map((part) => {
    switch (part.kind) {
      case "json":
        return { kind: "json", value: part.value } as const;
      case "markdown":
        return { kind: "markdown", markdown: part.markdown } as const;
      case "status":
        return { kind: "status", state: part.state, summary: part.summary } as const;
      case "text":
        return { kind: "text", text: part.text } as const;
    }
  });

  const artifactParts = (result?.artifacts ?? []).map((artifact) =>
    artifact.kind === "image"
      ? ({
          alt: artifact.name,
          artifact,
          kind: "image",
          uri: artifact.uri
        } as const)
      : artifact.kind === "audio"
        ? ({
            artifact,
            durationMs:
              typeof artifact.metadata.durationMs === "number" && Number.isFinite(artifact.metadata.durationMs)
                ? Math.trunc(artifact.metadata.durationMs)
                : undefined,
            kind: "audio",
            title: artifact.name,
            transcript: typeof artifact.metadata.transcript === "string" ? artifact.metadata.transcript : undefined,
            uri: artifact.uri,
            voice: typeof artifact.metadata.voice === "string" ? artifact.metadata.voice : undefined,
            waveform: Array.isArray(artifact.metadata.waveform)
              ? artifact.metadata.waveform.filter(
                  (value): value is number => typeof value === "number" && value >= 0 && value <= 1
                )
              : undefined
          } as const)
        : ({
            artifact,
            kind: "file",
            title: artifact.name,
            uri: artifact.uri
          } as const)
  );

  const citationParts = (result?.citations ?? []).map(
    (citation) =>
      ({
        kind: "citation",
        locator: citation.locator,
        title: citation.title,
        uri: citation.uri
      }) as const
  );

  const parts = [...displayParts, ...artifactParts, ...citationParts];

  // A plain string result with no display of its own is already fully visible,
  // and reading it as raw text beats reading it as an escaped JSON string.
  if (displayParts.length === 0 && !toolCall.error && typeof toolCall.result === "string") {
    return [{ kind: "text", text: toolCall.result }, ...artifactParts, ...citationParts];
  }

  const modelResult = omitDisplayedResultKeys(toolCall.result, result?.displayedResultKeys ?? []);
  const hasResult = modelResult !== undefined && modelResult !== null;
  if (!hasResult && !toolCall.error && parts.length > 0) {
    return parts;
  }

  // Invariant: the model always sees the tool's actual `result`. Display parts
  // used to suppress it entirely, so a tool that added a friendly status line
  // silently starved the model of its own output.
  return [
    ...parts,
    {
      kind: "json",
      value: {
        ...(toolCall.error ? { error: toolCall.error } : {}),
        ...(hasResult ? { result: modelResult } : {}),
        status: toolCall.status,
        toolName: toolCall.toolName
      }
    }
  ];
}

function omitDisplayedResultKeys(result: JsonValue | undefined, displayedKeys: string[]): JsonValue | undefined {
  if (displayedKeys.length === 0 || typeof result !== "object" || result === null || Array.isArray(result)) {
    return result;
  }

  const omitted = new Set(displayedKeys);
  const next = Object.fromEntries(Object.entries(result).filter(([key]) => !omitted.has(key)));

  return Object.keys(next).length > 0 ? next : undefined;
}

function isStructuredError(error: unknown): error is StructuredError {
  return typeof error === "object" && error !== null && "code" in error && "message" in error && "retriable" in error;
}
