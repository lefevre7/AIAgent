import crypto from "node:crypto";

import type {
  ApprovalRequest,
  ApprovalResolution,
  JsonValue,
  LanguageModelCallOptions,
  LanguageModelRequest,
  LanguageModelProvider,
  LanguageModelResponse,
  LanguageModelStreamEvent,
  Message,
  MessagePart,
  ModelToolCallProposal,
  SessionRecord,
  SteeringInjection,
  StructuredError,
  TaskStateSnapshot,
  ToolCallRecord,
  ToolDefinition,
  TurnRecord
} from "@/core/contracts";
import {
  ACTIVATES_TOOLS_METADATA_KEY,
  CHANNEL_OPERATOR_METADATA_KEY,
  COMPLETION_SUMMARY_MESSAGE_TAG,
  CONTEXT_WINDOW_EXCEEDED_ERROR_CODE,
  extractStructuredError,
  taskStateSnapshotSchema
} from "@/core/contracts";
import type { MemoryContextProvider } from "@/core/memory";
import type { SessionMemoryLifecycle } from "@/core/memory";
import type { TaskStateProvider } from "@/core/plans";
import type { FileSessionStore } from "@/core/sessions";
import { buildPromptPack } from "@/core/prompts";
import {
  createSkillProvider,
  loadSkillContent,
  narrowSkillToolDefinition,
  readSkillActivations,
  recordSkillLoads,
  resolveSkillMentions,
  selectModelVisibleSkills,
  SKILL_NAME_METADATA_KEY,
  SKILL_TOOL_NAME,
  withSkillActivations,
  type SkillDiscovery,
  type SkillProvider,
  type SkillRecord
} from "@/core/skills";

export type AgentLoopStatusMetrics = {
  contextWindowPercentage?: number;
  elapsedSeconds: number;
  tokensUsed?: number;
};

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
  stopReason: "awaiting_approval" | "cancelled" | "completed" | "completion_blocked" | "failed";
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
  maxIdenticalToolCalls?: number;
  maxTurns?: number | "unlimited";
  reasoningContextTurns?: number;
  session: SessionRecord;
  // Aborting it cancels the run: the in-flight model request is aborted and no
  // further tool call or turn starts.
  signal?: AbortSignal;
  steeringInjections?: SteeringInjection[];
  taskSummary?: string;
  userMessages?: Message[];
};

type AgentLoopModelRequest = Omit<LanguageModelRequest, "modelId" | "provider"> & {
  modelId?: string;
  provider?: LanguageModelProvider;
};

export interface AgentLoopModel {
  generate(request: AgentLoopModelRequest, options?: LanguageModelCallOptions): Promise<LanguageModelResponse>;
  stream?(
    request: AgentLoopModelRequest,
    onEvent: (event: LanguageModelStreamEvent) => void,
    options?: LanguageModelCallOptions
  ): Promise<LanguageModelResponse>;
}

export interface AgentLoopToolExecutionResult {
  approvalRequest?: ApprovalRequest;
  resultMessage?: Message;
  toolCall: ToolCallRecord;
}

export interface AgentLoopToolExecutor {
  execute(
    call: ToolCallRecord,
    context: {
      /** The tools the model can call this turn (its profile's, plus any tool_search activated). */
      callableToolNames?: ReadonlySet<string>;
      session: SessionRecord;
      /** The skills found for this run, which the `skill` tool loads from. */
      skills?: SkillDiscovery;
      turn: TurnRecord;
    }
  ): Promise<AgentLoopToolExecutionResult>;
}

