import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  ArtifactReference,
  JsonValue,
  MCPToolCapability,
  ToolDefinition
} from "@/core/contracts";
import { artifactReferenceSchema } from "@/core/contracts";
import type { MCPManager } from "@/core/mcp/manager";
import { disambiguateInvocationName } from "@/core/mcp/names";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";
import type { ExecutableToolRegistry } from "@/core/tools/registry";
import { createExecutableToolRegistry } from "@/core/tools/registry";

export type McpRuntimeToolOptions = {
  // Directory under which non-text MCP tool output (images/audio/binary
  // resources) is persisted so it can be surfaced as an artifact. When omitted,
  // non-text content is still summarized as a text placeholder but not saved.
  artifactRoot?: string;
};

type McpRuntimeToolBuildOptions = McpRuntimeToolOptions & {
  // Registry-facing invocation name. May differ from capability.invocationName
  // when a cross-server collision was disambiguated (e.g. "…-2"). Routing still
  // uses capability.invocationName, which is unique within its own server.
  invocationName?: string;
};

export function createMcpRuntimeTools(
  manager: MCPManager,
  options: McpRuntimeToolOptions = {}
): RuntimeTool[] {
  // Keep invocation names injective across ALL connected servers. Two servers
  // whose names slugify alike (or that expose the same tool slug) would collide
  // in the shared registry; disambiguate the later ones with a "-2"/"-3" suffix.
  const usedInvocationNames = new Set<string>();
  return manager.getToolCapabilities().map((capability) => {
    const invocationName = disambiguateInvocationName(
      capability.invocationName,
      usedInvocationNames
    );
    return createMcpRuntimeTool(manager, capability, {
      ...options,
      invocationName
    });
  });
}

export function createMcpExecutableToolRegistry(
  manager: MCPManager,
  options: McpRuntimeToolOptions = {}
): ExecutableToolRegistry {
  return new DynamicMcpToolRegistry(manager, options);
}

export function createMcpRuntimeTool(
  manager: MCPManager,
  capability: MCPToolCapability,
  options: McpRuntimeToolBuildOptions = {}
): RuntimeTool {
  const registryInvocationName = options.invocationName ?? capability.invocationName;
  return {
    definition: buildMcpToolDefinition(capability, registryInvocationName),
    async execute(call): Promise<RuntimeToolResult> {
      // Route by the capability's own (per-server unique) invocation name — the
      // registry-facing name may have been disambiguated for a cross-server
      // clash, but the manager resolves the raw tool name from this one.
      const result = await manager.callTool(
        capability.serverName ?? "",
        capability.invocationName,
        call.arguments
      );
      const content = Array.isArray(result.content) ? result.content : [];
      const { artifacts, display } = await extractContent(
        content,
        options.artifactRoot,
        call.id
      );

      return {
        artifacts,
        display,
        metadata: {
          isError: result.isError === true,
          rawContent: content as JsonValue
        },
        result: {
          content: content as JsonValue,
          isError: result.isError === true,
          structuredContent: toJsonCompatibleValue(result.structuredContent) ?? null
        }
      };
    }
  };
}

