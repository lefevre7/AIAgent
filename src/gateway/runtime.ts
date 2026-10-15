import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  AgentLoop,
  ApprovalCoordinator,
  repeatsShownText,
  ChannelService,
  foldedSessionMetadata,
  FileSessionStore,
  filterModelVisibleMessages,
  LanguageModelRuntime,
  MemorySystemStatus,
  TaskStateService,
  ToolRuntime,
  createToolResultMessage,
  createDefaultToolRegistry,
  resolveVisibleToolDefinitions,
  createExternalAgentServiceFromConfig,
  createExternalAgentSessionServiceFromConfig,
  createExternalAgentTurnSummarizer,
  createImageServiceFromConfig,
  createVoiceServiceFromConfig,
  createMcpManagerFromLoadedConfig,
  createMemoryServiceFromConfig,
  createPlaywrightBrowserAutomationService,
  createSkillProvider,
  createToolApprovalDecider,
  followSkillsSettings,
  ensureStateRootWritable,
  openTerminalWindow,
  ContextWindowTracker,
  followMcpTrustRules,
  CommandRuntime,
  loadAIAgentConfig,
  type ApprovalSettings,
  type AppConfig,
  type CommandOutputListener,
  type EmbeddingAdapterRegistration,
  type ExternalAgentService,
  type ExternalAgentSessionService,
  type ExternalAgentSessionHost,
  type ExternalAgentTurnSummarizer,
  type ImageService,
  type VoiceService,
  type LanguageModelAdapterRegistration,
  type LoadedAIAgentConfig,
  type MCPManager,
  type PlaywrightBrowserAutomationService,
  type SkillProvider,
  type StructuredError,
  summarizeServerUpdate,
  summarizeStatus,
  describeCatalogFit,
  recordSkillLoads,
  resolveSkillCatalogBudgetChars,
  toSkillSummary,
  toMcpIdSegment
} from "@/core";
import { WorkspaceMutationEngine } from "@/core";
import {
  CHANNEL_OPERATOR_METADATA_KEY,
  COMPLETION_SUMMARY_MESSAGE_TAG,
  approvalResolutionSchema,
  channelMessageSchema,
  gatewayApprovalListQuerySchema,
  gatewayApprovalRecordSchema,
  gatewayEventPageSchema,
  gatewayEventReplayQuerySchema,
  gatewayEventSchema,
  gatewayMessageInputSchema,
  gatewayRequestPayloadSchemas,
  gatewayResponsePayloadSchemas,
  gatewayResponseSchema,
  gatewayRunRecordSchema,
  gatewaySessionListQuerySchema,
  gatewaySessionSnapshotSchema,
  gatewaySubscriptionSchema,
  messageSchema,
  sessionRecordSchema,
  toolCallRecordSchema,
  turnRecordSchema,
  type ApprovalRequest,
  type ApprovalResolution,
  type ArtifactReference,
  type ChannelMessage,
  type ChannelRuntimeStatus,
  type GatewayApprovalRecord,
  type GatewayEvent,
  type GatewayEventPage,
  type GatewayEventReplayQuery,
  type GatewayRequest,
  type GatewayResponse,
  type GatewayRunCompletionReason,
  type GatewayRunKind,
  type GatewayRunRecord,
  type GatewaySessionCompactResult,
  type GatewaySessionSnapshot,
  type GatewaySubscription,
  type JsonValue,
  type LanguageModelResponse,
  type MCPServerStatus,
  type Message,
  type SessionRecord,
  type SessionSnapshot,
  type SteeringInjection,
  type TaskStateSnapshot,
  type ToolCallRecord,
  type ToolDefinition,
  type TurnRecord
} from "@/core/contracts";
import {
  buildChannelHelpText,
  buildUnauthorizedChannelCommandText,
  isAuthorizedChannelOperator,
  parseChannelCommand,
  resolveChannelOperatorIdentities,
  type ChannelCommand
} from "@/gateway/channel-commands";
import { createMcpElicitationBroker, DEFAULT_ELICITATION_TIMEOUT_MS, isLiveApproval } from "@/gateway/elicitation";
import { createGatewayError as gatewayError, normalizeGatewayError } from "@/gateway/errors";

// How many terminal run records stay readable through `run.get`. Large enough
// that a client polling right after a run ends always finds it, small enough
// that a long-lived gateway does not accumulate them.
const FINISHED_RUN_HISTORY_LIMIT = 100;

type ActiveGatewayRun = {
  // Aborted by a cancel: the agent loop stops before its next turn or tool
  // call, and the in-flight model request is aborted with it.
  abortController: AbortController;
  cancelRequested: boolean;
  run: GatewayRunRecord;
};

type MaterializedApprovalResume = {
  messageIds: string[];
  // For each executed or declined call: the trigger of the turn it came from
  // (a direct `tool.execute` is `gateway_request`) and how it ended.
  origins: Array<{ status: ToolCallRecord["status"]; trigger: TurnRecord["trigger"] | undefined }>;
  remainingPendingApprovalCount: number;
  session: SessionRecord;
  toolCallIds: string[];
  turnIds: string[];
};

type GatewayRuntimeEvents = {
  event: [GatewayEvent];
};

/** The listener an `aia attach` window can reach, known only once a surface serves one. */
export type AttachEndpointHolder = { url?: string };

type GatewayRuntimeOptions = {
  approvals: ApprovalSettings;
  attachEndpoint?: AttachEndpointHolder;
  /**
   * Opens a desktop terminal window on an interactive external-agent session.
   * Injected rather than called directly so the gateway never depends on a
   * platform-specific window manager, and tests can assert on it.
   */
  attachExternalAgentSession?: (externalSessionId: string) => Promise<{ command: string }>;
  channelService?: ChannelService;
  config: AppConfig;
  externalAgentService?: ExternalAgentService;
  externalAgentSessionService?: ExternalAgentSessionService;
  imageService?: ImageService;
  mcpManager: MCPManager;
  memoryService: Awaited<ReturnType<typeof createMemoryServiceFromConfig>>;
  modelRuntime: LanguageModelRuntime;
  sessions: FileSessionStore;
  // The skills the loop, the `skill` tool, and `skills.list` share. Defaults
  // to one built from `config.skills`.
  skills?: SkillProvider;
  taskStateService: TaskStateService;
  toolRuntime: ToolRuntime;
  userHomeDirectory?: string;
  voiceService?: VoiceService;
  workspaceRoot: string;
  browserService?: PlaywrightBrowserAutomationService;
};

export interface GatewayRuntimeProviderRegistrationHost {
  registerEmbeddingAdapter(registration: EmbeddingAdapterRegistration): void;
  registerLanguageModelAdapter(registration: LanguageModelAdapterRegistration): void;
}

export interface GatewayRuntimeLike {
  getApprovalRecord(requestId: string): Promise<GatewayApprovalRecord>;
  getSessionSnapshot(sessionId: string): Promise<GatewaySessionSnapshot>;
  listApprovalRecords(query: z.input<typeof gatewayApprovalListQuerySchema>): Promise<GatewayApprovalRecord[]>;
  replayEvents(query: GatewayEventReplayQuery): Promise<GatewayEventPage>;
  request(request: GatewayRequest): Promise<GatewayResponse>;
  /**
   * Records the gateway WebSocket an `aia attach` window can reach for this
   * process, once a surface serves one. Until then no window is opened.
   */
  setAttachEndpoint?(url: string | undefined): void;
  subscribe(listener: (event: GatewayEvent) => void, options?: GatewaySubscribeOptions): () => void;
}

export type GatewaySubscribeOptions = {
  /**
   * Whether this subscriber puts session `sessionId`'s approvals in front of
   * someone right now (the CLI during a turn, an open web page), as opposed
   * to one only waiting for a run to end, or logging. The runtime asks before
   * it puts an MCP server's question to an operator. A subscriber that does
   * not say shows none.
   */
  showsApprovals?: (sessionId: string) => boolean;
};

