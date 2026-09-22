import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { WhatsAppChannelAdapter } from "@/core/channels/whatsapp";
import { channelMessageSchema, type ChannelMessage } from "@/core/contracts";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function createSessionDirectory(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aia-whatsapp-adapter-"));
  tempRoots.push(root);
  return path.join(root, "session");
}

/** The bridge contract is one JSON file per outbound message in `outbound/`. */
async function readOutbound(sessionDirectory: string): Promise<Array<Record<string, unknown>>> {
  const directory = path.join(sessionDirectory, "outbound");
  const names = (await fs.readdir(directory).catch(() => [] as string[]))
    .filter((name) => name.endsWith(".json"))
    .sort();
  return Promise.all(
    names.map(async (name) => JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as Record<string, unknown>)
  );
}

function outboundMessage(overrides: Partial<ChannelMessage>): ChannelMessage {
  return channelMessageSchema.parse({
    attachments: [],
    createdAt: "2026-03-31T12:00:00.000Z",
    direction: "outbound",
    id: "channel-message.whatsapp.outbound.1",
    identity: {
      accountId: "whatsapp-account",
      channel: "whatsapp",
      userId: "user-42"
    },
    metadata: {},
    parts: [{ kind: "text", text: "hello" }],
    ...overrides
  });
}

