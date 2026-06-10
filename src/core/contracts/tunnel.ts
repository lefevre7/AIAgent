import { z } from "zod";

import { channelKindSchema } from "@/core/contracts/channels";
import { metadataSchema } from "@/core/contracts/common";

export const tunnelProviderSchema = z.enum(["none", "tailscale"]);
export const tunnelExposureSurfaceSchema = z.enum(["channel_webhook", "gateway_http", "gateway_websocket", "web"]);
export const tunnelExposureSchema = z
  .object({
    channel: channelKindSchema.optional(),
    metadata: metadataSchema.default({}),
    path: z.string().min(1),
    publicUrl: z.string().min(1).optional(),
    requiresAuthentication: z.boolean().default(false),
    surface: tunnelExposureSurfaceSchema
  })
  .strict();

export const tunnelStatusSchema = z
  .object({
    enabled: z.boolean(),
    exposures: z.array(tunnelExposureSchema).default([]),
    metadata: metadataSchema.default({}),
    provider: tunnelProviderSchema,
    publicBaseUrl: z.string().min(1).optional(),
    ready: z.boolean(),
    warnings: z.array(z.string().min(1)).default([])
  })
  .strict();

export type TunnelExposure = z.infer<typeof tunnelExposureSchema>;
export type TunnelExposureSurface = z.infer<typeof tunnelExposureSurfaceSchema>;
export type TunnelProvider = z.infer<typeof tunnelProviderSchema>;
export type TunnelStatus = z.infer<typeof tunnelStatusSchema>;
