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
    const sessions = new FileSessionStore(config.memory.stateRoot);
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
      stateRoot: config.memory.stateRoot,
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
});