describe("WhatsAppChannelAdapter", () => {
  test("reports healthy and creates the directories it needs", async () => {
    const sessionDirectory = await createSessionDirectory();
    const adapter = new WhatsAppChannelAdapter({ pollIntervalMs: 10, sessionDirectory });

    await expect(adapter.health()).resolves.toEqual({ ok: true });
    // health() is also the first thing that guarantees the bridge directories
    // exist, so a bridge started afterwards has somewhere to write.
    await expect(fs.stat(sessionDirectory)).resolves.toBeTruthy();

    await adapter.close();
  });

  test("copies inbound media into the session directory and exposes typed parts", async () => {
    const sessionDirectory = await createSessionDirectory();
    const sourceDirectory = path.join(path.dirname(sessionDirectory), "bridge-media");
    await fs.mkdir(sourceDirectory, { recursive: true });
    const imagePath = path.join(sourceDirectory, "photo.png");
    await fs.writeFile(imagePath, "fake-png-bytes", "utf8");

    const adapter = new WhatsAppChannelAdapter({ pollIntervalMs: 10, sessionDirectory });
    const received: ChannelMessage[] = [];
    await adapter.start({
      emitInboundMessage: async (message) => {
        received.push(message);
        return message;
      }
    });

    // The bridge drops one .json file per inbound message into inbound/.
    await fs.writeFile(
      path.join(sessionDirectory, "inbound", "0001.json"),
      JSON.stringify({
        accountId: "whatsapp-account",
        createdAt: "2026-03-31T12:00:00.000Z",
        id: "channel-message.whatsapp.inbound.media",
        media: [{ caption: "a photo", filePath: imagePath, kind: "image" }],
        metadata: {},
        userId: "user-42"
      }),
      "utf8"
    );

    await waitFor(() => received.length > 0);
    await adapter.close();

    const message = received[0]!;
    expect(message.attachments).toHaveLength(1);
    const imagePart = message.parts.find((part) => part.kind === "image");
    expect(imagePart).toBeDefined();

    // The caption becomes the message text when there is no separate body,
    // otherwise a media-only message would reach the model with no prompt.
    expect(message.parts.some((part) => part.kind === "text" && part.text === "a photo")).toBe(true);

    // The bytes are copied under the session directory rather than referenced
    // in place, so the artifact survives the bridge cleaning up after itself.
    const storedPath = message.attachments[0]!.uri.replace("file://", "");
    expect(storedPath.startsWith(sessionDirectory)).toBe(true);
    await expect(fs.readFile(storedPath, "utf8")).resolves.toBe("fake-png-bytes");
  });

  test("writes outbound text and renders attachments from artifacts and parts", async () => {
    const sessionDirectory = await createSessionDirectory();
    const adapter = new WhatsAppChannelAdapter({ pollIntervalMs: 10, sessionDirectory });

    await adapter.send(
      outboundMessage({
        attachments: [
          {
            id: "artifact.chart",
            kind: "image",
            mediaType: "image/png",
            metadata: {},
            name: "chart.png",
            uri: "file:///tmp/chart.png"
          }
        ],
        parts: [
          { kind: "text", text: "here is the chart" },
          { kind: "audio", title: "note.m4a", uri: "file:///tmp/note.m4a" },
          { kind: "file", title: "report.pdf", uri: "file:///tmp/report.pdf" }
        ]
      })
    );

    const entries = await readOutbound(sessionDirectory);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.text).toContain("here is the chart");

    const attachments = entry.attachments as Array<{ kind: string; name?: string }>;
    // One from the artifact list, two from parts that carry no artifact.
    expect(attachments.map((attachment) => attachment.kind).sort()).toEqual(["audio", "document", "image"]);
    expect(attachments.some((attachment) => attachment.name === "chart.png")).toBe(true);

    await adapter.close();
  });

  test("does not duplicate an attachment that appears as both an artifact and a part", async () => {
    const sessionDirectory = await createSessionDirectory();
    const adapter = new WhatsAppChannelAdapter({ pollIntervalMs: 10, sessionDirectory });

    const artifact = {
      id: "artifact.same",
      kind: "image" as const,
      mediaType: "image/png",
      metadata: {},
      name: "same.png",
      uri: "file:///tmp/same.png"
    };

    await adapter.send(
      outboundMessage({
        attachments: [artifact],
        parts: [
          { kind: "text", text: "one image only" },
          { artifact, kind: "image", uri: artifact.uri }
        ]
      })
    );

    const entries = await readOutbound(sessionDirectory);
    const attachments = entries[0]!.attachments as unknown[];
    expect(attachments).toHaveLength(1);

    await adapter.close();
  });

  test("normalizeInboundMessage validates an already-shaped channel message", async () => {
    const sessionDirectory = await createSessionDirectory();
    const adapter = new WhatsAppChannelAdapter({ pollIntervalMs: 10, sessionDirectory });

    const message = outboundMessage({ direction: "inbound" });
    await expect(adapter.normalizeInboundMessage(message)).resolves.toMatchObject({ id: message.id });

    await adapter.close();
  });

  // The poller must survive a transient filesystem failure: throwing out of
  // the loop surfaced as an unhandled rejection (which can take the process
  // down) and silently stopped inbound delivery.
  test("keeps polling after the inbound directory disappears", async () => {
    const sessionDirectory = await createSessionDirectory();
    const adapter = new WhatsAppChannelAdapter({ pollIntervalMs: 10, sessionDirectory });
    const received: ChannelMessage[] = [];
    await adapter.start({
      emitInboundMessage: async (message) => {
        received.push(message);
        return message;
      }
    });

    // Capture the warning rather than letting it spam the suite output, and
    // assert it actually fires — a poller that fails silently is the other
    // half of this bug.
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      await fs.rm(path.join(sessionDirectory, "inbound"), { force: true, recursive: true });
      await new Promise((resolve) => setTimeout(resolve, 60));
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings.some((entry) => entry.includes("AIA_CHANNEL_POLL_FAILED"))).toBe(true);

    // Recreate it and confirm delivery resumes rather than having stopped.
    await fs.mkdir(path.join(sessionDirectory, "inbound"), { recursive: true });
    await fs.writeFile(
      path.join(sessionDirectory, "inbound", "0001.json"),
      JSON.stringify({
        accountId: "whatsapp-account",
        createdAt: "2026-03-31T12:00:00.000Z",
        id: "channel-message.whatsapp.inbound.recovered",
        media: [],
        metadata: {},
        text: "still here",
        userId: "user-42"
      }),
      "utf8"
    );

    await waitFor(() => received.length > 0);
    await adapter.close();

    expect(received[0]?.parts).toEqual([{ kind: "text", text: "still here" }]);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out after ${timeoutMs}ms.`);
}
