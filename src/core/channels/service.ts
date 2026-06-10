import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { AppConfig } from "@/core/config";
import {
  channelDeliveryRecordSchema,
  channelIdentitySchema,
  channelMessageSchema,
  channelRouteSchema,
  channelRuntimeStatusSchema,
  channelSendRequestSchema,
  channelWebhookEndpointSchema,
  sessionRecordSchema,
  structuredErrorSchema,
  type ChannelAdapter,
  type ChannelDeliveryRecord,
  type ChannelIdentity,
  type ChannelKind,
  type ChannelMessage,
  type ChannelRoute,
  type ChannelRuntimeStatus,
  type ChannelSendRequest,
  type ChannelWebhookEndpoint,
  type StructuredError
} from "@/core/contracts";
import { writeJsonAtomic } from "@/core/io/files";
import type { FileSessionStore } from "@/core/sessions";
import type { TunnelService } from "@/core/tunnel";

type ChannelServiceOptions = {
  adapters?: ChannelAdapter[];
  channelsConfig: AppConfig["channels"];
  onInboundMessage?: (message: ChannelMessage) => Promise<void>;
  sessions: FileSessionStore;
  stateRoot: string;
  tunnelService?: TunnelService;
};

const supportedChannelKinds = ["discord", "whatsapp", "teams", "imessage"] as const;

const routesIndexSchema = z
  .object({
    routes: z.array(channelRouteSchema).default([]),
    updatedAt: z.string().datetime({ offset: true })
  })
  .strict();

const defaultChannelCapabilities: Record<ChannelKind, ChannelRuntimeStatus["capabilities"]> = {
  cli: [],
  discord: ["approvals", "attachments", "images", "outbound_messages", "steering"],
  gateway: [],
  imessage: ["attachments", "images", "outbound_messages", "steering"],
  sdk: [],
  teams: ["approvals", "attachments", "outbound_messages", "steering", "webhooks"],
  web: [],
  whatsapp: ["approvals", "attachments", "images", "outbound_messages", "steering"]
};

export class ChannelService {
  private readonly adaptersByChannel = new Map<ChannelKind, ChannelAdapter>();
  private inboundMessageListener?: (message: ChannelMessage) => Promise<void>;
  private started = false;

  constructor(private readonly options: ChannelServiceOptions) {
    for (const adapter of options.adapters ?? []) {
      this.adaptersByChannel.set(adapter.channel, adapter);
    }
    this.inboundMessageListener = options.onInboundMessage;
  }

  async close(): Promise<void> {
    await Promise.all(
      Array.from(this.adaptersByChannel.values()).map(async (adapter) => {
        await adapter.close?.();
      })
    );
    this.started = false;
  }

