import express, { type Request, type Response } from "express";

import { createBootstrapInfo } from "@/core/index";
import { createGatewayRouter, type GatewayRouterOptions } from "@/gateway/index";
import { createChannelRouter, type ChannelRouterOptions } from "@/server/channel-router";
import { createControlPlaneRouter, type ControlPlaneRouterOptions } from "@/server/control-plane/router";
import { createWebAccessMiddleware, type WebAccessOptions } from "@/server/web-access";

export type NextRequestHandler = (request: Request, response: Response) => Promise<void> | void;
export type HttpApp = ReturnType<typeof express> & {
  handle: (request: Request, response: Response, next: (error?: unknown) => void) => void;
};

export type HttpAppOptions = {
  channels?: ChannelRouterOptions;
  controlPlane?: ControlPlaneRouterOptions;
  gateway?: GatewayRouterOptions;
  webAccess?: WebAccessOptions;
};

export function createHttpApp(nextRequestHandler: NextRequestHandler, options: HttpAppOptions = {}): HttpApp {
  const app = express();
  const bootstrapInfo = createBootstrapInfo();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));

  app.get("/api/health", (_request, response) => {
    response.json({
      bootstrap: bootstrapInfo,
      ok: true,
      surface: "server"
    });
  });

  if (options.gateway) {
    app.use("/api/gateway", createGatewayRouter(options.gateway));
  }

  if (options.controlPlane) {
    app.use("/api/control-plane", createControlPlaneRouter(options.controlPlane));
  }

  if (options.channels) {
    app.use("/api/channels", createChannelRouter(options.channels));
  }

  if (options.webAccess) {
    app.use(createWebAccessMiddleware(options.webAccess));
  }

  app.all(/.*/, async (request, response) => {
    await nextRequestHandler(request, response);
  });

  return app as HttpApp;
}
