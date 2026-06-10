import crypto from "node:crypto";

import { z } from "zod";

import type {
  ChannelDeliveryRecord,
  ChannelRoute,
  ChannelRuntimeStatus,
  ChannelWebhookEndpoint,
  GatewayApprovalRecord,
  GatewayEventPage,
  GatewayRequestTopic,
  MemoryHit,
  SessionRecord,
  SteeringInjection,
  TaskStateSnapshot,
  TunnelStatus
} from "@/core/contracts";
import {
  gatewayRequestPayloadSchemas,
  gatewayRequestSchema,
  gatewayResponsePayloadSchemas,
  type GatewaySessionSnapshot
} from "@/core/contracts";
import type { MemorySystemStatus } from "@/core/memory";
import { normalizeGatewayError } from "@/gateway/errors";
import { createGatewayHealthSnapshot, type GatewayHealthSnapshot } from "@/gateway/router";
import type { ServerRuntimeContext } from "@/server/runtime-context";

export type ControlPlaneSessionView = {
  deliveries: ChannelDeliveryRecord[];
  route: ChannelRoute | null;
  snapshot: GatewaySessionSnapshot;
  taskState: TaskStateSnapshot | null;
};

export type ControlPlaneGatewaySummary = {
  authMode: "loopback_only" | "token";
  health: GatewayHealthSnapshot;
  status: {
    ok: true;
    status: string;
  };
  websocketPath: string;
};

export type ControlPlaneMemorySummary = {
  hits: MemoryHit[];
  query: string | null;
  sessionId: string | null;
  status: MemorySystemStatus;
};

export type ControlPlaneChannelSummary = {
  deliveries: ChannelDeliveryRecord[];
  routes: ChannelRoute[];
  statuses: ChannelRuntimeStatus[];
  webhookEndpoints: ChannelWebhookEndpoint[];
};

export type ControlPlaneSettingsSummary = {
  browser: {
    artifactRoot: string;
    headless: boolean;
    viewport: {
      height: number;
      width: number;
    };
  };
  channels: Array<{
    channel: string;
    configured: boolean;
    enabled: boolean;
  }>;
  gateway: {
    authRequired: boolean;
    hostname: string;
    port: number;
    requestTimeoutMs: number;
    websocketPath: string;
  };
  memory: {
    embeddingModel: string | null;
    embeddingProvider: string;
    embeddingsEnabled: boolean;
    retrievalLimit: number;
    stateRoot: string;
    userGlobalRoot: string;
    workspaceRoot: string;
  };
  runtime: {
    defaultModel: string;
    defaultProvider: string;
    logLevel: string;
    statusUpdates: boolean;
    verboseEvents: boolean;
  };
  tunnel: {
    enabled: boolean;
    hostname: string | null;
    provider: string;
    publicBaseUrl: string | null;
  };
};

export type ControlPlaneDashboard = {
  approvals: GatewayApprovalRecord[];
  bootstrap: ServerRuntimeContext["bootstrapInfo"];
  channels: ControlPlaneChannelSummary;
  gateway: ControlPlaneGatewaySummary;
  logs: GatewayEventPage;
  memory: ControlPlaneMemorySummary;
  sessions: {
    items: SessionRecord[];
    selected: ControlPlaneSessionView | null;
  };
  settings: ControlPlaneSettingsSummary;
  tunnel: TunnelStatus;
};

export type ControlPlaneDashboardQuery = {
  eventLimit?: number;
  memorySessionId?: string;
  memoryText?: string;
  sessionId?: string;
  sessionLimit?: number;
};

export class ControlPlaneService {
  constructor(private readonly context: ServerRuntimeContext) {}