export class GatewayRuntime
  extends EventEmitter<GatewayRuntimeEvents>
  implements GatewayRuntimeLike, GatewayRuntimeProviderRegistrationHost
{
  private readonly activeRunsById = new Map<string, ActiveGatewayRun>();
  private readonly activeRunsBySession = new Map<string, ActiveGatewayRun>();
  // Accumulated provider-native reasoning per turn, flushed as one persisted
  // event when the turn is reported. See onAssistantReasoning.
  private readonly pendingReasoningByTurn = new Map<string, { sessionId: string; text: string }>();
  // Terminal runs, kept briefly so `run.get` can answer for a run that already
  // finished. A caller that subscribes to run.updated just after a run ends
  // would otherwise have no way to learn it is over, and would wait forever.
  private readonly finishedRunsById = new Map<string, GatewayRunRecord>();
  private readonly inFlightRuns = new Set<Promise<void>>();
  private readonly eventLog: GatewayEventLog;
  private readonly approvalCoordinator: ApprovalCoordinator;
  private readonly agentLoop: AgentLoop;
  private readonly skills: SkillProvider;
  // Resolved once in initialize() from the provider when not set in config; the
  // AgentLoop reads it through a getter so it picks up the late-resolved value.
  private readonly contextWindow: ContextWindowTracker;
  // Sessions already warned that the provider answered with another model.
  private readonly modelMismatchNotedSessions = new Set<string>();
  // Waiters for the answer to an MCP server's question, by approval id.
  private readonly elicitationWaiters = new Map<string, (resolution: ApprovalResolution) => void>();
  // Each subscriber's answer to "would you show this session's approvals?"
  private readonly eventInterests = new Map<(event: GatewayEvent) => void, (sessionId: string) => boolean>();
  private readonly onMcpServerUpdated = ({
    previousState,
    status
  }: {
    previousState?: MCPServerStatus["state"];
    status: MCPServerStatus;
  }) => {
    // Live only: a server's state is the process's, and replaying yesterday's
    // "connecting" into a new session would be noise.
    void this.emitEvent(
      {
        createdAt: new Date().toISOString(),
        // Any server name is allowed ("brave search"); an id must fit entityIdSchema.
        id: `mcp-updated.${toMcpIdSegment(status.serverName)}.${crypto.randomUUID()}`,
        metadata: {},
        payload: {
          ...(previousState ? { previousState } : {}),
          server: summarizeServerUpdate(status)
        },
        topic: "mcp.updated"
      },
      false
    );
  };

  constructor(private readonly options: GatewayRuntimeOptions) {
    super();
    this.eventLog = new GatewayEventLog(path.join(options.config.memory.stateRoot, "gateway", "events.jsonl"));
    this.contextWindow = new ContextWindowTracker(options.config.runtime.modelSettings.contextWindowTokens);
    this.approvalCoordinator = new ApprovalCoordinator(options.sessions);
    this.skills =
      options.skills ??
      createSkillProvider({
        settings: options.config.skills,
        ...(options.userHomeDirectory ? { userHomeDirectory: options.userHomeDirectory } : {})
      });
    this.agentLoop = new AgentLoop({
      autoCompactThresholdTokens: options.config.memory.autoCompactThresholdTokens,
      contextWindowTokens: () => this.contextWindow.current,
      onContextWindowExceeded: ({ contextWindowTokens }) => {
        if (contextWindowTokens !== undefined) {
          this.contextWindow.learn(contextWindowTokens);
        }
      },
      memoryContextProvider: options.memoryService,
      memoryLifecycle: options.memoryService,
      model: {
        generate: async (request, callOptions) =>
          this.noteAnsweringModel(request, await options.modelRuntime.generate(request, callOptions)),
        // Only when the runtime streams: the loop streams whenever the model can.
        ...(typeof options.modelRuntime.stream === "function"
          ? {
              stream: async (request, onEvent, callOptions) =>
                this.noteAnsweringModel(request, await options.modelRuntime.stream(request, onEvent, callOptions))
            }
          : {})
      },
      modelSettings: {
        frequencyPenalty: options.config.runtime.modelSettings.frequencyPenalty,
        maxOutputTokens: options.config.runtime.modelSettings.maxOutputTokens,
        minP: options.config.runtime.modelSettings.minP,
        presencePenalty: options.config.runtime.modelSettings.presencePenalty,
        repetitionPenalty: options.config.runtime.modelSettings.repetitionPenalty,
        supportsVision: options.config.runtime.modelSettings.supportsVision,
        temperature: options.config.runtime.modelSettings.temperature,
        topK: options.config.runtime.modelSettings.topK,
        topP: options.config.runtime.modelSettings.topP
      },
      promptBudgets: {
        activeSkillsChars: options.config.runtime.promptBudgets.activeSkillsChars,
        instructionDocChars: options.config.runtime.promptBudgets.instructionDocChars,
        memorySummaryChars: options.config.runtime.promptBudgets.memorySummaryChars
      },
      onAssistantDelta: ({ delta, sessionId, turnId }) => {
        void this.emitEvent(
          {
            createdAt: new Date().toISOString(),
            id: `message-delta.${turnId}.${crypto.randomUUID()}`,
            metadata: { sessionId },
            payload: { delta, sessionId, turnId },
            topic: "message.delta"
          },
          false
        );
      },
      onAssistantReasoning: ({ delta, sessionId, turnId }) => {
        // Per-delta events stream live but are never persisted: a single turn
        // can produce thousands, and the events log is not a token stream.
        void this.emitEvent(
          {
            createdAt: new Date().toISOString(),
            id: `message-reasoning.${turnId}.${crypto.randomUUID()}`,
            metadata: { sessionId },
            payload: { delta, sessionId, turnId },
            topic: "message.reasoning"
          },
          false
        );
        // Accumulated here so the turn can be archived as one persisted event.
        // Provider-native reasoning deliberately never enters the transcript
        // (it would be replayed to the model); the events log is its archive.
        const pending = this.pendingReasoningByTurn.get(turnId);
        if (pending) {
          pending.text += delta;
        } else {
          this.pendingReasoningByTurn.set(turnId, { sessionId, text: delta });
        }
      },
      // Tool activity is emitted as each call settles rather than with the
      // post-run batch, so an operator watching a long run sees tools as they
      // happen. Failures here are logged and dropped: a progress event must
      // never be able to abort the run that produced it.
      onToolUpdated: async ({ sessionId, toolCall }) => {
        try {
          await this.emitEvent(
            {
              createdAt: toolCall.completedAt ?? toolCall.startedAt,
              id: `tool-updated.${toolCall.id}`,
              metadata: { sessionId },
              payload: toolCall,
              topic: "tool.updated"
            },
            true
          );
        } catch (error) {
          console.error(`Failed to emit tool activity for "${toolCall.toolName}":`, error);
        }
      },
      onStatus: async ({ session, summary, metrics }) => {
        await this.emitEvent(
          {
            createdAt: new Date().toISOString(),
            id: `gateway-status.${crypto.randomUUID()}`,
            metadata: {
              sessionId: session.id
            },
            payload: {
              ...(metrics ? { metrics } : {}),
              ok: true,
              status: summary
            },
            topic: "gateway.status"
          },
          false
        );
      },
      sessions: options.sessions,
      skills: this.skills,
      surface: "gateway",
      taskStateProvider: options.taskStateService,
      toolCatalog: options.toolRuntime,
      toolExecutor: options.toolRuntime,
      userHomeDirectory: options.userHomeDirectory
    });
    options.mcpManager.on("server_updated", this.onMcpServerUpdated);
    options.mcpManager.setElicitationHandler(
      createMcpElicitationBroker({
        ask: async (request) => {
          await options.sessions.appendApprovalRequest(request);
          await this.emitApprovalRequested(request);
          await this.relayApprovalToChannel(request).catch(() => undefined);
        },
        canReachOperator: (sessionId) => this.canReachOperator(sessionId),
        expire: async (requestId) => {
          await this.resolveApproval({
            actor: "system",
            comment: "Nobody answered the MCP server's question in time.",
            decision: "expired",
            requestId
          });
        },
        timeoutMs: options.config.mcp.elicitationTimeoutMs ?? DEFAULT_ELICITATION_TIMEOUT_MS,
        waitForAnswer: (requestId, signal) =>
          new Promise((resolve) => {
            const finish = (resolution: ApprovalResolution | null) => {
              this.elicitationWaiters.delete(requestId);
              signal.removeEventListener("abort", onAbort);
              resolve(resolution);
            };
            const onAbort = () => finish(null);
            this.elicitationWaiters.set(requestId, finish);
            signal.addEventListener("abort", onAbort, { once: true });
          })
      })
    );
  }

  async initialize(): Promise<void> {
    await this.eventLog.initialize();
    await this.refreshContextWindow();
  }

  // Looked up at startup and again before every run: a model the provider had
  // not loaded yet at startup (LM Studio loads one on its first request)
  // reports its real window only once it is loaded. An unknown answer keeps
  // the last known window rather than discarding it.
  private async refreshContextWindow(): Promise<void> {
    this.contextWindow.report(await this.resolveProviderContextWindow());
  }

  /**
   * Publishes live output from a long-lived process.
   *
   * Emitted with `persist=false`: a PTY produces thousands of small chunks and
   * the durable copy already exists as the session's combined log, so writing
   * every chunk to the events log would bloat it for no recoverable gain.
   */
  emitToolOutputDelta(payload: {
    chunk: string;
    sessionId?: string;
    sourceId: string;
    sourceKind: "command" | "external_agent";
    stream: "combined" | "stderr" | "stdout";
  }): void {
    void this.emitEvent(
      {
        createdAt: new Date().toISOString(),
        id: `tool-output.${payload.sourceId}.${crypto.randomUUID()}`,
        metadata: payload.sessionId ? { sessionId: payload.sessionId } : {},
        payload,
        topic: "tool.output.delta"
      },
      false
    );
  }

  // Best-effort: ask the default provider for the configured model's context
  // window so the status metric can show a real percentage. Skipped when the
  // window is set in config; failures are swallowed (the loop falls back to a
  // default). Capped by the adapter's own short lookup timeout.
  private async resolveProviderContextWindow(): Promise<number | undefined> {
    if (this.options.config.runtime.modelSettings.contextWindowTokens) {
      return undefined;
    }
    try {
      const provider = this.options.config.runtime.defaultProvider;
      const adapter = this.options.modelRuntime.getAdapter(provider);
      if (!adapter.getModelContextWindow) {
        return undefined;
      }
      // The model a turn will actually ask for. This used to pass LM Studio's
      // configured model for every provider but Ollama.
      const modelId = this.options.modelRuntime.resolveModelId(provider);
      return modelId ? await adapter.getModelContextWindow(modelId) : undefined;
    } catch {
      return undefined;
    }
  }

  async close(): Promise<void> {
    // Cancel what is still running, then drain. Draining alone waited for a run
    // that was still generating to finish on its own, so `/exit`, an SDK close,
    // or a server stop could block for as long as the model kept going.
    await Promise.allSettled([...this.activeRunsById.keys()].map(async (runId) => this.cancelRun(runId)));
    // Drain fire-and-forget runs (and any follow-up runs they queue) before
    // tearing down dependencies, so no event write lands after shutdown.
    while (this.inFlightRuns.size > 0) {
      await Promise.allSettled([...this.inFlightRuns]);
    }
    this.removeAllListeners();
    this.options.mcpManager.off("server_updated", this.onMcpServerUpdated);
    this.options.mcpManager.setElicitationHandler(undefined);
    await this.options.modelRuntime.close().catch(() => undefined);
    await this.options.browserService?.dispose().catch(() => undefined);
    await this.options.imageService?.dispose().catch(() => undefined);
    await this.options.voiceService?.dispose().catch(() => undefined);
    await this.options.mcpManager.close().catch(() => undefined);
    await this.options.externalAgentSessionService?.shutdown().catch(() => undefined);
  }

  async getChannelStatuses(channel?: string): Promise<ChannelRuntimeStatus[]> {
    if (this.options.channelService) {
      const statuses = await this.options.channelService.listRuntimeStatuses();
      return channel ? statuses.filter((entry) => entry.channel === channel) : statuses;
    }

    const config = this.options.config.channels;
    const statuses = [
      {
        capabilities: ["approvals", "attachments", "images", "outbound_messages", "steering"] as const,
        channel: "discord" as const,
        configured: typeof config.discord.appId === "string" && typeof config.discord.botToken === "string",
        enabled: config.discord.enabled,
        metadata: {},
        status: config.discord.enabled
          ? typeof config.discord.appId === "string" && typeof config.discord.botToken === "string"
            ? "not_implemented"
            : "not_configured"
          : "disabled"
      },
      {
        capabilities: ["approvals", "attachments", "images", "outbound_messages", "steering"] as const,
        channel: "whatsapp" as const,
        configured: typeof config.whatsapp.sessionDirectory === "string",
        enabled: config.whatsapp.enabled,
        metadata: {},
        status: config.whatsapp.enabled
          ? typeof config.whatsapp.sessionDirectory === "string"
            ? "not_implemented"
            : "not_configured"
          : "disabled"
      },
      {
        capabilities: ["approvals", "attachments", "outbound_messages", "steering", "webhooks"] as const,
        channel: "teams" as const,
        configured:
          typeof config.teams.appId === "string" &&
          typeof config.teams.appPassword === "string" &&
          typeof config.teams.publicBaseUrl === "string",
        enabled: config.teams.enabled,
        metadata: {},
        status: config.teams.enabled
          ? typeof config.teams.appId === "string" &&
            typeof config.teams.appPassword === "string" &&
            typeof config.teams.publicBaseUrl === "string"
            ? "not_implemented"
            : "not_configured"
          : "disabled"
      },
      {
        capabilities: ["attachments", "images", "outbound_messages", "steering"] as const,
        channel: "imessage" as const,
        configured:
          typeof config.imessage.blueBubblesUrl === "string" && typeof config.imessage.blueBubblesPassword === "string",
        enabled: config.imessage.enabled,
        metadata: {},
        status: config.imessage.enabled
          ? typeof config.imessage.blueBubblesUrl === "string" &&
            typeof config.imessage.blueBubblesPassword === "string"
            ? "not_implemented"
            : "not_configured"
          : "disabled"
      }
    ].map((entry) => gatewayResponsePayloadSchemas["channel.list"].shape.channels.element.parse(entry));

    if (!channel) {
      return statuses;
    }

    return statuses.filter((entry) => entry.channel === channel);
  }

  async getMemoryStatus(): Promise<MemorySystemStatus> {
    return this.options.memoryService.getMemoryStatus();
  }

  async getSessionSnapshot(sessionId: string): Promise<GatewaySessionSnapshot> {
    const snapshot = await this.options.sessions.getSessionSnapshot(sessionId);
    if (!snapshot) {
      throw gatewayError("not_found", `Session "${sessionId}" was not found.`);
    }

    return gatewaySessionSnapshotSchema.parse({
      snapshot,
      taskState: await this.options.taskStateService.getTaskState(sessionId)
    });
  }

  async getTaskState(sessionId: string): Promise<TaskStateSnapshot | null> {
    return this.options.taskStateService.getTaskState(sessionId);
  }

  async listSessions(query: z.input<typeof gatewaySessionListQuerySchema> = {}): Promise<SessionRecord[]> {
    const parsed = gatewaySessionListQuerySchema.parse(query);
    const sessions = await this.options.sessions.listSessions();
    return sessions
      .filter((session) => (parsed.status ? session.status === parsed.status : true))
      .slice(0, parsed.limit);
  }

  searchTools(query: z.input<(typeof gatewayRequestPayloadSchemas)["tool.search"]>): ToolDefinition[] {
    const { all, ...search } = gatewayRequestPayloadSchemas["tool.search"].parse(query);
    return this.options.toolRuntime
      .searchDefinitions(all ? { ...search, limit: Number.MAX_SAFE_INTEGER } : search)
      .map((match) => match.definition);
  }

  async acceptChannelMessage(message: ChannelMessage): Promise<GatewayRunRecord | null> {
    let normalized = channelMessageSchema.parse(message);
    if (!normalized.sessionId) {
      normalized = await this.ensureSessionForChannelMessage(normalized);
    }
    await this.emitChannelMessageEvent(normalized);

    const commandRun = await this.maybeHandleChannelCommand(normalized);
    if (commandRun.handled) {
      return commandRun.run;
    }

    if (!normalized.sessionId) {
      return null;
    }

    const session = await this.options.sessions.getSession(normalized.sessionId);
    if (!session || this.activeRunsBySession.has(session.id)) {
      return null;
    }

    const requestId = `gateway-request.channel-message.${crypto.randomUUID()}`;
    const run = await this.queueRun({
      kind: "session_message",
      requestId,
      sessionId: session.id
    });
    this.launchSessionRun(run.id, session, {
      requestId,
      userMessages: [this.createChannelUserMessage(normalized)]
    });
    return run;
  }

  async listApprovalRecords(query: z.input<typeof gatewayApprovalListQuerySchema>) {
    const parsed = gatewayApprovalListQuerySchema.parse(query);
    let records: GatewayApprovalRecord[];

    if (parsed.pendingOnly) {
      const pending = await this.options.sessions.readPendingApprovals();
      records = Object.values(pending)
        .filter((entry) => !parsed.sessionId || entry.sessionId === parsed.sessionId)
        .map((entry) =>
          gatewayApprovalRecordSchema.parse({
            request: entry.request
          })
        );
    } else {
      const sessions = parsed.sessionId
        ? [await this.requireSession(parsed.sessionId)]
        : await this.options.sessions.listSessions();
      const snapshots = await Promise.all(
        sessions.map(async (session) => this.options.sessions.getSessionSnapshot(session.id))
      );
      records = snapshots
        .filter((snapshot): snapshot is SessionSnapshot => snapshot !== null)
        .flatMap((snapshot) => buildApprovalRecords(snapshot));
    }

    return records
      .sort((left, right) => right.request.createdAt.localeCompare(left.request.createdAt))
      .slice(0, parsed.limit);
  }

  async getApprovalRecord(requestId: string): Promise<GatewayApprovalRecord> {
    const pending = await this.options.sessions.readPendingApprovals();
    if (pending[requestId]) {
      return gatewayApprovalRecordSchema.parse({
        request: pending[requestId].request
      });
    }

    const sessions = await this.options.sessions.listSessions();
    for (const session of sessions) {
      const snapshot = await this.options.sessions.getSessionSnapshot(session.id);
      if (!snapshot) {
        continue;
      }

      const match = buildApprovalRecords(snapshot).find((record) => record.request.id === requestId);
      if (match) {
        return match;
      }
    }

    throw gatewayError("not_found", `Approval request "${requestId}" was not found.`);
  }

  async replayEvents(query: GatewayEventReplayQuery): Promise<GatewayEventPage> {
    return this.eventLog.list(gatewayEventReplayQuerySchema.parse(query));
  }

  subscribe(listener: (event: GatewayEvent) => void, options: GatewaySubscribeOptions = {}): () => void {
    this.on("event", listener);
    this.eventInterests.set(listener, options.showsApprovals ?? (() => false));
    return () => {
      this.off("event", listener);
      this.eventInterests.delete(listener);
    };
  }

  // Whether an approval for this session would reach an operator right now:
  // a subscriber that shows it, or the channel conversation bound to it.
  private async canReachOperator(sessionId: string): Promise<boolean> {
    if ([...this.eventInterests.values()].some((showsApprovals) => showsApprovals(sessionId))) {
      return true;
    }
    // A channel conversation reaches someone who can answer only when its
    // channel names operators: everyone else's `/approve` is refused, and the
    // question used to wait out its whole timeout there.
    const route = await this.options.channelService?.getRouteForSession(sessionId).catch(() => null);
    return Boolean(
      route && resolveChannelOperatorIdentities(this.options.config.channels, route.identity.channel).length > 0
    );
  }

  async request(request: GatewayRequest): Promise<GatewayResponse> {
    try {
      const payload = await this.dispatch(request);
      return gatewayResponseSchema.parse({
        createdAt: new Date().toISOString(),
        id: `gateway-response.${crypto.randomUUID()}`,
        metadata: {},
        ok: true,
        payload,
        requestId: request.id,
        topic: request.topic
      });
    } catch (error) {
      return gatewayResponseSchema.parse({
        createdAt: new Date().toISOString(),
        error: normalizeGatewayError(error),
        id: `gateway-response.${crypto.randomUUID()}`,
        metadata: {},
        ok: false,
        requestId: request.id,
        topic: request.topic
      });
    }
  }

  registerEmbeddingAdapter(registration: EmbeddingAdapterRegistration): void {
    this.options.memoryService.registerEmbeddingAdapter(registration.adapter);
    if (registration.makeDefault) {
      this.options.memoryService.setDefaultEmbeddingProvider({
        embeddingModel: registration.defaultModel,
        providerId: registration.adapter.providerId
      });
    }
  }

  registerLanguageModelAdapter(registration: LanguageModelAdapterRegistration): void {
    this.options.modelRuntime.registerAdapter(registration);
  }

  setAttachEndpoint(url: string | undefined): void {
    if (this.options.attachEndpoint) {
      this.options.attachEndpoint.url = url;
    }
  }

  private async dispatch(request: GatewayRequest): Promise<unknown> {
    switch (request.topic) {
      case "approval.get":
        return gatewayResponsePayloadSchemas["approval.get"].parse(
          await this.getApprovalRecord(gatewayRequestPayloadSchemas["approval.get"].parse(request.payload).requestId)
        );
      case "approval.list":
        return gatewayResponsePayloadSchemas["approval.list"].parse({
          approvals: await this.listApprovalRecords(
            gatewayRequestPayloadSchemas["approval.list"].parse(request.payload)
          )
        });
      case "approval.resolve":
        return gatewayResponsePayloadSchemas["approval.resolve"].parse(
          await this.resolveApproval(gatewayRequestPayloadSchemas["approval.resolve"].parse(request.payload))
        );
      case "channel.health":
        return gatewayResponsePayloadSchemas["channel.health"].parse({
          channels: await this.getChannelStatuses(
            gatewayRequestPayloadSchemas["channel.health"].parse(request.payload).channel
          )
        });
      case "channel.list":
        gatewayRequestPayloadSchemas["channel.list"].parse(request.payload);
        return gatewayResponsePayloadSchemas["channel.list"].parse({
          channels: await this.getChannelStatuses()
        });
      case "channel.send":
        return gatewayResponsePayloadSchemas["channel.send"].parse(
          await this.sendChannelMessage(gatewayRequestPayloadSchemas["channel.send"].parse(request.payload))
        );
      case "external_agent.cancel":
        return gatewayResponsePayloadSchemas["external_agent.cancel"].parse(
          await this.requireExternalAgentService().cancel(
            gatewayRequestPayloadSchemas["external_agent.cancel"].parse(request.payload)
          )
        );
      case "external_agent.get": {
        const jobId = gatewayRequestPayloadSchemas["external_agent.get"].parse(request.payload).jobId;
        const job = await this.requireExternalAgentService().getJob(jobId);
        if (!job) {
          throw gatewayError("not_found", `External-agent job "${jobId}" was not found.`);
        }
        return gatewayResponsePayloadSchemas["external_agent.get"].parse(job);
      }
      case "external_agent.list": {
        const service = this.requireExternalAgentService();
        const query = gatewayRequestPayloadSchemas["external_agent.list"].parse(request.payload);
        const [definitions, jobs] = await Promise.all([service.listDefinitions(), service.listJobs(query)]);
        return gatewayResponsePayloadSchemas["external_agent.list"].parse({
          definitions,
          jobs
        });
      }
      case "external_agent.resume":
        return gatewayResponsePayloadSchemas["external_agent.resume"].parse(
          await this.requireExternalAgentService().resume(
            gatewayRequestPayloadSchemas["external_agent.resume"].parse(request.payload)
          )
        );
      case "external_agent.run":
        return gatewayResponsePayloadSchemas["external_agent.run"].parse(
          await this.requireExternalAgentService().run(
            gatewayRequestPayloadSchemas["external_agent.run"].parse(request.payload)
          )
        );
      case "external_agent.session.attach": {
        const { externalSessionId } = gatewayRequestPayloadSchemas["external_agent.session.attach"].parse(
          request.payload
        );
        if (!this.options.attachExternalAgentSession) {
          throw gatewayError(
            "unsupported",
            "This runtime cannot open a terminal window for an interactive external-agent session."
          );
        }
        const { command } = await this.options.attachExternalAgentSession(externalSessionId);
        const sessions = await this.requireExternalAgentSessionService().listSessions();
        const session = sessions.find((entry) => entry.id === externalSessionId);
        if (!session) {
          throw gatewayError("not_found", `Interactive external-agent session "${externalSessionId}" was not found.`);
        }
        return gatewayResponsePayloadSchemas["external_agent.session.attach"].parse({ command, session });
      }
      case "external_agent.session.list":
        gatewayRequestPayloadSchemas["external_agent.session.list"].parse(request.payload);
        return gatewayResponsePayloadSchemas["external_agent.session.list"].parse({
          sessions: await this.requireExternalAgentSessionService().listSessions()
        });
      case "external_agent.session.read":
        return gatewayResponsePayloadSchemas["external_agent.session.read"].parse(
          await this.requireExternalAgentSessionService().readSession(
            gatewayRequestPayloadSchemas["external_agent.session.read"].parse(request.payload)
          )
        );
      case "external_agent.session.send":
        return gatewayResponsePayloadSchemas["external_agent.session.send"].parse(
          await this.requireExternalAgentSessionService().sendToSession(
            gatewayRequestPayloadSchemas["external_agent.session.send"].parse(request.payload)
          )
        );
      case "external_agent.session.start":
        return gatewayResponsePayloadSchemas["external_agent.session.start"].parse(
          await this.requireExternalAgentSessionService().startSession(
            gatewayRequestPayloadSchemas["external_agent.session.start"].parse(request.payload)
          )
        );
      case "external_agent.session.stop":
        return gatewayResponsePayloadSchemas["external_agent.session.stop"].parse(
          await this.requireExternalAgentSessionService().stopSession(
            gatewayRequestPayloadSchemas["external_agent.session.stop"].parse(request.payload)
          )
        );
      case "external_agent.session.write": {
        const payload = gatewayRequestPayloadSchemas["external_agent.session.write"].parse(request.payload);
        await this.requireExternalAgentSessionService().writeHumanInput(payload.externalSessionId, payload.text);
        return gatewayResponsePayloadSchemas["external_agent.session.write"].parse({ ok: true });
      }
      case "gateway.health":
        gatewayRequestPayloadSchemas["gateway.health"].parse(request.payload);
        return gatewayResponsePayloadSchemas["gateway.health"].parse({
          ok: true,
          status: "ready"
        });
      case "gateway.subscribe":
        return gatewayResponsePayloadSchemas["gateway.subscribe"].parse({
          subscription: gatewaySubscriptionSchema.parse(request.payload)
        });
      case "mcp.list": {
        const query = gatewayRequestPayloadSchemas["mcp.list"].parse(request.payload);
        return gatewayResponsePayloadSchemas["mcp.list"].parse({
          servers: this.options.mcpManager.summarizeServers(query.serverNames ? new Set(query.serverNames) : undefined)
        });
      }
      case "mcp.reconnect": {
        const { serverName } = gatewayRequestPayloadSchemas["mcp.reconnect"].parse(request.payload);
        const status = await this.options.mcpManager.reconnect(serverName);
        return gatewayResponsePayloadSchemas["mcp.reconnect"].parse({
          server: summarizeStatus(
            status,
            this.options.mcpManager.getToolCapabilities().filter((tool) => tool.serverName === serverName)
          )
        });
      }
      case "memory.query":
        return gatewayResponsePayloadSchemas["memory.query"].parse({
          hits: await this.options.memoryService.query(
            gatewayRequestPayloadSchemas["memory.query"].parse(request.payload)
          )
        });
      case "model.health":
        return gatewayResponsePayloadSchemas["model.health"].parse(
          await this.options.modelRuntime.health(
            gatewayRequestPayloadSchemas["model.health"].parse(request.payload).provider
          )
        );
      case "run.cancel":
        return gatewayResponsePayloadSchemas["run.cancel"].parse({
          run: await this.cancelRun(gatewayRequestPayloadSchemas["run.cancel"].parse(request.payload).runId)
        });
      case "run.get":
        return gatewayResponsePayloadSchemas["run.get"].parse({
          run: this.getRunRecord(gatewayRequestPayloadSchemas["run.get"].parse(request.payload).runId)
        });
      case "session.cancel":
        return gatewayResponsePayloadSchemas["session.cancel"].parse({
          run: await this.cancelSession(gatewayRequestPayloadSchemas["session.cancel"].parse(request.payload).sessionId)
        });
      case "session.compact":
        return gatewayResponsePayloadSchemas["session.compact"].parse(
          await this.compactSessionNow(gatewayRequestPayloadSchemas["session.compact"].parse(request.payload).sessionId)
        );
      case "session.create":
        return gatewayResponsePayloadSchemas["session.create"].parse(
          await this.createSession(gatewayRequestPayloadSchemas["session.create"].parse(request.payload), request.id)
        );
      case "session.list": {
        return gatewayResponsePayloadSchemas["session.list"].parse({
          sessions: await this.listSessions(gatewayRequestPayloadSchemas["session.list"].parse(request.payload))
        });
      }
      case "session.message":
        return gatewayResponsePayloadSchemas["session.message"].parse(
          await this.enqueueSessionMessage(
            gatewayRequestPayloadSchemas["session.message"].parse(request.payload),
            request.id
          )
        );
      case "session.resume":
        return gatewayResponsePayloadSchemas["session.resume"].parse(
          await this.enqueueSessionResume(
            gatewayRequestPayloadSchemas["session.resume"].parse(request.payload),
            request.id
          )
        );
      case "session.snapshot":
        return gatewayResponsePayloadSchemas["session.snapshot"].parse(
          await this.getSessionSnapshot(
            gatewayRequestPayloadSchemas["session.snapshot"].parse(request.payload).sessionId
          )
        );
      case "skills.list": {
        const query = gatewayRequestPayloadSchemas["skills.list"].parse(request.payload);
        const discovery = await this.skills.discover(query.cwd ?? this.options.workspaceRoot);
        // At the budget a run's catalog gets now (the configured one, else 2%
        // of the context window).
        const catalogFit = describeCatalogFit(
          discovery.skills,
          resolveSkillCatalogBudgetChars({
            configured: this.skills.settings.maxCatalogChars,
            contextWindowTokens: this.contextWindow.current
          })
        );
        return gatewayResponsePayloadSchemas["skills.list"].parse({
          diagnostics: [...discovery.diagnostics, ...(catalogFit ? [catalogFit] : [])],
          skills: discovery.skills.map(toSkillSummary)
        });
      }
      case "steering.inject":
        return gatewayResponsePayloadSchemas["steering.inject"].parse(
          await this.injectSteering(gatewayRequestPayloadSchemas["steering.inject"].parse(request.payload))
        );
      case "tool.execute":
        return gatewayResponsePayloadSchemas["tool.execute"].parse(
          await this.enqueueToolExecution(
            gatewayRequestPayloadSchemas["tool.execute"].parse(request.payload),
            request.id
          )
        );
      case "tool.search":
        return gatewayResponsePayloadSchemas["tool.search"].parse({
          tools: this.searchTools(gatewayRequestPayloadSchemas["tool.search"].parse(request.payload))
        });
    }
  }

  private async sendChannelMessage(
    input: z.infer<(typeof gatewayRequestPayloadSchemas)["channel.send"]>
  ): Promise<ChannelMessage> {
    const message = await this.requireChannelService().send(input);
    await this.emitChannelMessageEvent(message);
    return message;
  }

  private async cancelRun(runId: string): Promise<GatewayRunRecord> {
    const active = this.activeRunsById.get(runId);
    if (!active) {
      throw gatewayError("not_found", `Gateway run "${runId}" is not active.`);
    }

    if (active.cancelRequested) {
      return active.run;
    }

    active.cancelRequested = true;
    // Said before the abort: the run can end, and announce its terminal
    // record, while this method still waits below. Announced after, this
    // "still running" record came last, and a watcher saw the run come back.
    active.run = gatewayRunRecordSchema.parse({
      ...active.run,
      metadata: {
        ...active.run.metadata,
        cancelRequestedAt: new Date().toISOString()
      },
      updatedAt: new Date().toISOString()
    });
    const requested = active.run;
    await this.emitEvent(
      {
        createdAt: requested.updatedAt,
        id: `run-updated.${requested.id}.${crypto.randomUUID()}`,
        metadata: {},
        payload: requested,
        topic: "run.updated"
      },
      true
    );
    // The flag alone was only read before and after the whole loop, so a cancel
    // stopped nothing: the generation ran to its end and further turns and tool
    // calls kept going. The signal reaches the loop and the model request.
    active.abortController.abort();
    // A tool call waiting on the operator's answer to its server's question
    // would otherwise wait out that question's timeout before the run ends.
    await this.cancelPendingElicitations(requested.sessionId).catch(() => undefined);
    // The run as it is now: possibly finished meanwhile.
    return this.activeRunsById.get(runId)?.run ?? this.finishedRunsById.get(runId) ?? requested;
  }

  private getRunRecord(runId: string): GatewayRunRecord {
    const run = this.activeRunsById.get(runId)?.run ?? this.finishedRunsById.get(runId);
    if (!run) {
      throw gatewayError("not_found", `Run "${runId}" was not found.`);
    }

    return run;
  }

  private rememberFinishedRun(run: GatewayRunRecord): void {
    this.finishedRunsById.set(run.id, run);
    while (this.finishedRunsById.size > FINISHED_RUN_HISTORY_LIMIT) {
      const oldest = this.finishedRunsById.keys().next();
      if (oldest.done) {
        break;
      }
      this.finishedRunsById.delete(oldest.value);
    }
  }

  private async cancelSession(sessionId: string): Promise<GatewayRunRecord> {
    const active = this.activeRunsBySession.get(sessionId);
    if (!active) {
      throw gatewayError("not_found", `Session "${sessionId}" has no active gateway run.`);
    }

    return this.cancelRun(active.run.id);
  }

  // Operator-triggered compaction (CLI `/compact`). Writes the session summary
  // through the same memory lifecycle the loop uses for threshold compaction,
  // then moves the session's compaction watermark to the newest persisted
  // message so later model requests replay only the summary (via the Durable
  // Memory prompt section), the operator's own messages, and whatever arrives
  // afterwards.
  private async compactSessionNow(sessionId: string): Promise<GatewaySessionCompactResult> {
    const session = await this.requireIdleSession(sessionId);
    const pendingApprovals = await this.options.sessions.readPendingApprovals();
    if (Object.values(pendingApprovals).some((entry) => entry.sessionId === sessionId)) {
      throw gatewayError("busy", `Session "${sessionId}" has pending approvals. Resolve them before compacting.`);
    }

    const snapshot = await this.options.sessions.getSessionSnapshot(sessionId);
    const visibleMessages = filterModelVisibleMessages(snapshot?.messages ?? [], session);
    const outcome = await this.options.memoryService.compactSessionDetailed({
      sessionId,
      trigger: "manual"
    });

    const watermarkMessageId = snapshot?.messages.at(-1)?.id;
    const updatedAt = new Date().toISOString();
    const updatedSession = sessionRecordSchema.parse({
      ...session,
      lastActiveAt: updatedAt,
      metadata: watermarkMessageId
        ? foldedSessionMetadata(
            session.metadata,
            watermarkMessageId,
            await this.options.taskStateService.getTaskState(sessionId)
          )
        : session.metadata,
      updatedAt
    });
    // Save the record directly: persistSession() also rewrites resume metadata,
    // which is not what a compaction of an otherwise-untouched session wants.
    await this.options.sessions.saveSession(updatedSession);

    await this.emitEvent(
      {
        createdAt: updatedAt,
        id: `session-updated.${sessionId}.${crypto.randomUUID()}`,
        metadata: {},
        payload: updatedSession,
        topic: "session.updated"
      },
      true
    );
    await this.emitEvent(
      {
        createdAt: updatedAt,
        id: `memory-updated.${sessionId}.${crypto.randomUUID()}`,
        // memory.updated carries no session in its payload; the metadata
        // sessionId is what session-scoped subscriptions (the CLI) filter on.
        metadata: { sessionId },
        payload: {
          entryId: `memory.session-summary.${sessionId}`,
          scope: "session"
        },
        topic: "memory.updated"
      },
      true
    );

    return {
      compactedThroughMessageId: watermarkMessageId,
      // The operator's messages stay visible across the watermark, so count
      // what actually left the model's view.
      hiddenMessageCount: Math.max(
        0,
        visibleMessages.length - filterModelVisibleMessages(snapshot?.messages ?? [], updatedSession).length
      ),
      session: updatedSession,
      summary: outcome.summary,
      summaryPath: outcome.summaryPath
    };
  }

  private async createSession(
    input: z.infer<(typeof gatewayRequestPayloadSchemas)["session.create"]>,
    requestId: string
  ): Promise<z.infer<(typeof gatewayResponsePayloadSchemas)["session.create"]>> {
    const session = await this.persistCreatedSession({
      channelThreadId: input.channelThreadId,
      cwd: input.cwd,
      goal: input.goal,
      metadata: input.metadata,
      modelId: input.modelId,
      provider: input.provider,
      surface: "gateway",
      tags: input.tags,
      title: input.title,
      userId: input.userId
    });

    if (!input.initialMessage) {
      return {
        session
      };
    }

    const run = await this.queueRun({
      kind: "session_create",
      requestId,
      sessionId: session.id
    });
    this.launchSessionRun(run.id, session, {
      requestId,
      userMessages: [this.createUserMessage(session.id, input.initialMessage)]
    });

    return {
      run,
      session
    };
  }

  private async enqueueSessionMessage(
    input: z.infer<(typeof gatewayRequestPayloadSchemas)["session.message"]>,
    requestId: string
  ) {
    const session = await this.requireIdleSession(input.sessionId);
    const run = await this.queueRun({
      kind: "session_message",
      requestId,
      sessionId: session.id
    });
    this.launchSessionRun(run.id, session, {
      requestId,
      userMessages: [this.createUserMessage(session.id, input)]
    });
    return {
      run,
      sessionId: session.id
    };
  }

  private async enqueueSessionResume(
    input: z.infer<(typeof gatewayRequestPayloadSchemas)["session.resume"]>,
    requestId: string
  ) {
    const session = await this.requireIdleSession(input.sessionId);
    const run = await this.queueRun({
      kind: "session_resume",
      requestId,
      sessionId: session.id
    });
    this.launchSessionRun(run.id, session, {
      requestId
    });
    return {
      run,
      sessionId: session.id
    };
  }

  private async enqueueToolExecution(
    input: z.infer<(typeof gatewayRequestPayloadSchemas)["tool.execute"]>,
    requestId: string
  ) {
    const session = await this.requireIdleSession(input.sessionId);
    const run = await this.queueRun({
      kind: "tool_execute",
      requestId,
      sessionId: session.id
    });
    this.launchToolRun(run.id, session, input);
    return {
      run,
      sessionId: session.id
    };
  }

  private async resolveApproval(input: z.infer<(typeof gatewayRequestPayloadSchemas)["approval.resolve"]>) {
    const pending = await this.options.sessions.readPendingApprovals();
    const pendingEntry = pending[input.requestId];
    if (!pendingEntry) {
      throw gatewayError("not_found", `Pending approval "${input.requestId}" was not found.`);
    }

    const resolution: ApprovalResolution = approvalResolutionSchema.parse({
      actor: input.actor ?? "gateway",
      comment: input.comment,
      decidedAt: new Date().toISOString(),
      decision: input.decision,
      id: `approval-resolution.${crypto.randomUUID()}`,
      metadata: {},
      requestId: input.requestId
    });

    const result = await this.approvalCoordinator.resolveApproval({
      actor: resolution.actor,
      autoQueueDeniedCommentAsSteering: true,
      resolution,
      sessionId: pendingEntry.sessionId
    });

    await this.emitEvent(
      {
        createdAt: resolution.decidedAt,
        id: `approval-resolved.${resolution.id}`,
        metadata: {
          sessionId: pendingEntry.sessionId
        },
        payload: resolution,
        topic: "approval.resolved"
      },
      true
    );
    this.elicitationWaiters.get(resolution.requestId)?.(resolution);

    return {
      approval: gatewayApprovalRecordSchema.parse({
        request: pendingEntry.request,
        resolution
      }),
      steeringInjection: result.steeringInjection
    };
  }

  private async injectSteering(input: SteeringInjection): Promise<SteeringInjection> {
    const steering = gatewayRequestPayloadSchemas["steering.inject"].parse(input);
    await this.requireSession(steering.sessionId);
    await this.options.sessions.appendSteeringInjections([steering]);
    return steering;
  }

  private launchSessionRun(
    runId: string,
    session: SessionRecord,
    params: {
      requestId: string;
      userMessages?: Message[];
    }
  ): void {
    this.trackRun(this.guardRun(runId, session.id, () => this.executeSessionRun(runId, session, params)));
  }

  private launchToolRun(
    runId: string,
    session: SessionRecord,
    input: z.infer<(typeof gatewayRequestPayloadSchemas)["tool.execute"]>
  ): void {
    this.trackRun(this.guardRun(runId, session.id, () => this.executeToolRun(runId, session, input)));
  }

  // A run is fire-and-forget: nothing awaits it, so anything that throws after
  // the agent loop returns — event emission, session persistence, the channel
  // relay — used to skip completeRun entirely and leave the run stuck in
  // "running" forever. That is invisible from outside: waitForRun only
  // resolves on a terminal run.updated, so the operator sees the CLI go silent
  // mid-task with no error and no prompt, and the session stays wedged as
  // "busy" because it never leaves activeRunsBySession. Every run must reach a
  // terminal state, even when finalizing it is the only thing left that works.
  private async guardRun(runId: string, sessionId: string, body: () => Promise<void>): Promise<void> {
    try {
      await body();
    } catch (error) {
      await this.failRun(runId, sessionId, normalizeGatewayError(error));
    } finally {
      // The success path flushes per turn from emitSessionRunEvents, which a
      // failing run never reaches: its accumulated reasoning would stay in the
      // map forever (a leak in a long-lived server) and the archive event
      // would be lost for exactly the turns worth reading back. Flushing here
      // covers every exit, and is a no-op for turns already flushed.
      await this.flushPendingReasoningForSession(sessionId);
    }
  }

  private async failRun(runId: string, sessionId: string, error: StructuredError): Promise<void> {
    const active = this.activeRunsById.get(runId);

    try {
      const session = await this.options.sessions.getSession(sessionId);
      if (session) {
        const failedSession = await this.persistSession(session, "failed", {
          activeTurnId: undefined,
          clearError: false,
          statusSummary: error.message,
          structuredError: error
        });
        await this.emitEvent(
          {
            createdAt: failedSession.updatedAt,
            id: `session-updated.${failedSession.id}.${crypto.randomUUID()}`,
            metadata: {},
            payload: failedSession,
            topic: "session.updated"
          },
          true
        );
      }
    } catch (persistError) {
      console.error(`Failed to record the failure of gateway run "${runId}":`, persistError);
    }

    if (!active) {
      return;
    }

    try {
      await this.completeRun(active, {
        completionReason: "session_failed",
        error,
        sessionId,
        status: "failed"
      });
    } catch (completeError) {
      // completeRun already releases the maps in a finally, so reaching here
      // means only the terminal event failed. Say so loudly: a caller waiting
      // on this run is about to wait forever.
      console.error(`Failed to emit the terminal event for gateway run "${runId}":`, completeError);
    }
  }

  // Keeps a handle on every fire-and-forget run so close() can drain them.
  // Without this, an event persisted as a run finalizes can race teardown and
  // attempt to write under a state root that has already been removed.
  private trackRun(promise: Promise<void>): void {
    const tracked = promise.then(
      () => undefined,
      (error: unknown) => {
        // guardRun owns run failures, so anything surfacing here means even
        // failing the run threw. Discarding it silently is exactly how a
        // wedged run stayed invisible, so it goes to stderr.
        console.error("A gateway run failed and could not be finalized:", error);
      }
    );
    this.inFlightRuns.add(tracked);
    void tracked.finally(() => {
      this.inFlightRuns.delete(tracked);
    });
  }

  private async executeSessionRun(
    runId: string,
    session: SessionRecord,
    params: {
      requestId: string;
      userMessages?: Message[];
    }
  ): Promise<void> {
    const active = this.requireActiveRun(runId);
    if (active.cancelRequested) {
      await this.finalizeCancelledRun(active, session);
      return;
    }

    await this.transitionRun(active, {
      status: "running"
    });

    let currentSession = session;
    const materialized = await this.materializeResolvedToolApprovals(currentSession);
    currentSession = materialized.session;

    const onlyDirectToolCalls =
      materialized.origins.length > 0 && materialized.origins.every((origin) => origin.trigger === "gateway_request");
    if (onlyDirectToolCalls && (params.userMessages ?? []).length === 0) {
      await this.finishDirectToolResume(active, materialized);
      return;
    }

    // Optional MCP servers still connecting get the rest of their startup
    // grace; ones that take longer join a later run.
    await Promise.all([this.options.mcpManager.waitForStartup(), this.refreshContextWindow()]);
    const result = await this.agentLoop.run({
      availableTools: resolveVisibleToolDefinitions({
        // Surface the MCP status tool under the lean profile only when there
        // are MCP servers, so the agent can answer "what MCP servers do you
        // have?" without bloating the lean catalog otherwise. Any server the
        // manager knows counts (imported, withheld as untrusted, added by a
        // reload), not only the startup config's own `mcp.servers`.
        // `skill` too; the loop drops it for a session with no skills.
        alwaysInclude: [...(this.options.mcpManager.getServerStatuses().length > 0 ? ["mcp_status"] : []), "skill"],
        registry: this.options.toolRuntime,
        toolsConfig: this.options.config.tools
      }),
      maxConsecutiveNudges: this.options.config.runtime.maxConsecutiveNudges,
      maxIdenticalToolCalls: this.options.config.runtime.maxIdenticalToolCalls,
      maxTurns: this.options.config.runtime.maxTurnsPerRun,
      reasoningContextTurns: this.options.config.runtime.reasoningContextTurns,
      session: currentSession,
      signal: active.abortController.signal,
      userMessages: params.userMessages
    });

    await this.emitSessionRunEvents(result);
    await this.relaySessionOutputsToChannel(result).catch(async (error) => {
      await this.emitLogEvent("warn", error instanceof Error ? error.message : String(error), {
        sessionId: result.session.id
      });
    });

    if (active.cancelRequested) {
      const cancelledSession = await this.persistSession(result.session, "cancelled", {
        activeTurnId: undefined,
        clearError: false,
        statusSummary: "The active gateway run was cancelled."
      });
      await this.emitEvent(
        {
          createdAt: cancelledSession.updatedAt,
          id: `session-updated.${cancelledSession.id}.${crypto.randomUUID()}`,
          metadata: {},
          payload: cancelledSession,
          topic: "session.updated"
        },
        true
      );
      await this.completeRun(active, {
        completionReason: "session_cancelled",
        messageIds: [...materialized.messageIds, ...result.messages.map((message) => message.id)],
        sessionId: cancelledSession.id,
        status: "cancelled",
        toolCallIds: [...materialized.toolCallIds, ...result.toolCalls.map((toolCall) => toolCall.id)],
        turnIds: [...materialized.turnIds, ...result.turns.map((turn) => turn.id)]
      });
      return;
    }

    await this.completeRun(active, {
      completionReason: mapSessionStopReasonToCompletionReason(result.stopReason),
      messageIds: [...materialized.messageIds, ...result.messages.map((message) => message.id)],
      sessionId: result.session.id,
      status: result.stopReason === "failed" ? "failed" : "completed",
      toolCallIds: [...materialized.toolCallIds, ...result.toolCalls.map((toolCall) => toolCall.id)],
      turnIds: [...materialized.turnIds, ...result.turns.map((turn) => turn.id)],
      ...(result.stopReason === "failed"
        ? {
            error: result.session.lastError ?? gatewayError("failed", "The session run failed.")
          }
        : {})
    });
  }

  private async executeToolRun(
    runId: string,
    session: SessionRecord,
    input: z.infer<(typeof gatewayRequestPayloadSchemas)["tool.execute"]>
  ): Promise<void> {
    const active = this.requireActiveRun(runId);
    if (active.cancelRequested) {
      await this.finalizeCancelledRun(active, session);
      return;
    }

    await this.transitionRun(active, {
      status: "running"
    });

    const snapshot = await this.options.sessions.getSessionSnapshot(session.id);
    const turn = turnRecordSchema.parse({
      id: `turn.gateway.${crypto.randomUUID()}`,
      metadata: {},
      sequence: snapshot?.turns.length ?? 0,
      sessionId: session.id,
      startedAt: new Date().toISOString(),
      status: "running",
      trigger: "gateway_request"
    });

    const updatedSession = await this.persistSession(session, "awaiting_tool_execution", {
      activeTurnId: turn.id,
      clearError: true,
      statusSummary: `Executing gateway tool "${input.toolName}".`
    });

    const toolCall = toolCallRecordSchema.parse({
      arguments: input.arguments,
      id: `tool-call.gateway.${crypto.randomUUID()}`,
      inputText: input.inputText,
      metadata: input.metadata,
      sessionId: session.id,
      startedAt: new Date().toISOString(),
      status: "pending",
      toolName: input.toolName,
      turnId: turn.id
    });

    const outcome = await this.options.toolRuntime.execute(toolCall, {
      session: updatedSession,
      turn
    });

    await this.options.sessions.appendToolCalls([outcome.toolCall]);
    let resultMessageId: string | undefined;

    turn.requestedToolCallIds = [outcome.toolCall.id];
    turn.executedToolCallIds = [outcome.toolCall.id];

    if (outcome.resultMessage) {
      await this.options.sessions.appendMessages([outcome.resultMessage]);
      turn.outputMessageIds.push(outcome.resultMessage.id);
      resultMessageId = outcome.resultMessage.id;
      await this.emitEvent(
        {
          createdAt: outcome.resultMessage.createdAt,
          id: `message-created.${outcome.resultMessage.id}`,
          metadata: {},
          payload: outcome.resultMessage,
          topic: "message.created"
        },
        true
      );
    }

    if (outcome.approvalRequest) {
      await this.options.sessions.appendApprovalRequest(outcome.approvalRequest);
      turn.approvalRequestIds = [outcome.approvalRequest.id];
      turn.completedAt = new Date().toISOString();
      turn.status = "waiting_for_approval";
      turn.summary = `Gateway tool "${input.toolName}" is waiting for approval.`;
      await this.options.sessions.appendTurn(turn);
      await this.emitApprovalRequested(outcome.approvalRequest);
      await this.emitEvent(
        {
          createdAt: turn.completedAt,
          id: `turn-updated.${turn.id}`,
          metadata: {},
          payload: turn,
          topic: "turn.updated"
        },
        true
      );
      await this.emitEvent(
        {
          createdAt: outcome.toolCall.completedAt ?? outcome.toolCall.startedAt,
          id: `tool-updated.${outcome.toolCall.id}`,
          metadata: {},
          payload: {
            ...outcome.toolCall,
            resultMessageId
          },
          topic: "tool.updated"
        },
        true
      );

      const awaitingApprovalSession = await this.persistSession(updatedSession, "awaiting_approval", {
        activeTurnId: turn.id,
        clearError: true,
        pendingApprovalIds: [outcome.approvalRequest.id],
        pendingToolCallIds: [outcome.toolCall.id],
        statusSummary: `Waiting for approval to execute gateway tool "${input.toolName}".`
      });
      await this.emitEvent(
        {
          createdAt: awaitingApprovalSession.updatedAt,
          id: `session-updated.${awaitingApprovalSession.id}.${crypto.randomUUID()}`,
          metadata: {},
          payload: awaitingApprovalSession,
          topic: "session.updated"
        },
        true
      );
      await this.completeRun(active, {
        approvalRequestIds: [outcome.approvalRequest.id],
        completionReason: "tool_awaiting_approval",
        messageIds: resultMessageId ? [resultMessageId] : [],
        sessionId: session.id,
        status: "completed",
        toolCallIds: [outcome.toolCall.id],
        turnIds: [turn.id]
      });
      return;
    }

    turn.completedAt = new Date().toISOString();
    turn.status = outcome.toolCall.status === "failed" ? "failed" : "completed";
    turn.summary =
      outcome.toolCall.status === "failed"
        ? `Gateway tool "${input.toolName}" failed.`
        : `Gateway tool "${input.toolName}" completed.`;
    await this.options.sessions.appendTurn(turn);

    // A skill this call loaded is recorded, as the agent loop records one.
    const finalSession = await this.persistSession(
      recordSkillLoads(updatedSession, [{ resultMessageId, toolCall: outcome.toolCall }]),
      "awaiting_user",
      {
        activeTurnId: undefined,
        clearError: outcome.toolCall.status !== "failed",
        pendingApprovalIds: [],
        pendingToolCallIds: [],
        statusSummary:
          outcome.toolCall.status === "failed"
            ? `Gateway tool "${input.toolName}" failed.`
            : `Gateway tool "${input.toolName}" completed.`
      }
    );

    await this.emitEvent(
      {
        createdAt: outcome.toolCall.completedAt ?? outcome.toolCall.startedAt,
        id: `tool-updated.${outcome.toolCall.id}`,
        metadata: {},
        payload: {
          ...outcome.toolCall,
          resultMessageId
        },
        topic: "tool.updated"
      },
      true
    );
    await this.emitEvent(
      {
        createdAt: turn.completedAt,
        id: `turn-updated.${turn.id}`,
        metadata: {},
        payload: turn,
        topic: "turn.updated"
      },
      true
    );
    await this.emitEvent(
      {
        createdAt: finalSession.updatedAt,
        id: `session-updated.${finalSession.id}.${crypto.randomUUID()}`,
        metadata: {},
        payload: finalSession,
        topic: "session.updated"
      },
      true
    );

    if (active.cancelRequested) {
      await this.finalizeCancelledRun(active, finalSession);
      return;
    }

    await this.completeRun(active, {
      completionReason: outcome.toolCall.status === "failed" ? "tool_failed" : "tool_succeeded",
      error:
        outcome.toolCall.status === "failed"
          ? (outcome.toolCall.error ?? gatewayError("failed", "The tool execution failed."))
          : undefined,
      messageIds: resultMessageId ? [resultMessageId] : [],
      sessionId: finalSession.id,
      status: outcome.toolCall.status === "failed" ? "failed" : "completed",
      toolCallIds: [outcome.toolCall.id],
      turnIds: [turn.id]
    });
  }

  /**
   * Archives a turn's provider-native reasoning as one persisted event.
   *
   * The live stream is thousands of unpersisted deltas; this is the durable
   * record an operator can read back later. It never reaches the transcript,
   * so it is never replayed into the model's context.
   */
  private async flushTurnReasoning(turnId: string): Promise<void> {
    const pending = this.pendingReasoningByTurn.get(turnId);
    this.pendingReasoningByTurn.delete(turnId);
    if (!pending || pending.text.trim().length === 0) {
      return;
    }

    await this.emitEvent(
      {
        createdAt: new Date().toISOString(),
        id: `message-reasoning-turn.${turnId}`,
        metadata: { sessionId: pending.sessionId },
        payload: {
          delta: pending.text,
          final: true,
          sessionId: pending.sessionId,
          turnId
        },
        topic: "message.reasoning"
      },
      true
    );
  }

  /**
   * Flushes any reasoning still buffered for a session's turns.
   *
   * The per-turn flush runs off `result.turns`, which only exists when the
   * loop returned normally. This is the catch-all for every other way a run
   * ends, so nothing accumulates in `pendingReasoningByTurn` indefinitely.
   */
  private async flushPendingReasoningForSession(sessionId: string): Promise<void> {
    const staleTurnIds = Array.from(this.pendingReasoningByTurn.entries())
      .filter(([, pending]) => pending.sessionId === sessionId)
      .map(([turnId]) => turnId);

    for (const turnId of staleTurnIds) {
      // Emission failures must not replace the run's own outcome; the buffer
      // entry is already removed by flushTurnReasoning before it emits.
      await this.flushTurnReasoning(turnId).catch(() => undefined);
    }
  }

  private async emitSessionRunEvents(result: Awaited<ReturnType<AgentLoop["run"]>>): Promise<void> {
    for (const approvalRequest of result.approvalRequests) {
      await this.emitApprovalRequested(approvalRequest);
    }

    for (const message of result.messages) {
      await this.emitEvent(
        {
          createdAt: message.createdAt,
          id: `message-created.${message.id}`,
          metadata: {},
          payload: message,
          topic: "message.created"
        },
        true
      );
    }

    // No tool.updated loop here on purpose: the agent loop's onToolUpdated
    // hook already emitted one per tool call as it settled, and re-emitting
    // would duplicate the event id in the log.
    for (const turn of result.turns) {
      await this.flushTurnReasoning(turn.id);
      await this.emitEvent(
        {
          createdAt: turn.completedAt ?? turn.startedAt,
          id: `turn-updated.${turn.id}`,
          metadata: {},
          payload: turn,
          topic: "turn.updated"
        },
        true
      );
    }

    await this.emitEvent(
      {
        createdAt: result.session.updatedAt,
        id: `session-updated.${result.session.id}.${crypto.randomUUID()}`,
        metadata: {},
        payload: result.session,
        topic: "session.updated"
      },
      true
    );
  }

  private async persistCreatedSession(input: {
    channelThreadId?: string;
    cwd: string;
    goal: string;
    metadata: Record<string, JsonValue>;
    modelId?: string;
    provider?: string;
    surface: "channel" | "gateway";
    tags: string[];
    title: string;
    userId?: string;
  }): Promise<SessionRecord> {
    const now = new Date().toISOString();
    const session = sessionRecordSchema.parse({
      channelThreadId: input.channelThreadId,
      createdAt: now,
      cwd: input.cwd,
      goal: input.goal,
      id: `session.${crypto.randomUUID()}`,
      lastActiveAt: now,
      metadata: {
        ...input.metadata,
        ...(input.modelId ? { activeModelId: input.modelId } : {}),
        ...(input.provider ? { activeProvider: input.provider } : {})
      },
      status: "idle",
      tags: input.tags,
      title: input.title,
      updatedAt: now,
      userId: input.userId
    });

    await this.options.sessions.saveSession(session);
    await this.options.sessions.saveResumeMetadata(session.id, {
      pendingApprovalIds: [],
      pendingToolCallIds: [],
      surface: input.surface,
      updatedAt: now
    });
    await this.emitEvent(
      {
        createdAt: now,
        id: `session-updated.${session.id}.${crypto.randomUUID()}`,
        metadata: {},
        payload: session,
        topic: "session.updated"
      },
      true
    );
    return session;
  }

  private async ensureSessionForChannelMessage(message: ChannelMessage): Promise<ChannelMessage> {
    if (!this.options.channelService) {
      return message;
    }

    const existingRoute = await this.options.channelService.getRouteForIdentity(message.identity);
    if (existingRoute) {
      return channelMessageSchema.parse({
        ...message,
        sessionId: existingRoute.sessionId
      });
    }

    const session = await this.persistCreatedSession({
      channelThreadId: buildChannelThreadId(message.identity),
      cwd: this.options.workspaceRoot,
      goal: buildChannelSessionGoal(message),
      metadata: buildChannelSessionMetadata(message),
      surface: "channel",
      tags: [`channel:${message.identity.channel}`],
      title: buildChannelSessionTitle(message),
      userId: message.identity.userId
    });

    await this.options.channelService.ensureRoute({
      identity: message.identity,
      lastInboundMessageId: message.id,
      metadata: message.metadata,
      sessionId: session.id
    });

    return channelMessageSchema.parse({
      ...message,
      sessionId: session.id
    });
  }

  private async maybeHandleChannelCommand(
    message: ChannelMessage
  ): Promise<{ handled: boolean; run: GatewayRunRecord | null }> {
    const command = parseChannelCommand(message);
    if (!command || !message.sessionId) {
      return {
        handled: false,
        run: null
      };
    }

    // Security review H6: control commands act on the operator's behalf —
    // `/approve` resolves a pending approval and resumes the run — so the
    // sender must be an allowlisted operator. Checked once here, before the
    // dispatch, so no future command kind can be added past the gate. Note the
    // command is still *handled* (not passed through to the model as a chat
    // message): a refused `/approve` must not become a prompt.
    const operatorIdentities = resolveChannelOperatorIdentities(this.options.config.channels, message.identity.channel);
    if (!isAuthorizedChannelOperator(message.identity, operatorIdentities)) {
      await this.sendChannelTextReply(message, buildUnauthorizedChannelCommandText(message.identity));
      return {
        handled: true,
        run: null
      };
    }

    switch (command.kind) {
      case "approval":
        return {
          handled: true,
          run: await this.handleChannelApprovalCommand(message, command)
        };
      case "help":
        await this.sendChannelTextReply(message, buildChannelHelpText());
        return {
          handled: true,
          run: null
        };
      case "steering":
        return {
          handled: true,
          run: await this.handleChannelSteeringCommand(message, command)
        };
    }
  }

  private async handleChannelApprovalCommand(
    message: ChannelMessage,
    command: Extract<ChannelCommand, { kind: "approval" }>
  ): Promise<GatewayRunRecord | null> {
    const session = await this.requireSession(message.sessionId as string);
    const requestId = command.requestId ?? (await this.resolveLatestPendingApprovalId(session.id));
    const pending = requestId ? (await this.options.sessions.readPendingApprovals())[requestId] : undefined;
    // A conversation answers its own session's approvals only: an id seen
    // elsewhere must not resolve another session's request from here.
    if (pending && pending.request.sessionId !== session.id) {
      await this.sendChannelTextReply(message, "That approval belongs to another conversation.");
      return null;
    }
    // An MCP server's question is answered while the run waits on it: the
    // tool call that asked is still open, and nothing needs resuming.
    if (requestId && pending && isLiveApproval(pending.request)) {
      const resolved = await this.resolveApproval({
        actor: "channel",
        comment: command.comment,
        decision: command.decision,
        requestId
      });
      await this.sendChannelTextReply(
        message,
        buildChannelApprovalAcknowledgement(
          resolved.approval.request,
          resolved.approval.resolution as ApprovalResolution
        )
      );
      return null;
    }
    if (this.activeRunsBySession.has(session.id)) {
      await this.sendChannelTextReply(
        message,
        `Session "${session.title}" is busy right now. Please retry once the current run finishes.`
      );
      return null;
    }
    if (!requestId) {
      await this.sendChannelTextReply(message, "There are no pending approvals for this conversation.");
      return null;
    }

    const resolved = await this.resolveApproval({
      actor: "channel",
      comment: command.comment,
      decision: command.decision,
      requestId
    });
    const approval = resolved.approval;
    await this.sendChannelTextReply(
      message,
      buildChannelApprovalAcknowledgement(approval.request, approval.resolution as ApprovalResolution)
    );
    return this.queueSessionResumeRun(session, `gateway-request.channel-approval.${crypto.randomUUID()}`);
  }

  private async handleChannelSteeringCommand(
    message: ChannelMessage,
    command: Extract<ChannelCommand, { kind: "steering" }>
  ): Promise<GatewayRunRecord | null> {
    const session = await this.requireSession(message.sessionId as string);
    const busy = this.activeRunsBySession.has(session.id);
    const steering = await this.injectSteering({
      createdAt: new Date().toISOString(),
      id: `steering.channel.${crypto.randomUUID()}`,
      message: command.message,
      metadata: {
        // Only an allowlisted operator gets this far (maybeHandleChannelCommand).
        [CHANNEL_OPERATOR_METADATA_KEY]: true,
        channelCommandMessageId: message.id
      },
      sessionId: session.id,
      source: "channel",
      state: "queued"
    });
    // A running task reads queued steering before its next step, so steering
    // sent mid-run no longer has to wait for (or be retried after) the run.
    if (busy) {
      await this.sendChannelTextReply(
        message,
        `Queued steering for "${session.title}". The running task will read it before its next step.`
      );
      return null;
    }
    await this.sendChannelTextReply(message, `Queued steering for "${session.title}".`);
    return this.queueSessionResumeRun(session, `gateway-request.channel-steering.${steering.id}`);
  }

  private async queueSessionResumeRun(session: SessionRecord, requestId: string): Promise<GatewayRunRecord> {
    const run = await this.queueRun({
      kind: "session_resume",
      requestId,
      sessionId: session.id
    });
    this.launchSessionRun(run.id, session, {
      requestId
    });
    return run;
  }

  private async materializeResolvedToolApprovals(session: SessionRecord): Promise<MaterializedApprovalResume> {
    const snapshot = await this.options.sessions.getSessionSnapshot(session.id);
    const pendingToolCallIds = snapshot?.resumeMetadata?.pendingToolCallIds ?? [];
    if (pendingToolCallIds.length === 0) {
      return {
        messageIds: [],
        origins: [],
        remainingPendingApprovalCount: 0,
        session,
        toolCallIds: [],
        turnIds: []
      };
    }

    const latestResolutions = new Map<string, ApprovalResolution>();
    for (const resolution of snapshot?.approvalResolutions ?? []) {
      const previous = latestResolutions.get(resolution.requestId);
      if (!previous || previous.decidedAt.localeCompare(resolution.decidedAt) < 0) {
        latestResolutions.set(resolution.requestId, resolution);
      }
    }

    const pendingApprovals = await this.options.sessions.readPendingApprovals();
    const remainingPendingApprovalIds = Object.values(pendingApprovals)
      .filter((entry) => entry.sessionId === session.id)
      .map((entry) => entry.request.id);
    const remainingPendingToolCallIds: string[] = [];
    const messageIds: string[] = [];
    const origins: MaterializedApprovalResume["origins"] = [];
    const toolCallIds: string[] = [];
    const turnIds: string[] = [];

    for (const pendingToolCallId of pendingToolCallIds) {
      const pendingToolCall = snapshot?.toolCalls.find((toolCall) => toolCall.id === pendingToolCallId);
      if (!pendingToolCall?.approvalRequestId) {
        continue;
      }

      const resolution = latestResolutions.get(pendingToolCall.approvalRequestId);
      if (!resolution) {
        remainingPendingToolCallIds.push(pendingToolCallId);
        continue;
      }

      const materialized =
        resolution.decision === "approved"
          ? await this.executeApprovedPendingToolCall(session, snapshot, pendingToolCall, resolution)
          : this.materializeDeclinedPendingToolCall(session, snapshot, pendingToolCall, resolution);
      session = recordSkillLoads(session, [
        { resultMessageId: materialized.message?.id, toolCall: materialized.toolCall }
      ]);

      await this.options.sessions.appendToolCalls([materialized.toolCall]);
      await this.options.sessions.appendTurn(materialized.turn);
      toolCallIds.push(materialized.toolCall.id);
      turnIds.push(materialized.turn.id);
      origins.push({
        status: materialized.toolCall.status,
        trigger: snapshot?.turns.find((turn) => turn.id === pendingToolCall.turnId)?.trigger
      });

      if (materialized.message) {
        await this.options.sessions.appendMessages([materialized.message]);
        messageIds.push(materialized.message.id);
        await this.emitEvent(
          {
            createdAt: materialized.message.createdAt,
            id: `message-created.${materialized.message.id}`,
            metadata: {},
            payload: materialized.message,
            topic: "message.created"
          },
          true
        );
      }

      await this.emitEvent(
        {
          createdAt: materialized.toolCall.completedAt ?? materialized.toolCall.startedAt,
          id: `tool-updated.${materialized.toolCall.id}`,
          metadata: {},
          payload: {
            ...materialized.toolCall,
            resultMessageId: materialized.message?.id
          },
          topic: "tool.updated"
        },
        true
      );
      await this.emitEvent(
        {
          createdAt: materialized.turn.completedAt ?? materialized.turn.startedAt,
          id: `turn-updated.${materialized.turn.id}`,
          metadata: {},
          payload: materialized.turn,
          topic: "turn.updated"
        },
        true
      );
    }

    if (toolCallIds.length === 0 && turnIds.length === 0 && messageIds.length === 0) {
      return {
        messageIds,
        origins,
        remainingPendingApprovalCount: remainingPendingApprovalIds.length,
        session,
        toolCallIds,
        turnIds
      };
    }

    const updatedSession = await this.persistSession(
      session,
      remainingPendingApprovalIds.length > 0 ? "awaiting_approval" : "idle",
      {
        activeTurnId: undefined,
        clearError: true,
        pendingApprovalIds: remainingPendingApprovalIds,
        pendingToolCallIds: remainingPendingToolCallIds,
        statusSummary:
          remainingPendingApprovalIds.length > 0
            ? `Waiting for ${remainingPendingApprovalIds.length} approval decision(s).`
            : "Continuing after the latest approval resolution."
      }
    );
    await this.emitEvent(
      {
        createdAt: updatedSession.updatedAt,
        id: `session-updated.${updatedSession.id}.${crypto.randomUUID()}`,
        metadata: {},
        payload: updatedSession,
        topic: "session.updated"
      },
      true
    );

    return {
      messageIds,
      origins,
      remainingPendingApprovalCount: remainingPendingApprovalIds.length,
      session: updatedSession,
      toolCallIds,
      turnIds
    };
  }

  // Resuming a direct `tool.execute` that paused for approval runs the approved
  // call and stops there. Continuing into the agent loop handed the session to
  // the model, which went on to work on the session's goal by itself (observed:
  // six further turns reading files nobody asked about).
  private async finishDirectToolResume(active: ActiveGatewayRun, materialized: MaterializedApprovalResume) {
    const stillWaiting = materialized.remainingPendingApprovalCount > 0;
    const finalSession = stillWaiting
      ? materialized.session
      : await this.persistSession(materialized.session, "awaiting_user", {
          activeTurnId: undefined,
          clearError: true,
          statusSummary: "The approved tool call ran."
        });
    if (!stillWaiting) {
      await this.emitEvent(
        {
          createdAt: finalSession.updatedAt,
          id: `session-updated.${finalSession.id}.${crypto.randomUUID()}`,
          metadata: {},
          payload: finalSession,
          topic: "session.updated"
        },
        true
      );
    }
    await this.completeRun(active, {
      completionReason: stillWaiting
        ? "tool_awaiting_approval"
        : materialized.origins.every((origin) => origin.status === "succeeded")
          ? "tool_succeeded"
          : "tool_failed",
      messageIds: materialized.messageIds,
      sessionId: finalSession.id,
      status: "completed",
      toolCallIds: materialized.toolCallIds,
      turnIds: materialized.turnIds
    });
  }

  private async executeApprovedPendingToolCall(
    session: SessionRecord,
    snapshot: SessionSnapshot | null,
    pendingToolCall: ToolCallRecord,
    resolution: ApprovalResolution
  ): Promise<{
    message?: Message;
    toolCall: ToolCallRecord;
    turn: z.infer<typeof turnRecordSchema>;
  }> {
    const startedAt = new Date().toISOString();
    const turn = turnRecordSchema.parse({
      approvalRequestIds: [resolution.requestId],
      executedToolCallIds: [],
      id: `turn.approval.${crypto.randomUUID()}`,
      inputMessageIds: [],
      metadata: {
        approvalResolutionId: resolution.id,
        resumedFromToolCallId: pendingToolCall.id
      },
      outputMessageIds: [],
      requestedToolCallIds: [],
      sequence: snapshot?.turns.length ?? 0,
      sessionId: session.id,
      startedAt,
      status: "running",
      trigger: "approval_resolution"
    });

    const resumedCall = toolCallRecordSchema.parse({
      ...pendingToolCall,
      completedAt: undefined,
      error: undefined,
      id: `tool-call.resumed.${crypto.randomUUID()}`,
      metadata: {
        ...pendingToolCall.metadata,
        approvalResolutionId: resolution.id,
        // The operator's resolution comment is the answer for interactive
        // tools (e.g. ask_user_question) and useful operator context for
        // every other tool resumed after approval.
        ...(typeof resolution.comment === "string" ? { approvalResolutionComment: resolution.comment } : {}),
        resumedFromToolCallId: pendingToolCall.id
      },
      result: undefined,
      startedAt,
      status: "pending",
      turnId: turn.id
    });
    const outcome = await this.options.toolRuntime.executeApproved(resumedCall, {
      session,
      turn
    });
    turn.requestedToolCallIds = [outcome.toolCall.id];
    turn.executedToolCallIds = [outcome.toolCall.id];
    if (outcome.resultMessage) {
      turn.outputMessageIds = [outcome.resultMessage.id];
    }
    turn.completedAt = outcome.toolCall.completedAt ?? new Date().toISOString();
    turn.status = outcome.toolCall.status === "failed" ? "failed" : "completed";
    turn.summary =
      outcome.toolCall.status === "failed"
        ? `Approved tool "${outcome.toolCall.toolName}" failed during resume.`
        : `Approved tool "${outcome.toolCall.toolName}" resumed successfully.`;

    return {
      message: outcome.resultMessage,
      toolCall: outcome.toolCall,
      turn
    };
  }

  private materializeDeclinedPendingToolCall(
    session: SessionRecord,
    snapshot: SessionSnapshot | null,
    pendingToolCall: ToolCallRecord,
    resolution: ApprovalResolution
  ): {
    message: Message;
    toolCall: ToolCallRecord;
    turn: z.infer<typeof turnRecordSchema>;
  } {
    const startedAt = new Date().toISOString();
    const turn = turnRecordSchema.parse({
      approvalRequestIds: [resolution.requestId],
      executedToolCallIds: [],
      id: `turn.approval.${crypto.randomUUID()}`,
      inputMessageIds: [],
      metadata: {
        approvalResolutionId: resolution.id,
        resumedFromToolCallId: pendingToolCall.id
      },
      outputMessageIds: [],
      requestedToolCallIds: [],
      sequence: snapshot?.turns.length ?? 0,
      sessionId: session.id,
      startedAt,
      status: "completed",
      trigger: "approval_resolution"
    });
    const toolCall = toolCallRecordSchema.parse({
      ...pendingToolCall,
      completedAt: startedAt,
      error: buildDeclinedToolError(pendingToolCall.toolName, resolution),
      id: `tool-call.resolved.${crypto.randomUUID()}`,
      metadata: {
        ...pendingToolCall.metadata,
        approvalResolutionId: resolution.id,
        resumedFromToolCallId: pendingToolCall.id
      },
      result: {
        approvalDecision: resolution.decision
      },
      startedAt,
      status: resolution.decision === "cancelled" ? "cancelled" : "failed",
      turnId: turn.id
    });
    const message = createToolResultMessage(session.id, turn.id, toolCall);
    turn.outputMessageIds = [message.id];
    turn.summary = `Approval ${resolution.decision} prevented "${pendingToolCall.toolName}" from running.`;
    return {
      message,
      toolCall,
      turn
    };
  }

  private async relaySessionOutputsToChannel(result: Awaited<ReturnType<AgentLoop["run"]>>): Promise<void> {
    if (!this.options.channelService) {
      return;
    }

    const route = await this.options.channelService.getRouteForSession(result.session.id);
    if (!route) {
      return;
    }

    const relayedText: string[] = [];
    for (const message of result.messages.filter((entry) => shouldRelayMessageToChannel(entry))) {
      // Tool-call parts are runtime bookkeeping, not user-facing content.
      const relayParts = message.parts.filter((part) => part.kind !== "tool_call");
      if (relayParts.length === 0) {
        continue;
      }
      const text = relayParts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n");
      // The completion summary follows the reply it may merely repeat.
      if (
        (message.tags ?? []).includes(COMPLETION_SUMMARY_MESSAGE_TAG) &&
        relayParts.every((part) => part.kind === "text") &&
        repeatsShownText(text, relayedText.join("\n"))
      ) {
        continue;
      }
      relayedText.push(text);
      await this.sendChannelMessage({
        attachments: collectArtifactsFromMessage(message),
        identity: route.identity,
        metadata: {
          gatewayMessageId: message.id,
          messageRole: message.role,
          source: message.source,
          ...(message.turnId ? { turnId: message.turnId } : {})
        },
        parts: relayParts,
        replyToId: route.lastInboundMessageId,
        sessionId: result.session.id
      });
    }

    for (const approvalRequest of result.approvalRequests) {
      await this.relayApprovalToChannel(approvalRequest);
    }
  }

  private async cancelPendingElicitations(sessionId: string): Promise<void> {
    const pending = await this.options.sessions.readPendingApprovals();
    for (const [requestId, entry] of Object.entries(pending)) {
      if (entry.sessionId === sessionId && isLiveApproval(entry.request)) {
        await this.resolveApproval({ actor: "system", decision: "cancelled", requestId });
      }
    }
  }

  /** Shows an approval prompt in the channel conversation bound to its session, when there is one. */
  private async relayApprovalToChannel(approvalRequest: ApprovalRequest): Promise<void> {
    const route = await this.options.channelService?.getRouteForSession(approvalRequest.sessionId);
    if (!route) {
      return;
    }
    await this.sendChannelMessage({
      attachments: [],
      identity: route.identity,
      metadata: {
        approvalRequestId: approvalRequest.id
      },
      parts: [
        {
          kind: "text",
          text: buildChannelApprovalPrompt(approvalRequest)
        }
      ],
      replyToId: route.lastInboundMessageId,
      sessionId: approvalRequest.sessionId
    });
  }

  private async resolveLatestPendingApprovalId(sessionId: string): Promise<string | null> {
    const pending = await this.options.sessions.readPendingApprovals();
    const latest = Object.values(pending)
      .filter((entry) => entry.sessionId === sessionId)
      .sort((left, right) => right.request.createdAt.localeCompare(left.request.createdAt))[0];
    return latest?.request.id ?? null;
  }

  private async sendChannelTextReply(message: ChannelMessage, text: string): Promise<void> {
    await this.sendChannelMessage({
      attachments: [],
      identity: message.identity,
      metadata: {
        channelCommandMessageId: message.id
      },
      parts: [
        {
          kind: "text",
          text
        }
      ],
      replyToId: message.id,
      sessionId: message.sessionId
    }).catch(async (error) => {
      await this.emitLogEvent("warn", error instanceof Error ? error.message : String(error), {
        ...(message.sessionId ? { sessionId: message.sessionId } : {})
      });
    });
  }

  /**
   * A provider can answer with a model other than the one asked for (LM
   * Studio serving whatever is loaded, say), and the only trace was the model
   * id on the response: a session could run on the wrong model and nobody
   * would know. Warned once per session.
   */
  private noteAnsweringModel(
    request: Parameters<LanguageModelRuntime["generate"]>[0],
    response: LanguageModelResponse
  ): LanguageModelResponse {
    const sessionId = request.sessionId;
    if (!sessionId || this.modelMismatchNotedSessions.has(sessionId)) {
      return response;
    }
    let requestedModel = request.modelId;
    try {
      requestedModel ??= this.options.modelRuntime.resolveRequest(request).modelId;
    } catch {
      return response;
    }
    if (!requestedModel || isSameModel(requestedModel, response.modelId)) {
      return response;
    }

    this.modelMismatchNotedSessions.add(sessionId);
    void this.emitLogEvent(
      "warn",
      `The provider answered with model "${response.modelId}", not the requested "${requestedModel}". It may be serving whatever model is loaded; check the loaded model, or the model id in your config.`,
      {
        answeredModel: response.modelId,
        code: MODEL_MISMATCH_LOG_CODE,
        providerId: response.provider,
        requestedModel,
        sessionId
      }
    ).catch(() => undefined);
    return response;
  }

  private async emitLogEvent(
    level: "debug" | "error" | "info" | "warn",
    message: string,
    metadata: Record<string, JsonValue> = {}
  ): Promise<void> {
    await this.emitEvent(
      {
        createdAt: new Date().toISOString(),
        id: `log.${level}.${crypto.randomUUID()}`,
        metadata,
        payload: {
          level,
          message
        },
        topic: "log.emitted"
      },
      true
    );
  }

  private createUserMessage(sessionId: string, input: z.infer<typeof gatewayMessageInputSchema>): Message {
    return messageSchema.parse({
      createdAt: new Date().toISOString(),
      id: `message.gateway.user.${crypto.randomUUID()}`,
      metadata: input.metadata,
      parts: buildMessageParts(input),
      role: "user",
      sessionId,
      source: "user",
      tags: input.tags
    });
  }

  private createChannelUserMessage(message: ChannelMessage): Message {
    return messageSchema.parse({
      createdAt: message.createdAt,
      id: `message.channel.user.${message.id}`,
      metadata: {
        ...message.metadata,
        [CHANNEL_OPERATOR_METADATA_KEY]: isAuthorizedChannelOperator(
          message.identity,
          resolveChannelOperatorIdentities(this.options.config.channels, message.identity.channel)
        ),
        channelAccountId: message.identity.accountId,
        channelDisplayName: message.identity.displayName ?? null,
        channelId: message.identity.channel,
        channelMessageId: message.id,
        channelUserId: message.identity.userId,
        ...(message.identity.roomId ? { channelRoomId: message.identity.roomId } : {})
      },
      parts: message.parts,
      role: "user",
      sessionId: message.sessionId!,
      source: "channel",
      tags: [`channel:${message.identity.channel}`]
    });
  }

  private async queueRun(params: {
    kind: GatewayRunKind;
    requestId: string;
    sessionId: string;
  }): Promise<GatewayRunRecord> {
    const run = gatewayRunRecordSchema.parse({
      createdAt: new Date().toISOString(),
      id: `gateway-run.${crypto.randomUUID()}`,
      kind: params.kind,
      metadata: {},
      requestId: params.requestId,
      sessionId: params.sessionId,
      status: "queued",
      updatedAt: new Date().toISOString()
    });
    const active: ActiveGatewayRun = {
      abortController: new AbortController(),
      cancelRequested: false,
      run
    };
    this.activeRunsById.set(run.id, active);
    this.activeRunsBySession.set(run.sessionId, active);
    await this.emitEvent(
      {
        createdAt: run.createdAt,
        id: `run-updated.${run.id}.${crypto.randomUUID()}`,
        metadata: {},
        payload: run,
        topic: "run.updated"
      },
      true
    );
    return run;
  }

  private async transitionRun(
    active: ActiveGatewayRun,
    patch: Partial<Omit<GatewayRunRecord, "id" | "kind" | "sessionId" | "createdAt" | "requestId">>
  ): Promise<void> {
    active.run = gatewayRunRecordSchema.parse({
      ...active.run,
      ...patch,
      approvalRequestIds: patch.approvalRequestIds ?? active.run.approvalRequestIds,
      messageIds: patch.messageIds ?? active.run.messageIds,
      toolCallIds: patch.toolCallIds ?? active.run.toolCallIds,
      turnIds: patch.turnIds ?? active.run.turnIds,
      updatedAt: new Date().toISOString()
    });
    await this.emitEvent(
      {
        createdAt: active.run.updatedAt,
        id: `run-updated.${active.run.id}.${crypto.randomUUID()}`,
        metadata: {},
        payload: active.run,
        topic: "run.updated"
      },
      true
    );
  }

  private async completeRun(
    active: ActiveGatewayRun,
    params: {
      approvalRequestIds?: string[];
      completionReason?: GatewayRunCompletionReason;
      error?: StructuredError;
      messageIds?: string[];
      sessionId: string;
      status: GatewayRunRecord["status"];
      toolCallIds?: string[];
      turnIds?: string[];
    }
  ): Promise<void> {
    await this.transitionRun(active, {
      approvalRequestIds: params.approvalRequestIds ?? active.run.approvalRequestIds,
      completedAt: new Date().toISOString(),
      completionReason: params.completionReason,
      error: params.error,
      messageIds: params.messageIds ?? active.run.messageIds,
      sessionId: params.sessionId,
      status: params.status,
      toolCallIds: params.toolCallIds ?? active.run.toolCallIds,
      turnIds: params.turnIds ?? active.run.turnIds
    } as Partial<GatewayRunRecord>).finally(() => {
      // Release the run even if emitting the terminal event failed. These maps
      // are the "session is busy" check, so a leaked entry rejects every later
      // request for that session with no way to clear it short of a restart.
      this.rememberFinishedRun(active.run);
      this.activeRunsById.delete(active.run.id);
      // `activeRunsBySession` is keyed by sessionId, which is reused across
      // runs over time — unlike `activeRunsById`, an unconditional delete here
      // can release a slot this run no longer owns. If a stale run's
      // completion (e.g. a cancelled run finalizing late) fires after a
      // fresher run for the same session has already taken the slot, deleting
      // unconditionally would wrongly clear the busy-gate out from under the
      // fresh run and let a second run start against the session concurrently.
      if (this.activeRunsBySession.get(active.run.sessionId) === active) {
        this.activeRunsBySession.delete(active.run.sessionId);
      }
    });
  }

  private async finalizeCancelledRun(active: ActiveGatewayRun, session: SessionRecord): Promise<void> {
    const cancelledSession = await this.persistSession(session, "cancelled", {
      activeTurnId: undefined,
      clearError: false,
      statusSummary: "The active gateway run was cancelled."
    });
    await this.emitEvent(
      {
        createdAt: cancelledSession.updatedAt,
        id: `session-updated.${cancelledSession.id}.${crypto.randomUUID()}`,
        metadata: {},
        payload: cancelledSession,
        topic: "session.updated"
      },
      true
    );
    await this.completeRun(active, {
      completionReason: "session_cancelled",
      sessionId: cancelledSession.id,
      status: "cancelled"
    });
  }

  private async persistSession(
    session: SessionRecord,
    status: SessionRecord["status"],
    options: {
      activeTurnId?: string;
      clearError: boolean;
      pendingApprovalIds?: string[];
      pendingToolCallIds?: string[];
      statusSummary?: string;
      structuredError?: StructuredError;
    }
  ): Promise<SessionRecord> {
    const updatedAt = new Date().toISOString();
    const updatedSession = sessionRecordSchema.parse({
      ...session,
      activeTurnId: options.activeTurnId,
      lastActiveAt: updatedAt,
      lastError: options.clearError ? undefined : (options.structuredError ?? session.lastError),
      status,
      updatedAt
    });

    await this.options.sessions.saveSession(updatedSession);
    await this.options.sessions.saveResumeMetadata(updatedSession.id, {
      activeTurnId: options.activeTurnId,
      pendingApprovalIds: options.pendingApprovalIds ?? [],
      pendingToolCallIds: options.pendingToolCallIds ?? [],
      statusSummary: options.statusSummary,
      surface: "gateway",
      updatedAt
    });

    return updatedSession;
  }

  private async requireSession(sessionId: string): Promise<SessionRecord> {
    const session = await this.options.sessions.getSession(sessionId);
    if (!session) {
      throw gatewayError("not_found", `Session "${sessionId}" was not found.`);
    }
    return session;
  }

  private async requireIdleSession(sessionId: string): Promise<SessionRecord> {
    const session = await this.requireSession(sessionId);
    if (this.activeRunsBySession.has(sessionId)) {
      throw gatewayError("busy", `Session "${sessionId}" already has an active gateway run.`);
    }
    return session;
  }

  private requireActiveRun(runId: string): ActiveGatewayRun {
    const active = this.activeRunsById.get(runId);
    if (!active) {
      throw gatewayError("not_found", `Gateway run "${runId}" is not active.`);
    }
    return active;
  }

  private requireExternalAgentService(): ExternalAgentService {
    if (!this.options.externalAgentService) {
      throw gatewayError("not_implemented", "External-agent execution is not configured for this gateway instance.");
    }

    return this.options.externalAgentService;
  }

  private requireExternalAgentSessionService(): ExternalAgentSessionService {
    if (!this.options.externalAgentSessionService) {
      throw gatewayError(
        "not_implemented",
        "Interactive external-agent sessions are not configured for this gateway instance."
      );
    }

    return this.options.externalAgentSessionService;
  }

  private requireChannelService(): ChannelService {
    if (!this.options.channelService) {
      throw gatewayError("not_implemented", "Messaging channels are not configured for this gateway instance.");
    }

    return this.options.channelService;
  }

  private async emitChannelMessageEvent(message: ChannelMessage): Promise<void> {
    await this.emitEvent(
      {
        createdAt: message.createdAt,
        id: `channel-message.${message.id}.${crypto.randomUUID()}`,
        metadata: {
          ...(message.sessionId ? { sessionId: message.sessionId } : {})
        },
        payload: message,
        topic: "channel.message"
      },
      true
    );
  }

  // Every approval.requested is built here, so a tool's approval and an MCP
  // server's question look the same to every subscriber (both carry the
  // session in metadata, as other session events do).
  private emitApprovalRequested(request: ApprovalRequest): Promise<void> {
    return this.emitEvent(
      {
        createdAt: request.createdAt,
        id: `approval-requested.${request.id}`,
        metadata: { sessionId: request.sessionId },
        payload: request,
        topic: "approval.requested"
      },
      true
    );
  }

  private async emitEvent(event: GatewayEvent, persist: boolean): Promise<void> {
    const normalizedEvent = normalizeGatewayEventId(event);
    const emitted = persist ? await this.eventLog.append(normalizedEvent) : gatewayEventSchema.parse(normalizedEvent);
    this.dispatchEvent(emitted);
  }

  // EventEmitter.emit() runs listeners synchronously and lets the first throw
  // escape into whoever emitted the event — which for a run means one
  // misbehaving subscriber aborts the run that produced the event. Give each
  // listener its own try/catch so a bad subscriber loses only its own event.
  private dispatchEvent(event: GatewayEvent): void {
    for (const listener of this.listeners("event")) {
      try {
        (listener as (value: GatewayEvent) => void)(event);
      } catch (error) {
        console.error("A gateway event subscriber threw:", error);
      }
    }
  }
}

