import crypto from "node:crypto";

import { Router, type Response } from "express";

import {
  gatewayApprovalListQuerySchema,
  gatewayEventReplayQuerySchema,
  gatewayRequestSchema,
  gatewayResponseSchema,
  type GatewayRequest,
  type GatewayResponse
} from "@/core/contracts";
import { BOOTSTRAP_PHASE } from "@/core/runtime-metadata";
import { authorizeGatewayHttpRequest, type GatewayAuthOptions } from "@/gateway/auth";
import { mapGatewayErrorToHttpStatusCode, normalizeGatewayError } from "@/gateway/errors";
import { withGatewayTimeout } from "@/gateway/timeout";
import type { GatewayRuntimeLike } from "@/gateway/runtime";

export type GatewayHealthSnapshot = {
  ok: true;
  phase: string;
  surface: "gateway";
};

export type GatewayRouterOptions = {
  auth?: GatewayAuthOptions;
  requestTimeoutMs?: number;
  runtime: GatewayRuntimeLike;
};

export function createGatewayHealthSnapshot(): GatewayHealthSnapshot {
  return {
    ok: true,
    phase: BOOTSTRAP_PHASE,
    surface: "gateway"
  };
}

export async function handleGatewayRequest(
  request: GatewayRequest,
  options: Pick<GatewayRouterOptions, "requestTimeoutMs" | "runtime">
): Promise<GatewayResponse> {
  try {
    return gatewayResponseSchema.parse(
      await withGatewayTimeout(options.runtime.request(request), options.requestTimeoutMs ?? 120_000)
    );
  } catch (error) {
    return buildGatewayErrorResponse(request, normalizeGatewayError(error));
  }
}

export function createGatewayRouter(options: GatewayRouterOptions): Router {
  const router = Router();

  router.use((request, response, next) => {
    const authorization = authorizeGatewayHttpRequest(request, options.auth);
    if (authorization.ok) {
      next();
      return;
    }

    response.status(authorization.statusCode).json({
      error: authorization.error,
      ok: false
    });
  });

  router.get("/health", (_request, response) => {
    response.json(createGatewayHealthSnapshot());
  });

  router.get("/status", (_request, response) => {
    response.json({
      ok: true,
      status: "ready"
    });
  });

  router.post("/request", async (request, response) => {
    const envelope = gatewayRequestSchema.safeParse(request.body);
    if (!envelope.success) {
      const error = normalizeGatewayError(envelope.error);
      response.status(400).json({
        error,
        ok: false
      });
      return;
    }

    response.json(await handleGatewayRequest(envelope.data, options));
  });

  router.get("/sessions/:sessionId/snapshot", async (request, response) => {
    await respondWithGatewayJson(response, async () => options.runtime.getSessionSnapshot(request.params.sessionId));
  });

  router.get("/approvals", async (request, response) => {
    await respondWithGatewayJson(response, async () =>
      ({
        approvals: await options.runtime.listApprovalRecords(
          gatewayApprovalListQuerySchema.parse({
            limit: parseIntegerQueryValue(request.query.limit),
            pendingOnly: parseBooleanQueryValue(request.query.pendingOnly),
            sessionId: parseStringQueryValue(request.query.sessionId)
          })
        )
      }) satisfies {
        approvals: Awaited<ReturnType<GatewayRuntimeLike["listApprovalRecords"]>>;
      }
    );
  });

  router.get("/approvals/:requestId", async (request, response) => {
    await respondWithGatewayJson(response, async () => options.runtime.getApprovalRecord(request.params.requestId));
  });

  router.get("/events", async (request, response) => {
    await respondWithGatewayJson(response, async () =>
      options.runtime.replayEvents(
        gatewayEventReplayQuerySchema.parse({
          cursor: parseStringQueryValue(request.query.cursor),
          limit: parseIntegerQueryValue(request.query.limit),
          sessionId: parseStringQueryValue(request.query.sessionId),
          topics: parseStringListQueryValue(request.query.topics)
        })
      )
    );
  });

  return router;
}

async function respondWithGatewayJson(
  response: Response,
  load: () => Promise<unknown>
): Promise<void> {
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

function buildGatewayErrorResponse(request: GatewayRequest, error: GatewayResponse["error"]): GatewayResponse {
  return gatewayResponseSchema.parse({
    createdAt: new Date().toISOString(),
    error,
    id: `gateway-response.${crypto.randomUUID()}`,
    metadata: {},
    ok: false,
    requestId: request.id,
    topic: request.topic
  });
}

function parseBooleanQueryValue(value: unknown): boolean | undefined {
  const text = parseStringQueryValue(value)?.toLowerCase();
  if (!text) {
    return undefined;
  }
  if (text === "true") {
    return true;
  }
  if (text === "false") {
    return false;
  }
  return undefined;
}

function parseIntegerQueryValue(value: unknown): number | undefined {
  const text = parseStringQueryValue(value);
  if (!text) {
    return undefined;
  }
  const parsed = Number.parseInt(text, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseStringListQueryValue(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const values = value
      .flatMap((entry) => (typeof entry === "string" ? entry.split(",") : []))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    return values.length > 0 ? values : undefined;
  }

  const text = parseStringQueryValue(value);
  if (!text) {
    return undefined;
  }

  const values = text
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return values.length > 0 ? values : undefined;
}

function parseStringQueryValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (Array.isArray(value)) {
    const first = value.find((entry): entry is string => typeof entry === "string" && entry.length > 0);
    return first;
  }

  return undefined;
}
