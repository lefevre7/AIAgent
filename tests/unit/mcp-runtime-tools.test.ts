import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  artifactReferenceSchema,
  createExecutableToolRegistry,
  createMcpExecutableToolRegistry,
  createMcpRuntimeTool,
  createMcpRuntimeTools,
  toolCallRecordSchema,
  type MCPManager,
  type MCPToolCapability
} from "@/core";
import type {
  RuntimeToolContext,
  RuntimeToolResult
} from "@/core/tools/runtime";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true }))
  );
});

function makeCap(overrides: Partial<MCPToolCapability> = {}): MCPToolCapability {
  return {
    access: "model_and_api",
    annotations: {},
    description: "A fixture MCP tool.",
    displayName: "Fixture Tool",
    execution: {},
    id: "mcp.tool.srv.tool",
    inputSchema: { type: "object" },
    invocationName: "mcp_srv_tool",
    kind: "tool",
    metadata: {},
    name: "tool",
    rawName: "tool",
    serverName: "srv",
    tags: ["mcp", "tool"],
    ...overrides
  };
}

function stubManager(
  overrides: Partial<Pick<MCPManager, "callTool" | "getToolCapabilities" | "getGeneration">> = {}
): MCPManager {
  return {
    callTool: async () => ({ content: [], isError: false }),
    getGeneration: () => 0,
    getToolCapabilities: () => [],
    ...overrides
  } as unknown as MCPManager;
}

function makeCall(toolName = "mcp_srv_tool") {
  return toolCallRecordSchema.parse({
    arguments: {},
    id: "tool-call.mcp.1",
    metadata: {},
    sessionId: "session.mcp.1",
    startedAt: "2026-03-27T12:00:00.000Z",
    status: "pending",
    toolName,
    turnId: "turn.mcp.1"
  });
}

const context = {} as unknown as RuntimeToolContext;

describe("buildMcpToolDefinition", () => {
  test("always requires approval, even for server-declared read-only tools", () => {
    const mgr = stubManager();
    const readOnly = createMcpRuntimeTool(
      mgr,
      makeCap({ annotations: { readOnlyHint: true } })
    );
    expect(readOnly.definition.kind).toBe("mcp");
    expect(readOnly.definition.approvalMode).toBe("ask");
    expect(readOnly.definition.approvalMode).not.toBe("never");
    expect(readOnly.definition.source.serverName).toBe("srv");
  });

  test("derives side effects from server annotations", () => {
    const mgr = stubManager();
    const sideEffectsFor = (annotations: MCPToolCapability["annotations"]) =>
      createMcpRuntimeTool(mgr, makeCap({ annotations })).definition.sideEffects;

    expect(sideEffectsFor({ readOnlyHint: true })).toEqual(["none"]);
    expect(sideEffectsFor({ readOnlyHint: true, openWorldHint: true })).toEqual([
      "network_read"
    ]);
    expect(sideEffectsFor({ destructiveHint: true })).toEqual(["remote_mutation"]);
    expect(sideEffectsFor({ openWorldHint: true })).toEqual(["network_write"]);
    expect(sideEffectsFor({})).toEqual(["remote_mutation"]);
  });
});

