import { describe, expect, test } from "vitest";
import { z } from "zod";

import {
  createGatewayError,
  isStructuredError,
  mapGatewayErrorToHttpStatusCode,
  normalizeGatewayError
} from "@/gateway/errors";

describe("gateway errors", () => {
  test("createGatewayError fills defaults", () => {
    expect(createGatewayError("boom", "It broke")).toEqual({
      code: "boom",
      details: {},
      message: "It broke",
      retriable: false
    });
    expect(createGatewayError("boom", "retry", { attempt: 1 }, true)).toMatchObject({
      details: { attempt: 1 },
      retriable: true
    });
  });

  test("normalizeGatewayError passes through structured errors", () => {
    const structured = createGatewayError("not_found", "missing");
    expect(normalizeGatewayError(structured)).toBe(structured);
  });

  test("normalizeGatewayError maps zod errors to invalid_request", () => {
    const parsed = z.object({ name: z.string() }).safeParse({});
    const error = parsed.success ? new z.ZodError([]) : parsed.error;
    const normalized = normalizeGatewayError(error);
    expect(normalized.code).toBe("invalid_request");
    expect(Array.isArray((normalized.details as { issues: string[] }).issues)).toBe(true);
  });

  test("normalizeGatewayError maps native errors and unknown values", () => {
    const fromError = normalizeGatewayError(new Error("kaboom"));
    expect(fromError).toMatchObject({ code: "gateway_request_failed", message: "kaboom" });

    const fromString = normalizeGatewayError("plain");
    expect(fromString).toMatchObject({ code: "gateway_request_failed", message: "plain" });
  });

  test("mapGatewayErrorToHttpStatusCode covers known codes", () => {
    const cases: Array<[string, number]> = [
      ["authentication_required", 401],
      ["unauthorized", 401],
      ["forbidden", 403],
      ["invalid_request", 400],
      ["not_found", 404],
      ["busy", 409],
      ["timed_out", 504],
      ["not_implemented", 501],
      ["something_else", 500]
    ];
    for (const [code, status] of cases) {
      expect(mapGatewayErrorToHttpStatusCode(createGatewayError(code, code))).toBe(status);
    }
  });

  test("isStructuredError discriminates", () => {
    expect(isStructuredError(createGatewayError("x", "y"))).toBe(true);
    expect(isStructuredError({ code: "x" })).toBe(false);
    expect(isStructuredError(null)).toBe(false);
    expect(isStructuredError("nope")).toBe(false);
  });
});
