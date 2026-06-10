import { Router, type Request, type Response } from "express";

import { mapGatewayErrorToHttpStatusCode, normalizeGatewayError } from "@/gateway/errors";
import {
  createControlPlaneAccessMiddleware,
  type WebAccessOptions
} from "@/server/web-access";
import { ControlPlaneService } from "@/server/control-plane/service";

export type ControlPlaneRouterOptions = {
  access?: WebAccessOptions;
  service: ControlPlaneService;
};

export function createControlPlaneRouter(options: ControlPlaneRouterOptions): Router {
  const router = Router();

  router.use(createControlPlaneAccessMiddleware(options.access));

  router.get("/dashboard", async (request, response) => {
    await respondWithJson(response, async () =>
      options.service.getDashboard({
        eventLimit: parseIntegerField(request.query.eventLimit),
        memorySessionId: readStringField(request.query.memorySessionId),
        memoryText: readStringField(request.query.memoryText),
        sessionId: readStringField(request.query.sessionId),
        sessionLimit: parseIntegerField(request.query.sessionLimit)
      })
    );
  });

  router.get("/sessions", async (request, response) => {
    await respondWithJson(response, async () => ({
      sessions: await options.service.listSessions(parseIntegerField(request.query.limit) ?? 24)
    }));
  });

  router.get("/events/stream", (request, response) => {
    response.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream"
    });
    response.write(": connected\n\n");

    const unsubscribe = options.service.subscribeEvents(
      (event) => {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      },
      { sessionId: readStringField(request.query.sessionId) }
    );

    const heartbeat = setInterval(() => response.write(": ping\n\n"), 15_000);
    heartbeat.unref?.();
    request.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  router.get("/sessions/:sessionId", async (request, response) => {
    await respondWithJson(response, async () => options.service.getSessionView(request.params.sessionId));
  });

  router.get("/approvals", async (_request, response) => {
    await respondWithJson(response, async () => ({
      approvals: await options.service.listApprovals()
    }));
  });

  router.get("/memory", async (request, response) => {
    await respondWithJson(response, async () =>
      options.service.getMemory({
        sessionId: readStringField(request.query.sessionId),
        text: readStringField(request.query.text)
      })
    );
  });

  router.get("/channels", async (_request, response) => {
    await respondWithJson(response, async () => options.service.getChannels());
  });

  router.get("/gateway", async (_request, response) => {
    await respondWithJson(response, async () => options.service.getGatewaySummary());
  });

  router.get("/logs", async (request, response) => {
    await respondWithJson(response, async () =>
      options.service.getLogs({
        limit: parseIntegerField(request.query.limit),
        sessionId: readStringField(request.query.sessionId)
      })
    );
  });

  router.get("/settings", async (_request, response) => {
    await respondWithJson(response, async () => options.service.getSettingsSummary());
  });

  router.get("/tunnel", async (_request, response) => {
    await respondWithJson(response, async () => options.service.getTunnelStatus());
  });

  router.post("/sessions", async (request, response) => {
    await respondWithAction(request, response, async () => {
      const result = await options.service.createSession({
        cwd: requiredField(request, "cwd"),
        goal: requiredField(request, "goal"),
        initialMessage: readBodyField(request, "initialMessage"),
        title: requiredField(request, "title")
      });

      return {
        body: result,
        flash: "Session created.",
        sessionId: result.session.id
      };
    });
  });

  router.post("/sessions/:sessionId/messages", async (request, response) => {
    await respondWithAction(request, response, async () => ({
      body: await options.service.sendSessionMessage({
        sessionId: request.params.sessionId,
        text: requiredField(request, "text")
      }),
      flash: "Message queued.",
      sessionId: request.params.sessionId
    }));
  });

  router.post("/sessions/:sessionId/steering", async (request, response) => {
    await respondWithAction(request, response, async () => ({
      body: await options.service.injectSteering({
        message: requiredField(request, "message"),
        sessionId: request.params.sessionId
      }),
      flash: "Steering queued.",
      sessionId: request.params.sessionId
    }));
  });

  router.post("/approvals/:requestId/resolve", async (request, response) => {
    await respondWithAction(request, response, async () => ({
      body: await options.service.resolveApproval({
        comment: readBodyField(request, "comment"),
        decision: requiredField(request, "decision") as "approved" | "cancelled" | "denied" | "expired",
        requestId: request.params.requestId
      }),
      flash: "Approval updated."
    }));
  });

  return router;
}

async function respondWithAction(
  request: Request,
  response: Response,
  action: () => Promise<{
    body: unknown;
    flash: string;
    sessionId?: string;
  }>
): Promise<void> {
  const redirectTo = normalizeRedirectTarget(
    readBodyField(request, "redirectTo") ?? readStringField(request.query.redirectTo)
  );

  try {
    const result = await action();
    if (redirectTo) {
      response.redirect(
        303,
        appendQueryParams(redirectTo, {
          flash: result.flash,
          sessionId: result.sessionId
        })
      );
      return;
    }

    response.json({
      ok: true,
      result: result.body
    });
  } catch (error) {
    const structuredError = normalizeGatewayError(error);
    if (redirectTo) {
      response.redirect(
        303,
        appendQueryParams(redirectTo, {
          flashError: structuredError.message
        })
      );
      return;
    }

    response.status(mapGatewayErrorToHttpStatusCode(structuredError)).json({
      error: structuredError,
      ok: false
    });
  }
}

async function respondWithJson(response: Response, load: () => Promise<unknown>): Promise<void> {
  try {
    response.json(await load());
  } catch (error) {
    const structuredError = normalizeGatewayError(error);
    response.status(mapGatewayErrorToHttpStatusCode(structuredError)).json({
      error: structuredError,
      ok: false
    });
  }
}

function appendQueryParams(target: string, params: Record<string, string | undefined>): string {
  const url = new URL(target, "http://localhost");
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }
  return `${url.pathname}${url.search}`;
}

function normalizeRedirectTarget(value: string | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return null;
  }
  return value;
}

function parseIntegerField(value: unknown): number | undefined {
  const parsed = Number.parseInt(readStringField(value) ?? "", 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readBodyField(request: Request, key: string): string | undefined {
  return readStringField((request.body as Record<string, unknown> | undefined)?.[key]);
}

function readStringField(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (Array.isArray(value)) {
    const first = value.find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    return first?.trim();
  }

  return undefined;
}

function requiredField(request: Request, key: string): string {
  const value = readBodyField(request, key);
  if (!value) {
    throw new Error(`Missing required field "${key}".`);
  }
  return value;
}
