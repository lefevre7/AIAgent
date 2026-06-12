import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  AgentLoop,
  ApprovalCoordinator,
  ChannelService,
  FileSessionStore,
  LanguageModelRuntime,
  MemorySystemStatus,
  TaskStateService,
  ToolRuntime,
  createToolResultMessage,
  createDefaultToolRegistry,
  createExternalAgentApprovalTargetResolver,
  createImageServiceFromConfig,
  createMcpManagerFromLoadedConfig,
  createMemoryServiceFromConfig,
  createPlaywrightBrowserAutomationService,
  createToolApprovalDecider,
  CommandRuntime,
  loadAIAgentConfig,
  type ApprovalSettings,
  type AppConfig,
  type EmbeddingAdapterRegistration,
  type ExternalAgentService,
  type ImageService,
  type LanguageModelAdapterRegistration,
  type LoadedAIAgentConfig,
  type MCPManager,
  type PlaywrightBrowserAutomationService,
  type StructuredError
} from "@/core";
import { WorkspaceMutationEngine } from "@/core";
import {
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
  type GatewaySessionSnapshot,
  type GatewaySubscription,
  type JsonValue,
  type Message,
  type SessionRecord,
  type SessionSnapshot,
  type SteeringInjection,
  type TaskStateSnapshot,
  type ToolCallRecord,
  type ToolDefinition
} from "@/core/contracts";
import { createGatewayError as gatewayError, normalizeGatewayError } from "@/gateway/errors";

type ActiveGatewayRun = {
  cancelRequested: boolean;
  run: GatewayRunRecord;
};

type ChannelCommand =
  | {
      decision: "approved" | "cancelled" | "denied";
      kind: "approval";
      requestId?: string;
      comment?: string;
    }
  | {
      kind: "help";
    }
  | {
      kind: "steering";
      message: string;
    };

type MaterializedApprovalResume = {
  messageIds: string[];
  session: SessionRecord;
  toolCallIds: string[];
  turnIds: string[];
};

type GatewayRuntimeEvents = {
  event: [GatewayEvent];
};

type GatewayRuntimeOptions = {
  approvals: ApprovalSettings;
  channelService?: ChannelService;
  config: AppConfig;
  externalAgentService?: ExternalAgentService;
  imageService?: ImageService;
  mcpManager: MCPManager;
  memoryService: Awaited<ReturnType<typeof createMemoryServiceFromConfig>>;
  modelRuntime: LanguageModelRuntime;
  sessions: FileSessionStore;
  taskStateService: TaskStateService;
  toolRuntime: ToolRuntime;
  userHomeDirectory?: string;
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
  subscribe(listener: (event: GatewayEvent) => void): () => void;
}

