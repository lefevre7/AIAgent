import crypto from "node:crypto";

import type {
  ApprovalRequest,
  ApprovalResolution,
  LanguageModelRequest,
  LanguageModelProvider,
  LanguageModelResponse,
  LanguageModelStreamEvent,
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
  maxConsecutiveNudges?: number;
  maxTurns?: number | "unlimited";
  session: SessionRecord;
  steeringInjections?: SteeringInjection[];
  taskSummary?: string;
  userMessages?: Message[];
};

type AgentLoopModelRequest = Omit<LanguageModelRequest, "modelId" | "provider"> & {
  modelId?: string;
  provider?: LanguageModelProvider;
};

export interface AgentLoopModel {
  generate(request: AgentLoopModelRequest): Promise<LanguageModelResponse>;
  stream?(
    request: AgentLoopModelRequest,
    onEvent: (event: LanguageModelStreamEvent) => void
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
  autoCompactThresholdTokens?: number;
  completionGate?: (params: {
    latestResponse: LanguageModelResponse;
    session: SessionRecord;
    snapshot: Awaited<ReturnType<FileSessionStore["getSessionSnapshot"]>>;
  }) => Promise<AgentLoopCompletionDecision>;
  contextWindowTokens?: number;
  model: AgentLoopModel;
  modelSettings?: {
    maxOutputTokens?: number;
    temperature?: number;
    topP?: number;
  };
  onAssistantDelta?: (params: { delta: string; sessionId: string; turnId: string }) => void;
  onAssistantReasoning?: (params: { delta: string; sessionId: string; turnId: string }) => void;
  onStatus?: (params: { session: SessionRecord; summary: string }) => Promise<void> | void;
  promptBudgets?: {
    instructionDocChars?: number;
    memorySummaryChars?: number;
  };
  sessions: FileSessionStore;
  memoryContextProvider?: MemoryContextProvider;
  memoryLifecycle?: SessionMemoryLifecycle;
  taskStateProvider?: TaskStateProvider;
  toolCatalog?: {
    getDefinition(toolName: string): ToolDefinition | null;
  };
  toolExecutor?: AgentLoopToolExecutor;
  surface?: "channel" | "cli" | "gateway" | "sdk" | "web";
  userHomeDirectory?: string;
};

const DEFAULT_AUTO_COMPACT_THRESHOLD_TOKENS = 100_000;
const AUTO_COMPACT_CONTEXT_WINDOW_FRACTION = 0.8;
const DEFAULT_MAX_CONSECUTIVE_NUDGES = 3;
const ACTIVATED_TOOLS_METADATA_KEY = "activatedToolNames";
const COMPACTION_WATERMARK_METADATA_KEY = "compactedThroughMessageId";

export class AgentLoop {
  constructor(private readonly options: AgentLoopOptions) {}

