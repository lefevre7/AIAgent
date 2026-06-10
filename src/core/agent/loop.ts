import crypto from "node:crypto";

import type {
  ApprovalRequest,
  ApprovalResolution,
  LanguageModelRequest,
  LanguageModelProvider,
  LanguageModelResponse,
  Message,
  SessionRecord,
  SteeringInjection,
  StructuredError,
  TaskStateSnapshot,
  ToolCallRecord,
  ToolDefinition,
  TurnRecord
} from "@/core/contracts";
import type { MemoryContextProvider } from "@/core/memory";
import type { SessionMemoryLifecycle } from "@/core/memory";
import type { TaskStateProvider } from "@/core/plans";
import type { FileSessionStore } from "@/core/sessions";
import { buildPromptPack } from "@/core/prompts";

export type AgentLoopCompletionDecision =
  | {
      accepted: true;
    }
  | {
      accepted: false;
      reasons: string[];
    };

export type AgentLoopRunResult = {
  approvalRequests: ApprovalRequest[];
  messages: Message[];
  session: SessionRecord;
  stopReason: "awaiting_approval" | "completed" | "completion_blocked" | "failed";
  toolCalls: ToolCallRecord[];
  turns: TurnRecord[];
};

export type AgentLoopRunParams = {
  approvalResolutions?: Array<{
    resolution: ApprovalResolution;
    sessionId: string;
  }>;
  availableTools: ToolDefinition[];
  maxTurns?: number;
  session: SessionRecord;
  steeringInjections?: SteeringInjection[];
  taskSummary?: string;
  userMessages?: Message[];
};

export interface AgentLoopModel {
  generate(
    request: Omit<LanguageModelRequest, "modelId" | "provider"> & {
      modelId?: string;
      provider?: LanguageModelProvider;
    }
  ): Promise<LanguageModelResponse>;
}

export interface AgentLoopToolExecutionResult {
  approvalRequest?: ApprovalRequest;
  resultMessage?: Message;
  toolCall: ToolCallRecord;
}

export interface AgentLoopToolExecutor {
  execute(call: ToolCallRecord, context: { session: SessionRecord; turn: TurnRecord }): Promise<AgentLoopToolExecutionResult>;
}

type AgentLoopOptions = {
  completionGate?: (params: {
    latestResponse: LanguageModelResponse;
    session: SessionRecord;
    snapshot: Awaited<ReturnType<FileSessionStore["getSessionSnapshot"]>>;
  }) => Promise<AgentLoopCompletionDecision>;
  model: AgentLoopModel;
  onStatus?: (params: { session: SessionRecord; summary: string }) => Promise<void> | void;
  sessions: FileSessionStore;
  memoryContextProvider?: MemoryContextProvider;
  memoryLifecycle?: SessionMemoryLifecycle;
  taskStateProvider?: TaskStateProvider;
  toolExecutor?: AgentLoopToolExecutor;
  surface?: "channel" | "cli" | "gateway" | "sdk" | "web";
  userHomeDirectory?: string;
};

export class AgentLoop {
  constructor(private readonly options: AgentLoopOptions) {}

