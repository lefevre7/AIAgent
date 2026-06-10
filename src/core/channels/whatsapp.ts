import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  artifactKindSchema,
  channelIdentitySchema,
  channelMessageSchema,
  entityIdSchema,
  isoTimestampSchema,
  messagePartSchema,
  metadataSchema,
  type ArtifactReference,
  type ChannelAdapter,
  type ChannelAdapterStartContext,
  type ChannelMessage,
  type MessagePart
} from "@/core/contracts";
import { createArtifactReferenceFromFile } from "@/core/io/artifacts";
import { sleep, writeJsonAtomic } from "@/core/io/files";

const DEFAULT_POLL_INTERVAL_MS = 250;

const whatsappBridgeMediaSchema = z
  .object({
    caption: z.string().min(1).optional(),
    filePath: z.string().min(1),
    kind: z.enum(["audio", "document", "image", "video"]),
    mediaType: z.string().min(1).max(256).optional(),
    name: z.string().min(1).max(256).optional()
  })
  .strict();

export const whatsappBridgeInboundEntrySchema = z
  .object({
    accountId: z.string().min(1).max(256),
    createdAt: isoTimestampSchema,
    displayName: z.string().min(1).max(256).optional(),
    id: entityIdSchema,
    media: z.array(whatsappBridgeMediaSchema).default([]),
    metadata: metadataSchema.default({}),
    replyToId: entityIdSchema.optional(),
    roomId: z.string().min(1).max(256).optional(),
    text: z.string().min(1).optional(),
    userId: z.string().min(1).max(256)
  })
  .strict()
  .superRefine((value, context) => {
    if (value.text?.trim() || value.media.length > 0) {
      return;
    }

    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Expected either "text" or at least one media item for a WhatsApp inbound entry.'
    });
  });

const whatsappBridgeOutboundAttachmentSchema = z
  .object({
    filePath: z.string().min(1).optional(),
    kind: z.enum(["audio", "document", "image", "video"]),
    mediaType: z.string().min(1).max(256).optional(),
    name: z.string().min(1).max(256).optional(),
    uri: z.string().min(1)
  })
  .strict();

export const whatsappBridgeOutboundEntrySchema = z
  .object({
    attachments: z.array(whatsappBridgeOutboundAttachmentSchema).default([]),
    createdAt: isoTimestampSchema,
    id: entityIdSchema,
    identity: channelIdentitySchema,
    metadata: metadataSchema.default({}),
    parts: z.array(messagePartSchema).min(1),
    replyToId: entityIdSchema.optional(),
    sessionId: entityIdSchema.optional(),
    text: z.string().min(1).optional()
  })
  .strict();

export type WhatsAppChannelAdapterOptions = {
  pollIntervalMs?: number;
  sessionDirectory: string;
};

export class WhatsAppChannelAdapter implements ChannelAdapter {
  readonly capabilities: ChannelAdapter["capabilities"] = [
    "approvals",
    "attachments",
    "images",
    "outbound_messages",
    "steering"
  ];
  readonly channel = "whatsapp" as const;

  private closed = false;
  private poller: Promise<void> | null = null;

  constructor(private readonly options: WhatsAppChannelAdapterOptions) {}

  async close(): Promise<void> {
    this.closed = true;
    await this.poller?.catch(() => undefined);
    this.poller = null;
  }

  async health(): Promise<{ ok: boolean }> {
    await this.ensureDirectories();
    return {
      ok: true
    };
  }

  async normalizeInboundMessage(message: ChannelMessage): Promise<ChannelMessage> {
    return channelMessageSchema.parse(message);
  }

  async send(message: ChannelMessage): Promise<void> {
    await this.ensureDirectories();
    const outbound = whatsappBridgeOutboundEntrySchema.parse({
      attachments: collectOutboundAttachments(message),
      createdAt: message.createdAt,
      id: message.id,
      identity: message.identity,
      metadata: {
        ...message.metadata,
        transport: "whatsapp_session_directory"
      },
      parts: message.parts,
      replyToId: message.replyToId,
      sessionId: message.sessionId,
      text: renderMessagePartsToText(message.parts)
    });

    const filePath = path.join(
      this.outboundDirectory(),
      `${sanitizeSegment(message.createdAt)}.${sanitizeSegment(message.id)}.json`
    );
    await writeJsonAtomic(filePath, outbound);
  }

  async start(context: ChannelAdapterStartContext): Promise<void> {
    if (this.poller) {
      return;
    }

    await this.ensureDirectories();
    this.closed = false;
    this.poller = this.runPollingLoop(context);
  }

