import { z } from "zod";

import {
  artifactReferenceSchema,
  entityIdSchema,
  isoTimestampSchema,
  metadataSchema,
  structuredErrorSchema
} from "@/core/contracts/common";
import { messagePartSchema } from "@/core/contracts/messages";

export const channelKindSchema = z.enum(["cli", "discord", "gateway", "imessage", "sdk", "teams", "web", "whatsapp"]);
export const channelCapabilitySchema = z.enum([
  "approvals",
  "attachments",
  "images",
  "outbound_messages",
  "steering",
  "voice_input",
  "voice_output",
  "webhooks"
]);
export const channelRuntimeStateSchema = z.enum([
  "disabled",
  "healthy",
  "not_configured",
  "not_implemented",
  "unhealthy"
]);

export const channelIdentitySchema = z
  .object({
    accountId: z.string().min(1).max(256),
    channel: channelKindSchema,
    displayName: z.string().min(1).max(256).optional(),
    roomId: z.string().min(1).max(256).optional(),
    userId: z.string().min(1).max(256)
  })
  .strict();

export const channelMessageSchema = z
  .object({
    attachments: z.array(artifactReferenceSchema).default([]),
    createdAt: isoTimestampSchema,
    direction: z.enum(["inbound", "outbound"]),
    id: entityIdSchema,
    identity: channelIdentitySchema,
    metadata: metadataSchema.default({}),
    parts: z.array(messagePartSchema).min(1),
    replyToId: entityIdSchema.optional(),
    sessionId: entityIdSchema.optional()
  })
  .strict();

export const channelRuntimeStatusSchema = z
  .object({
    capabilities: z.array(channelCapabilitySchema).default([]),
    channel: channelKindSchema,
    configured: z.boolean(),
    enabled: z.boolean(),
    metadata: metadataSchema.default({}),
    status: channelRuntimeStateSchema
  })
  .strict();

export const channelSendRequestSchema = z
  .object({
    attachments: z.array(artifactReferenceSchema).default([]),
    identity: channelIdentitySchema,
    metadata: metadataSchema.default({}),
    parts: z.array(messagePartSchema).min(1),
    replyToId: entityIdSchema.optional(),
    sessionId: entityIdSchema.optional()
  })
  .strict();

export const channelRouteSchema = z
  .object({
    createdAt: isoTimestampSchema,
    id: entityIdSchema,
    identity: channelIdentitySchema,
    lastInboundMessageId: entityIdSchema.optional(),
    lastOutboundMessageId: entityIdSchema.optional(),
    metadata: metadataSchema.default({}),
    sessionId: entityIdSchema,
    updatedAt: isoTimestampSchema
  })
  .strict();

export const channelDeliveryStatusSchema = z.enum(["failed", "queued", "received", "sending", "sent"]);

export const channelDeliveryRecordSchema = z
  .object({
    attemptCount: z.number().int().nonnegative().default(0),
    channel: channelKindSchema,
    createdAt: isoTimestampSchema,
    direction: z.enum(["inbound", "outbound"]),
    id: entityIdSchema,
    lastAttemptAt: isoTimestampSchema.optional(),
    lastError: structuredErrorSchema.optional(),
    message: channelMessageSchema,
    metadata: metadataSchema.default({}),
    routeId: entityIdSchema.optional(),
    sessionId: entityIdSchema.optional(),
    status: channelDeliveryStatusSchema,
    updatedAt: isoTimestampSchema
  })
  .strict();

export const channelWebhookStatusSchema = z.enum(["disabled", "missing_public_base_url", "ready"]);

export const channelWebhookEndpointSchema = z
  .object({
    channel: channelKindSchema,
    metadata: metadataSchema.default({}),
    path: z.string().min(1),
    publicUrl: z.string().min(1).optional(),
    status: channelWebhookStatusSchema
  })
  .strict();

export interface ChannelAdapterStartContext {
  emitInboundMessage(message: ChannelMessage): Promise<ChannelMessage>;
}

export interface ChannelAdapter {
  readonly channel: ChannelKind;
  readonly capabilities: ChannelCapability[];

  health(): Promise<{ ok: boolean }>;
  handleWebhook?(
    payload: unknown,
    context: {
      headers: Record<string, string | string[] | undefined>;
      receivedAt: string;
    }
  ): Promise<ChannelMessage[]>;
  normalizeInboundMessage(message: ChannelMessage): Promise<ChannelMessage>;
  start?(context: ChannelAdapterStartContext): Promise<void>;
  send(message: ChannelMessage): Promise<void>;
  close?(): Promise<void>;
}

export type ChannelCapability = z.infer<typeof channelCapabilitySchema>;
export type ChannelDeliveryRecord = z.infer<typeof channelDeliveryRecordSchema>;
export type ChannelDeliveryStatus = z.infer<typeof channelDeliveryStatusSchema>;
export type ChannelIdentity = z.infer<typeof channelIdentitySchema>;
export type ChannelKind = z.infer<typeof channelKindSchema>;
export type ChannelMessage = z.infer<typeof channelMessageSchema>;
export type ChannelRoute = z.infer<typeof channelRouteSchema>;
export type ChannelRuntimeState = z.infer<typeof channelRuntimeStateSchema>;
export type ChannelRuntimeStatus = z.infer<typeof channelRuntimeStatusSchema>;
export type ChannelSendRequest = z.infer<typeof channelSendRequestSchema>;
export type ChannelWebhookEndpoint = z.infer<typeof channelWebhookEndpointSchema>;
export type ChannelWebhookStatus = z.infer<typeof channelWebhookStatusSchema>;