/**
 * Builds the command a desktop terminal window runs to join a live session.
 *
 * The window runs the same `aia attach` relay any operator could run by hand,
 * so the desktop window is a convenience over a documented command rather than
 * a private channel only the agent can open.
 *
 * It names the listener and the workspace explicitly. The window's shell is
 * started by the terminal app, not by this process, so it never inherits this
 * cwd: a bare `aia attach <id>` read a different state root, found no endpoint,
 * and dialled a port nothing listened on. `--cwd` lets it load this workspace's
 * config and the endpoint record that carries the listener's token.
 * `do script` runs the command through a shell, so every argument is quoted.
 */
export function buildAttachCommand(externalSessionId: string, endpoint: { cwd: string; url: string }): string {
  return ["aia", "attach", externalSessionId, "--url", endpoint.url, "--cwd", endpoint.cwd]
    .map(quoteShellArgument)
    .join(" ");
}

function quoteShellArgument(value: string): string {
  return /^[A-Za-z0-9._:/=@+-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Opens shared desktop windows for interactive external-agent sessions — but
 * only while some surface of this process serves a listener the window can
 * reach. A window with nothing to connect to is worse than no window: it fails
 * with a connection error while the model is told the terminal is shared.
 */
export function createExternalAgentSessionHost(params: {
  attachEndpoint: AttachEndpointHolder;
  autoAttachOnStart: boolean;
  cwd: string;
  service: ExternalAgentSessionService;
  terminalApp: string;
}): ExternalAgentSessionHost {
  return {
    async attach(externalSessionId) {
      const url = params.attachEndpoint.url;
      if (!url) {
        throw new Error(
          "This process is not serving a gateway endpoint an `aia attach` window could reach, so no window was opened. " +
            "Drive the agent from the interactive `aia` REPL or the server to share its terminal."
        );
      }
      const command = buildAttachCommand(externalSessionId, { cwd: params.cwd, url });
      await openTerminalWindow({ command, terminalApp: params.terminalApp });
      await params.service.noteAttached(externalSessionId);
      return { command };
    },
    get autoAttachOnStart() {
      return params.autoAttachOnStart && params.attachEndpoint.url !== undefined;
    },
    service: params.service
  };
}

export async function createGatewayRuntimeFromLoadedConfig(params: {
  channelService?: ChannelService;
  cwd: string;
  embeddingAdapters?: EmbeddingAdapterRegistration[];
  env?: Record<string, string | undefined>;
  externalAgentService?: ExternalAgentService;
  fetchImpl?: typeof fetch;
  languageModelAdapters?: LanguageModelAdapterRegistration[];
  loaded: LoadedAIAgentConfig;
  sessions?: FileSessionStore;
  userHomeDirectory?: string;
}): Promise<GatewayRuntime> {
  // Before anything is spawned: every service below writes under the state
  // root, and an unwritable one used to fail deep inside the memory service
  // with a bare errno, after the MCP servers were already running.
  await ensureStateRootWritable(params.loaded);

  const sessions = params.sessions ?? new FileSessionStore(params.loaded.resolvedConfig.memory.stateRoot);
  const mcpManager = createMcpManagerFromLoadedConfig({
    cwd: params.cwd,
    env: params.env,
    fetchImpl: params.fetchImpl,
    loaded: params.loaded,
    userHomeDirectory: params.userHomeDirectory,
    // Hot-reload MCP servers on config/import file changes unless disabled.
    watch: params.loaded.resolvedConfig.mcp.watch ?? true
  });

  // A stdio MCP server spawned here keeps the event loop alive. When any later
  // step threw (a required server failing, the memory service, a corrupt
  // events log), nothing closed it, so the caller printed the error and the
  // process never exited.
  try {
    return await assembleGatewayRuntime(params, { mcpManager, sessions });
  } catch (error) {
    await mcpManager.close().catch(() => undefined);
    throw error;
  }
}

async function assembleGatewayRuntime(
  params: Parameters<typeof createGatewayRuntimeFromLoadedConfig>[0],
  { mcpManager, sessions }: { mcpManager: MCPManager; sessions: FileSessionStore }
): Promise<GatewayRuntime> {
  await mcpManager.initialize();

  const memoryService = await createMemoryServiceFromConfig({
    config: params.loaded.resolvedConfig,
    embeddingAdapters: params.embeddingAdapters?.map((registration) => registration.adapter),
    fetchImpl: params.fetchImpl,
    sessions
  });
  // Built here, not only injected. The interactive session service below is
  // constructed from config, so every surface gets interactive agents — but the
  // one-shot job service used to arrive only from the server's runtime context,
  // and `createDefaultToolRegistry` registers `external_agent` *only when that
  // service exists*. The result was that the CLI and the in-process SDK had no
  // external-agent tool at all: not one-shot, and not interactive either, since
  // the same tool carries both. A caller that wants its own instance (the
  // server, which also serves it over HTTP) still injects one.
  const externalAgentService =
    params.externalAgentService ??
    createExternalAgentServiceFromConfig({
      config: params.loaded.resolvedConfig,
      sessions
    }) ??
    undefined;
  const browserService = createPlaywrightBrowserAutomationService({
    actionTimeoutMs: params.loaded.resolvedConfig.browser.actionTimeoutMs,
    artifactRoot: params.loaded.resolvedConfig.browser.artifactRoot,
    headless: params.loaded.resolvedConfig.browser.headless,
    launchTimeoutMs: params.loaded.resolvedConfig.browser.launchTimeoutMs,
    navigationTimeoutMs: params.loaded.resolvedConfig.browser.navigationTimeoutMs,
    snapshotMaxElements: params.loaded.resolvedConfig.browser.snapshotMaxElements,
    snapshotTextChars: params.loaded.resolvedConfig.browser.snapshotTextChars,
    viewport: params.loaded.resolvedConfig.browser.viewport
  });
  const taskStateService = new TaskStateService({
    sessions,
    stateRoot: params.loaded.resolvedConfig.memory.stateRoot
  });
  const workspaceEngine = new WorkspaceMutationEngine({
    allowArbitraryPaths: true,
    stateRoot: params.loaded.resolvedConfig.memory.stateRoot,
    workspaceRoot: params.cwd
  });
  // The command runtime is built before the gateway it reports to, so the sink
  // is late-bound rather than threading a half-built runtime into a service.
  const commandOutputSink: { emit?: CommandOutputListener } = {};
  const commandRuntime = new CommandRuntime({
    baseDirectory: params.cwd,
    onOutput: (event) => commandOutputSink.emit?.(event),
    stateRoot: params.loaded.resolvedConfig.memory.stateRoot
  });
  const imageService = Object.values(params.loaded.resolvedConfig.providers.imageProviders).some(
    (providerConfig) => providerConfig.enabled
  )
    ? createImageServiceFromConfig(params.loaded.resolvedConfig, {
        fetchImpl: params.fetchImpl
      })
    : undefined;
  // Built here, like the image service, so the voice tools exist on every
  // surface (the REPL, the server, the SDK). Only `aia voice` used to build
  // one, so the model never had them. Nothing touches a device until a tool
  // runs, and each voice action still goes through approval.
  const voiceService = Object.values(params.loaded.resolvedConfig.providers.voiceProviders).some(
    (providerConfig) => providerConfig.enabled
  )
    ? createVoiceServiceFromConfig(params.loaded.resolvedConfig, { sessions })
    : undefined;
  // Auto-approve tools from MCP servers configured as trusted, while keeping
  // explicit operator deny rules authoritative. Followed through the MCP
  // manager's config reloads, which is where `trust: "trusted"` comes and goes.
  const readCurrentApprovals = followMcpTrustRules(params.loaded.approvals, () => mcpManager.getConfiguredServers());
  // Like the command runtime above, the interactive session service is built
  // before the gateway and the model runtime it depends on, so both hooks are
  // late-bound through sinks instead of threading a half-built runtime around.
  const externalAgentOutputSink: {
    emit?: (event: {
      chunk: string;
      externalSessionId: string;
      sessionId?: string;
      stream: "combined" | "stderr" | "stdout";
    }) => void;
  } = {};
  const externalAgentSummarySink: { summarize?: ExternalAgentTurnSummarizer } = {};
  const externalAgentSessionService = createExternalAgentSessionServiceFromConfig({
    config: params.loaded.resolvedConfig,
    onOutput: (event) => externalAgentOutputSink.emit?.(event),
    onWarning: (message) => {
      console.warn(message);
    },
    summarize: async (input) => externalAgentSummarySink.summarize?.(input),
    workspaceRoot: params.cwd
  });
  // Late-bound too: the interactive CLI serves its listener after boot and the
  // server after it binds, while `--prompt` and plain SDK hosts serve none.
  const attachEndpoint: AttachEndpointHolder = {};
  const externalAgentSessionHost = externalAgentSessionService
    ? createExternalAgentSessionHost({
        attachEndpoint,
        autoAttachOnStart: params.loaded.resolvedConfig.externalAgents.interactive.autoAttachOnStart,
        cwd: params.cwd,
        service: externalAgentSessionService,
        terminalApp: params.loaded.resolvedConfig.externalAgents.interactive.terminalApp
      })
    : undefined;
  // Followed, not fixed at start: `aia skills enable|disable` in another
  // terminal applies to this session from its next run.
  const skills = createSkillProvider({
    settings: await followSkillsSettings({
      loaded: params.loaded,
      reload: () =>
        loadAIAgentConfig({
          cwd: params.cwd,
          ...(params.env ? { env: params.env } : {}),
          resolveSecrets: false,
          ...(params.userHomeDirectory ? { userHomeDirectory: params.userHomeDirectory } : {}),
          warnWhenUntrusted: false
        })
    }),
    ...(params.userHomeDirectory ? { userHomeDirectory: params.userHomeDirectory } : {})
  });
  const toolRuntime = new ToolRuntime({
    approvalDecider: createToolApprovalDecider({ settings: readCurrentApprovals }),
    registry: createDefaultToolRegistry({
      browserService,
      channelService: params.channelService,
      commandRuntime,
      externalAgentService,
      ...(externalAgentSessionHost ? { externalAgentSessionHost } : {}),
      fetchImpl: params.fetchImpl,
      imageService,
      mcpArtifactRoot: path.join(params.loaded.resolvedConfig.memory.stateRoot, "mcp-tool-artifacts"),
      mcpManager,
      memoryService,
      sessions,
      skills,
      taskStateService,
      ...(voiceService ? { voiceService } : {}),
      workspaceEngine
    })
  });
  const modelRuntime = new LanguageModelRuntime({
    adapters: params.languageModelAdapters,
    config: params.loaded.resolvedConfig,
    fetchImpl: params.fetchImpl
  });
  const runtime = new GatewayRuntime({
    approvals: readCurrentApprovals(),
    attachEndpoint,
    ...(externalAgentSessionHost
      ? {
          attachExternalAgentSession: async (externalSessionId: string) =>
            externalAgentSessionHost.attach(externalSessionId)
        }
      : {}),
    browserService,
    channelService: params.channelService,
    config: params.loaded.resolvedConfig,
    externalAgentService,
    ...(externalAgentSessionService ? { externalAgentSessionService } : {}),
    imageService,
    mcpManager,
    memoryService,
    modelRuntime,
    sessions,
    skills,
    taskStateService,
    toolRuntime,
    userHomeDirectory: params.userHomeDirectory,
    ...(voiceService ? { voiceService } : {}),
    workspaceRoot: params.cwd
  });
  externalAgentSummarySink.summarize = createExternalAgentTurnSummarizer({
    config: params.loaded.resolvedConfig,
    modelRuntime
  });
  externalAgentOutputSink.emit = (event) => {
    runtime.emitToolOutputDelta({
      chunk: event.chunk,
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      sourceId: event.externalSessionId,
      sourceKind: "external_agent",
      stream: event.stream
    });
  };
  commandOutputSink.emit = (event) => {
    runtime.emitToolOutputDelta({
      chunk: event.chunk,
      ...(event.ownerSessionId ? { sessionId: event.ownerSessionId } : {}),
      sourceId: event.sessionId,
      sourceKind: "command",
      stream: event.stream
    });
  };
  for (const registration of params.embeddingAdapters ?? []) {
    if (registration.makeDefault) {
      memoryService.setDefaultEmbeddingProvider({
        embeddingModel: registration.defaultModel,
        providerId: registration.adapter.providerId
      });
    }
  }
  try {
    await runtime.initialize();
  } catch (error) {
    // Everything is built by now, so the runtime's own close releases all of
    // it (model queue, browser, image, MCP, interactive sessions).
    await runtime.close().catch(() => undefined);
    throw error;
  }
  return runtime;
}

export async function createGatewayRuntime(params: {
  cwd: string;
  embeddingAdapters?: EmbeddingAdapterRegistration[];
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  languageModelAdapters?: LanguageModelAdapterRegistration[];
  sessions?: FileSessionStore;
  userHomeDirectory?: string;
}): Promise<GatewayRuntime> {
  const loaded = await loadAIAgentConfig({
    cwd: params.cwd,
    env: params.env,
    userHomeDirectory: params.userHomeDirectory
  });
  return createGatewayRuntimeFromLoadedConfig({
    cwd: params.cwd,
    embeddingAdapters: params.embeddingAdapters,
    env: params.env,
    fetchImpl: params.fetchImpl,
    languageModelAdapters: params.languageModelAdapters,
    loaded,
    sessions: params.sessions,
    userHomeDirectory: params.userHomeDirectory
  });
}

class GatewayEventLog {
  private initialized = false;
  private nextSequence = 1;
  private readonly events: Array<{ event: GatewayEvent; sequence: number }> = [];

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      for (const line of raw
        .split("\n")
        .map((entry) => entry.trim())
        .filter(Boolean)) {
        const persisted = persistedGatewayEventSchema.parse(JSON.parse(line) as unknown);
        this.events.push(persisted);
        this.nextSequence = Math.max(this.nextSequence, persisted.sequence + 1);
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }

    this.initialized = true;
  }

  async append(event: GatewayEvent): Promise<GatewayEvent> {
    await this.initialize();

    const sequence = this.nextSequence;
    this.nextSequence += 1;
    const persisted = persistedGatewayEventSchema.parse({
      event: gatewayEventSchema.parse({
        ...event,
        cursor: encodeCursor(sequence)
      }),
      sequence
    });
    this.events.push(persisted);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, `${JSON.stringify(persisted)}\n`, "utf8");
    return persisted.event;
  }

  list(query: GatewayEventReplayQuery): GatewayEventPage {
    const afterSequence = decodeCursor(query.cursor);
    const filtered = this.events
      .filter((entry) => entry.sequence > afterSequence)
      .map((entry) => entry.event)
      .filter((event) => eventMatchesGatewaySubscription(event, query))
      .slice(0, query.limit);

    return gatewayEventPageSchema.parse({
      events: filtered,
      nextCursor: filtered.at(-1)?.cursor
    });
  }
}