  private async archiveInboundFile(filePath: string, bucket: "failed" | "processed"): Promise<void> {
    const targetDirectory = bucket === "processed" ? this.processedInboundDirectory() : this.failedInboundDirectory();
    await fs.mkdir(targetDirectory, { recursive: true });
    const targetPath = path.join(targetDirectory, path.basename(filePath));
    await fs.rename(filePath, targetPath).catch(async () => {
      const fallbackPath = path.join(
        targetDirectory,
        `${path.basename(filePath, ".json")}.${Date.now()}.${bucket}.json`
      );
      await fs.rename(filePath, fallbackPath);
    });
  }

  private async ensureDirectories(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.failedInboundDirectory(), { recursive: true }),
      fs.mkdir(this.inboundDirectory(), { recursive: true }),
      fs.mkdir(this.inboundMediaDirectory(), { recursive: true }),
      fs.mkdir(this.outboundDirectory(), { recursive: true }),
      fs.mkdir(this.processedInboundDirectory(), { recursive: true })
    ]);
  }

  private failedInboundDirectory(): string {
    return path.join(this.options.sessionDirectory, "failed", "inbound");
  }

  private inboundDirectory(): string {
    return path.join(this.options.sessionDirectory, "inbound");
  }

  private inboundMediaDirectory(): string {
    return path.join(this.options.sessionDirectory, "media", "inbound");
  }

  private async normalizeInboundEntry(
    input: z.infer<typeof whatsappBridgeInboundEntrySchema> | ChannelMessage
  ): Promise<ChannelMessage> {
    if ("identity" in input) {
      return channelMessageSchema.parse(input);
    }

    const attachments: ArtifactReference[] = [];
    const parts: MessagePart[] = [];
    const captions: string[] = [];

    if (input.text?.trim()) {
      parts.push({
        kind: "text",
        text: input.text.trim()
      });
    }

    for (const [index, media] of input.media.entries()) {
      const artifact = await this.persistInboundMedia(input.id, index, media);
      attachments.push(artifact);
      if (media.caption?.trim()) {
        captions.push(media.caption.trim());
      }

      switch (artifact.kind) {
        case "audio":
          parts.push({
            artifact,
            kind: "audio",
            title: artifact.name,
            uri: artifact.uri
          });
          break;
        case "image":
          parts.push({
            alt: media.caption,
            artifact,
            kind: "image",
            uri: artifact.uri
          });
          break;
        default:
          parts.push({
            artifact,
            kind: "file",
            title: artifact.name,
            uri: artifact.uri
          });
          break;
      }
    }

    if (!input.text?.trim() && captions.length > 0) {
      parts.unshift({
        kind: "text",
        text: captions.join("\n\n")
      });
    }

    return channelMessageSchema.parse({
      attachments: dedupeArtifacts(attachments),
      createdAt: input.createdAt,
      direction: "inbound",
      id: input.id,
      identity: {
        accountId: input.accountId,
        channel: "whatsapp",
        displayName: input.displayName,
        roomId: input.roomId,
        userId: input.userId
      },
      metadata: {
        ...input.metadata,
        transport: "whatsapp_session_directory"
      },
      parts,
      replyToId: input.replyToId
    });
  }

  private outboundDirectory(): string {
    return path.join(this.options.sessionDirectory, "outbound");
  }

  private async persistInboundMedia(
    messageId: string,
    index: number,
    media: z.infer<typeof whatsappBridgeMediaSchema>
  ): Promise<ArtifactReference> {
    const sourcePath = path.resolve(media.filePath);
    const resolvedName = media.name?.trim();
    const extension = path.extname(resolvedName || sourcePath);
    const baseNameSource =
      resolvedName && extension.length > 0
        ? resolvedName.slice(0, -extension.length)
        : resolvedName ?? path.basename(sourcePath, extension);
    const baseName = sanitizeFileName(baseNameSource || `${messageId}-${index + 1}`);
    const targetPath = path.join(
      this.inboundMediaDirectory(),
      `${sanitizeSegment(messageId)}.${index + 1}.${baseName}${extension}`
    );
    await fs.copyFile(sourcePath, targetPath);
    return createArtifactReferenceFromFile(targetPath, mapMediaKindToArtifactKind(media.kind), {
      mediaType: media.mediaType,
      metadata: {
        sourceFilePath: sourcePath,
        transport: "whatsapp_session_directory",
        whatsappMediaKind: media.kind
      },
      name: path.basename(targetPath)
    });
  }

  private async pollInboundDirectory(context: ChannelAdapterStartContext): Promise<void> {
    const entries = (await fs.readdir(this.inboundDirectory(), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      if (this.closed) {
        return;
      }

      const filePath = path.join(this.inboundDirectory(), entry.name);
      try {
        const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
        const normalized = await this.normalizeInboundEntry(parseInboundPayload(raw));
        await context.emitInboundMessage(normalized);
        await this.archiveInboundFile(filePath, "processed");
      } catch {
        await this.archiveInboundFile(filePath, "failed");
      }
    }
  }

  private processedInboundDirectory(): string {
    return path.join(this.options.sessionDirectory, "processed", "inbound");
  }

  private async runPollingLoop(context: ChannelAdapterStartContext): Promise<void> {
    while (!this.closed) {
      await this.pollInboundDirectory(context);
      if (this.closed) {
        return;
      }
      await sleep(this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    }
  }
}

function collectArtifactsFromParts(parts: MessagePart[]): ArtifactReference[] {
  return parts.flatMap((part) => {
    switch (part.kind) {
      case "audio":
      case "file":
      case "image":
        return part.artifact ? [part.artifact] : [];
      default:
        return [];
    }
  });
}

function collectOutboundAttachments(message: ChannelMessage): Array<z.infer<typeof whatsappBridgeOutboundAttachmentSchema>> {
  const seen = new Set<string>();
  const artifacts = dedupeArtifacts([...message.attachments, ...collectArtifactsFromParts(message.parts)]);
  const fromArtifacts = artifacts.map((artifact) => toOutboundAttachment({
    kind: mapArtifactKindToOutboundKind(artifact.kind),
    mediaType: artifact.mediaType,
    name: artifact.name,
    uri: artifact.uri
  }));
  const fromParts = message.parts.flatMap((part) => {
    switch (part.kind) {
      case "audio":
        return part.artifact
          ? []
          : [
              toOutboundAttachment({
                kind: "audio",
                name: part.title,
                uri: part.uri
              })
            ];
      case "file":
        return part.artifact
          ? []
          : [
              toOutboundAttachment({
                kind: "document",
                name: part.title,
                uri: part.uri
              })
            ];
      case "image":
        return part.artifact
          ? []
          : [
              toOutboundAttachment({
                kind: "image",
                uri: part.uri
              })
            ];
      default:
        return [];
    }
  });

  return [...fromArtifacts, ...fromParts].filter((attachment) => {
    if (seen.has(attachment.uri)) {
      return false;
    }
    seen.add(attachment.uri);
    return true;
  });
}

function dedupeArtifacts(artifacts: ArtifactReference[]): ArtifactReference[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    if (seen.has(artifact.uri)) {
      return false;
    }
    seen.add(artifact.uri);
    return true;
  });
}

