import { ZodError } from "zod";

import type { JsonValue, StructuredError } from "@/core/contracts";

export function createGatewayError(
  code: string,
  message: string,
  details: Record<string, JsonValue> = {},
  retriable = false
): StructuredError {
  return {
    code,
    details,
    message,
    retriable
  };
}

export function normalizeGatewayError(error: unknown): StructuredError {
  if (isStructuredError(error)) {
    return error;
  }

  if (error instanceof ZodError) {
    return createGatewayError("invalid_request", "The gateway request did not match the expected schema.", {
      issues: error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    });
  }

  if (error instanceof Error) {
    return createGatewayError("gateway_request_failed", error.message, {
      name: error.name
    });
  }

  return createGatewayError("gateway_request_failed", String(error));
}

export function mapGatewayErrorToHttpStatusCode(error: StructuredError): number {
  switch (error.code) {
    case "authentication_required":
    case "unauthorized":
      return 401;
    case "forbidden":
      return 403;
    case "invalid_request":
      return 400;
    case "not_found":
      return 404;
    case "busy":
      return 409;
    case "timed_out":
      return 504;
    case "not_implemented":
      return 501;
    default:
      return 500;
  }
}

export function isStructuredError(error: unknown): error is StructuredError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    "retriable" in error
  );
}