const persistedGatewayEventSchema = z
  .object({
    event: gatewayEventSchema,
    sequence: z.number().int().positive()
  })
  .strict();

function normalizeGatewayEventId(event: GatewayEvent): GatewayEvent {
  if (event.id.length <= 128) {
    return event;
  }

  const digest = crypto
    .createHash("sha1")
    .update(`${event.topic}:${event.id}:${event.createdAt}`)
    .digest("hex")
    .slice(0, 20);

  return gatewayEventSchema.parse({
    ...event,
    id: `event.${event.topic}.${digest}`
  });
}

function buildApprovalRecords(snapshot: SessionSnapshot): GatewayApprovalRecord[] {
  const latestResolutions = new Map<string, ApprovalResolution>();
  for (const resolution of snapshot.approvalResolutions) {
    const previous = latestResolutions.get(resolution.requestId);
    if (!previous || previous.decidedAt.localeCompare(resolution.decidedAt) < 0) {
      latestResolutions.set(resolution.requestId, resolution);
    }
  }

  return snapshot.approvalRequests.map((request) =>
    gatewayApprovalRecordSchema.parse({
      request,
      resolution: latestResolutions.get(request.id)
    })
  );
}

function buildMessageParts(input: z.infer<typeof gatewayMessageInputSchema>) {
  const parts = [...(input.parts ?? [])];
  if (input.text) {
    parts.unshift({
      kind: "text",
      text: input.text
    });
  }
  return parts;
}