  async run(params: AgentLoopRunParams): Promise<AgentLoopRunResult> {
    await this.options.memoryLifecycle?.initializeSessionMemory(params.session);
    const taskState: TaskStateSnapshot | null = this.options.taskStateProvider
      ? await this.options.taskStateProvider.getTaskState(params.session.id)
      : null;
    const memoryContext = this.options.memoryContextProvider
      ? await this.options.memoryContextProvider.getPromptContext(params.session.id)
      : null;
    const maxTurns = params.maxTurns ?? 6;
    const promptPack = await buildPromptPack({
      availableTools: params.availableTools,
      cwd: params.session.cwd,
      memoryContext,
      taskSummary: params.taskSummary ?? params.session.goal,
      taskState,
      userHomeDirectory: this.options.userHomeDirectory
    });

    let session = await this.persistSession(params.session, params.session.status, {
      activeTurnId: params.session.activeTurnId
    });

    const appendedMessages: Message[] = [];
    const appendedToolCalls: ToolCallRecord[] = [];
    const appendedApprovalRequests: ApprovalRequest[] = [];
    const appendedTurns: TurnRecord[] = [];

    for (const item of params.approvalResolutions ?? []) {
      await this.options.sessions.appendApprovalResolution(item.resolution, item.sessionId);
    }

    const pendingApprovals = await this.listSessionPendingApprovals(session.id);
    if (pendingApprovals.length > 0) {
      session = await this.persistSession(session, "awaiting_approval", {
        pendingApprovalIds: pendingApprovals.map((approval) => approval.id),
        statusSummary: `Waiting for ${pendingApprovals.length} approval decision(s).`
      });
      return {
        approvalRequests: appendedApprovalRequests,
        messages: appendedMessages,
        session,
        stopReason: "awaiting_approval",
        toolCalls: appendedToolCalls,
        turns: appendedTurns
      };
    }

    const persistedQueuedSteering = await this.listQueuedSteering(session.id);
    const queuedSteering = mergeSteeringInjections(persistedQueuedSteering, params.steeringInjections ?? []);

    if ((params.userMessages ?? []).length > 0) {
      await this.options.sessions.appendMessages(params.userMessages ?? []);
      appendedMessages.push(...(params.userMessages ?? []));
    }

    const appliedSteering = queuedSteering.map((injection) => ({
      ...injection,
      state: "applied" as const
    }));
    if (appliedSteering.length > 0) {
      await this.options.sessions.appendSteeringInjections(appliedSteering);
    }

    let pendingInputMessages = [
      ...(params.userMessages ?? []),
      ...appliedSteering.map((injection) => createSteeringMessage(session.id, injection))
    ];
    if (pendingInputMessages.length > 0) {
      const steeringMessages = pendingInputMessages.filter((message) => message.source !== "user");
      if (steeringMessages.length > 0) {
        await this.options.sessions.appendMessages(steeringMessages);
        appendedMessages.push(...steeringMessages);
      }
    }

    let nextTrigger: TurnRecord["trigger"] =
      appliedSteering.length > 0 ? "steering" : pendingInputMessages.length > 0 ? "user" : "resume";

    for (let sequence = 0; sequence < maxTurns; sequence += 1) {
      const turnId = `turn.${session.id}.${sequence + 1}.${crypto.randomUUID()}`;
      const startedAt = new Date().toISOString();
      const statusMessage = createStatusMessage(session, turnId, sequence + 1);
      await this.options.sessions.appendMessages([statusMessage]);
      appendedMessages.push(statusMessage);

      const turn = createTurnRecord({
        id: turnId,
        inputMessageIds: [...pendingInputMessages.map((message) => message.id), statusMessage.id],
        sequence,
        sessionId: session.id,
        startedAt,
        trigger: nextTrigger
      });

      session = await this.persistSession(session, "running_model", {
        activeTurnId: turn.id,
        statusSummary: `Running model turn ${sequence + 1}.`
      });

      await this.emitStatus(session, `Running model turn ${sequence + 1}.`);

      const snapshot = await this.options.sessions.getSessionSnapshot(session.id);
      const visibleMessages = (snapshot?.messages ?? []).filter((message) => message.visibility !== "hidden");

      let response: LanguageModelResponse;
      try {
        response = await this.options.model.generate({
          availableTools: params.availableTools,
          id: `lm-request.${turn.id}`,
          instructions: promptPack.systemPrompt,
          messages: visibleMessages,
          metadata: {},
          ...(typeof session.metadata.activeModelId === "string" ? { modelId: session.metadata.activeModelId } : {}),
          ...(typeof session.metadata.activeProvider === "string"
            ? { provider: session.metadata.activeProvider as LanguageModelProvider }
            : {}),
          responseFormat: {
            kind: "text"
          },
          sessionId: session.id,
          settings: {
            stopSequences: [],
            toolChoice: "auto"
          },
          turnId: turn.id
        });
      } catch (error) {
        turn.status = "failed";
        turn.completedAt = new Date().toISOString();
        turn.summary = "The language model request failed.";
        await this.options.sessions.appendTurn(turn);
        appendedTurns.push(turn);
        session = await this.persistFailedSession(session, error);
        return {
          approvalRequests: appendedApprovalRequests,
          messages: appendedMessages,
          session,
          stopReason: "failed",
          toolCalls: appendedToolCalls,
          turns: appendedTurns
        };
      }

      if (response.message) {
        await this.options.sessions.appendMessages([response.message]);
        appendedMessages.push(response.message);
        turn.outputMessageIds.push(response.message.id);
      }

      if (response.toolCalls.length === 0) {
        const continuationMessage = createSystemMessage(
          session.id,
          turn.id,
          promptPack.nudges.taskContinuation,
          "system",
          "hidden"
        );
        await this.options.sessions.appendMessages([continuationMessage]);
        appendedMessages.push(continuationMessage);
        turn.outputMessageIds.push(continuationMessage.id);
        turn.completedAt = new Date().toISOString();
        turn.status = "completed";
        turn.summary = "The runtime nudged the model to continue because it did not use any tools.";
        await this.options.sessions.appendTurn(turn);
        appendedTurns.push(turn);
        pendingInputMessages = [continuationMessage];
        nextTrigger = "system_nudge";
        continue;
      }

      const completionInvocationNames = new Set(
        params.availableTools
          .filter((tool) => tool.toolId === "tool.builtin.attempt_complete" || tool.name === "attempt_complete")
          .map((tool) => tool.invocationName)
      );
      const completionCalls = response.toolCalls.filter((toolCall) => completionInvocationNames.has(toolCall.toolName));
      const nonCompletionCalls = response.toolCalls.filter((toolCall) => !completionInvocationNames.has(toolCall.toolName));

      if (completionCalls.length > 0) {
        if (nonCompletionCalls.length > 0 || completionCalls.length > 1) {
          const invalidCompletionMessage = createSystemMessage(
            session.id,
            turn.id,
            "Do not mix `attempt_complete` with other tool calls. Finish the remaining work, then call `attempt_complete` by itself.",
            "system",
            "hidden"
          );
          await this.options.sessions.appendMessages([invalidCompletionMessage]);
          appendedMessages.push(invalidCompletionMessage);
          turn.outputMessageIds.push(invalidCompletionMessage.id);
          turn.completedAt = new Date().toISOString();
          turn.status = "completed";
          turn.summary = "The runtime rejected a mixed completion/tool turn.";
          await this.options.sessions.appendTurn(turn);
          appendedTurns.push(turn);
          pendingInputMessages = [invalidCompletionMessage];
          nextTrigger = "system_nudge";
          session = await this.persistSession(session, "completion_blocked", {
            statusSummary: "Completion was blocked because `attempt_complete` was mixed with other tool calls."
          });
          continue;
        }

        session = await this.persistSession(session, "attempting_completion", {
          activeTurnId: turn.id,
          statusSummary: "Validating completion."
        });

        const completionDecision = await this.resolveCompletionDecision(session, response);
        if (completionDecision.accepted) {
          turn.completedAt = new Date().toISOString();
          turn.status = "completed";
          turn.summary = "The runtime accepted `attempt_complete`.";
          await this.options.sessions.appendTurn(turn);
          appendedTurns.push(turn);
          session = await this.persistSession(session, "completed", {
            statusSummary: "The task completed successfully."
          });
          await this.options.memoryLifecycle?.compactSession({
            sessionId: session.id,
            trigger: "completion"
          });
          return {
            approvalRequests: appendedApprovalRequests,
            messages: appendedMessages,
            session,
            stopReason: "completed",
            toolCalls: appendedToolCalls,
            turns: appendedTurns
          };
        }

        const rejectionMessage = createSystemMessage(
          session.id,
          turn.id,
          `${promptPack.nudges.completionBlocked}\n\nRejection reasons:\n${completionDecision.reasons
            .map((reason) => `- ${reason}`)
            .join("\n")}`,
          "system",
          "hidden"
        );
        await this.options.sessions.appendMessages([rejectionMessage]);
        appendedMessages.push(rejectionMessage);
        turn.outputMessageIds.push(rejectionMessage.id);
        turn.completedAt = new Date().toISOString();
        turn.status = "completed";
        turn.summary = "The runtime rejected `attempt_complete` and returned structured reasons.";
        await this.options.sessions.appendTurn(turn);
        appendedTurns.push(turn);
        session = await this.persistSession(session, "completion_blocked", {
          statusSummary: "Completion was rejected because required work remains unresolved."
        });
        pendingInputMessages = [rejectionMessage];
        nextTrigger = "system_nudge";
        continue;
      }

      session = await this.persistSession(session, "awaiting_tool_execution", {
        activeTurnId: turn.id,
        statusSummary: `Executing ${nonCompletionCalls.length} tool call(s).`
      });

      const toolOutcomes = [];
      for (const proposal of nonCompletionCalls) {
        const toolDefinition = params.availableTools.find((definition) => definition.invocationName === proposal.toolName);
        const toolCall = createToolCallRecord(session.id, turn.id, proposal, toolDefinition);
        const outcome = await (this.options.toolExecutor ?? defaultToolExecutor()).execute(toolCall, {
          session,
          turn
        });
        toolOutcomes.push(outcome);
        appendedToolCalls.push(outcome.toolCall);
      }

      await this.options.sessions.appendToolCalls(toolOutcomes.map((outcome) => outcome.toolCall));
      turn.requestedToolCallIds = toolOutcomes.map((outcome) => outcome.toolCall.id);
      turn.executedToolCallIds = toolOutcomes.map((outcome) => outcome.toolCall.id);

      const toolResultMessages = toolOutcomes
        .map((outcome) => outcome.resultMessage ?? createToolResultMessage(session.id, turn.id, outcome.toolCall))
        .filter(Boolean);
      if (toolResultMessages.length > 0) {
        await this.options.sessions.appendMessages(toolResultMessages);
        appendedMessages.push(...toolResultMessages);
        turn.outputMessageIds.push(...toolResultMessages.map((message) => message.id));
      }

      const approvalRequests = toolOutcomes
        .map((outcome) => outcome.approvalRequest)
        .filter((request): request is ApprovalRequest => request !== undefined);

      if (approvalRequests.length > 0) {
        for (const request of approvalRequests) {
          await this.options.sessions.appendApprovalRequest(request);
        }
        appendedApprovalRequests.push(...approvalRequests);
        turn.approvalRequestIds = approvalRequests.map((request) => request.id);
        turn.completedAt = new Date().toISOString();
        turn.status = "waiting_for_approval";
        turn.summary = "The runtime paused because tool execution requires approval.";
        await this.options.sessions.appendTurn(turn);
        appendedTurns.push(turn);
        session = await this.persistSession(session, "awaiting_approval", {
          pendingApprovalIds: approvalRequests.map((request) => request.id),
          pendingToolCallIds: toolOutcomes.map((outcome) => outcome.toolCall.id),
          statusSummary: `Waiting for ${approvalRequests.length} approval decision(s).`
        });
        return {
          approvalRequests: appendedApprovalRequests,
          messages: appendedMessages,
          session,
          stopReason: "awaiting_approval",
          toolCalls: appendedToolCalls,
          turns: appendedTurns
        };
      }

      turn.completedAt = new Date().toISOString();
      turn.status = "completed";
      turn.summary = `Executed ${toolOutcomes.length} tool call(s).`;
      await this.options.sessions.appendTurn(turn);
      appendedTurns.push(turn);
      pendingInputMessages = toolResultMessages;
      nextTrigger = "tool_result";
    }

    session = await this.persistSession(session, "completion_blocked", {
      statusSummary: `The runtime reached the turn limit without an accepted completion.`
    });
    return {
      approvalRequests: appendedApprovalRequests,
      messages: appendedMessages,
      session,
      stopReason: "completion_blocked",
      toolCalls: appendedToolCalls,
      turns: appendedTurns
    };
  }