// Convert an MCP CallToolResult.content[] into display parts and persisted
// artifacts. Text and embedded-resource text are lifted verbatim into display;
// image/audio/binary blocks get a text placeholder (so the model and user at
// least know they exist) plus, when an artifact root is configured, a persisted
// artifact so images can reach a vision-capable model and the UI can render
// them. The full content array is preserved on the result regardless.
async function extractContent(
  content: unknown[],
  artifactRoot: string | undefined,
  callId: string
): Promise<{
  artifacts: ArtifactReference[];
  display: RuntimeToolResult["display"];
}> {
  const display: NonNullable<RuntimeToolResult["display"]> = [];
  const artifacts: ArtifactReference[] = [];
  const pushText = (text: string) => {
    if (text.length > 0) {
      display.push({ kind: "text", text });
    }
  };

  for (const item of content) {
    if (!isRecord(item)) {
      continue;
    }

    if (item.type === "text" && typeof item.text === "string") {
      pushText(item.text);
      continue;
    }

    if (item.type === "resource" && isRecord(item.resource)) {
      const resource = item.resource;
      if (typeof resource.text === "string") {
        pushText(resource.text);
        continue;
      }
      const uri = typeof resource.uri === "string" ? resource.uri : "resource";
      pushText(`[resource: ${uri}]`);
      if (artifactRoot && typeof resource.blob === "string") {
        const artifact = await persistArtifact({
          artifactRoot,
          base64: resource.blob,
          callId,
          index: artifacts.length,
          kind: "document",
          mediaType:
            typeof resource.mimeType === "string"
              ? resource.mimeType
              : "application/octet-stream",
          name: typeof resource.uri === "string" ? resource.uri : "resource"
        });
        if (artifact) {
          artifacts.push(artifact);
        }
      }
      continue;
    }

    if (item.type === "image" && typeof item.data === "string") {
      const mediaType =
        typeof item.mimeType === "string" ? item.mimeType : "image/png";
      pushText(`[image: ${mediaType}]`);
      if (artifactRoot) {
        const artifact = await persistArtifact({
          artifactRoot,
          base64: item.data,
          callId,
          index: artifacts.length,
          kind: "image",
          mediaType,
          name: "mcp-image"
        });
        if (artifact) {
          artifacts.push(artifact);
        }
      }
      continue;
    }

    if (item.type === "audio" && typeof item.data === "string") {
      const mediaType =
        typeof item.mimeType === "string" ? item.mimeType : "audio/wav";
      pushText(`[audio: ${mediaType}]`);
      if (artifactRoot) {
        const artifact = await persistArtifact({
          artifactRoot,
          base64: item.data,
          callId,
          index: artifacts.length,
          kind: "audio",
          mediaType,
          name: "mcp-audio"
        });
        if (artifact) {
          artifacts.push(artifact);
        }
      }
      continue;
    }

    if (item.type === "resource_link" && typeof item.uri === "string") {
      pushText(`[resource link: ${item.uri}]`);
    }
  }

  return { artifacts, display };
}

async function persistArtifact(params: {
  artifactRoot: string;
  base64: string;
  callId: string;
  index: number;
  kind: "audio" | "document" | "image";
  mediaType: string;
  name: string;
}): Promise<ArtifactReference | null> {
  try {
    const buffer = Buffer.from(params.base64, "base64");
    if (buffer.byteLength === 0) {
      return null;
    }
    const directory = path.join(params.artifactRoot, "mcp");
    await fs.mkdir(directory, { recursive: true });
    const fileName = `${sanitizeFileSegment(params.callId)}-${params.index}${extensionForMediaType(params.mediaType, params.kind)}`;
    const filePath = path.join(directory, fileName);
    await fs.writeFile(filePath, buffer);
    // Server-controlled name/mediaType must satisfy artifactReferenceSchema
    // bounds (min(1)/max(256)); an unclamped value (e.g. a >256-char resource
    // URI, or an empty mimeType) would otherwise produce a message part that
    // fails messageSchema.parse on session read and breaks session loads. Clamp,
    // then validate through the schema so only a valid artifact is returned.
    return artifactReferenceSchema.parse({
      byteLength: buffer.byteLength,
      id: `${params.callId}.mcp-artifact.${params.index}`.slice(0, 256),
      kind: params.kind,
      mediaType:
        params.mediaType.length >= 1 && params.mediaType.length <= 256
          ? params.mediaType
          : undefined,
      metadata: {},
      name: clampArtifactName(params.name),
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      uri: filePath
    });
  } catch {
    // Persisting an artifact is best-effort; a failure (write error or an
    // artifact that still fails validation) must not fail the tool call. The
    // text placeholder still records that the content existed.
    return null;
  }
}

function clampArtifactName(value: string): string {
  const trimmed = value.slice(0, 256);
  return trimmed.length > 0 ? trimmed : "mcp-artifact";
}