function buildChannelApprovalAcknowledgement(request: ApprovalRequest, resolution: ApprovalResolution): string {
  const decision =
    resolution.decision === "approved" ? "Approved" : resolution.decision === "denied" ? "Denied" : "Cancelled";
  return `${decision} approval for "${request.target.label}".`;
}

function buildChannelApprovalPrompt(request: ApprovalRequest): string {
  return [
    `Approval needed for "${request.target.label}".`,
    request.justification,
    `Risk: ${request.riskSummary}`,
    `Reply "/approve ${request.id}" to continue or "/deny ${request.id} <reason>" to reject.`
  ].join("\n");
}

function buildChannelSessionGoal(message: ChannelMessage): string {
  const target = message.identity.displayName ?? message.identity.userId;
  return `Respond helpfully to ${describeChannel(message.identity.channel)} messages from ${target}.`;
}

function buildChannelSessionMetadata(message: ChannelMessage): Record<string, JsonValue> {
  return {
    ...message.metadata,
    channelAccountId: message.identity.accountId,
    channelAutoCreated: true,
    channelDisplayName: message.identity.displayName ?? null,
    channelId: message.identity.channel,
    channelUserId: message.identity.userId,
    ...(message.identity.roomId ? { channelRoomId: message.identity.roomId } : {})
  };
}