  private async emitStatus(session: SessionRecord, summary: string): Promise<void> {
    await this.options.onStatus?.({
      session,
      summary
    });
  }

  private async listSessionPendingApprovals(sessionId: string): Promise<ApprovalRequest[]> {
    const approvals = await this.options.sessions.readPendingApprovals();
    return Object.values(approvals)
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => entry.request);
  }

  private async listQueuedSteering(sessionId: string): Promise<SteeringInjection[]> {
    const snapshot = await this.options.sessions.getSessionSnapshot(sessionId);
    if (!snapshot) {
      return [];
    }

    const latestById = new Map<string, SteeringInjection>();
    for (const injection of snapshot.steeringInjections) {
      latestById.set(injection.id, injection);
    }

    return Array.from(latestById.values())
      .filter((injection) => injection.state === "queued")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  private async persistFailedSession(session: SessionRecord, error: unknown): Promise<SessionRecord> {
    return this.persistSession(session, "failed", {
      statusSummary: "The language model request failed.",
      structuredError: normalizeUnknownError(error)
    });
  }

  private async persistSession(
    session: SessionRecord,
    status: SessionRecord["status"],
    options: {
      activeTurnId?: string;
      pendingApprovalIds?: string[];
      pendingToolCallIds?: string[];
      statusSummary?: string;
      structuredError?: StructuredError;
    }
  ): Promise<SessionRecord> {
    const updatedSession: SessionRecord = {
      ...session,
      activeTurnId: options.activeTurnId,
      lastActiveAt: new Date().toISOString(),
      lastError: options.structuredError ?? session.lastError,
      status,
      updatedAt: new Date().toISOString()
    };
    await this.options.sessions.saveSession(updatedSession);
    await this.options.sessions.saveResumeMetadata(updatedSession.id, {
      activeTurnId: options.activeTurnId,
      pendingApprovalIds: options.pendingApprovalIds ?? [],
      pendingToolCallIds: options.pendingToolCallIds ?? [],
      statusSummary: options.statusSummary,
      surface: this.options.surface ?? "sdk",
      updatedAt: updatedSession.updatedAt
    });
    return updatedSession;
  }

  private async resolveCompletionDecision(
    session: SessionRecord,
    response: LanguageModelResponse
  ): Promise<AgentLoopCompletionDecision> {
    const snapshot = await this.options.sessions.getSessionSnapshot(session.id);
    if (this.options.completionGate) {
      return this.options.completionGate({
        latestResponse: response,
        session,
        snapshot
      });
    }

    const pendingApprovals = await this.listSessionPendingApprovals(session.id);
    if (pendingApprovals.length > 0) {
      return {
        accepted: false,
        reasons: ["There are still pending approvals."]
      };
    }

    return {
      accepted: true
    };
  }
}