  async ensureRoute(input: {
    identity: ChannelIdentity;
    lastInboundMessageId?: string;
    lastOutboundMessageId?: string;
    metadata?: Record<string, unknown>;
    sessionId: string;
  }): Promise<ChannelRoute> {
    const identity = channelIdentitySchema.parse(input.identity);
    const routesState = await this.readRoutesState();
    const existing = routesState.routes.find((route) => this.identityKey(route.identity) === this.identityKey(identity));
    const now = new Date().toISOString();

    const route = channelRouteSchema.parse(
      existing
        ? {
            ...existing,
            lastInboundMessageId: input.lastInboundMessageId ?? existing.lastInboundMessageId,
            lastOutboundMessageId: input.lastOutboundMessageId ?? existing.lastOutboundMessageId,
            metadata: {
              ...existing.metadata,
              ...(input.metadata ?? {})
            },
            sessionId: input.sessionId,
            updatedAt: now
          }
        : {
            createdAt: now,
            id: `channel-route.${crypto.randomUUID()}`,
            identity,
            lastInboundMessageId: input.lastInboundMessageId,
            lastOutboundMessageId: input.lastOutboundMessageId,
            metadata: input.metadata ?? {},
            sessionId: input.sessionId,
            updatedAt: now
          }
    );

    const nextRoutes = [...routesState.routes.filter((entry) => entry.id !== route.id), route].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    );
    await this.writeRoutesState(nextRoutes, now);
    await this.bindRouteToSession(route);
    return route;
  }

  async getRouteForIdentity(identity: ChannelIdentity): Promise<ChannelRoute | null> {
    const routesState = await this.readRoutesState();
    return (
      routesState.routes.find((route) => this.identityKey(route.identity) === this.identityKey(identity)) ?? null
    );
  }

  async getRouteForSession(sessionId: string): Promise<ChannelRoute | null> {
    const routesState = await this.readRoutesState();
    return routesState.routes.find((route) => route.sessionId === sessionId) ?? null;
  }

  async handleWebhook(
    channel: ChannelKind,
    payload: unknown,
    headers: Record<string, string | string[] | undefined>
  ): Promise<ChannelMessage[]> {
    const adapter = this.adaptersByChannel.get(channel);
    if (!adapter?.handleWebhook) {
      throw channelError("not_implemented", `Channel "${channel}" does not expose webhook handling yet.`);
    }

    const normalized = await adapter.handleWebhook(payload, {
      headers,
      receivedAt: new Date().toISOString()
    });
    const recorded: ChannelMessage[] = [];
    for (const message of normalized) {
      const parsed = await this.recordInboundMessage(message);
      recorded.push(parsed);
    }
    return recorded;
  }

  setInboundMessageListener(listener: ((message: ChannelMessage) => Promise<void>) | undefined): void {
    this.inboundMessageListener = listener;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.started = true;
    await Promise.all(
      Array.from(this.adaptersByChannel.values()).map(async (adapter) => {
        if (!isConfigBackedChannel(adapter.channel)) {
          return;
        }
        if (!this.options.channelsConfig[adapter.channel].enabled || !this.isChannelConfigured(adapter.channel)) {
          return;
        }
        await adapter.start?.({
          emitInboundMessage: async (message) => {
            const recorded = await this.recordInboundMessage(message);
            await this.inboundMessageListener?.(recorded);
            return recorded;
          }
        });
      })
    );
  }

  async listDeliveries(query: {
    channel?: ChannelKind;
    limit?: number;
    sessionId?: string;
  } = {}): Promise<ChannelDeliveryRecord[]> {
    const deliveries: ChannelDeliveryRecord[] = await this.readLatestJsonLines(
      this.deliveriesFile(),
      channelDeliveryRecordSchema
    );
    return deliveries
      .filter((delivery) => (query.channel ? delivery.channel === query.channel : true))
      .filter((delivery) => (query.sessionId ? delivery.sessionId === query.sessionId : true))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, query.limit ?? 100);
  }

  async listRuntimeStatuses(): Promise<ChannelRuntimeStatus[]> {
    const statuses = await Promise.all(
      supportedChannelKinds.map(async (channel) => {
        const adapter = this.adaptersByChannel.get(channel);
        const enabled = this.options.channelsConfig[channel].enabled;
        const configured = this.isChannelConfigured(channel);
        const capabilities = adapter?.capabilities ?? defaultChannelCapabilities[channel];
        const webhookEndpoint = capabilities.includes("webhooks") ? this.getWebhookEndpoint(channel) : null;

        if (!enabled) {
          return channelRuntimeStatusSchema.parse({
            capabilities,
            channel,
            configured,
            enabled,
            metadata: withWebhookMetadata({}, webhookEndpoint),
            status: "disabled"
          });
        }

        if (!configured) {
          return channelRuntimeStatusSchema.parse({
            capabilities,
            channel,
            configured,
            enabled,
            metadata: withWebhookMetadata({}, webhookEndpoint),
            status: "not_configured"
          });
        }

        if (!adapter) {
          return channelRuntimeStatusSchema.parse({
            capabilities,
            channel,
            configured,
            enabled,
            metadata: withWebhookMetadata({}, webhookEndpoint),
            status: "not_implemented"
          });
        }

        const health = await adapter.health().catch(() => ({ ok: false }));
        return channelRuntimeStatusSchema.parse({
          capabilities,
          channel,
          configured,
          enabled,
          metadata: withWebhookMetadata(
            {
              adapterRegistered: true
            },
            webhookEndpoint
          ),
          status: health.ok ? "healthy" : "unhealthy"
        });
      })
    );

    return statuses;
  }

  async listRoutes(): Promise<ChannelRoute[]> {
    const routesState = await this.readRoutesState();
    return routesState.routes.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async recordInboundMessage(message: ChannelMessage): Promise<ChannelMessage> {
    const adapter = this.adaptersByChannel.get(message.identity.channel);
    const normalized = channelMessageSchema.parse(
      adapter ? await adapter.normalizeInboundMessage(message) : message
    );
    const route = await this.getRouteForIdentity(normalized.identity);
    const recordedMessage = channelMessageSchema.parse({
      ...normalized,
      sessionId: normalized.sessionId ?? route?.sessionId
    });
    const delivery = channelDeliveryRecordSchema.parse({
      attemptCount: 1,
      channel: recordedMessage.identity.channel,
      createdAt: recordedMessage.createdAt,
      direction: "inbound",
      id: `channel-delivery.${crypto.randomUUID()}`,
      lastAttemptAt: recordedMessage.createdAt,
      message: recordedMessage,
      metadata: {},
      routeId: route?.id,
      sessionId: recordedMessage.sessionId,
      status: "received",
      updatedAt: recordedMessage.createdAt
    });

    await this.appendDelivery(delivery);

    if (route || recordedMessage.sessionId) {
      await this.ensureRoute({
        identity: route?.identity ?? recordedMessage.identity,
        lastInboundMessageId: recordedMessage.id,
        metadata: route?.metadata ?? recordedMessage.metadata,
        sessionId: route?.sessionId ?? recordedMessage.sessionId!
      });
    }

    return recordedMessage;
  }

  async send(input: ChannelSendRequest): Promise<ChannelMessage> {
    const request = channelSendRequestSchema.parse(input);
    const channel = request.identity.channel;
    const route = request.sessionId ? await this.getRouteForSession(request.sessionId) : await this.getRouteForIdentity(request.identity);
    const now = new Date().toISOString();
    const message = channelMessageSchema.parse({
      attachments: request.attachments,
      createdAt: now,
      direction: "outbound",
      id: `channel-message.${crypto.randomUUID()}`,
      identity: route?.identity ?? request.identity,
      metadata: request.metadata,
      parts: request.parts,
      replyToId: request.replyToId,
      sessionId: request.sessionId ?? route?.sessionId
    });

    const initial = channelDeliveryRecordSchema.parse({
      attemptCount: 1,
      channel,
      createdAt: now,
      direction: "outbound",
      id: `channel-delivery.${crypto.randomUUID()}`,
      lastAttemptAt: now,
      message,
      metadata: {},
      routeId: route?.id,
      sessionId: message.sessionId,
      status: "sending",
      updatedAt: now
    });
    await this.appendDelivery(initial);

    const error = this.validateChannelSend(channel);
    if (error) {
      await this.appendDelivery({
        ...initial,
        lastError: error,
        status: "failed",
        updatedAt: new Date().toISOString()
      });
      throw error;
    }

    const adapter = this.adaptersByChannel.get(channel) as ChannelAdapter;
    try {
      await adapter.send(message);
      await this.appendDelivery({
        ...initial,
        status: "sent",
        updatedAt: new Date().toISOString()
      });
      const sessionId = message.sessionId ?? route?.sessionId ?? request.sessionId;
      if (sessionId) {
        await this.ensureRoute({
          identity: message.identity,
          lastOutboundMessageId: message.id,
          metadata: route?.metadata,
          sessionId
        });
      }
      return message;
    } catch (error) {
      const structured = normalizeStructuredError(error, `Channel "${channel}" send failed.`);
      await this.appendDelivery({
        ...initial,
        lastError: structured,
        status: "failed",
        updatedAt: new Date().toISOString()
      });
      throw structured;
    }
  }

  listWebhookEndpoints(): ChannelWebhookEndpoint[] {
    return supportedChannelKinds
      .map((channel) => this.getWebhookEndpoint(channel))
      .filter((endpoint): endpoint is ChannelWebhookEndpoint => endpoint !== null);
  }

  private async appendDelivery(record: ChannelDeliveryRecord): Promise<void> {
    await fs.mkdir(path.dirname(this.deliveriesFile()), { recursive: true });
    await fs.appendFile(this.deliveriesFile(), `${JSON.stringify(channelDeliveryRecordSchema.parse(record))}\n`, "utf8");
  }

  private async bindRouteToSession(route: ChannelRoute): Promise<void> {
    const session = await this.options.sessions.getSession(route.sessionId);
    if (!session) {
      return;
    }

    const threadId = `${route.identity.channel}:${route.identity.accountId}:${route.identity.roomId ?? route.identity.userId}`;
    const nextSession = sessionRecordSchema.parse({
      ...session,
      channelThreadId: threadId,
      metadata: {
        ...session.metadata,
        channelAccountId: route.identity.accountId,
        channelDisplayName: route.identity.displayName ?? null,
        channelId: route.identity.channel,
        channelUserId: route.identity.userId,
        ...(route.identity.roomId ? { channelRoomId: route.identity.roomId } : {})
      },
      updatedAt: route.updatedAt
    });
    await this.options.sessions.saveSession(nextSession);
  }

  private deliveriesFile(): string {
    return path.join(this.options.stateRoot, "channels", "deliveries.jsonl");
  }

  private getWebhookEndpoint(channel: ChannelKind): ChannelWebhookEndpoint | null {
    const capabilities = defaultChannelCapabilities[channel];
    if (!capabilities.includes("webhooks")) {
      return null;
    }

    const publicUrl = this.options.tunnelService?.getPublicUrl(this.webhookPath(channel));
    return channelWebhookEndpointSchema.parse({
      channel,
      metadata: {},
      path: this.webhookPath(channel),
      publicUrl,
      status: publicUrl ? "ready" : "missing_public_base_url"
    });
  }

  private identityKey(identity: ChannelIdentity): string {
    return [identity.channel, identity.accountId, identity.roomId ?? "-", identity.userId].join(":");
  }

  private isChannelConfigured(channel: ChannelKind): boolean {
    switch (channel) {
      case "discord":
        return (
          typeof this.options.channelsConfig.discord.appId === "string" &&
          typeof this.options.channelsConfig.discord.botToken === "string"
        );
      case "teams":
        return (
          typeof this.options.channelsConfig.teams.appId === "string" &&
          typeof this.options.channelsConfig.teams.appPassword === "string" &&
          typeof this.options.channelsConfig.teams.publicBaseUrl === "string"
        );
      case "whatsapp":
        return typeof this.options.channelsConfig.whatsapp.sessionDirectory === "string";
      case "imessage":
        return (
          typeof this.options.channelsConfig.imessage.blueBubblesUrl === "string" &&
          typeof this.options.channelsConfig.imessage.blueBubblesPassword === "string"
        );
      case "cli":
      case "gateway":
      case "sdk":
      case "web":
        return true;
    }
  }

  private async readLatestJsonLines<TSchema extends z.ZodTypeAny>(
    filePath: string,
    schema: TSchema
  ): Promise<z.output<TSchema>[]> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const latestById = new Map<string, z.output<TSchema>>();
      for (const line of raw.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
        const parsed = schema.parse(JSON.parse(line) as unknown);
        if (typeof parsed === "object" && parsed !== null && "id" in parsed && typeof parsed.id === "string") {
          latestById.set(parsed.id, parsed);
        }
      }
      return [...latestById.values()];
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async readRoutesState(): Promise<z.infer<typeof routesIndexSchema>> {
    try {
      const raw = await fs.readFile(this.routesFile(), "utf8");
      return routesIndexSchema.parse(JSON.parse(raw) as unknown);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return routesIndexSchema.parse({
          routes: [],
          updatedAt: new Date().toISOString()
        });
      }
      throw error;
    }
  }

  private routesFile(): string {
    return path.join(this.options.stateRoot, "channels", "routes.json");
  }

  private validateChannelSend(channel: ChannelKind): StructuredError | null {
    if (!isConfigurableChannelKind(channel)) {
      return channelError("not_implemented", `Channel "${channel}" is not supported by the messaging runtime.`);
    }

    const channelConfig = this.options.channelsConfig[channel];
    if (!("enabled" in channelConfig) || !channelConfig.enabled) {
      return channelError("channel_disabled", `Channel "${channel}" is disabled in configuration.`);
    }
    if (!this.isChannelConfigured(channel)) {
      return channelError("channel_not_configured", `Channel "${channel}" is missing required configuration.`);
    }
    const adapter = this.adaptersByChannel.get(channel);
    if (!adapter) {
      return channelError("not_implemented", `Channel "${channel}" has no registered adapter yet.`);
    }
    if (!adapter.capabilities.includes("outbound_messages")) {
      return channelError("channel_capability_missing", `Channel "${channel}" cannot send outbound messages.`);
    }
    return null;
  }

  private webhookPath(channel: ChannelKind): string {
    return `/api/channels/${channel}/webhook`;
  }

  private async writeRoutesState(routes: ChannelRoute[], updatedAt: string): Promise<void> {
    await fs.mkdir(path.dirname(this.routesFile()), { recursive: true });
    await writeJsonAtomic(
      this.routesFile(),
      routesIndexSchema.parse({
        routes,
        updatedAt
      })
    );
  }
}