function buildChannelSessionTitle(message: ChannelMessage): string {
  return `${formatChannelDisplayName(message.identity.channel)} ${message.identity.displayName ?? message.identity.userId}`;
}

function buildDeclinedToolError(toolName: string, resolution: ApprovalResolution): StructuredError {
  const decision = resolution.decision;
  return {
    code:
      decision === "denied"
        ? "tool_execution_denied_by_operator"
        : decision === "cancelled"
          ? "tool_execution_cancelled_by_operator"
          : "tool_execution_expired",
    details: {
      approvalRequestId: resolution.requestId,
      approvalResolutionId: resolution.id,
      decision
    },
    message:
      decision === "denied"
        ? `Tool "${toolName}" was denied by operator approval.`
        : decision === "cancelled"
          ? `Tool "${toolName}" was cancelled before approval.`
          : `Tool "${toolName}" approval expired before execution.`,
    retriable: decision === "expired"
  };
}

function collectArtifactsFromMessage(message: Message): ArtifactReference[] {
  const artifacts = new Map<string, ArtifactReference>();
  for (const part of message.parts) {
    if ("artifact" in part && part.artifact?.uri) {
      artifacts.set(part.artifact.uri, part.artifact);
    }
  }
  return Array.from(artifacts.values());
}

function shouldRelayMessageToChannel(message: Message): boolean {
  return message.visibility !== "hidden" && message.role === "assistant";
}