function createStatusMessage(session: SessionRecord, turnId: string, turnNumber: number): Message {
  return {
    createdAt: new Date().toISOString(),
    id: createMessageId("status", turnId),
    metadata: {},
    parts: [
      {
        kind: "status",
        state: session.status,
        summary: `Turn ${turnNumber}: ${session.goal}`
      }
    ],
    role: "status",
    sessionId: session.id,
    source: "system",
    tags: [],
    turnId,
    visibility: "hidden"
  };
}

function createSteeringMessage(sessionId: string, injection: SteeringInjection): Message {
  return {
    createdAt: injection.createdAt,
    id: `message.steering.${injection.id}`,
    metadata: injection.metadata,
    parts: [{ kind: "text", text: injection.message }],
    role: injection.source === "system" ? "system" : "user",
    sessionId,
    source:
      injection.source === "channel"
        ? "channel"
        : injection.source === "user"
          ? "user"
          : injection.source === "system"
            ? "system"
            : "operator",
    tags: ["steering"],
    turnId: injection.turnId,
    visibility: "default"
  };
}

function createSystemMessage(
  sessionId: string,
  turnId: string,
  text: string,
  source: Message["source"],
  visibility: Message["visibility"]
): Message {
  return {
    createdAt: new Date().toISOString(),
    id: createMessageId("system", `${turnId}.${crypto.randomUUID()}`),
    metadata: {},
    parts: [{ kind: "text", text }],
    role: source === "system" ? "system" : "assistant",
    sessionId,
    source,
    tags: [],
    turnId,
    visibility
  };
}