function buildMcpToolDefinition(
  capability: MCPToolCapability,
  invocationName: string
): ToolDefinition {
  const readOnly = capability.annotations.readOnlyHint === true;
  const destructive = capability.annotations.destructiveHint === true;
  const openWorld = capability.annotations.openWorldHint === true;

  return {
    aliases: [],
    annotations: {
      destructiveHint: destructive,
      idempotentHint: capability.annotations.idempotentHint === true,
      meta: capability.metadata,
      openWorldHint: openWorld,
      readOnlyHint: readOnly,
      title: capability.displayName
    },
    // Always request approval for MCP tools. The server-supplied readOnlyHint is
    // an untrusted, advisory annotation (per the MCP spec) and must not silently
    // grant execution or bypass operator deny rules. Trusted servers are
    // auto-approved via an mcp_server/mcp_tool allow rule (see the server's
    // `trust` config), which still lets an explicit deny rule win.
    approvalMode: "ask",
    descriptor: {
      approvalNotes:
        `Approval is requested before running ${capability.displayName}. Mark its MCP server "trusted" (or add an mcp_server/mcp_tool allow rule) to auto-approve it; the server-reported read-only hint is advisory and does not skip approval.`,
      examples: [
        `Use when the MCP server "${capability.serverName}" exposes a specialized capability you cannot satisfy with built-in tools.`,
        `Prefer this when ${capability.displayName} is the canonical action provided by the connected MCP server.`
      ],
      purpose:
        capability.description ??
        `Call the MCP tool "${capability.name}" from server "${capability.serverName}" and return its structured result.`,
      sideEffectSummary: readOnly
        ? "This MCP tool is marked read-only by the server (advisory)."
        : "This MCP tool can perform side effects outside the local built-in runtime.",
      whenNotToUse: [
        "Do not use this when a safer built-in read or edit tool already covers the same task.",
        "Do not guess the arguments; inspect the MCP capability catalog first if the schema is unclear."
      ],
      whenToUse: [
        `Use when the connected MCP server "${capability.serverName}" provides the best specialized implementation for this task.`,
        "Use after confirming the tool schema and approval expectations match the requested action."
      ]
    },
    description:
      capability.description ??
      `Call the MCP tool "${capability.name}" on server "${capability.serverName}".`,
    displayName: capability.displayName,
    execution: {
      inputMode: "json",
      resumable:
        capability.execution.taskSupport === "required" ||
        capability.execution.taskSupport === "optional",
      taskSupport: capability.execution.taskSupport ?? "forbidden"
    },
    idempotent: capability.annotations.idempotentHint === true,
    inputSchema: capability.inputSchema,
    invocationName,
    kind: "mcp",
    metadata: capability.metadata,
    name: `${capability.serverName}.${capability.rawName}`,
    outputKind: "json",
    outputSchema: capability.outputSchema,
    retryable: true,
    searchTags: capability.tags,
    sideEffects: resolveSideEffects({ destructive, openWorld, readOnly }),
    source: {
      displayName: capability.serverName,
      kind: "mcp",
      serverName: capability.serverName
    },
    streamingMode: "none",
    toolId: capability.id,
    usageGuidance:
      "Use this only after confirming the MCP server is connected and this tool is the best fit. Prefer built-in tools first when they offer the same capability with better local guarantees.",
    version: "1.0.0"
  };
}

function resolveSideEffects(params: {
  destructive: boolean;
  openWorld: boolean;
  readOnly: boolean;
}): ToolDefinition["sideEffects"] {
  if (params.readOnly) {
    return params.openWorld ? ["network_read"] : ["none"];
  }
  if (params.destructive) {
    return ["remote_mutation"];
  }
  return params.openWorld ? ["network_write"] : ["remote_mutation"];
}

function toJsonCompatibleValue(value: unknown): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeFileSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "mcp";
}

function extensionForMediaType(
  mediaType: string,
  kind: "audio" | "document" | "image"
): string {
  switch (mediaType) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "audio/wav":
    case "audio/x-wav":
      return ".wav";
    case "audio/mpeg":
    case "audio/mp3":
      return ".mp3";
    default:
      // Default images to .png so the downstream data-URL resolver infers a
      // usable image mime type; everything else falls back to a generic ext.
      return kind === "image" ? ".png" : ".bin";
  }
}

class DynamicMcpToolRegistry implements ExecutableToolRegistry {
  private cached?: { generation: number; registry: ExecutableToolRegistry };

  constructor(
    private readonly manager: MCPManager,
    private readonly options: McpRuntimeToolOptions
  ) {}

  getDefinition(toolName: string): ToolDefinition | null {
    return this.snapshot().getDefinition(toolName);
  }

  getTool(toolName: string): RuntimeTool | null {
    return this.snapshot().getTool(toolName);
  }

  listDefinitions(): ToolDefinition[] {
    return this.snapshot().listDefinitions();
  }

  searchDefinitions(query: Parameters<ExecutableToolRegistry["searchDefinitions"]>[0]) {
    return this.snapshot().searchDefinitions(query);
  }

  // Rebuild only when the manager's capability set may have changed (tracked by
  // its generation counter), rather than on every lookup. Duplicate invocation
  // names are skipped rather than thrown so one misbehaving server cannot make
  // the whole tool catalog un-enumerable.
  private snapshot(): ExecutableToolRegistry {
    const generation = this.manager.getGeneration();
    if (this.cached && this.cached.generation === generation) {
      return this.cached.registry;
    }
    const registry = createExecutableToolRegistry(
      createMcpRuntimeTools(this.manager, this.options),
      { onDuplicate: "skip" }
    );
    this.cached = { generation, registry };
    return registry;
  }
}
