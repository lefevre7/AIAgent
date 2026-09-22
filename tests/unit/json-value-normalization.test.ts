import { describe, expect, test } from "vitest";

import {
  jsonValueSchema,
  mcpServerSummarySchema,
  metadataSchema,
  toJsonRecord,
  toJsonValue,
  toolCallRecordSchema
} from "@/core/contracts";

// Zod keeps an optional key that was assigned an explicit `undefined`, and a
// record of JsonValue has no branch for one. That combination made a real run
// unrecoverable: an MCP server that never connected produced a summary with
// `lastConnectedAt: undefined`, the tool.updated event carrying it failed to
// parse, and the run died mid-finalization. The on-disk copy looked healthy
// because JSON.stringify had already dropped the key.

describe("json value normalization", () => {
  test("zod keeps a key assigned an explicit undefined", () => {
    const summary = mcpServerSummarySchema.parse({
      capabilities: { prompts: 0, resourceTemplates: 0, resources: 0, tools: 0 },
      error: "fetch failed",
      lastConnectedAt: undefined,
      serverName: "never-connected",
      state: "failed",
      tools: [],
      transport: "streamable-http"
    });

    expect("lastConnectedAt" in summary).toBe(true);
    expect(summary.lastConnectedAt).toBeUndefined();
  });

  test("jsonValueSchema tolerates an undefined-valued key by dropping it", () => {
    const parsed = jsonValueSchema.parse({
      keep: "value",
      nested: { deep: undefined, kept: 1 },
      drop: undefined
    });

    expect(parsed).toEqual({ keep: "value", nested: { kept: 1 } });
  });

  test("metadata records tolerate undefined-valued keys at the top level", () => {
    expect(metadataSchema.parse({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  test("a tool call record carrying an undefined-valued result key still parses", () => {
    const record = {
      arguments: {},
      completedAt: "2026-09-18T01:46:16.661Z",
      id: "116086964",
      metadata: {},
      result: {
        servers: [{ error: "fetch failed", lastConnectedAt: undefined }]
      },
      sessionId: "session.x",
      startedAt: "2026-09-18T01:46:16.661Z",
      status: "succeeded",
      toolName: "mcp_status",
      turnId: "turn.x"
    };

    expect(() => toolCallRecordSchema.parse(record)).not.toThrow();
  });

  test("toJsonValue matches what JSON.stringify would keep", () => {
    expect(toJsonValue({ drop: undefined, keep: 1 })).toEqual({ keep: 1 });
    expect(toJsonValue([1, undefined, "two"])).toEqual([1, null, "two"]);
    expect(toJsonValue(Number.NaN)).toBeNull();
    expect(toJsonValue(Number.POSITIVE_INFINITY)).toBeNull();
    expect(toJsonValue(undefined)).toBeUndefined();
    expect(toJsonValue(() => undefined)).toBeUndefined();
    expect(toJsonValue(new Date("2026-09-18T01:46:16.661Z"))).toBe("2026-09-18T01:46:16.661Z");
    expect(toJsonValue({ nested: { drop: undefined, keep: [{ a: undefined }] } })).toEqual({
      nested: { keep: [{}] }
    });
  });

  test("toJsonRecord collapses non-objects rather than corrupting the field", () => {
    expect(toJsonRecord({ a: undefined, b: 2 })).toEqual({ b: 2 });
    expect(toJsonRecord("not an object")).toEqual({});
    expect(toJsonRecord(undefined)).toEqual({});
    expect(toJsonRecord([1, 2])).toEqual({});
  });
});
