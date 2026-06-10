import { Router } from "express";

import { channelKindSchema } from "@/core/contracts";
import { mapGatewayErrorToHttpStatusCode, normalizeGatewayError } from "@/gateway/errors";
import type { GatewayRuntime } from "@/gateway/runtime";
import type { ChannelService } from "@/core/channels";

export type ChannelRouterOptions = {
  channelService: ChannelService;
  gatewayRuntime: GatewayRuntime;
};

export function createChannelRouter(options: ChannelRouterOptions): Router {
  const router = Router();

  router.post("/:channel/webhook", async (request, response) => {
    try {
      const channel = channelKindSchema.parse(request.params.channel);
      const messages = await options.channelService.handleWebhook(channel, request.body, request.headers);
      const runs = await Promise.all(messages.map(async (message) => options.gatewayRuntime.acceptChannelMessage(message)));

      response.status(202).json({
        messages,
        ok: true,
        runs: runs.filter((run) => run !== null)
      });
    } catch (error) {
      const structuredError = normalizeGatewayError(error);
      response.status(mapGatewayErrorToHttpStatusCode(structuredError)).json({
        error: structuredError,
        ok: false
      });
    }
  });

  return router;
}