  async run(params: AgentLoopRunParams): Promise<AgentLoopRunResult> {
    await this.options.memoryLifecycle?.initializeSessionMemory(params.session);
    const taskState: TaskStateSnapshot | null = this.options.taskStateProvider
      ? await this.options.taskStateProvider.getTaskState(params.session.id)
      : null;
    const maxTurns = params.maxTurns ?? "unlimited";
    const maxConsecutiveNudges = params.maxConsecutiveNudges ?? DEFAULT_MAX_CONSECUTIVE_NUDGES;
    // Rebuilt after threshold compaction so the refreshed session summary
    // reaches the Durable Memory section of the system prompt.
    const buildPack = async (forSession: SessionRecord) =>
      buildPromptPack({
        availableTools: this.resolveEffectiveTools(params.availableTools, forSession),
        cwd: forSession.cwd,
        instructionDocCharBudget: this.options.promptBudgets?.instructionDocChars,
        memoryContext: this.options.memoryContextProvider
          ? await this.options.memoryContextProvider.getPromptContext(forSession.id)
          : null,
        memorySummaryCharBudget: this.options.promptBudgets?.memorySummaryChars,
        taskSummary: params.taskSummary ?? forSession.goal,
        taskState,
        userHomeDirectory: this.options.userHomeDirectory
      });
    let promptPack = await buildPack(params.session);

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

    let consecutiveNudges = 0;
    for (let sequence = 0; maxTurns === "unlimited" || sequence < maxTurns; sequence += 1) {
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
      const visibleMessages = filterModelVisibleMessages(snapshot?.messages ?? [], session);
      const effectiveTools = this.resolveEffectiveTools(params.availableTools, session);

      const modelRequest = {
        availableTools: effectiveTools,
        id: `lm-request.${turn.id}`,
        instructions: promptPack.systemPrompt,
        messages: visibleMessages,
        metadata: {},
        ...(typeof session.metadata.activeModelId === "string" ? { modelId: session.metadata.activeModelId } : {}),
        ...(typeof session.metadata.activeProvider === "string"
          ? { provider: session.metadata.activeProvider as LanguageModelProvider }
          : {}),
        responseFormat: {
          kind: "text" as const
        },
        sessionId: session.id,
        settings: {
          ...(this.options.modelSettings?.maxOutputTokens !== undefined
            ? { maxOutputTokens: this.options.modelSettings.maxOutputTokens }
            : {}),
          stopSequences: [],
          ...(this.options.modelSettings?.temperature !== undefined
            ? { temperature: this.options.modelSettings.temperature }
            : {}),
          toolChoice: "auto" as const,
          ...(this.options.modelSettings?.topP !== undefined ? { topP: this.options.modelSettings.topP } : {})
        },
        turnId: turn.id
      };

      let response: LanguageModelResponse;
      try {
        const onAssistantDelta = this.options.onAssistantDelta;
        const onAssistantReasoning = this.options.onAssistantReasoning;
        if (this.options.model.stream && (onAssistantDelta || onAssistantReasoning)) {
          response = await this.options.model.stream(modelRequest, (event) => {
            if (event.kind === "response.delta") {
              onAssistantDelta?.({ delta: event.delta, sessionId: session.id, turnId: turn.id });
            } else if (event.kind === "response.reasoning") {
              onAssistantReasoning?.({ delta: event.delta, sessionId: session.id, turnId: turn.id });
            }
          });
        } else {
          response = await this.options.model.generate(modelRequest);
        }
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

      const assistantMessage = buildAssistantTurnMessage(session.id, turn.id, response);
      if (assistantMessage) {
        await this.options.sessions.appendMessages([assistantMessage]);
        appendedMessages.push(assistantMessage);
        turn.outputMessageIds.push(assistantMessage.id);
      }

      // Turns that make no tool progress (no-tool replies and mixed/rejected
      // completion attempts) count toward the nudge guard; with unlimited
      // turns this is what stops a model that loops without progressing. The
      // guard fires only after the unproductive outcome is known, so a valid
      // completion attempt is always evaluated first.
      const failNoProgressGuard = async (summary: string, statusSummary: string): Promise<AgentLoopRunResult> => {
        turn.completedAt = new Date().toISOString();
        turn.status = "completed";
        turn.summary = summary;
        await this.options.sessions.appendTurn(turn);
        appendedTurns.push(turn);
        session = await this.persistSession(session, "completion_blocked", {
          statusSummary
        });
        return {
          approvalRequests: appendedApprovalRequests,
          messages: appendedMessages,
          session,
          stopReason: "completion_blocked",
          toolCalls: appendedToolCalls,
          turns: appendedTurns
        };
      };

      if (response.toolCalls.length === 0) {
        consecutiveNudges += 1;
        if (consecutiveNudges > maxConsecutiveNudges) {
          return failNoProgressGuard(
            "The runtime stopped after repeated turns without tool use or completion.",
            `The model produced ${consecutiveNudges} consecutive turns without tool use or an accepted completion.`
          );
        }

        const rejectedToolCalls = describeRejectedToolCalls(response);
        const continuationMessage = createSystemMessage(
          session.id,
          turn.id,
          rejectedToolCalls.length > 0
            ? `${promptPack.nudges.taskContinuation}\n\nYour previous tool call(s) could not be parsed and were ignored:\n${rejectedToolCalls
                .map((reason) => `- ${reason}`)
                .join("\n")}\nRe-issue each tool call with the exact tool name and valid JSON arguments.`
            : promptPack.nudges.taskContinuation,
          "system",
          "compact"
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
          consecutiveNudges += 1;
          if (consecutiveNudges > maxConsecutiveNudges) {
            return failNoProgressGuard(
              "The runtime stopped after repeated turns without progress.",
              `The model produced ${consecutiveNudges} consecutive unproductive turns.`
            );
          }
          const invalidCompletionMessage = createSystemMessage(
            session.id,
            turn.id,
            "Do not mix `attempt_complete` with other tool calls. Finish the remaining work, then call `attempt_complete` by itself.",
            "system",
            "compact"
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

        consecutiveNudges += 1;
        if (consecutiveNudges > maxConsecutiveNudges) {
          return failNoProgressGuard(
            "The runtime stopped after repeated rejected completion attempts.",
            `The model produced ${consecutiveNudges} consecutive unproductive turns.`
          );
        }

        const rejectionMessage = createSystemMessage(
          session.id,
          turn.id,
          `${promptPack.nudges.completionBlocked}\n\nRejection reasons:\n${completionDecision.reasons
            .map((reason) => `- ${reason}`)
            .join("\n")}`,
          "system",
          "compact"
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

      consecutiveNudges = 0;
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

      session = this.mergeActivatedTools(session, toolOutcomes);

      const compacted = await this.compactIfOverThreshold({
        response,
        session,
        watermarkMessageId: statusMessage.id
      });
      if (compacted) {
        session = compacted;
        session = await this.persistSession(session, "awaiting_tool_execution", {
          activeTurnId: turn.id,
          statusSummary: "Compacted session context after crossing the token threshold."
        });
        promptPack = await buildPack(session);
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

  private resolveEffectiveTools(baseTools: ToolDefinition[], session: SessionRecord): ToolDefinition[] {
    const catalog = this.options.toolCatalog;
    if (!catalog) {
      return baseTools;
    }

    const activatedNames = readActivatedToolNames(session);
    if (activatedNames.length === 0) {
      return baseTools;
    }

    const known = new Set(baseTools.map((tool) => tool.invocationName));
    const effective = [...baseTools];
    for (const name of activatedNames) {
      if (known.has(name)) {
        continue;
      }
      const definition = catalog.getDefinition(name);
      if (definition) {
        known.add(definition.invocationName);
        effective.push(definition);
      }
    }
    return effective;
  }

  private mergeActivatedTools(session: SessionRecord, outcomes: AgentLoopToolExecutionResult[]): SessionRecord {
    if (!this.options.toolCatalog) {
      return session;
    }

    const discovered: string[] = [];
    for (const outcome of outcomes) {
      if (outcome.toolCall.status !== "succeeded") {
        continue;
      }
      const definition = this.options.toolCatalog.getDefinition(outcome.toolCall.toolName);
      if (!definition || definition.name !== "tool_search") {
        continue;
      }
      const result = outcome.toolCall.result;
      if (typeof result !== "object" || result === null || Array.isArray(result)) {
        continue;
      }
      const matches = (result as { matches?: unknown }).matches;
      if (!Array.isArray(matches)) {
        continue;
      }
      for (const match of matches) {
        if (typeof match === "object" && match !== null && !Array.isArray(match)) {
          const invocationName = (match as { invocationName?: unknown }).invocationName;
          if (typeof invocationName === "string" && invocationName.length > 0) {
            discovered.push(invocationName);
          }
        }
      }
    }

    if (discovered.length === 0) {
      return session;
    }

    const merged = Array.from(new Set([...readActivatedToolNames(session), ...discovered])).slice(0, 64);
    return {
      ...session,
      metadata: {
        ...session.metadata,
        [ACTIVATED_TOOLS_METADATA_KEY]: merged
      }
    };
  }

  private async compactIfOverThreshold(params: {
    response: LanguageModelResponse;
    session: SessionRecord;
    watermarkMessageId: string;
  }): Promise<SessionRecord | null> {
    if (!this.options.memoryLifecycle) {
      return null;
    }

    const threshold =
      this.options.autoCompactThresholdTokens ??
      (this.options.contextWindowTokens
        ? Math.floor(this.options.contextWindowTokens * AUTO_COMPACT_CONTEXT_WINDOW_FRACTION)
        : DEFAULT_AUTO_COMPACT_THRESHOLD_TOKENS);
    if (threshold <= 0) {
      return null;
    }

    const usedTokens = params.response.usage.inputTokens;
    if (usedTokens < threshold) {
      return null;
    }

    await this.options.memoryLifecycle.compactSession({
      sessionId: params.session.id,
      sourceTokenCount: usedTokens,
      trigger: "threshold"
    });

    return {
      ...params.session,
      metadata: {
        ...params.session.metadata,
        [COMPACTION_WATERMARK_METADATA_KEY]: params.watermarkMessageId
      }
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

function readActivatedToolNames(session: SessionRecord): string[] {
  const raw = session.metadata[ACTIVATED_TOOLS_METADATA_KEY];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

export function filterModelVisibleMessages(messages: Message[], session: SessionRecord): Message[] {
  const watermarkId = session.metadata[COMPACTION_WATERMARK_METADATA_KEY];
  let scoped = messages;
  if (typeof watermarkId === "string" && watermarkId.length > 0) {
    const index = messages.findIndex((message) => message.id === watermarkId);
    if (index >= 0) {
      scoped = messages.slice(index + 1);
    }
  }
  return scoped.filter((message) => message.visibility !== "hidden");
}

function buildAssistantTurnMessage(sessionId: string, turnId: string, response: LanguageModelResponse): Message | null {
  const textParts = response.message?.parts.filter((part) => part.kind !== "tool_call") ?? [];
  const toolCallParts = response.toolCalls.map((toolCall) => ({
    arguments: toolCall.arguments,
    callId: toolCall.callId,
    inputText: toolCall.inputText,
    kind: "tool_call" as const,
    toolName: toolCall.toolName
  }));

  if (textParts.length === 0 && toolCallParts.length === 0) {
    return null;
  }

  return {
    createdAt: new Date().toISOString(),
    id: response.message?.id ?? `message.assistant.${response.id}`,
    metadata: response.message?.metadata ?? {},
    parts: [...textParts, ...toolCallParts],
    role: "assistant",
    sessionId,
    source: "assistant",
    tags: response.message?.tags ?? [],
    turnId,
    visibility: response.message?.visibility ?? "default"
  };
}

function describeRejectedToolCalls(response: LanguageModelResponse): string[] {
  const raw = response.metadata.rejectedToolCalls;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry) => {
    if (typeof entry === "string") {
      return [entry];
    }
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const reason = (entry as { reason?: unknown }).reason;
      if (typeof reason === "string" && reason.length > 0) {
        return [reason];
      }
    }
    return [];
  });
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
    metadata: {
      toolCallId: toolCall.id
    },
    parts: [
      {
        kind: "json",
        value: {
          ...(toolCall.error ? { error: toolCall.error } : {}),
          ...(toolCall.result !== undefined && toolCall.result !== null ? { result: toolCall.result } : {}),
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