function isConfigBackedChannel(channel: ChannelKind): channel is (typeof supportedChannelKinds)[number] {
  return (supportedChannelKinds as readonly string[]).includes(channel);
}

function channelError(code: string, message: string): StructuredError {
  return structuredErrorSchema.parse({
    code,
    details: {},
    message,
    retriable: false
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function normalizeStructuredError(error: unknown, fallbackMessage: string): StructuredError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    "retriable" in error
  ) {
    return structuredErrorSchema.parse(error);
  }

  if (error instanceof Error) {
    return structuredErrorSchema.parse({
      code: "channel_send_failed",
      details: {
        name: error.name
      },
      message: error.message,
      retriable: false
    });
  }

  return structuredErrorSchema.parse({
    code: "channel_send_failed",
    details: {},
    message: fallbackMessage,
    retriable: false
  });
}

function isConfigurableChannelKind(channel: ChannelKind): channel is keyof AppConfig["channels"] {
  return supportedChannelKinds.includes(channel as (typeof supportedChannelKinds)[number]);
}

function withWebhookMetadata(
  metadata: Record<string, unknown>,
  endpoint: ChannelWebhookEndpoint | null
): Record<string, unknown> {
  if (!endpoint) {
    return metadata;
  }

  return {
    ...metadata,
    webhookPath: endpoint.path,
    ...(endpoint.publicUrl ? { webhookPublicUrl: endpoint.publicUrl } : {})
  };
}
