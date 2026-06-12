import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ChannelService, FileSessionStore, TunnelService, createDefaultAppConfig } from "@/core";
import { sessionRecordSchema, type ChannelAdapter, type ChannelMessage } from "@/core/contracts";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

describe("ChannelService", () => {
  test("tracks channel routes, deliveries, webhook endpoints, and session bindings through the shared runtime", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aia-channels-"));
    tempRoots.push(tempRoot);

    const config = createDefaultAppConfig({
      userStateDirectory: tempRoot
    });
    const sessions = new FileSessionStore(path.join(tempRoot, ".aia"));
    const session = sessionRecordSchema.parse({
      createdAt: "2026-03-31T12:00:00.000Z",
      cwd: "/workspace",
      goal: "Respond to channel activity",
      id: "session.channel.1",
      lastActiveAt: "2026-03-31T12:00:00.000Z",
      metadata: {},
      status: "idle",
      tags: [],
      title: "Channel Session",
      updatedAt: "2026-03-31T12:00:00.000Z"
    });
    await sessions.saveSession(session);

    const identity = {
      accountId: "tenant-1",
      channel: "teams" as const,
      displayName: "Ada",
      roomId: "room-42",
      userId: "user-7"
    };
    const adapter: ChannelAdapter = {
      capabilities: ["outbound_messages", "steering", "webhooks"],
      channel: "teams",
      health: async () => ({ ok: true }),
      handleWebhook: async (): Promise<ChannelMessage[]> => [
        {
          attachments: [],
          createdAt: "2026-03-31T12:05:00.000Z",
          direction: "inbound",
          id: "channel-message.inbound.1",
          identity,
          metadata: {},
          parts: [{ kind: "text", text: "Inbound webhook" }]
        }
      ],
      normalizeInboundMessage: async (message) => message,
      send: async () => undefined
    };
    const tunnelService = new TunnelService({
      authToken: "secret-token",
      gatewayConfig: config.gateway,
      tunnelConfig: {
        ...config.tunnel,
        enabled: true,
        provider: "tailscale",
        publicBaseUrl: "https://agent.example.ts.net"
      }
    });
    const service = new ChannelService({
      adapters: [adapter],
      channelsConfig: {
        ...config.channels,
        teams: {
          appId: "teams-app-id",
          appPassword: "teams-app-password",
          enabled: true,
          publicBaseUrl: "https://agent.example.ts.net",
          tenantId: "tenant-1"
        }
      },
      sessions,
      stateRoot: path.join(tempRoot, ".aia"),
      tunnelService
    });

    await service.ensureRoute({
      identity,
      sessionId: session.id
    });

    const outbound = await service.send({
      identity,
      attachments: [],
      metadata: {},
      parts: [{ kind: "text", text: "Outbound response" }],
      sessionId: session.id
    });
    const inbound = await service.handleWebhook("teams", {
      text: "Inbound webhook"
    }, {});
    const route = await service.getRouteForSession(session.id);
    const deliveries = await service.listDeliveries({
      sessionId: session.id
    });
    const statuses = await service.listRuntimeStatuses();
    const savedSession = await sessions.getSession(session.id);

    expect(outbound.sessionId).toBe(session.id);
    expect(inbound[0]?.sessionId).toBe(session.id);
    expect(route?.lastOutboundMessageId).toBe(outbound.id);
    expect(route?.lastInboundMessageId).toBe("channel-message.inbound.1");
    expect(deliveries.map((delivery) => delivery.status)).toEqual(expect.arrayContaining(["received", "sent"]));
    expect(statuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "teams",
          status: "healthy"
        })
      ])
    );
    expect(service.listWebhookEndpoints()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "teams",
          publicUrl: "https://agent.example.ts.net/api/channels/teams/webhook",
          status: "ready"
        })
      ])
    );
    expect(savedSession?.channelThreadId).toBe("teams:tenant-1:room-42");
  });

  async function buildService(options: {
    adapters: ChannelAdapter[];
    channelsConfig?: (base: ReturnType<typeof createDefaultAppConfig>["channels"]) => ReturnType<typeof createDefaultAppConfig>["channels"];
  }) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aia-channels-err-"));
    tempRoots.push(tempRoot);
    const config = createDefaultAppConfig({ userStateDirectory: tempRoot });
    const sessions = new FileSessionStore(path.join(tempRoot, ".aia"));
    return new ChannelService({
      adapters: options.adapters,
      channelsConfig: options.channelsConfig ? options.channelsConfig(config.channels) : config.channels,
      sessions,
      stateRoot: path.join(tempRoot, ".aia")
    });
  }

  function adapterFor(channel: "discord" | "teams", capabilities: ChannelAdapter["capabilities"], send?: ChannelAdapter["send"]): ChannelAdapter {
    return {
      capabilities,
      channel,
      handleWebhook: async () => [],
      health: async () => ({ ok: true }),
      normalizeInboundMessage: async (message) => message,
      send: send ?? (async () => undefined)
    };
  }

  function enableTeams(base: ReturnType<typeof createDefaultAppConfig>["channels"]) {
    return {
      ...base,
      teams: {
        appId: "id",
        appPassword: "pw",
        enabled: true,
        publicBaseUrl: "https://x.example.com",
        tenantId: "tenant-1"
      }
    };
  }

  const teamsIdentity = { accountId: "tenant-1", channel: "teams" as const, roomId: "r1", userId: "u1" };

  test("rejects sends on a disabled channel", async () => {
    const service = await buildService({ adapters: [adapterFor("discord", ["outbound_messages"])] });
    await expect(
      service.send({
        attachments: [],
        identity: { accountId: "guild-1", channel: "discord", userId: "u1" },
        metadata: {},
        parts: [{ kind: "text", text: "hi" }]
      })
    ).rejects.toMatchObject({ code: "channel_disabled" });
  });

  test("rejects sends when the adapter lacks outbound capability", async () => {
    const service = await buildService({ adapters: [adapterFor("teams", ["webhooks"])], channelsConfig: enableTeams });
    await expect(
      service.send({ attachments: [], identity: teamsIdentity, metadata: {}, parts: [{ kind: "text", text: "hi" }] })
    ).rejects.toMatchObject({ code: "channel_capability_missing" });
  });

  test("normalizes adapter send failures and records a failed delivery", async () => {
    const service = await buildService({
      adapters: [
        adapterFor("teams", ["outbound_messages"], async () => {
          throw new Error("provider exploded");
        })
      ],
      channelsConfig: enableTeams
    });

    await expect(
      service.send({ attachments: [], identity: teamsIdentity, metadata: {}, parts: [{ kind: "text", text: "hi" }] })
    ).rejects.toMatchObject({ message: expect.stringContaining("provider exploded") });

    const deliveries = await service.listDeliveries({});
    expect(deliveries.some((delivery) => delivery.status === "failed")).toBe(true);
  });

  test("rejects webhooks for channels without a webhook adapter", async () => {
    const service = await buildService({ adapters: [] });
    await expect(service.handleWebhook("discord", {}, {})).rejects.toMatchObject({ code: "not_implemented" });
  });

  test("reports runtime statuses for disabled, unconfigured, and adapterless channels", async () => {
    const unconfigured = await buildService({
      adapters: [],
      channelsConfig: (base) => ({ ...base, teams: { ...base.teams, enabled: true } })
    });
    const statuses = await unconfigured.listRuntimeStatuses();
    expect(statuses.find((status) => status.channel === "teams")?.status).toBe("not_configured");
    expect(statuses.some((status) => status.status === "disabled")).toBe(true);

    const adapterless = await buildService({ adapters: [], channelsConfig: enableTeams });
    const adapterlessStatuses = await adapterless.listRuntimeStatuses();
    expect(adapterlessStatuses.find((status) => status.channel === "teams")?.status).toBe("not_implemented");
  });
});