function describeChannel(channel: ChannelMessage["identity"]["channel"]): string {
  return channel === "whatsapp" ? "WhatsApp" : channel;
}

function formatChannelDisplayName(channel: ChannelMessage["identity"]["channel"]): string {
  return channel === "whatsapp" ? "WhatsApp" : toTitleCase(channel);
}

function toTitleCase(value: string): string {
  return value
    .split(/[_\s-]+/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function mapSessionStopReasonToCompletionReason(
  stopReason: Awaited<ReturnType<AgentLoop["run"]>>["stopReason"]
): GatewayRunCompletionReason {
  switch (stopReason) {
    case "awaiting_approval":
      return "session_awaiting_approval";
    case "cancelled":
      return "session_cancelled";
    case "completion_blocked":
      return "session_completion_blocked";
    case "completed":
      return "session_completed";
    case "failed":
      return "session_failed";
  }
}

/** The `code` in a log.emitted event's metadata when the provider answered with another model. */
export const MODEL_MISMATCH_LOG_CODE = "model_mismatch";

// Spellings of one model: Ollama's implicit ":latest", LM Studio's instance
// suffix (":2" for a second copy), and an id with or without its publisher.
function isSameModel(requested: string, answered: string): boolean {
  const normalize = (id: string) =>
    id
      .trim()
      .toLowerCase()
      .replace(/:(latest|\d+)$/u, "");
  const left = normalize(requested);
  const right = normalize(answered);
  return left === right || left.split("/").at(-1) === right.split("/").at(-1);
}

/**
 * Whether a subscriber following `subscription` shows session `sessionId`'s
 * approvals: it named `approval.requested` (a subscriber to every topic, a
 * logger or an events() loop, answers nothing) and follows that session or
 * every session.
 */
export function subscriptionShowsApprovals(
  subscription: Pick<GatewaySubscription, "sessionId" | "topics"> | null | undefined,
  sessionId: string
): boolean {
  return (
    subscription?.topics?.includes("approval.requested") === true &&
    (!subscription.sessionId || subscription.sessionId === sessionId)
  );
}

export function eventMatchesGatewaySubscription(
  event: GatewayEvent,
  subscription: Pick<GatewaySubscription, "sessionId" | "topics">
): boolean {
  if (subscription.topics && !subscription.topics.includes(event.topic)) {
    return false;
  }

  if (!subscription.sessionId) {
    return true;
  }

  // An MCP server serves every session in the process, so a session's
  // subscriber (the CLI) hears when one fails or needs a login.
  if (event.topic === "mcp.updated") {
    return true;
  }

  return deriveGatewayEventSessionId(event) === subscription.sessionId;
}

export function deriveGatewayEventSessionId(event: GatewayEvent): string | undefined {
  switch (event.topic) {
    case "approval.requested":
      return event.payload.sessionId;
    case "approval.resolved":
      return typeof event.metadata.sessionId === "string" ? event.metadata.sessionId : undefined;
    case "channel.message":
      return event.payload.sessionId ?? undefined;
    case "external_agent.updated":
      return event.payload.request.sessionId ?? undefined;
    case "gateway.status":
    case "log.emitted":
      return typeof event.metadata.sessionId === "string" ? event.metadata.sessionId : undefined;
    case "mcp.updated":
      // MCP servers belong to the process, not a session.
      return undefined;
    case "memory.updated":
      return typeof event.metadata.sessionId === "string" ? event.metadata.sessionId : undefined;
    case "message.created":
      return event.payload.sessionId;
    case "message.delta":
      return event.payload.sessionId;
    case "message.reasoning":
      return event.payload.sessionId;
    case "run.updated":
      return event.payload.sessionId;
    case "session.updated":
      return event.payload.id;
    case "tool.output.delta":
      return event.payload.sessionId;
    case "tool.updated":
      return event.payload.sessionId;
    case "turn.updated":
      return event.payload.sessionId;
    default: {
      // Exhaustiveness guard: a new event topic must add a case above so
      // session-filtered subscriptions (e.g. the CLI) don't silently drop it.
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

function encodeCursor(sequence: number): string {
  return Buffer.from(JSON.stringify({ sequence }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { sequence?: unknown };
    return typeof parsed.sequence === "number" && Number.isInteger(parsed.sequence) && parsed.sequence >= 0
      ? parsed.sequence
      : 0;
  } catch {
    return 0;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function buildChannelThreadId(identity: ChannelMessage["identity"]): string {
  return `${identity.channel}:${identity.accountId}:${identity.roomId ?? identity.userId}`;
}