export class GatewayRuntime
  extends EventEmitter<GatewayRuntimeEvents>
  implements GatewayRuntimeLike, GatewayRuntimeProviderRegistrationHost
{
  private readonly activeRunsById = new Map<string, ActiveGatewayRun>();
  private readonly activeRunsBySession = new Map<string, ActiveGatewayRun>();
  private readonly inFlightRuns = new Set<Promise<void>>();
  private readonly eventLog: GatewayEventLog;
  private readonly approvalCoordinator: ApprovalCoordinator;
  private readonly agentLoop: AgentLoop;

  constructor(private readonly options: GatewayRuntimeOptions) {
    super();
    this.eventLog = new GatewayEventLog(path.join(options.config.memory.stateRoot, "gateway", "events.jsonl"));
    this.approvalCoordinator = new ApprovalCoordinator(options.sessions);
    this.agentLoop = new AgentLoop({
      memoryContextProvider: options.memoryService,
      memoryLifecycle: options.memoryService,
      model: options.modelRuntime,
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
      },
      onStatus: async ({ session, summary }) => {
        await this.emitEvent(
          {
            createdAt: new Date().toISOString(),
            id: `gateway-status.${crypto.randomUUID()}`,
            metadata: {
              sessionId: session.id
            },
            payload: {
              ok: true,
              status: summary
            },
            topic: "gateway.status"
          },
          false
        );
      },
      sessions: options.sessions,
      surface: "gateway",
      taskStateProvider: options.taskStateService,
      toolExecutor: options.toolRuntime,
      userHomeDirectory: options.userHomeDirectory
    });
  }

  async initialize(): Promise<void> {
    await this.eventLog.initialize();
  }

  async close(): Promise<void> {
    // Drain fire-and-forget runs (and any follow-up runs they queue) before
    // tearing down dependencies, so no event write lands after shutdown.
    while (this.inFlightRuns.size > 0) {
      await Promise.allSettled([...this.inFlightRuns]);
    }
    this.removeAllListeners();
    await this.options.modelRuntime.close().catch(() => undefined);
    await this.options.browserService?.dispose().catch(() => undefined);
    await this.options.imageService?.dispose().catch(() => undefined);
    await this.options.mcpManager.close().catch(() => undefined);
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
        configured: typeof config.imessage.blueBubblesUrl === "string" && typeof config.imessage.blueBubblesPassword === "string",
        enabled: config.imessage.enabled,
        metadata: {},
        status: config.imessage.enabled
          ? typeof config.imessage.blueBubblesUrl === "string" && typeof config.imessage.blueBubblesPassword === "string"
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

  searchTools(query: z.input<typeof gatewayRequestPayloadSchemas["tool.search"]>): ToolDefinition[] {
    return this.options.toolRuntime
      .searchDefinitions(gatewayRequestPayloadSchemas["tool.search"].parse(query))
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
      const snapshots = await Promise.all(sessions.map(async (session) => this.options.sessions.getSessionSnapshot(session.id)));
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

  subscribe(listener: (event: GatewayEvent) => void): () => void {
    this.on("event", listener);
    return () => {
      this.off("event", listener);
    };
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

  private async dispatch(request: GatewayRequest): Promise<unknown> {
    switch (request.topic) {
      case "approval.get":
        return gatewayResponsePayloadSchemas["approval.get"].parse(
          await this.getApprovalRecord(gatewayRequestPayloadSchemas["approval.get"].parse(request.payload).requestId)
        );
      case "approval.list":
        return gatewayResponsePayloadSchemas["approval.list"].parse({
          approvals: await this.listApprovalRecords(gatewayRequestPayloadSchemas["approval.list"].parse(request.payload))
        });
      case "approval.resolve":
        return gatewayResponsePayloadSchemas["approval.resolve"].parse(
          await this.resolveApproval(gatewayRequestPayloadSchemas["approval.resolve"].parse(request.payload))
        );
      case "channel.health":
        return gatewayResponsePayloadSchemas["channel.health"].parse({
          channels: await this.getChannelStatuses(gatewayRequestPayloadSchemas["channel.health"].parse(request.payload).channel)
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
          await this.requireExternalAgentService().cancel(gatewayRequestPayloadSchemas["external_agent.cancel"].parse(request.payload))
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
          await this.requireExternalAgentService().resume(gatewayRequestPayloadSchemas["external_agent.resume"].parse(request.payload))
        );
      case "external_agent.run":
        return gatewayResponsePayloadSchemas["external_agent.run"].parse(
          await this.requireExternalAgentService().run(gatewayRequestPayloadSchemas["external_agent.run"].parse(request.payload))
        );
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
      case "memory.query":
        return gatewayResponsePayloadSchemas["memory.query"].parse({
          hits: await this.options.memoryService.query(gatewayRequestPayloadSchemas["memory.query"].parse(request.payload))
        });
      case "model.health":
        return gatewayResponsePayloadSchemas["model.health"].parse(
          await this.options.modelRuntime.health(gatewayRequestPayloadSchemas["model.health"].parse(request.payload).provider)
        );
      case "run.cancel":
        return gatewayResponsePayloadSchemas["run.cancel"].parse({
          run: await this.cancelRun(gatewayRequestPayloadSchemas["run.cancel"].parse(request.payload).runId)
        });
      case "session.cancel":
        return gatewayResponsePayloadSchemas["session.cancel"].parse({
          run: await this.cancelSession(gatewayRequestPayloadSchemas["session.cancel"].parse(request.payload).sessionId)
        });
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
          await this.enqueueSessionMessage(gatewayRequestPayloadSchemas["session.message"].parse(request.payload), request.id)
        );
      case "session.resume":
        return gatewayResponsePayloadSchemas["session.resume"].parse(
          await this.enqueueSessionResume(gatewayRequestPayloadSchemas["session.resume"].parse(request.payload), request.id)
        );
      case "session.snapshot":
        return gatewayResponsePayloadSchemas["session.snapshot"].parse(
          await this.getSessionSnapshot(gatewayRequestPayloadSchemas["session.snapshot"].parse(request.payload).sessionId)
        );
      case "steering.inject":
        return gatewayResponsePayloadSchemas["steering.inject"].parse(
          await this.injectSteering(gatewayRequestPayloadSchemas["steering.inject"].parse(request.payload))
        );
      case "tool.execute":
        return gatewayResponsePayloadSchemas["tool.execute"].parse(
          await this.enqueueToolExecution(gatewayRequestPayloadSchemas["tool.execute"].parse(request.payload), request.id)
        );
      case "tool.search":
        return gatewayResponsePayloadSchemas["tool.search"].parse({
          tools: this.searchTools(gatewayRequestPayloadSchemas["tool.search"].parse(request.payload))
        });
    }
  }

  private async sendChannelMessage(
    input: z.infer<typeof gatewayRequestPayloadSchemas["channel.send"]>
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
    active.run = gatewayRunRecordSchema.parse({
      ...active.run,
      metadata: {
        ...active.run.metadata,
        cancelRequestedAt: new Date().toISOString()
      },
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
    return active.run;
  }

  private async cancelSession(sessionId: string): Promise<GatewayRunRecord> {
    const active = this.activeRunsBySession.get(sessionId);
    if (!active) {
      throw gatewayError("not_found", `Session "${sessionId}" has no active gateway run.`);
    }

    return this.cancelRun(active.run.id);
  }

  private async createSession(
    input: z.infer<typeof gatewayRequestPayloadSchemas["session.create"]>,
    requestId: string
  ): Promise<z.infer<typeof gatewayResponsePayloadSchemas["session.create"]>> {
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
    input: z.infer<typeof gatewayRequestPayloadSchemas["session.message"]>,
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
    input: z.infer<typeof gatewayRequestPayloadSchemas["session.resume"]>,
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
    input: z.infer<typeof gatewayRequestPayloadSchemas["tool.execute"]>,
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

  private async resolveApproval(input: z.infer<typeof gatewayRequestPayloadSchemas["approval.resolve"]>) {
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
    this.trackRun(this.executeSessionRun(runId, session, params));
  }

  private launchToolRun(runId: string, session: SessionRecord, input: z.infer<typeof gatewayRequestPayloadSchemas["tool.execute"]>): void {
    this.trackRun(this.executeToolRun(runId, session, input));
  }

  // Keeps a handle on every fire-and-forget run so close() can drain them.
  // Without this, an event persisted as a run finalizes can race teardown and
  // attempt to write under a state root that has already been removed.
  private trackRun(promise: Promise<void>): void {
    const tracked = promise.then(
      () => undefined,
      () => undefined
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

    const result = await this.agentLoop.run({
      availableTools: this.options.toolRuntime.listDefinitions(),
      session: currentSession,
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
      ...(result.stopReason === "failed" ? { error: result.session.lastError ?? gatewayError("failed", "The session run failed.") } : {})
    });
  }

  private async executeToolRun(
    runId: string,
    session: SessionRecord,
    input: z.infer<typeof gatewayRequestPayloadSchemas["tool.execute"]>
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
      await this.emitEvent(
        {
          createdAt: outcome.approvalRequest.createdAt,
          id: `approval-requested.${outcome.approvalRequest.id}`,
          metadata: {},
          payload: outcome.approvalRequest,
          topic: "approval.requested"
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

    const finalSession = await this.persistSession(updatedSession, "awaiting_user", {
      activeTurnId: undefined,
      clearError: outcome.toolCall.status !== "failed",
      pendingApprovalIds: [],
      pendingToolCallIds: [],
      statusSummary:
        outcome.toolCall.status === "failed"
          ? `Gateway tool "${input.toolName}" failed.`
          : `Gateway tool "${input.toolName}" completed.`
    });

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
          ? outcome.toolCall.error ?? gatewayError("failed", "The tool execution failed.")
          : undefined,
      messageIds: resultMessageId ? [resultMessageId] : [],
      sessionId: finalSession.id,
      status: outcome.toolCall.status === "failed" ? "failed" : "completed",
      toolCallIds: [outcome.toolCall.id],
      turnIds: [turn.id]
    });
  }

  private async emitSessionRunEvents(result: Awaited<ReturnType<AgentLoop["run"]>>): Promise<void> {
    for (const approvalRequest of result.approvalRequests) {
      await this.emitEvent(
        {
          createdAt: approvalRequest.createdAt,
          id: `approval-requested.${approvalRequest.id}`,
          metadata: {},
          payload: approvalRequest,
          topic: "approval.requested"
        },
        true
      );
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

    for (const toolCall of result.toolCalls) {
      await this.emitEvent(
        {
          createdAt: toolCall.completedAt ?? toolCall.startedAt,
          id: `tool-updated.${toolCall.id}`,
          metadata: {},
          payload: {
            ...toolCall,
            resultMessageId: result.messages.find((message) => message.id === `message.tool.${toolCall.id}`)?.id
          },
          topic: "tool.updated"
        },
        true
      );
    }

    for (const turn of result.turns) {
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

  private async maybeHandleChannelCommand(message: ChannelMessage): Promise<{ handled: boolean; run: GatewayRunRecord | null }> {
    const command = parseChannelCommand(message);
    if (!command || !message.sessionId) {
      return {
        handled: false,
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
    if (this.activeRunsBySession.has(session.id)) {
      await this.sendChannelTextReply(message, `Session "${session.title}" is busy right now. Please retry once the current run finishes.`);
      return null;
    }

    const requestId = command.requestId ?? (await this.resolveLatestPendingApprovalId(session.id));
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
    if (this.activeRunsBySession.has(session.id)) {
      await this.sendChannelTextReply(message, `Session "${session.title}" is busy right now. Please retry after the active run finishes.`);
      return null;
    }

    const steering = await this.injectSteering({
      createdAt: new Date().toISOString(),
      id: `steering.channel.${crypto.randomUUID()}`,
      message: command.message,
      metadata: {
        channelCommandMessageId: message.id
      },
      sessionId: session.id,
      source: "channel",
      state: "queued"
    });
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

      await this.options.sessions.appendToolCalls([materialized.toolCall]);
      await this.options.sessions.appendTurn(materialized.turn);
      toolCallIds.push(materialized.toolCall.id);
      turnIds.push(materialized.turn.id);

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
      session: updatedSession,
      toolCallIds,
      turnIds
    };
  }

  private async executeApprovedPendingToolCall(
    session: SessionRecord,
    snapshot: SessionSnapshot | null,
    pendingToolCall: ToolCallRecord,
    resolution: ApprovalResolution
  ): Promise<{ message?: Message; toolCall: ToolCallRecord; turn: z.infer<typeof turnRecordSchema> }> {
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
  ): { message: Message; toolCall: ToolCallRecord; turn: z.infer<typeof turnRecordSchema> } {
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

    for (const message of result.messages.filter((entry) => shouldRelayMessageToChannel(entry))) {
      await this.sendChannelMessage({
        attachments: collectArtifactsFromMessage(message),
        identity: route.identity,
        metadata: {
          gatewayMessageId: message.id,
          messageRole: message.role,
          source: message.source,
          ...(message.turnId ? { turnId: message.turnId } : {})
        },
        parts: message.parts,
        replyToId: route.lastInboundMessageId,
        sessionId: result.session.id
      });
    }

    for (const approvalRequest of result.approvalRequests) {
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
        sessionId: result.session.id
      });
    }
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

  private async queueRun(params: { kind: GatewayRunKind; requestId: string; sessionId: string }): Promise<GatewayRunRecord> {
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
    } as Partial<GatewayRunRecord>);
    this.activeRunsById.delete(active.run.id);
    this.activeRunsBySession.delete(active.run.sessionId);
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
      lastError: options.clearError ? undefined : options.structuredError ?? session.lastError,
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

  private async emitEvent(event: GatewayEvent, persist: boolean): Promise<void> {
    const normalizedEvent = normalizeGatewayEventId(event);
    const emitted = persist ? await this.eventLog.append(normalizedEvent) : gatewayEventSchema.parse(normalizedEvent);
    this.emit("event", emitted);
  }
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
  const sessions = params.sessions ?? new FileSessionStore(params.loaded.resolvedConfig.memory.stateRoot);
  const mcpManager = createMcpManagerFromLoadedConfig({
    cwd: params.cwd,
    env: params.env,
    fetchImpl: params.fetchImpl,
    loaded: params.loaded,
    userHomeDirectory: params.userHomeDirectory,
    watch: false
  });
  await mcpManager.initialize();

  const memoryService = await createMemoryServiceFromConfig({
    config: params.loaded.resolvedConfig,
    embeddingAdapters: params.embeddingAdapters?.map((registration) => registration.adapter),
    fetchImpl: params.fetchImpl,
    sessions
  });
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
  const commandRuntime = new CommandRuntime({
    baseDirectory: params.cwd,
    stateRoot: params.loaded.resolvedConfig.memory.stateRoot
  });
  const imageService = Object.values(params.loaded.resolvedConfig.providers.imageProviders).some(
    (providerConfig) => providerConfig.enabled
  )
    ? createImageServiceFromConfig(params.loaded.resolvedConfig, {
        fetchImpl: params.fetchImpl
      })
    : undefined;
  const toolRuntime = new ToolRuntime({
    approvalDecider: createToolApprovalDecider({
      resolveAdditionalTargets: params.externalAgentService
        ? createExternalAgentApprovalTargetResolver({
            service: params.externalAgentService
          })
        : undefined,
      settings: params.loaded.approvals
    }),
    registry: createDefaultToolRegistry({
      browserService,
      channelService: params.channelService,
      commandRuntime,
      externalAgentService: params.externalAgentService,
      fetchImpl: params.fetchImpl,
      imageService,
      mcpManager,
      memoryService,
      sessions,
      taskStateService,
      workspaceEngine
    })
  });
  const modelRuntime = new LanguageModelRuntime({
    adapters: params.languageModelAdapters,
    config: params.loaded.resolvedConfig,
    fetchImpl: params.fetchImpl
  });
  const runtime = new GatewayRuntime({
    approvals: params.loaded.approvals,
    browserService,
    channelService: params.channelService,
    config: params.loaded.resolvedConfig,
    externalAgentService: params.externalAgentService,
    imageService,
    mcpManager,
    memoryService,
    modelRuntime,
    sessions,
    taskStateService,
    toolRuntime,
    userHomeDirectory: params.userHomeDirectory,
    workspaceRoot: params.cwd
  });
  for (const registration of params.embeddingAdapters ?? []) {
    if (registration.makeDefault) {
      memoryService.setDefaultEmbeddingProvider({
        embeddingModel: registration.defaultModel,
        providerId: registration.adapter.providerId
      });
    }
  }
  await runtime.initialize();
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
      for (const line of raw.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
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
  const decision = resolution.decision === "approved" ? "Approved" : resolution.decision === "denied" ? "Denied" : "Cancelled";
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

function buildChannelHelpText(): string {
  return [
    "Channel commands:",
    '/approve <requestId> to approve the latest pending action.',
    '/deny <requestId> <reason> to reject an action.',
    '/steer <message> to inject steering into the current session.'
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

function extractCommandText(message: ChannelMessage): string | null {
  const text = message.parts
    .flatMap((part) => {
      switch (part.kind) {
        case "markdown":
          return [part.markdown];
        case "text":
          return [part.text];
        default:
          return [];
      }
    })
    .join("\n")
    .trim();

  return text.length > 0 ? text : null;
}

function parseChannelCommand(message: ChannelMessage): ChannelCommand | null {
  const text = extractCommandText(message);
  if (!text?.startsWith("/")) {
    return null;
  }

  const [rawCommand, ...rest] = text.split(/\s+/u);
  const command = rawCommand.slice(1).toLowerCase();
  switch (command) {
    case "approve":
    case "cancel":
    case "deny": {
      const [maybeRequestId, ...commentTokens] = rest;
      const hasRequestId = typeof maybeRequestId === "string" && maybeRequestId.length > 0 && maybeRequestId.includes(".");
      const comment = (hasRequestId ? commentTokens : rest).join(" ").trim() || undefined;
      return {
        comment,
        decision: command === "approve" ? "approved" : command === "deny" ? "denied" : "cancelled",
        kind: "approval",
        requestId: hasRequestId ? maybeRequestId : undefined
      };
    }
    case "help":
      return {
        kind: "help"
      };
    case "steer": {
      const messageText = rest.join(" ").trim();
      if (!messageText) {
        return {
          kind: "help"
        };
      }
      return {
        kind: "steering",
        message: messageText
      };
    }
    default:
      return null;
  }
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
    case "completion_blocked":
      return "session_completion_blocked";
    case "completed":
      return "session_completed";
    case "failed":
      return "session_failed";
  }
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