describe("createMcpRuntimeTool.execute", () => {
  test("lifts text, summarizes non-text, and persists image/audio/blob artifacts", async () => {
    const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-artifacts-"));
    tempRoots.push(artifactRoot);
    const mgr = stubManager({
      callTool: async () => ({
        content: [
          { text: "hello", type: "text" },
          { data: Buffer.from("png").toString("base64"), mimeType: "image/png", type: "image" },
          { resource: { text: "embedded text", uri: "file:///doc.md" }, type: "resource" },
          { data: Buffer.from("wav").toString("base64"), mimeType: "audio/wav", type: "audio" },
          {
            resource: {
              blob: Buffer.from("pdf").toString("base64"),
              mimeType: "application/pdf",
              uri: "file:///blob.pdf"
            },
            type: "resource"
          }
        ],
        isError: false,
        structuredContent: { ok: true }
      })
    });

    const tool = createMcpRuntimeTool(mgr, makeCap(), { artifactRoot });
    const result = await tool.execute(makeCall(), context);

    const payload = result.result as {
      content: unknown[];
      isError: boolean;
      structuredContent: unknown;
    };
    expect(payload.content).toHaveLength(5);
    expect(payload.isError).toBe(false);
    expect(payload.structuredContent).toEqual({ ok: true });
    expect((result.metadata?.rawContent as unknown[]).length).toBe(5);

    const texts = (result.display ?? []).map((part) =>
      part.kind === "text" ? part.text : `<${part.kind}>`
    );
    expect(texts).toEqual([
      "hello",
      "[image: image/png]",
      "embedded text",
      "[audio: audio/wav]",
      "[resource: file:///blob.pdf]"
    ]);

    const artifacts = result.artifacts ?? [];
    expect(artifacts.map((a) => a.kind).sort()).toEqual([
      "audio",
      "document",
      "image"
    ]);
    for (const artifact of artifacts) {
      await expect(fs.stat(artifact.uri)).resolves.toBeDefined();
    }
  });

  test("propagates isError and coalesces missing structuredContent to null", async () => {
    const mgr = stubManager({
      callTool: async () => ({
        content: [{ text: "boom", type: "text" }],
        isError: true
      })
    });
    const tool = createMcpRuntimeTool(mgr, makeCap());
    const result = await tool.execute(makeCall(), context);

    const payload = result.result as { isError: boolean; structuredContent: unknown };
    expect(payload.isError).toBe(true);
    expect(payload.structuredContent).toBeNull();
    expect(result.metadata?.isError).toBe(true);
  });

  test("clamps an over-long resource name so the persisted artifact stays schema-valid", async () => {
    const artifactRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-artifacts-"));
    tempRoots.push(artifactRoot);
    const longUri = `file:///${"x".repeat(400)}.bin`;
    const mgr = stubManager({
      callTool: async () => ({
        content: [
          {
            resource: {
              blob: Buffer.from("data").toString("base64"),
              mimeType: "application/octet-stream",
              uri: longUri
            },
            type: "resource"
          }
        ],
        isError: false
      })
    });
    const tool = createMcpRuntimeTool(mgr, makeCap(), { artifactRoot });
    const result = await tool.execute(makeCall(), context);

    expect(result.artifacts).toHaveLength(1);
    const artifact = result.artifacts![0]!;
    expect(artifact.name!.length).toBeLessThanOrEqual(256);
    // The persisted reference is valid against the schema (so it won't fail
    // messageSchema.parse on session read).
    expect(() => artifactReferenceSchema.parse(artifact)).not.toThrow();
  });

  test("omits artifacts when no artifact root is configured but still summarizes content", async () => {
    const mgr = stubManager({
      callTool: async () => ({
        content: [{ data: "AAAA", mimeType: "image/png", type: "image" }],
        isError: false
      })
    });
    const tool = createMcpRuntimeTool(mgr, makeCap());
    const result: RuntimeToolResult = await tool.execute(makeCall(), context);
    expect(result.artifacts ?? []).toHaveLength(0);
    expect((result.display ?? []).map((p) => (p.kind === "text" ? p.text : ""))).toEqual([
      "[image: image/png]"
    ]);
  });
});

describe("createMcpRuntimeTools", () => {
  test("disambiguates colliding invocation names across servers", () => {
    const mgr = stubManager({
      getToolCapabilities: () => [
        makeCap({
          id: "mcp.tool.a.x",
          invocationName: "mcp_shared_tool",
          name: "x",
          rawName: "x",
          serverName: "a"
        }),
        makeCap({
          id: "mcp.tool.b.y",
          invocationName: "mcp_shared_tool",
          name: "y",
          rawName: "y",
          serverName: "b"
        })
      ]
    });
    const names = createMcpRuntimeTools(mgr).map((t) => t.definition.invocationName);
    expect(names).toEqual(["mcp_shared_tool", "mcp_shared_tool-2"]);
  });
});

describe("DynamicMcpToolRegistry", () => {
  test("rebuilds tools only when the manager generation changes", () => {
    let generation = 1;
    let builds = 0;
    const mgr = stubManager({
      getGeneration: () => generation,
      getToolCapabilities: () => {
        builds += 1;
        return [makeCap()];
      }
    });
    const registry = createMcpExecutableToolRegistry(mgr);

    registry.listDefinitions();
    registry.getTool("mcp_srv_tool");
    expect(builds).toBe(1);

    generation = 2;
    registry.listDefinitions();
    expect(builds).toBe(2);
  });

  test("skips duplicate invocation names instead of throwing so one bad server cannot break the catalog", () => {
    const mgr = stubManager();
    const first = createMcpRuntimeTool(
      mgr,
      makeCap({ id: "mcp.tool.a.x", name: "x", rawName: "x", serverName: "a" }),
      { invocationName: "dup" }
    );
    const second = createMcpRuntimeTool(
      mgr,
      makeCap({ id: "mcp.tool.b.y", name: "y", rawName: "y", serverName: "b" }),
      { invocationName: "dup" }
    );

    expect(() => createExecutableToolRegistry([first, second])).toThrow(
      /already registered/
    );

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const registry = createExecutableToolRegistry([first, second], {
      onDuplicate: "skip"
    });
    expect(registry.listDefinitions()).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