  async getDashboard(query: ControlPlaneDashboardQuery = {}): Promise<ControlPlaneDashboard> {
    const sessions = await this.listSessions(query.sessionLimit ?? 24);
    const selectedSession =
      (query.sessionId ? await this.tryGetSessionView(query.sessionId) : null) ??
      (sessions[0] ? await this.tryGetSessionView(sessions[0].id) : null);
    const selectedSessionId = selectedSession?.snapshot.snapshot.session.id ?? null;

    const [approvals, channels, gateway, logs, memory, settings, tunnel] = await Promise.all([
      this.listApprovals(25),
      this.getChannels(),
      this.getGatewaySummary(),
      this.getLogs({
        limit: query.eventLimit ?? 25,
        sessionId: selectedSessionId ?? undefined
      }),
      this.getMemory({
        sessionId: query.memorySessionId ?? selectedSessionId ?? undefined,
        text: query.memoryText
      }),
      this.getSettingsSummary(),
      this.getTunnelStatus()
    ]);

    return {
      approvals,
      bootstrap: this.context.bootstrapInfo,
      channels,
      gateway,
      logs,
      memory,
      sessions: {
        items: sessions,
        selected: selectedSession
      },
      settings,
      tunnel
    };
  }

  async createSession(input: {
    cwd: string;
    goal: string;
    initialMessage?: string;
    title: string;
  }): Promise<z.infer<typeof gatewayResponsePayloadSchemas["session.create"]>> {
    return this.dispatch("session.create", {
      cwd: input.cwd,
      goal: input.goal,
      ...(input.initialMessage ? { initialMessage: { text: input.initialMessage } } : {}),
      metadata: {
        surface: "web_control_plane"
      },
      tags: [],
      title: input.title
    });
  }

  async getChannels(): Promise<ControlPlaneChannelSummary> {
    const [statuses, routes, deliveries] = await Promise.all([
      this.context.gatewayRuntime.getChannelStatuses(),
      this.context.channelService.listRoutes(),
      this.context.channelService.listDeliveries({
        limit: 20
      })
    ]);

    return {
      deliveries,
      routes,
      statuses,
      webhookEndpoints: this.context.channelService.listWebhookEndpoints()
    };
  }

  async getGatewaySummary(): Promise<ControlPlaneGatewaySummary> {
    return {
      authMode: this.context.gatewayAuthToken ? "token" : "loopback_only",
      health: createGatewayHealthSnapshot(),
      status: {
        ok: true,
        status: "ready"
      },
      websocketPath: this.context.loaded.resolvedConfig.gateway.websocketPath
    };
  }

  async getLogs(query: { limit?: number; sessionId?: string } = {}): Promise<GatewayEventPage> {
    return this.context.gatewayRuntime.replayEvents({
      limit: query.limit ?? 25,
      sessionId: query.sessionId
    });
  }

  async getMemory(query: {
    sessionId?: string;
    text?: string;
  }): Promise<ControlPlaneMemorySummary> {
    const status = await this.context.gatewayRuntime.getMemoryStatus();
    const text = query.text?.trim();

    if (!text) {
      return {
        hits: [],
        query: null,
        sessionId: query.sessionId ?? null,
        status
      };
    }

    const response = await this.dispatch("memory.query", {
      includeKinds: [],
      limit: 10,
      minConfidence: 0,
      scopes: query.sessionId ? ["workspace", "session", "user_global"] : ["workspace", "user_global"],
      sessionId: query.sessionId,
      text
    });

    return {
      hits: response.hits,
      query: text,
      sessionId: query.sessionId ?? null,
      status
    };
  }

  async getTunnelStatus(): Promise<TunnelStatus> {
    return this.context.tunnelService.getStatus();
  }

  async getSessionView(sessionId: string): Promise<ControlPlaneSessionView> {
    const [snapshot, taskState, route, deliveries] = await Promise.all([
      this.context.gatewayRuntime.getSessionSnapshot(sessionId),
      this.context.gatewayRuntime.getTaskState(sessionId),
      this.context.channelService.getRouteForSession(sessionId),
      this.context.channelService.listDeliveries({
        limit: 12,
        sessionId
      })
    ]);

    return {
      deliveries,
      route,
      snapshot,
      taskState
    };
  }