function createMessageId(kind: string, seed?: string): string {
  const digest = crypto
    .createHash("sha1")
    .update(seed ?? crypto.randomUUID())
    .digest("hex")
    .slice(0, 20);
  return `message.${kind}.${digest}`;
}

function mergeSteeringInjections(
  persisted: SteeringInjection[],
  injected: SteeringInjection[]
): SteeringInjection[] {
  const merged = new Map<string, SteeringInjection>();

  for (const item of [...persisted, ...injected]) {
    if (!merged.has(item.id)) {
      merged.set(item.id, item);
    }
  }

  return Array.from(merged.values()).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function createToolCallRecord(
  sessionId: string,
  turnId: string,
  proposal: LanguageModelResponse["toolCalls"][number],
  definition?: ToolDefinition
): ToolCallRecord {
  return {
    arguments: proposal.arguments,
    id: proposal.callId,
    inputText: proposal.inputText,
    metadata: {},
    sessionId,
    startedAt: new Date().toISOString(),
    status: "pending",
    toolId: definition?.toolId ?? proposal.toolId,
    toolName: proposal.toolName,
    turnId
  };
}

function createToolResultMessage(sessionId: string, turnId: string, toolCall: ToolCallRecord): Message {
  return {
    createdAt: new Date().toISOString(),
    id: `message.tool.${toolCall.id}`,
    metadata: {},
    parts: [
      {
        kind: "json",
        value: {
          error: toolCall.error ?? null,
          result: toolCall.result ?? null,
          status: toolCall.status,
          toolName: toolCall.toolName
        }
      }
    ],
    role: "tool",
    sessionId,
    source: "tool_runtime",
    tags: [],
    turnId,
    visibility: "default"
  };
}

function createTurnRecord(params: {
  id: string;
  inputMessageIds: string[];
  sequence: number;
  sessionId: string;
  startedAt: string;
  trigger: TurnRecord["trigger"];
}): TurnRecord {
  return {
    approvalRequestIds: [],
    executedToolCallIds: [],
    id: params.id,
    inputMessageIds: params.inputMessageIds,
    metadata: {},
    outputMessageIds: [],
    requestedToolCallIds: [],
    sequence: params.sequence,
    sessionId: params.sessionId,
    startedAt: params.startedAt,
    status: "running",
    trigger: params.trigger
  };
}

function defaultToolExecutor(): AgentLoopToolExecutor {
  return {
    async execute(call) {
      const failedToolCall: ToolCallRecord = {
        ...call,
        completedAt: new Date().toISOString(),
        error: {
          code: "tool_runtime_unavailable",
          details: {
            toolName: call.toolName
          },
          message: `No tool executor is configured for "${call.toolName}".`,
          retriable: false
        },
        status: "failed"
      };

      return {
        resultMessage: createToolResultMessage(call.sessionId, call.turnId, failedToolCall),
        toolCall: failedToolCall
      };
    }
  };
}

function normalizeUnknownError(error: unknown): StructuredError {
  if (error instanceof Error) {
    return {
      code: "agent_loop_error",
      details: {
        name: error.name
      },
      message: error.message,
      retriable: false
    };
  }

  return {
    code: "agent_loop_error",
    details: {},
    message: String(error),
    retriable: false
  };
}