function mapArtifactKindToOutboundKind(kind: z.infer<typeof artifactKindSchema>): "audio" | "document" | "image" | "video" {
  switch (kind) {
    case "audio":
      return "audio";
    case "image":
    case "screenshot":
      return "image";
    case "video":
      return "video";
    default:
      return "document";
  }
}

function mapMediaKindToArtifactKind(kind: z.infer<typeof whatsappBridgeMediaSchema>["kind"]): z.infer<typeof artifactKindSchema> {
  switch (kind) {
    case "audio":
      return "audio";
    case "image":
      return "image";
    case "video":
      return "video";
    case "document":
    default:
      return "document";
  }
}

function maybeFilePathFromUri(uri: string): string | undefined {
  if (path.isAbsolute(uri)) {
    return uri;
  }

  try {
    if (uri.startsWith("file://")) {
      return fileURLToPath(uri);
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function parseInboundPayload(raw: unknown): z.infer<typeof whatsappBridgeInboundEntrySchema> | ChannelMessage {
  if (typeof raw === "object" && raw !== null && "identity" in raw) {
    return channelMessageSchema.parse(raw);
  }

  return whatsappBridgeInboundEntrySchema.parse(raw);
}

function renderMessagePartsToText(parts: MessagePart[]): string | undefined {
  const rendered = parts
    .map((part) => {
      switch (part.kind) {
        case "audio":
          return part.title ? `[Audio] ${part.title}` : "[Audio]";
        case "citation":
          return part.uri ? `${part.title} (${part.uri})` : part.title;
        case "file":
          return part.title ? `[File] ${part.title}` : "[File]";
        case "image":
          return part.alt ? `[Image] ${part.alt}` : "[Image]";
        case "json":
          return JSON.stringify(part.value, null, 2);
        case "markdown":
          return part.markdown;
        case "status":
          return part.summary;
        case "text":
          return part.text;
      }
    })
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join("\n\n")
    .trim();

  return rendered.length > 0 ? rendered : undefined;
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "media";
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120) || "entry";
}

function toOutboundAttachment(input: {
  kind: "audio" | "document" | "image" | "video";
  mediaType?: string;
  name?: string;
  uri: string;
}): z.infer<typeof whatsappBridgeOutboundAttachmentSchema> {
  return whatsappBridgeOutboundAttachmentSchema.parse({
    filePath: maybeFilePathFromUri(input.uri),
    kind: input.kind,
    mediaType: input.mediaType,
    name: input.name,
    uri: input.uri
  });
}
