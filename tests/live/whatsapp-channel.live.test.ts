import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect } from "vitest";

import {
  WhatsAppChannelAdapter,
  channelMessageSchema,
  whatsappBridgeInboundEntrySchema,
  whatsappBridgeOutboundEntrySchema,
  type ChannelMessage
} from "@/core";
import { createLiveTestHarness, envFlag } from "./helpers";

const { createTempRoot: createLiveTempRoot, liveTest } = createLiveTestHarness({
  enabled: envFlag("AIA_RUN_LIVE_WHATSAPP_TESTS"),
  prefix: "aiagent-live-whatsapp-"
});

describe("whatsapp channel live", () => {
  liveTest("round-trips inbound and outbound envelopes through the session-directory bridge", async () => {
    const root = await createLiveTempRoot();
    const sessionDirectory = process.env.AIA_WHATSAPP_LIVE_SESSION_DIRECTORY ?? path.join(root, "whatsapp-session");
    const adapter = new WhatsAppChannelAdapter({
      pollIntervalMs: 25,
      sessionDirectory
    });
    const received: ChannelMessage[] = [];

    const imagePath = path.join(root, "sample.png");
    await fs.writeFile(imagePath, "fake-image", "utf8");

    try {
      await adapter.start({
        emitInboundMessage: async (message) => {
          received.push(message);
          return message;
        }
      });

      const inboundEntry = whatsappBridgeInboundEntrySchema.parse({
        accountId: "whatsapp-live-account",
        createdAt: "2026-03-31T13:00:00.000Z",
        displayName: "Live User",
        id: "channel-message.whatsapp.live.1",
        media: [
          {
            filePath: imagePath,
            kind: "image",
            mediaType: "image/png",
            name: "sample.png"
          }
        ],
        metadata: {},
        text: "Live inbound message",
        userId: "whatsapp-live-user"
      });

      const inboundDirectory = path.join(sessionDirectory, "inbound");
      await fs.mkdir(inboundDirectory, { recursive: true });
      await fs.writeFile(
        path.join(inboundDirectory, `${Date.now()}.${inboundEntry.id}.json`),
        `${JSON.stringify(inboundEntry)}\n`,
        "utf8"
      );

      await waitFor(() => received.length > 0);

      const inboundMessage = received[0];
      expect(inboundMessage?.identity.channel).toBe("whatsapp");
      expect(inboundMessage?.attachments).toHaveLength(1);
      const persistedImagePath = fileURLToPath(inboundMessage!.attachments[0]!.uri);
      expect(path.basename(persistedImagePath)).toContain("sample.png");
      expect(path.basename(persistedImagePath)).not.toContain("sample.png.png");

      await adapter.send(
        channelMessageSchema.parse({
          attachments: [],
          createdAt: "2026-03-31T13:01:00.000Z",
          direction: "outbound",
          id: "channel-message.whatsapp.live.outbound.1",
          identity: {
            accountId: "whatsapp-live-account",
            channel: "whatsapp",
            displayName: "Live User",
            userId: "whatsapp-live-user"
          },
          metadata: {},
          parts: [
            {
              kind: "text",
              text: "Live outbound reply"
            }
          ]
        })
      );

      await waitFor(async () => {
        const outboundDirectory = path.join(sessionDirectory, "outbound");
        const files = await fs.readdir(outboundDirectory).catch(() => []);
        return files.some((entry) => entry.endsWith(".json"));
      });

      const outboundDirectory = path.join(sessionDirectory, "outbound");
      const outboundFiles = (await fs.readdir(outboundDirectory)).filter((entry) => entry.endsWith(".json")).sort();
      const outbound = whatsappBridgeOutboundEntrySchema.parse(
        JSON.parse(await fs.readFile(path.join(outboundDirectory, outboundFiles.at(-1)!), "utf8")) as unknown
      );
      expect(outbound.text).toContain("Live outbound reply");
    } finally {
      await adapter.close();
    }
  });
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000, intervalMs = 25): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out after ${timeoutMs}ms.`);
}
