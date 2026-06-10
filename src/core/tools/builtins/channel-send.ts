import { z } from "zod";

import type { JsonSchemaDocument, ToolDefinition } from "@/core/contracts";
import type { ChannelService } from "@/core/channels";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

const channelSendInputSchema = z
  .object({
    text: z.string().min(1).max(8000)
  })
  .strict();

export function createChannelSendTool(params: { channelService: ChannelService }): RuntimeTool {
  return {
    definition: channelSendToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = channelSendInputSchema.parse(call.arguments as unknown);
      const route = await params.channelService.getRouteForSession(context.session.id);
      if (!route) {
        throw new Error("This session is not bound to a messaging channel, so there is no recipient to message.");
      }

      const sent = await params.channelService.send({
        attachments: [],
        identity: route.identity,
        metadata: {},
        parts: [{ kind: "text", text: input.text }],
        sessionId: context.session.id
      });

      return {
        display: [
          {
            kind: "status",
            state: "sent",
            summary: `Sent a message to ${route.identity.channel} (${route.identity.displayName ?? route.identity.userId}).`
          }
        ],
        result: {
          channel: route.identity.channel,
          delivered: true,
          messageId: sent.id
        }
      };
    }
  };
}

const channelSendOutputSchema: JsonSchemaDocument = {
  additionalProperties: false,
  properties: {
    channel: { type: "string" },
    delivered: { type: "boolean" },
    messageId: { type: "string" }
  },
  required: ["channel", "delivered", "messageId"],
  type: "object"
};

export const channelSendToolDefinition: ToolDefinition = {
  aliases: ["message_channel", "notify_channel"],
  annotations: {
    idempotentHint: false,
    meta: {
      family: "channels"
    },
    openWorldHint: true,
    readOnlyHint: false,
    title: "Send Channel Message"
  },
  approvalMode: "ask",
  descriptor: {
    approvalNotes: "Operator approval is required because this tool sends a message to an external messaging channel.",
    examples: [
      "Notify the operator on their channel that a long task has finished.",
      "Send a short status update to the channel that started this session."
    ],
    purpose: "Send a message to the messaging channel that this session is bound to.",
    sideEffectSummary: "Delivers an outbound message to an external channel.",
    whenNotToUse: [
      "Do not use it when the session is not bound to a channel.",
      "Do not use it for normal assistant replies; just respond in the session."
    ],
    whenToUse: [
      "Use to proactively notify the originating channel (e.g. a finished job or a needed decision).",
      "Use when the operator asked to be messaged on their channel."
    ]
  },
  description:
    "Send a message to the messaging channel this session is bound to (for example WhatsApp). Fails if the session has no bound channel. Requires approval because it delivers an external message.",
  displayName: "Send Channel Message",
  execution: {
    inputMode: "json",
    resumable: false,
    taskSupport: "forbidden"
  },
  idempotent: false,
  inputSchema: {
    additionalProperties: false,
    properties: {
      text: {
        description: "The message text to send to the bound channel.",
        type: "string"
      }
    },
    required: ["text"],
    type: "object"
  },
  invocationName: "channel_send",
  kind: "built_in",
  metadata: {},
  name: "channel_send",
  outputKind: "json",
  outputSchema: channelSendOutputSchema,
  retryable: false,
  searchTags: ["channel", "message", "notify", "send", "whatsapp"],
  sideEffects: ["channel_io"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.builtin.channel_send",
  usageGuidance:
    "Use this to message the channel that started the session. It requires approval and fails if the session is not bound to a channel. Keep messages concise.",
  version: "1.0.0"
};
