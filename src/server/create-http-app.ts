import express, { type NextFunction, type Request, type Response } from "express";

import { createBootstrapInfo } from "@/core/index";
import { createGatewayError } from "@/gateway/errors";
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

  app.use(respondToUnreadableBody);

  return app as HttpApp;
}

/**
 * A body the parsers cannot read (malformed JSON, or too large) used to get
 * Express's HTML error page, stack trace included in development, instead of
 * the `{ ok: false, error }` envelope every API client parses.
 */
function respondToUnreadableBody(error: unknown, _request: Request, response: Response, next: NextFunction): void {
  const type = typeof error === "object" && error !== null ? (error as { type?: unknown }).type : undefined;
  if (type === "entity.parse.failed") {
    response.status(400).json({
      error: createGatewayError("invalid_request", "The request body is not valid JSON."),
      ok: false
    });
    return;
  }
  if (type === "entity.too.large") {
    response.status(413).json({
      error: createGatewayError("invalid_request", "The request body is larger than the 1 MB limit."),
      ok: false
    });
    return;
  }
  next(error);
}