  async getSettingsSummary(): Promise<ControlPlaneSettingsSummary> {
    const config = this.context.loaded.resolvedConfig;
    const channelStatuses = await this.context.gatewayRuntime.getChannelStatuses();

    return {
      browser: {
        artifactRoot: config.browser.artifactRoot,
        headless: config.browser.headless,
        viewport: config.browser.viewport
      },
      channels: channelStatuses.map((status) => ({
        channel: status.channel,
        configured: status.configured,
        enabled: status.enabled
      })),
      gateway: {
        authRequired: Boolean(this.context.gatewayAuthToken),
        hostname: config.gateway.hostname,
        port: config.gateway.port,
        requestTimeoutMs: config.gateway.requestTimeoutMs,
        websocketPath: config.gateway.websocketPath
      },
      memory: {
        embeddingModel: config.memory.embeddingModel ?? null,
        embeddingProvider: config.memory.embeddingProvider,
        embeddingsEnabled: config.memory.embeddingsEnabled,
        retrievalLimit: config.memory.retrievalLimit,
        stateRoot: config.memory.stateRoot,
        userGlobalRoot: config.memory.userGlobalRoot,
        workspaceRoot: config.memory.workspaceRoot
      },
      runtime: {
        defaultModel: config.runtime.defaultModel,
        defaultProvider: config.runtime.defaultProvider,
        logLevel: config.runtime.logLevel,
        statusUpdates: config.runtime.statusUpdates,
        verboseEvents: config.runtime.verboseEvents
      },
      tunnel: {
        enabled: config.tunnel.enabled,
        hostname: config.tunnel.hostname ?? null,
        provider: config.tunnel.provider,
        publicBaseUrl: config.tunnel.publicBaseUrl ?? null
      }
    };
  }

  async injectSteering(input: {
    message: string;
    sessionId: string;
  }): Promise<SteeringInjection> {
    return this.dispatch("steering.inject", {
      createdAt: new Date().toISOString(),
      id: `steering.web.${crypto.randomUUID()}`,
      message: input.message,
      metadata: {
        surface: "web_control_plane"
      },
      sessionId: input.sessionId,
      source: "operator",
      state: "queued"
    });
  }

  async listApprovals(limit = 25): Promise<GatewayApprovalRecord[]> {
    return this.context.gatewayRuntime.listApprovalRecords({
      limit,
      pendingOnly: false
    });
  }

  async listSessions(limit = 24): Promise<SessionRecord[]> {
    return this.context.gatewayRuntime.listSessions({
      limit
    });
  }

  async resolveApproval(input: {
    comment?: string;
    decision: "approved" | "cancelled" | "denied" | "expired";
    requestId: string;
  }): Promise<z.infer<typeof gatewayResponsePayloadSchemas["approval.resolve"]>> {
    return this.dispatch("approval.resolve", {
      actor: "web",
      comment: input.comment,
      decision: input.decision,
      requestId: input.requestId
    });
  }

  async sendSessionMessage(input: {
    sessionId: string;
    text: string;
  }): Promise<z.infer<typeof gatewayResponsePayloadSchemas["session.message"]>> {
    return this.dispatch("session.message", {
      metadata: {
        surface: "web_control_plane"
      },
      sessionId: input.sessionId,
      tags: [],
      text: input.text
    });
  }

  private async dispatch<Topic extends GatewayRequestTopic>(
    topic: Topic,
    payload: z.input<(typeof gatewayRequestPayloadSchemas)[Topic]>
  ): Promise<z.infer<(typeof gatewayResponsePayloadSchemas)[Topic]>> {
    const response = await this.context.gatewayRuntime.request(
      gatewayRequestSchema.parse({
        createdAt: new Date().toISOString(),
        id: `gateway-request.web.${crypto.randomUUID()}`,
        metadata: {
          surface: "web"
        },
        payload: gatewayRequestPayloadSchemas[topic].parse(payload),
        topic
      })
    );

    if (!response.ok) {
      throw normalizeGatewayError(response.error);
    }

    return gatewayResponsePayloadSchemas[topic].parse(response.payload) as z.infer<
      (typeof gatewayResponsePayloadSchemas)[Topic]
    >;
  }

  private async tryGetSessionView(sessionId: string): Promise<ControlPlaneSessionView | null> {
    try {
      return await this.getSessionView(sessionId);
    } catch (error) {
      const normalized = normalizeGatewayError(error);
      if (normalized.code === "not_found") {
        return null;
      }
      throw error;
    }
  }
}