type AgentLoopOptions = {
  autoCompactThresholdTokens?: number;
  completionGate?: (params: {
    latestResponse: LanguageModelResponse;
    session: SessionRecord;
    snapshot: Awaited<ReturnType<FileSessionStore["getSessionSnapshot"]>>;
  }) => Promise<AgentLoopCompletionDecision>;
  // A number, or a getter so the host can resolve it lazily (e.g. after querying
  // the provider for the model's context window).
  contextWindowTokens?: number | (() => number | undefined);
  /**
   * Told what a provider's "prompt too long" refusal said, before the loop
   * compacts and retries: the window it names (llama.cpp's n_ctx) is the one
   * requests really get, so the host can use it from then on.
   */
  onContextWindowExceeded?: (details: { contextWindowTokens?: number; promptTokens?: number }) => void;
  model: AgentLoopModel;
  modelSettings?: {
    frequencyPenalty?: number;
    maxOutputTokens?: number;
    minP?: number;
    presencePenalty?: number;
    repetitionPenalty?: number;
    supportsVision?: boolean;
    temperature?: number;
    topK?: number;
    topP?: number;
  };
  onAssistantDelta?: (params: { delta: string; sessionId: string; turnId: string }) => void;
  onAssistantReasoning?: (params: { delta: string; sessionId: string; turnId: string }) => void;
  onStatus?: (params: {
    session: SessionRecord;
    summary: string;
    metrics?: AgentLoopStatusMetrics;
  }) => Promise<void> | void;
  // Called as each tool call settles, so a surface can show tool activity while
  // the run is still going instead of receiving it all after the run ends. The
  // host is expected to swallow its own failures: progress reporting must never
  // be able to abort the run it is reporting on.
  onToolUpdated?: (params: { sessionId: string; toolCall: ToolCallRecord }) => Promise<void> | void;
  promptBudgets?: {
    activeSkillsChars?: number;
    instructionDocChars?: number;
    memorySummaryChars?: number;
  };
  sessions: FileSessionStore;
  // Where the run's skills come from. Defaults to the standard roots (project,
  // `~/.aia/skills`, `~/.agents/skills`, bundled) with default settings.
  skills?: SkillProvider;
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
// Used for the context-window % metric when no window is configured and the
// provider could not report one.
const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_768;
const AUTO_COMPACT_CONTEXT_WINDOW_FRACTION = 0.8;
const DEFAULT_MAX_CONSECUTIVE_NUDGES = 3;
const DEFAULT_MAX_IDENTICAL_TOOL_CALLS = 3;
// How many of the most recent turns keep their reasoning in the model request.
// 1 = the current turn only, so reasoning survives across this turn's tool
// results but older deliberation stops consuming the context window.
const DEFAULT_REASONING_CONTEXT_TURNS = 1;
const ACTIVATED_TOOLS_METADATA_KEY = "activatedToolNames";
// Session metadata key holding the id of the last message that has been folded
// into the compacted summary. Messages up to and including it are no longer
// replayed to the model, except the operator's own (see
// filterModelVisibleMessages and retainConversationInput). Exported so a manual
// compaction (gateway `session.compact`, CLI `/compact`) sets the same key.
export const COMPACTION_WATERMARK_METADATA_KEY = "compactedThroughMessageId";
// How much of what the conversation's people said survives a compaction, in
// characters: Codex's budget for the user messages it keeps
// (COMPACT_USER_MESSAGE_MAX_TOKENS, 20k tokens) at ~4 characters per token.
const COMPACTION_RETAINED_USER_MESSAGE_CHARS = 80_000;
// Session metadata key holding the task state as of the last fold, which the
// system prompt's Task State section shows (see foldedSessionMetadata).
export const COMPACTED_TASK_STATE_METADATA_KEY = "compactedTaskState";

/**
 * Session metadata after a compaction that folds history: the watermark, and
 * the task state as of the fold.
 *
 * The system prompt shows that task state rather than the live one, so the
 * prompt stays the same between runs until history is folded again. A local
 * server reuses what it has already read of a prompt only up to its first
 * change, and the whole conversation follows the system prompt: a plan update
 * once made the next run re-read 80k tokens, 13 minutes on the operator's
 * machine (2026-10-02). Until a fold the model sees its plan through its own
 * plan-tool calls in the transcript.
 */
export function foldedSessionMetadata(
  metadata: SessionRecord["metadata"],
  watermarkMessageId: string,
  taskState: TaskStateSnapshot | null | undefined
): SessionRecord["metadata"] {
  const shown =
    taskState &&
    (taskState.progress.total > 0 ||
      taskState.summary ||
      taskState.nextStep ||
      taskState.blockers.length > 0 ||
      taskState.recentAttempts.length > 0)
      ? // The prompt renders progress and notes; the plan record and working
        // memory are left out to keep the session record small.
        (JSON.parse(JSON.stringify({ ...taskState, plan: null, workingMemory: [] })) as JsonValue)
      : null;
  return {
    ...metadata,
    [COMPACTED_TASK_STATE_METADATA_KEY]: shown,
    [COMPACTION_WATERMARK_METADATA_KEY]: watermarkMessageId
  };
}
// Tool families that record thought or plan state without acting on the task.
// A turn whose only calls belong to these families makes no real progress, so
// it counts toward the no-progress guard instead of resetting it. Classifying
// by the tool's declared family (not the loaded model) keeps this explicit and
// model-agnostic.
const NO_PROGRESS_TOOL_FAMILIES = new Set(["planning", "reasoning"]);
const REPEATED_TOOL_CALL_ERROR_CODE = "repeated_tool_call";
// Turns of refused repeats allowed in a row before they count as no progress.
const FREE_REFUSED_TURNS = 2;
// Sessions whose folded skill loads one loop remembers.
const MAX_REMEMBERED_SESSIONS = 256;

export class AgentLoop {
  private readonly skills: SkillProvider;
  // Per session (the most recent ones): the skill loads compaction folded
  // away, as of a watermark and a set of loads.
  private readonly foldedSkillLoads = new Map<string, { key: string; messageIds: Set<string> }>();

  constructor(private readonly options: AgentLoopOptions) {
    this.skills =
      options.skills ??
      createSkillProvider(options.userHomeDirectory ? { userHomeDirectory: options.userHomeDirectory } : {});
  }

  async run(params: AgentLoopRunParams): Promise<AgentLoopRunResult> {
    await this.options.memoryLifecycle?.initializeSessionMemory(params.session);
    const runStartTime = Date.now();
    const maxTurns = params.maxTurns ?? "unlimited";
    const maxConsecutiveNudges = params.maxConsecutiveNudges ?? DEFAULT_MAX_CONSECUTIVE_NUDGES;
    const maxIdenticalToolCalls = params.maxIdenticalToolCalls ?? DEFAULT_MAX_IDENTICAL_TOOL_CALLS;
    // How many times each exact (tool, arguments) pair has already run in this
    // execution. A small model that cannot tell an empty result from a failed
    // one will otherwise reissue the same read indefinitely, and the
    // no-progress guard never fires because each call "succeeds".
    const identicalToolCallCounts = new Map<string, number>();
    // Found once per run, so the catalog, the `skill` tool's name enum, and
    // `$name` mentions all see the same skills.
    const skillDiscovery = await this.skills.discover(params.session.cwd);
    const skillToolNames = selectModelVisibleSkills(skillDiscovery.skills).map((skill) => skill.name);
    // Rebuilt after threshold compaction so the refreshed session summary
    // reaches the Durable Memory section of the system prompt.
    const buildPack = async (forSession: SessionRecord) =>
      buildPromptPack({
        activeSkills: await this.resolveCompactedSkills(forSession, skillDiscovery.skills),
        activeSkillsCharBudget: this.options.promptBudgets?.activeSkillsChars,
        availableTools: this.resolveEffectiveTools(params.availableTools, forSession, skillToolNames),
        contextWindowTokens: this.resolveContextWindowTokens(),
        cwd: forSession.cwd,
        instructionDocCharBudget: this.options.promptBudgets?.instructionDocChars,
        memoryContext: this.options.memoryContextProvider
          ? await this.options.memoryContextProvider.getPromptContext(forSession.id)
          : null,
        memorySummaryCharBudget: this.options.promptBudgets?.memorySummaryChars,
        skillSettings: this.skills.settings,
        skills: skillDiscovery,
        taskSummary: params.taskSummary ?? forSession.goal,
        taskState: await this.resolvePromptTaskState(forSession),
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
    const mentionedSkills = await this.loadMentionedSkills(session, pendingInputMessages, skillDiscovery.skills);
    if (mentionedSkills) {
      session = mentionedSkills.session;
      appendedMessages.push(...mentionedSkills.messages);
      pendingInputMessages = [...pendingInputMessages, ...mentionedSkills.messages];
    }

    let nextTrigger: TurnRecord["trigger"] =
      appliedSteering.length > 0 ? "steering" : pendingInputMessages.length > 0 ? "user" : "resume";

    let consecutiveNudges = 0;
    // Tracked separately from consecutiveNudges so a single "think, then act"
    // turn stays legitimate while a think -> plan -> think chain does not.
    let consecutivePlanningTurns = 0;
    // Turns whose every tool call was refused as a repeat, in a row.
    let consecutiveRefusedTurns = 0;
    // Running total of generated tokens across every turn in this run, so the
    // status metric reports cumulative work (like context, which accumulates
    // until compaction) rather than just the latest turn.
    let cumulativeOutputTokens = 0;
    const isCancelled = () => params.signal?.aborted === true;
    const finishCancelled = async (): Promise<AgentLoopRunResult> => {
      session = await this.persistSession(session, "cancelled", {
        activeTurnId: undefined,
        statusSummary: "Cancelled by the operator."
      });
      return {
        approvalRequests: appendedApprovalRequests,
        messages: appendedMessages,
        session,
        stopReason: "cancelled",
        toolCalls: appendedToolCalls,
        turns: appendedTurns
      };
    };

    for (let sequence = 0; maxTurns === "unlimited" || sequence < maxTurns; sequence += 1) {
      // Checked before every turn: a cancelled run starts no new model turn.
      if (isCancelled()) {
        return finishCancelled();
      }

      // Steering that arrived while the previous turn's model call or tools were
      // running is delivered here, at the tool boundary. It used to be read only
      // when a run started, so an operator's "stop, do this instead" reached the
      // model only after the run had already finished the old plan.
      if (sequence > 0) {
        const lateSteering = await this.listQueuedSteering(session.id);
        if (lateSteering.length > 0) {
          const applied = lateSteering.map((injection) => ({ ...injection, state: "applied" as const }));
          await this.options.sessions.appendSteeringInjections(applied);
          const steeringMessages = applied.map((injection) => createSteeringMessage(session.id, injection));
          await this.options.sessions.appendMessages(steeringMessages);
          appendedMessages.push(...steeringMessages);
          pendingInputMessages = [...pendingInputMessages, ...steeringMessages];
          nextTrigger = "steering";
          const lateMentionedSkills = await this.loadMentionedSkills(session, steeringMessages, skillDiscovery.skills);
          if (lateMentionedSkills) {
            session = lateMentionedSkills.session;
            appendedMessages.push(...lateMentionedSkills.messages);
            pendingInputMessages = [...pendingInputMessages, ...lateMentionedSkills.messages];
          }
        }
      }

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
      const visibleMessages = filterModelVisibleMessages(snapshot?.messages ?? [], session, {
        reasoningContextTurns: params.reasoningContextTurns
      });
      const effectiveTools = this.resolveEffectiveTools(params.availableTools, session, skillToolNames);

      const modelRequest = {
        availableTools: effectiveTools,
        id: `lm-request.${turn.id}`,
        instructions: promptPack.systemPrompt,
        messages: visibleMessages,
        metadata: {},
        ...(typeof session.metadata.activeModelId === "string" ? { modelId: session.metadata.activeModelId } : {}),
        ...(typeof session.metadata.activeProvider === "string"
          ? {
              provider: session.metadata.activeProvider as LanguageModelProvider
            }
          : {}),
        responseFormat: {
          kind: "text" as const
        },
        sessionId: session.id,
        settings: {
          ...(this.options.modelSettings?.frequencyPenalty !== undefined
            ? { frequencyPenalty: this.options.modelSettings.frequencyPenalty }
            : {}),
          ...(this.options.modelSettings?.maxOutputTokens !== undefined
            ? { maxOutputTokens: this.options.modelSettings.maxOutputTokens }
            : {}),
          ...(this.options.modelSettings?.minP !== undefined ? { minP: this.options.modelSettings.minP } : {}),
          ...(this.options.modelSettings?.presencePenalty !== undefined
            ? { presencePenalty: this.options.modelSettings.presencePenalty }
            : {}),
          ...(this.options.modelSettings?.repetitionPenalty !== undefined
            ? {
                repetitionPenalty: this.options.modelSettings.repetitionPenalty
              }
            : {}),
          stopSequences: [],
          ...(this.options.modelSettings?.supportsVision !== undefined
            ? { supportsVision: this.options.modelSettings.supportsVision }
            : {}),
          ...(this.options.modelSettings?.temperature !== undefined
            ? { temperature: this.options.modelSettings.temperature }
            : {}),
          toolChoice: "auto" as const,
          ...(this.options.modelSettings?.topK !== undefined ? { topK: this.options.modelSettings.topK } : {}),
          ...(this.options.modelSettings?.topP !== undefined ? { topP: this.options.modelSettings.topP } : {})
        },
        turnId: turn.id
      };

      let response: LanguageModelResponse | undefined;
      let request: AgentLoopModelRequest = modelRequest;
      let overflowCompaction: OverflowCompaction["kind"] | undefined;
      while (!response) {
        try {
          response = await this.requestModel(request, session.id, turn.id, params.signal);
        } catch (error) {
          if (isCancelled()) {
            turn.status = "cancelled";
            turn.completedAt = new Date().toISOString();
            turn.summary = "Cancelled by the operator while the model was generating.";
            await this.options.sessions.appendTurn(turn);
            appendedTurns.push(turn);
            return finishCancelled();
          }
          // A prompt larger than the context window will not fit on a plain
          // retry, but it may once the history before this task is folded
          // into the session summary: the fold threshold compaction does,
          // triggered by the provider's refusal instead of our own estimate,
          // which one huge tool result can outrun between two turns. Once per
          // turn, and never the task's own work (see compactForContextOverflow).
          const structured = extractStructuredError(error);
          if (structured?.code === CONTEXT_WINDOW_EXCEEDED_ERROR_CODE) {
            const { contextWindowTokens, promptTokens } = structured.details;
            this.options.onContextWindowExceeded?.({
              ...(typeof contextWindowTokens === "number" ? { contextWindowTokens } : {}),
              ...(typeof promptTokens === "number" ? { promptTokens } : {})
            });
          }
          if (overflowCompaction === undefined && structured?.code === CONTEXT_WINDOW_EXCEEDED_ERROR_CODE) {
            const compaction = await this.compactForContextOverflow({
              error,
              runFirstMessageId: appendedMessages[0]?.id,
              session,
              turn
            });
            overflowCompaction = compaction.kind;
            if (compaction.kind === "compacted") {
              session = compaction.session;
              promptPack = await buildPack(session);
              const retrySnapshot = await this.options.sessions.getSessionSnapshot(session.id);
              request = {
                ...request,
                // A request id is a queue job's id, and the file queue refuses
                // one it has seen: the retry used to fail on its own id.
                id: `${modelRequest.id}.overflow-retry`,
                instructions: promptPack.systemPrompt,
                messages: filterModelVisibleMessages(retrySnapshot?.messages ?? [], session, {
                  reasoningContextTurns: params.reasoningContextTurns
                })
              };
              continue;
            }
          }
          turn.status = "failed";
          turn.completedAt = new Date().toISOString();
          turn.summary = "The language model request failed.";
          await this.options.sessions.appendTurn(turn);
          appendedTurns.push(turn);
          session = await this.persistFailedSession(session, explainContextOverflow(error, overflowCompaction));
          return {
            approvalRequests: appendedApprovalRequests,
            messages: appendedMessages,
            session,
            stopReason: "failed",
            toolCalls: appendedToolCalls,
            turns: appendedTurns
          };
        }
      }

      cumulativeOutputTokens += response.usage.outputTokens;
      await this.emitStatus(
        session,
        `Turn ${sequence + 1} model response received.`,
        this.buildStatusMetrics(response, runStartTime, cumulativeOutputTokens)
      );

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
      const nonCompletionCalls = response.toolCalls.filter(
        (toolCall) => !completionInvocationNames.has(toolCall.toolName)
      );

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

        // Steering that arrived while the model was producing its final answer
        // must be read before the task ends, or it is silently deferred to
        // some later run. Hold the completion, deliver the steering on the next
        // turn, and let the model finish again. Operator-driven, so it does not
        // count toward the no-progress guard.
        if ((await this.listQueuedSteering(session.id)).length > 0) {
          const heldMessage = createSystemMessage(
            session.id,
            turn.id,
            "New operator steering arrived before the task finished. Read it and act on it, then call `attempt_complete` again.",
            "system",
            "compact"
          );
          await this.options.sessions.appendMessages([heldMessage]);
          appendedMessages.push(heldMessage);
          turn.outputMessageIds.push(heldMessage.id);
          turn.completedAt = new Date().toISOString();
          turn.status = "completed";
          turn.summary = "The runtime held `attempt_complete` because operator steering arrived.";
          await this.options.sessions.appendTurn(turn);
          appendedTurns.push(turn);
          pendingInputMessages = [heldMessage];
          nextTrigger = "system_nudge";
          continue;
        }

        session = await this.persistSession(session, "attempting_completion", {
          activeTurnId: turn.id,
          statusSummary: "Validating completion."
        });

        const completionDecision = await this.resolveCompletionDecision(session, response);
        if (completionDecision.accepted) {
          // The prompt pack tells the model to put its final answer in the
          // `summary` argument rather than in a chat message, and
          // `attempt_complete` is a runtime gate rather than an executed tool —
          // so nothing else in the system ever carries that text to a surface.
          // Persisting it as an ordinary assistant message is what makes the
          // answer visible to the CLI, the web transcript, channels, and the
          // session summary, from one place.
          const completionSummary = readCompletionSummary(completionCalls[0]);
          if (completionSummary) {
            const remainingCaveats = readRemainingCaveats(completionCalls[0]);
            const summaryMessage = createCompletionSummaryMessage(
              session.id,
              turn.id,
              completionSummary,
              remainingCaveats
            );
            await this.options.sessions.appendMessages([summaryMessage]);
            appendedMessages.push(summaryMessage);
            turn.outputMessageIds.push(summaryMessage.id);
          }

          turn.completedAt = new Date().toISOString();
          turn.status = "completed";
          turn.summary = "The runtime accepted `attempt_complete`.";
          await this.options.sessions.appendTurn(turn);
          appendedTurns.push(turn);
          session = await this.persistSession(session, "completed", {
            statusSummary: completionSummary ?? "The task completed successfully."
          });
          // Completion compaction writes the session summary but deliberately
          // leaves the compaction watermark alone. Every chat turn ends here,
          // and the summary carries no user messages, so hiding the transcript
          // would make the next turn in the same session (REPL, web follow-up,
          // channel thread) start with no memory of the conversation. Only
          // threshold compaction and a manual /compact hide history.
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

      // A turn whose only tool calls are planning/reasoning (think, update_plan)
      // changes no task state. One such turn between substantive turns is
      // legitimate — models think before acting — so only a second consecutive
      // planning turn counts toward the no-progress guard. Mixed turns (think
      // plus a real tool) are productive and reset both counters.
      const noProgressTurn = nonCompletionCalls.every((call) =>
        isNoProgressToolName(call.toolName, params.availableTools)
      );
      if (noProgressTurn) {
        consecutivePlanningTurns += 1;
        if (consecutivePlanningTurns > 1) {
          consecutiveNudges += 1;
          if (consecutiveNudges > maxConsecutiveNudges) {
            return failNoProgressGuard(
              "The runtime stopped after repeated planning or reasoning turns without taking action.",
              `The model produced ${consecutivePlanningTurns} consecutive turns that only planned or reasoned without acting.`
            );
          }
        }
      }
      // The first planning turn is allowed silently; nudging it would punish
      // the normal "think, then act" pattern the prompt asks for.
      const nudgeForPlanning = noProgressTurn && consecutivePlanningTurns > 1;

      session = await this.persistSession(session, "awaiting_tool_execution", {
        activeTurnId: turn.id,
        statusSummary: `Executing ${nonCompletionCalls.length} tool call(s).`
      });

      const toolOutcomes = [];
      for (const proposal of nonCompletionCalls) {
        const toolDefinition = params.availableTools.find(
          (definition) => definition.invocationName === proposal.toolName
        );
        const toolCall = createToolCallRecord(session.id, turn.id, proposal, toolDefinition);
        const identityKey = toolCallIdentityKey(toolCall);
        const priorIdenticalCalls = identicalToolCallCounts.get(identityKey) ?? 0;
        identicalToolCallCounts.set(identityKey, priorIdenticalCalls + 1);

        // A call already running finishes; once cancelled, none of the rest
        // start. Each still gets a record and a result, so the transcript keeps
        // one result per proposed call for the next model request.
        const outcome = isCancelled()
          ? cancelToolCall(toolCall)
          : priorIdenticalCalls >= maxIdenticalToolCalls
            ? refuseRepeatedToolCall(toolCall, priorIdenticalCalls)
            : await (this.options.toolExecutor ?? defaultToolExecutor()).execute(toolCall, {
                callableToolNames: new Set(effectiveTools.map((tool) => tool.invocationName)),
                session,
                skills: skillDiscovery,
                turn
              });
        toolOutcomes.push(outcome);
        appendedToolCalls.push(outcome.toolCall);
        // Recorded as each call finishes, not after the turn: a second load of
        // the same skill in this response sees the first, and a turn that
        // pauses for approval keeps it.
        session = recordSkillLoads(session, [
          { resultMessageId: outcome.resultMessage?.id, toolCall: outcome.toolCall }
        ]);
        await this.options.onToolUpdated?.({
          sessionId: session.id,
          toolCall: outcome.toolCall
        });
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

      // A turn whose every call the repeat guard refused did nothing. Two in a
      // row are free: a refusal is often what makes a model change course.
      // From the third, each counts toward the no-progress guard and gets its
      // own nudge. They used to count as progress, so a model calling the same
      // thing again and again (mcp_status, under the lean profile) never
      // tripped the guard.
      const refusedTurn =
        toolOutcomes.length > 0 &&
        toolOutcomes.every((outcome) => outcome.toolCall.error?.code === REPEATED_TOOL_CALL_ERROR_CODE);
      consecutiveRefusedTurns = refusedTurn ? consecutiveRefusedTurns + 1 : 0;
      const nudgeForRefusals = consecutiveRefusedTurns > FREE_REFUSED_TURNS;
      if (nudgeForRefusals && !nudgeForPlanning) {
        consecutiveNudges += 1;
        if (consecutiveNudges > maxConsecutiveNudges) {
          return failNoProgressGuard(
            "The runtime stopped after repeated tool calls it had refused as repeats.",
            `The model produced ${consecutiveRefusedTurns} consecutive turns of tool calls the runtime refused as repeats.`
          );
        }
      }
      if (!noProgressTurn && !refusedTurn) {
        // A turn that acted: both guards start over.
        consecutivePlanningTurns = 0;
        consecutiveNudges = 0;
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

      if (nudgeForPlanning || nudgeForRefusals) {
        const noProgressMessage = createSystemMessage(
          session.id,
          turn.id,
          nudgeForRefusals ? promptPack.nudges.repeatedCalls : promptPack.nudges.noProgress,
          "system",
          "compact"
        );
        await this.options.sessions.appendMessages([noProgressMessage]);
        appendedMessages.push(noProgressMessage);
        turn.outputMessageIds.push(noProgressMessage.id);
        await this.options.sessions.appendTurn(turn);
        appendedTurns.push(turn);
        pendingInputMessages = [...toolResultMessages, noProgressMessage];
        nextTrigger = "system_nudge";
      } else {
        await this.options.sessions.appendTurn(turn);
        appendedTurns.push(turn);
        pendingInputMessages = toolResultMessages;
        nextTrigger = "tool_result";
      }
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

  /**
   * The tools the model sees this turn: the run's tools, plus any a
   * `tool_search` activated, with the `skill` tool narrowed to the run's skill
   * names (and left out when there are none).
   */
  private resolveEffectiveTools(
    baseTools: ToolDefinition[],
    session: SessionRecord,
    skillNames: string[]
  ): ToolDefinition[] {
    return this.withActivatedTools(baseTools, session).flatMap((tool) =>
      tool.name !== SKILL_TOOL_NAME
        ? [tool]
        : skillNames.length > 0
          ? [narrowSkillToolDefinition(tool, skillNames)]
          : []
    );
  }

  private withActivatedTools(baseTools: ToolDefinition[], session: SessionRecord): ToolDefinition[] {
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

  /**
   * Adds the skills an operator named (`$name`) in `messages` to the session:
   * one message per skill, holding its instructions, right after the input,
   * and an activation record so the skill is not loaded twice. Only the
   * operator's own messages count: a channel message only when its sender is
   * one of the channel's operator identities, so a third party in a group chat
   * cannot start a skill reserved for the operator.
   */
  private async loadMentionedSkills(
    session: SessionRecord,
    messages: Message[],
    skills: SkillRecord[]
  ): Promise<{ messages: Message[]; session: SessionRecord } | null> {
    const loaded = new Set(readSkillActivations(session.metadata).map((activation) => activation.name));
    const mentioned: SkillRecord[] = [];
    for (const message of messages) {
      if (!isOperatorInput(message)) {
        continue;
      }
      for (const part of message.parts) {
        if (part.kind !== "text") {
          continue;
        }
        for (const skill of resolveSkillMentions(part.text, skills, {
          cwd: session.cwd,
          ...(this.options.userHomeDirectory ? { userHomeDirectory: this.options.userHomeDirectory } : {})
        })) {
          if (!loaded.has(skill.name)) {
            loaded.add(skill.name);
            mentioned.push(skill);
          }
        }
      }
    }
    if (mentioned.length === 0) {
      return null;
    }

    const skillMessages = await Promise.all(
      mentioned.map(
        async (skill): Promise<Message> => ({
          createdAt: new Date().toISOString(),
          id: createMessageId("skill", `${session.id}.${skill.name}.${crypto.randomUUID()}`),
          metadata: { [SKILL_NAME_METADATA_KEY]: skill.name },
          // A user message: every chat template accepts one mid-conversation,
          // which a second system message is not.
          parts: [{ kind: "text", text: await loadSkillContent(skill) }],
          role: "user",
          sessionId: session.id,
          source: "system",
          tags: ["skill"],
          visibility: "compact"
        })
      )
    );
    await this.options.sessions.appendMessages(skillMessages);
    return {
      messages: skillMessages,
      session: withSkillActivations(
        session,
        skillMessages.map((message, index) => ({ messageId: message.id, name: mentioned[index]!.name }))
      )
    };
  }

  /**
   * The skills loaded earlier whose instructions compaction has folded out of
   * the replayed transcript. The prompt restates them in full, so compaction
   * never unloads a skill the model is following.
   */
  private async resolveCompactedSkills(session: SessionRecord, skills: SkillRecord[]): Promise<SkillRecord[]> {
    const activations = readSkillActivations(session.metadata);
    const watermark = session.metadata[COMPACTION_WATERMARK_METADATA_KEY];
    if (activations.length === 0 || typeof watermark !== "string") {
      return [];
    }
    // Which loads compaction folded away changes only with the watermark or
    // the loads: the transcript is read again only then, not for every prompt
    // (three times in a row on the overflow retry).
    const key = [watermark, ...activations.map((activation) => activation.messageId)].join("\u0000");
    let folded = this.foldedSkillLoads.get(session.id);
    if (folded?.key !== key) {
      const snapshot = await this.options.sessions.getSessionSnapshot(session.id);
      const visible = new Set(
        filterModelVisibleMessages(snapshot?.messages ?? [], session).map((message) => message.id)
      );
      folded = {
        key,
        messageIds: new Set(
          activations.flatMap((activation) => (visible.has(activation.messageId) ? [] : [activation.messageId]))
        )
      };
      this.foldedSkillLoads.delete(session.id);
      this.foldedSkillLoads.set(session.id, folded);
      for (const oldest of this.foldedSkillLoads.keys()) {
        if (this.foldedSkillLoads.size <= MAX_REMEMBERED_SESSIONS) {
          break;
        }
        this.foldedSkillLoads.delete(oldest);
      }
    }
    const messageIds = folded.messageIds;
    return activations.flatMap((activation) =>
      messageIds.has(activation.messageId)
        ? skills.filter((skill) => skill.enabled && skill.name === activation.name)
        : []
    );
  }

  // The tools a call made callable for the rest of the session (tool_search
  // names the ones it found in its call metadata), added to the session.
  private mergeActivatedTools(session: SessionRecord, outcomes: AgentLoopToolExecutionResult[]): SessionRecord {
    if (!this.options.toolCatalog) {
      return session;
    }
    const discovered = outcomes.flatMap((outcome) => {
      const named = outcome.toolCall.metadata[ACTIVATES_TOOLS_METADATA_KEY];
      return outcome.toolCall.status === "succeeded" && Array.isArray(named)
        ? named.filter((name): name is string => typeof name === "string" && name.length > 0)
        : [];
    });
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

  private async requestModel(
    request: AgentLoopModelRequest,
    sessionId: string,
    turnId: string,
    signal: AbortSignal | undefined
  ): Promise<LanguageModelResponse> {
    const onAssistantDelta = this.options.onAssistantDelta;
    const onAssistantReasoning = this.options.onAssistantReasoning;
    const callOptions = signal ? { signal } : {};
    if (this.options.model.stream && (onAssistantDelta || onAssistantReasoning)) {
      return this.options.model.stream(
        request,
        (event) => {
          if (event.kind === "response.delta") {
            onAssistantDelta?.({ delta: event.delta, sessionId, turnId });
          } else if (event.kind === "response.reasoning") {
            onAssistantReasoning?.({ delta: event.delta, sessionId, turnId });
          }
        },
        callOptions
      );
    }
    return this.options.model.generate(request, callOptions);
  }

  /**
   * Folds the history before the current task into the session summary and
   * moves the compaction watermark past it, so a retried request carries the
   * summary (through the prompt pack), the operator's earlier messages
   * (retainConversationInput), and the task itself intact: from the latest
   * thing a person said at or before this run started (the request this run
   * works on, or for a run resumed after an approval, the request it paused
   * on) through this turn. Folding the task's own tool calls and results left
   * the retry with nothing but the request, and the model started over.
   *
   * `nothing_to_fold` when all of that history is folded already (what does
   * not fit is the task itself); `unavailable` without a memory lifecycle to
   * write the summary.
   */
  private async compactForContextOverflow(params: {
    error: unknown;
    /** The first message this run appended (its request, or its first status message). */
    runFirstMessageId: string | undefined;
    session: SessionRecord;
    turn: TurnRecord;
  }): Promise<OverflowCompaction> {
    if (!this.options.memoryLifecycle) {
      return { kind: "unavailable" };
    }
    const messages = (await this.options.sessions.getSessionSnapshot(params.session.id))?.messages ?? [];
    const turnInput = new Set(params.turn.inputMessageIds);
    const runStart = messages.findIndex((message) =>
      params.runFirstMessageId ? message.id === params.runFirstMessageId : turnInput.has(message.id)
    );
    if (runStart < 0) {
      return { kind: "nothing_to_fold" };
    }
    let keepFrom = runStart;
    for (let index = runStart; index >= 0; index -= 1) {
      if (isConversationInput(messages[index]!)) {
        keepFrom = index;
        break;
      }
    }
    const watermarkIndex = keepFrom - 1;
    const current = params.session.metadata[COMPACTION_WATERMARK_METADATA_KEY];
    const currentIndex = typeof current === "string" ? messages.findIndex((message) => message.id === current) : -1;
    const watermark = messages[watermarkIndex];
    if (!watermark || watermarkIndex <= currentIndex) {
      return { kind: "nothing_to_fold" };
    }

    const promptTokens = extractStructuredError(params.error)?.details.promptTokens;
    await this.options.memoryLifecycle.compactSession({
      sessionId: params.session.id,
      ...(typeof promptTokens === "number" ? { sourceTokenCount: promptTokens } : {}),
      trigger: "overflow"
    });
    const session = await this.persistSession(
      {
        ...params.session,
        metadata: foldedSessionMetadata(
          params.session.metadata,
          watermark.id,
          await this.readTaskState(params.session.id)
        )
      },
      "running_model",
      {
        activeTurnId: params.turn.id,
        statusSummary: "Compacted the session after the prompt overflowed the model's context window."
      }
    );
    return { kind: "compacted", session };
  }

  private async compactIfOverThreshold(params: {
    response: LanguageModelResponse;
    session: SessionRecord;
    watermarkMessageId: string;
  }): Promise<SessionRecord | null> {
    if (!this.options.memoryLifecycle) {
      return null;
    }

    const resolvedWindow = this.resolveContextWindowTokens();
    const threshold =
      this.options.autoCompactThresholdTokens ??
      (resolvedWindow
        ? Math.floor(resolvedWindow * AUTO_COMPACT_CONTEXT_WINDOW_FRACTION)
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
      metadata: foldedSessionMetadata(
        params.session.metadata,
        params.watermarkMessageId,
        await this.readTaskState(params.session.id)
      )
    };
  }

  private async readTaskState(sessionId: string): Promise<TaskStateSnapshot | null> {
    return this.options.taskStateProvider ? this.options.taskStateProvider.getTaskState(sessionId) : null;
  }

  /**
   * The task state the system prompt shows: as of the last fold (see
   * foldedSessionMetadata), or none before the first one.
   */
  private async resolvePromptTaskState(session: SessionRecord): Promise<TaskStateSnapshot | null> {
    if (COMPACTED_TASK_STATE_METADATA_KEY in session.metadata) {
      const parsed = taskStateSnapshotSchema.safeParse(session.metadata[COMPACTED_TASK_STATE_METADATA_KEY]);
      return parsed.success ? parsed.data : null;
    }
    // Folded before the frozen copy existed: the live state, as before.
    return typeof session.metadata[COMPACTION_WATERMARK_METADATA_KEY] === "string"
      ? this.readTaskState(session.id)
      : null;
  }

  private async emitStatus(session: SessionRecord, summary: string, metrics?: AgentLoopStatusMetrics): Promise<void> {
    await this.options.onStatus?.({
      ...(metrics ? { metrics } : {}),
      session,
      summary
    });
  }

  private buildStatusMetrics(
    response: LanguageModelResponse,
    runStartTime: number,
    cumulativeOutputTokens: number
  ): AgentLoopStatusMetrics {
    // "Tokens used" = cumulative generated tokens across the run (each turn's
    // completion/eval count, which already includes reasoning tokens). Context %
    // reflects how full the window is, so it uses the latest prompt (input)
    // tokens against the resolved window size.
    const promptTokens = response.usage.inputTokens;
    const contextWindowTokens = this.resolveContextWindowTokens() ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    return {
      ...(contextWindowTokens > 0 && promptTokens > 0
        ? {
            contextWindowPercentage: Math.min(100, Math.round((promptTokens / contextWindowTokens) * 1000) / 10)
          }
        : {}),
      elapsedSeconds: Math.round((Date.now() - runStartTime) / 1000),
      tokensUsed: cumulativeOutputTokens
    };
  }

  private resolveContextWindowTokens(): number | undefined {
    const configured =
      typeof this.options.contextWindowTokens === "function"
        ? this.options.contextWindowTokens()
        : this.options.contextWindowTokens;
    return configured && configured > 0 ? configured : undefined;
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

function isOperatorInput(message: Message): boolean {
  return (
    message.role === "user" &&
    (message.source === "user" ||
      message.source === "operator" ||
      (message.source === "channel" && message.metadata[CHANNEL_OPERATOR_METADATA_KEY] === true))
  );
}

function readActivatedToolNames(session: SessionRecord): string[] {
  const raw = session.metadata[ACTIVATED_TOOLS_METADATA_KEY];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

export function filterModelVisibleMessages(
  messages: Message[],
  session: SessionRecord,
  options: { reasoningContextTurns?: number } = {}
): Message[] {
  const watermarkId = session.metadata[COMPACTION_WATERMARK_METADATA_KEY];
  let scoped = messages;
  if (typeof watermarkId === "string" && watermarkId.length > 0) {
    const index = messages.findIndex((message) => message.id === watermarkId);
    if (index >= 0) {
      scoped = [
        ...retainConversationInput(messages.slice(0, index + 1), COMPACTION_RETAINED_USER_MESSAGE_CHARS),
        ...messages.slice(index + 1)
      ];
    }
  }
  return dropStaleReasoningParts(
    scoped.filter((message) => message.visibility !== "hidden"),
    options.reasoningContextTurns ?? DEFAULT_REASONING_CONTEXT_TURNS
  );
}

/**
 * What the conversation's people said before a compaction watermark, kept in
 * the replayed history while everything else there is folded away.
 *
 * The session summary records tool calls and the agent's narration, never the
 * requests, so folding these too left the model working on a task nobody had
 * stated. It also opened the history with the assistant's tool call, and chat
 * templates such as Qwen 3.5's refuse a conversation that does not start with
 * a user turn ("No user query found in messages."): every later request in
 * the session failed, even after the operator spoke again.
 *
 * Newest first within `budgetChars`, text only, as Codex keeps them: the
 * message that straddles the budget keeps its start and end, and older ones
 * are dropped.
 */
function retainConversationInput(folded: Message[], budgetChars: number): Message[] {
  const retained: Message[] = [];
  let remaining = budgetChars;
  for (let index = folded.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = folded[index];
    if (!message || !isConversationInput(message)) {
      continue;
    }
    const text = message.parts
      .flatMap((part) => (part.kind === "text" ? [part.text] : part.kind === "markdown" ? [part.markdown] : []))
      .join("\n\n");
    if (text.trim().length === 0) {
      continue;
    }
    if (text.length > remaining) {
      retained.push({ ...message, parts: [{ kind: "text", text: elideMiddle(text, remaining) }] });
      break;
    }
    const textOnly = message.parts.every((part) => part.kind === "text" || part.kind === "markdown");
    retained.push(textOnly ? message : { ...message, parts: [{ kind: "text", text }] });
    remaining -= text.length;
  }
  return retained.reverse();
}

// The operator, steering, and channel messages: what people said. A user-role
// message the runtime wrote (a loaded skill's instructions) is not; compaction
// restates active skills in the prompt instead.
function isConversationInput(message: Message): boolean {
  return (
    message.role === "user" &&
    message.visibility !== "hidden" &&
    (message.source === "user" || message.source === "operator" || message.source === "channel")
  );
}

function elideMiddle(text: string, maxChars: number): string {
  const head = Math.ceil(maxChars / 2);
  const tail = maxChars - head;
  const dropped = (text.length - maxChars).toLocaleString("en-US");
  return [
    text.slice(0, head),
    `[${dropped} characters of this message were dropped when the session was compacted]`,
    ...(tail > 0 ? [text.slice(text.length - tail)] : [])
  ].join("\n\n");
}

/**
 * Keeps reasoning for the most recent `retainedTurns` turns and drops the rest.
 *
 * Reasoning is expensive context and replaying an older turn's deliberation
 * reinforces "plan -> re-plan" loops, but the model still needs this turn's
 * reasoning to survive across tool results. Filtering by turn (rather than by
 * message) is what makes those two requirements compatible.
 */
function dropStaleReasoningParts(messages: Message[], retainedTurns: number): Message[] {
  const turnIds: string[] = [];
  for (const message of messages) {
    if (message.turnId !== undefined && !turnIds.includes(message.turnId)) {
      turnIds.push(message.turnId);
    }
  }
  const retained = new Set(retainedTurns > 0 ? turnIds.slice(-retainedTurns) : []);

  return messages.flatMap((message) => {
    // A message with no turn cannot be aged, so its reasoning is kept.
    if (message.turnId === undefined || retained.has(message.turnId)) {
      return [message];
    }
    if (!message.parts.some((part) => part.kind === "reasoning")) {
      return [message];
    }
    const parts = message.parts.filter((part) => part.kind !== "reasoning");
    // A message that was nothing but reasoning carries no remaining signal.
    return parts.length > 0 ? [{ ...message, parts }] : [];
  });
}

function buildAssistantTurnMessage(sessionId: string, turnId: string, response: LanguageModelResponse): Message | null {
  const rawTextParts = response.message?.parts.filter((part) => part.kind !== "tool_call") ?? [];
  const toolCallParts = response.toolCalls.map((toolCall) => ({
    arguments: toolCall.arguments,
    callId: toolCall.callId,
    inputText: toolCall.inputText,
    kind: "tool_call" as const,
    toolName: toolCall.toolName
  }));

  // Inline <think>/analysis markup is moved into first-class reasoning parts
  // instead of being deleted. Deleting it lost detail the operator wanted in the
  // transcript; leaving it inline meant every later turn replayed the model's
  // indecision back at it. Splitting lets the transcript keep it while
  // filterModelVisibleMessages drops it by age.
  const reasoningParts: MessagePart[] = [];
  const textParts: MessagePart[] = [];
  for (const part of rawTextParts) {
    if (part.kind !== "text") {
      textParts.push(part);
      continue;
    }
    const split = splitReasoningMarkup(part.text);
    if (split.reasoning.length > 0) {
      reasoningParts.push({ kind: "reasoning", text: split.reasoning });
    }
    if (split.text.length > 0) {
      textParts.push({ ...part, text: split.text });
    }
  }

  if (reasoningParts.length === 0 && textParts.length === 0 && toolCallParts.length === 0) {
    return null;
  }

  return {
    createdAt: new Date().toISOString(),
    id: response.message?.id ?? `message.assistant.${response.id}`,
    metadata: response.message?.metadata ?? {},
    parts: [...reasoningParts, ...textParts, ...toolCallParts],
    role: "assistant",
    sessionId,
    source: "assistant",
    tags: response.message?.tags ?? [],
    turnId,
    visibility: response.message?.visibility ?? "default"
  };
}

const REASONING_MARKUP_PATTERNS = [
  /<think>([\s\S]*?)<\/think>/giu,
  /<\|channel\|>analysis([\s\S]*?)(?:<\|end\|>|<\|message\|>)/giu
];

function splitReasoningMarkup(text: string): {
  reasoning: string;
  text: string;
} {
  const reasoning: string[] = [];
  let remaining = text;
  for (const pattern of REASONING_MARKUP_PATTERNS) {
    remaining = remaining.replace(pattern, (_match, captured: string) => {
      const trimmed = captured.trim();
      if (trimmed.length > 0) {
        reasoning.push(trimmed);
      }
      return "";
    });
  }

  return {
    reasoning: reasoning.join("\n\n"),
    text: remaining.replace(/\n{3,}/gu, "\n\n").trim()
  };
}

function isNoProgressToolName(toolName: string, definitions: ToolDefinition[]): boolean {
  const definition = definitions.find(
    (candidate) =>
      candidate.invocationName === toolName || candidate.name === toolName || candidate.aliases.includes(toolName)
  );
  const family = definition?.annotations?.meta?.family;
  return typeof family === "string" && NO_PROGRESS_TOOL_FAMILIES.has(family);
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

/**
 * Pulls the operator-facing answer out of an accepted `attempt_complete` call.
 *
 * `summary` is required by the tool schema, but a model can still send an empty
 * or whitespace-only string, and a malformed call reaches here as an arbitrary
 * JSON value. Anything that is not real text yields null so the caller falls
 * back to the generic status line instead of persisting an empty message.
 */
function readCompletionSummary(completionCall: ModelToolCallProposal | undefined): string | null {
  const raw = completionCall?.arguments?.summary;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Pulls the model's own "what's still not done" list out of an accepted
 * `attempt_complete` call. The tool's schema and usage guidance both invite
 * the model to report remaining caveats, but nothing ever read the argument
 * back out — the runtime discarded it, so an honestly-reported caveat never
 * reached the operator.
 */
function readRemainingCaveats(completionCall: ModelToolCallProposal | undefined): string[] {
  const raw = completionCall?.arguments?.remainingCaveats;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

/**
 * The final answer, persisted as an ordinary assistant message.
 *
 * Tagged so a surface can tell the completion summary apart from streamed
 * narration on the same turn (the CLI prints it after the stream; without the
 * tag it could not know whether it had already shown this text).
 */
function createCompletionSummaryMessage(
  sessionId: string,
  turnId: string,
  summary: string,
  remainingCaveats: string[]
): Message {
  const text =
    remainingCaveats.length > 0
      ? `${summary}\n\nRemaining caveats:\n${remainingCaveats.map((caveat) => `- ${caveat}`).join("\n")}`
      : summary;

  return {
    createdAt: new Date().toISOString(),
    id: createMessageId("completion", `${turnId}.${crypto.randomUUID()}`),
    metadata: {},
    parts: [{ kind: "text", text }],
    role: "assistant",
    sessionId,
    source: "assistant",
    tags: [COMPLETION_SUMMARY_MESSAGE_TAG],
    turnId,
    visibility: "default"
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

function mergeSteeringInjections(persisted: SteeringInjection[], injected: SteeringInjection[]): SteeringInjection[] {
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

// Identity of a tool call for repeat detection: the tool plus its arguments,
// with object keys sorted so argument order cannot disguise the same call.
function toolCallIdentityKey(toolCall: ToolCallRecord): string {
  return `${toolCall.toolName}:${stableStringify(toolCall.arguments)}`;
}

function stableStringify(value: JsonValue | undefined): string {
  if (value === undefined) {
    return "";
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

// A cancelled run records the calls it never started as cancelled rather than
// dropping them, so the transcript keeps a result for every proposed call.
function cancelToolCall(toolCall: ToolCallRecord): AgentLoopToolExecutionResult {
  return {
    toolCall: {
      ...toolCall,
      completedAt: new Date().toISOString(),
      error: {
        code: "tool_call_cancelled",
        details: {},
        message: "Cancelled by the operator before it ran.",
        retriable: false
      },
      status: "cancelled"
    }
  };
}

// Refusing costs one turn and tells the model exactly what to do differently;
// executing it again would return the same bytes and buy nothing. The refusal
// is a normal failed tool result so it flows back through the same path the
// model already knows how to read.
function refuseRepeatedToolCall(toolCall: ToolCallRecord, priorIdenticalCalls: number): AgentLoopToolExecutionResult {
  const failedCall: ToolCallRecord = {
    ...toolCall,
    completedAt: new Date().toISOString(),
    error: {
      code: REPEATED_TOOL_CALL_ERROR_CODE,
      details: {
        priorIdenticalCalls,
        toolName: toolCall.toolName
      },
      message: `"${toolCall.toolName}" was already called ${priorIdenticalCalls} time(s) in this run with exactly these arguments, and returned the same result each time. Do not repeat it: use the result you already have, call a different tool, change the arguments, or report what you found.`,
      retriable: false
    },
    metadata: {
      ...toolCall.metadata,
      repeatedToolCall: true
    },
    status: "failed"
  };

  return {
    resultMessage: createToolResultMessage(toolCall.sessionId, toolCall.turnId, failedCall),
    toolCall: failedCall
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

/** What an overflow's compaction did: see AgentLoop.compactForContextOverflow. */
type OverflowCompaction =
  | { kind: "compacted"; session: SessionRecord }
  | { kind: "nothing_to_fold" }
  | { kind: "unavailable" };

/**
 * A context overflow reworded so the operator can act on it: the numbers, and
 * the settings that change them. Any other error passes through unchanged.
 */
function explainContextOverflow(error: unknown, compaction: OverflowCompaction["kind"] | undefined): unknown {
  const structured = extractStructuredError(error);
  if (structured?.code !== CONTEXT_WINDOW_EXCEEDED_ERROR_CODE) {
    return error;
  }
  const { contextWindowTokens, promptTokens } = structured.details;
  const sizes =
    typeof promptTokens === "number" && typeof contextWindowTokens === "number"
      ? ` (${promptTokens} tokens) is larger than the model's context window (${contextWindowTokens} tokens)`
      : " is larger than the model's context window";
  // The provider's own way to a larger window, when its adapter gave one.
  const larger =
    typeof structured.details.remedy === "string" && structured.details.remedy.length > 0
      ? structured.details.remedy
      : "Load the model with a larger context window";
  const situation =
    compaction === "compacted"
      ? `${sizes}, even after compacting the session. ${larger}, or start a new session.`
      : compaction === "nothing_to_fold"
        ? // The task's own messages and tool results are kept whole, never
          // cut down to fit (no tool-output cap), so the operator decides.
          `${sizes}, and nothing from before this task is left to fold: the task's own messages and tool ` +
          `results do not fit. ${larger}, or ask for less at a time (a line range, a narrower search).`
        : `${sizes}. ${larger}, or start a new session.`;
  return {
    ...structured,
    message: `The prompt${situation} The provider said: ${structured.message}`
  };
}

function normalizeUnknownError(error: unknown): StructuredError {
  // A provider's structured error (a context overflow, a rate limit) is worth
  // more than its message: the session's lastError keeps its code.
  const structured = extractStructuredError(error);
  if (structured) {
    return structured;
  }
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
