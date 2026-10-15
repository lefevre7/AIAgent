import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { toJsonRecord, type JsonValue, type MCPCapability } from "@/core/contracts";
import { resolveStartupTimeoutMs, type McpServerConfig, type McpTransportKind } from "@/core/mcp/connection";
import { retryTransientMcpFailures } from "@/core/mcp/http";
import { buildMcpCapabilityId, disambiguateInvocationName, sanitizeMcpInvocationName } from "@/core/mcp/names";
import { sanitizeToolInputSchema } from "@/core/mcp/schema";

// Codex's bounds on a listing. A server over them fails to start rather than
// flooding the catalog; a repeated cursor or the page cap only stops paging.
export const MAX_MCP_TOOLS_PER_SERVER = 2_048;
export const MAX_MCP_CURSOR_BYTES = 64 * 1024;
const MAX_PAGINATION_PAGES = 1000;
// The server's own usage notes, shown in mcp_status and tool_search.
const MAX_INSTRUCTIONS_CHARS = 16_384;

export type EnumeratedServer = {
  capabilities: MCPCapability[];
  counts: { prompts: number; resourceTemplates: number; resources: number; tools: number };
  instructions?: string;
  rawToolNamesByInvocationName: Map<string, string>;
  /** Tools left out because their input schema could not describe arguments. */
  skippedTools: Array<{ name: string; reason: string }>;
};

// A tools/list page read without checking each tool, for when one does not
// pass the SDK's check: the tools are checked one at a time instead.
const LOOSE_TOOLS_PAGE_SCHEMA = z
  .object({ nextCursor: z.string().optional(), tools: z.array(z.unknown()) })
  .passthrough();

function isSchemaError(error: unknown): boolean {
  return error instanceof Error && (error.name === "ZodError" || Array.isArray((error as { issues?: unknown }).issues));
}

function readToolName(raw: unknown): string {
  const name = typeof raw === "object" && raw !== null ? (raw as { name?: unknown }).name : undefined;
  return typeof name === "string" && name.length > 0 ? name : "(unnamed)";
}

// A schema the sanitizer cannot handle skips its tool, never the server.
function sanitizeSchemaSafely(input: unknown): ReturnType<typeof sanitizeToolInputSchema> {
  try {
    return sanitizeToolInputSchema(input);
  } catch (error) {
    return {
      ok: false,
      reason: `its input schema could not be read (${error instanceof Error ? error.message : String(error)})`
    };
  }
}

/**
 * Whether a tool may be listed and called: `enabledTools`, when set, is the
 * whole list (even `[]`); `disabledTools` then removes names. Exact raw names,
 * checked when listing and again when calling.
 */
export function isMcpToolAllowed(config: McpServerConfig, rawToolName: string): boolean {
  if (config.enabledTools && !config.enabledTools.includes(rawToolName)) {
    return false;
  }
  return !config.disabledTools?.includes(rawToolName);
}

/**
 * Lists a connected server's tools, resources, resource templates, and
 * prompts. Each listing is a phase with the server's whole startup budget
 * (not a share of one), and over HTTP a transient failure is tried again.
 *
 * The tools listing must succeed for the server to count as connected, so its
 * errors propagate (the server is then failed and retried later) instead of
 * becoming "connected with no tools". The other listings are best effort: a
 * tools-only server (most stdio servers) advertises no resources, and an
 * advertised listing that faults leaves that list empty.
 */
export async function enumerateMcpServer(params: {
  client: Client;
  serverConfig: McpServerConfig;
  serverName: string;
  transport: McpTransportKind;
}): Promise<EnumeratedServer> {
  const { client, serverConfig, serverName } = params;
  const capabilitiesAdvertised = client.getServerCapabilities();
  const budget = resolveStartupTimeoutMs(serverConfig);
  const retry = params.transport === "stdio" ? <T>(run: () => Promise<T>) => run() : retryTransientMcpFailures;
  // Each listing (all its pages) gets the budget, given to each page as the
  // time left. Not as a shared AbortSignal: the SDK never removes its abort
  // listener, so a phase timer firing later sent notifications/cancelled for
  // every request that had long since finished.
  const listPhase = <T extends Record<string, unknown>, K extends keyof T & string>(
    request: (cursor: string | undefined, options: { timeout: number }) => Promise<T>,
    key: K
  ) =>
    retry(async () => {
      const deadline = Date.now() + budget;
      return collectPaginated((cursor) => request(cursor, { timeout: Math.max(1, deadline - Date.now()) }), key);
    });

  const malformedTools: string[] = [];
  const listedTools = capabilitiesAdvertised?.tools
    ? await listPhase(async (cursor, options) => {
        try {
          return await client.listTools(cursor ? { cursor } : undefined, options);
        } catch (error) {
          if (!isSchemaError(error)) {
            throw error;
          }
          // One malformed tool failed the SDK's check of the whole page, and
          // so the whole server. Read the page loosely and keep the tools
          // that are well formed.
          const page = await client.request(
            { method: "tools/list", ...(cursor ? { params: { cursor } } : {}) },
            LOOSE_TOOLS_PAGE_SCHEMA,
            options
          );
          const tools: Tool[] = [];
          for (const raw of page.tools) {
            const parsed = ToolSchema.safeParse(raw);
            if (parsed.success) {
              tools.push(parsed.data);
            } else {
              malformedTools.push(readToolName(raw));
            }
          }
          return { ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}), tools };
        }
      }, "tools")
    : [];
  // Counted after enabledTools/disabledTools: they are how a server over the
  // limit is narrowed to the tools wanted.
  const allowedTools = listedTools.filter((entry) => isMcpToolAllowed(serverConfig, entry.name));
  if (allowedTools.length > MAX_MCP_TOOLS_PER_SERVER) {
    throw new Error(
      `MCP server "${serverName}" lists ${allowedTools.length} tools; at most ${MAX_MCP_TOOLS_PER_SERVER} are supported. Use enabledTools to pick the ones you need.`
    );
  }
  const bestEffort = async <T>(enabled: boolean, run: () => Promise<T[]>): Promise<T[]> => {
    if (!enabled) {
      return [];
    }
    try {
      return await run();
    } catch {
      return [];
    }
  };
  // Independent of each other, so listed at once: connecting a server used
  // to take the sum of its four listings.
  const [resources, resourceTemplates, prompts] = await Promise.all([
    bestEffort(Boolean(capabilitiesAdvertised?.resources), () =>
      listPhase((cursor, options) => client.listResources(cursor ? { cursor } : undefined, options), "resources")
    ),
    bestEffort(Boolean(capabilitiesAdvertised?.resources), () =>
      listPhase(
        (cursor, options) => client.listResourceTemplates(cursor ? { cursor } : undefined, options),
        "resourceTemplates"
      )
    ),
    bestEffort(Boolean(capabilitiesAdvertised?.prompts), () =>
      listPhase((cursor, options) => client.listPrompts(cursor ? { cursor } : undefined, options), "prompts")
    )
  ]);

  const rawToolNamesByInvocationName = new Map<string, string>();
  // slugify is lossy, so keep invocation names injective within this server
  // (e.g. "GetUser"/"getuser" -> mcp_x_getuser, mcp_x_getuser-2). A duplicate
  // would otherwise overwrite the raw-name mapping and later crash the shared
  // tool registry on a duplicate invocation name.
  const usedInvocationNames = new Set<string>();
  const skippedTools: EnumeratedServer["skippedTools"] = malformedTools.map((name) => ({
    name,
    reason: "the server listed it in a form that is not a valid MCP tool"
  }));
  for (const skipped of skippedTools) {
    console.warn(
      `[AIA_MCP_TOOL_SKIPPED] MCP server "${serverName}": skipped tool "${skipped.name}": ${skipped.reason}.`
    );
  }
  const toolCapabilities: MCPCapability[] = [];
  for (const tool of allowedTools) {
    const schema = sanitizeSchemaSafely(tool.inputSchema);
    if (!schema.ok) {
      skippedTools.push({ name: tool.name, reason: schema.reason });
      console.warn(`[AIA_MCP_TOOL_SKIPPED] MCP server "${serverName}": skipped tool "${tool.name}": ${schema.reason}.`);
      continue;
    }
    const invocationName = disambiguateInvocationName(
      sanitizeMcpInvocationName(serverName, tool.name),
      usedInvocationNames
    );
    rawToolNamesByInvocationName.set(invocationName, tool.name);
    toolCapabilities.push({
      access: "model_and_api",
      annotations: extractAnnotations(tool.annotations),
      description: tool.description,
      displayName: tool.title ?? tool.annotations?.title ?? tool.name,
      execution: {
        taskSupport: normalizeTaskSupport(tool.execution?.taskSupport)
      },
      id: buildMcpCapabilityId("tool", serverName, tool.name),
      inputSchema: schema.schema,
      invocationName,
      kind: "tool",
      metadata: toJsonRecord(tool._meta),
      name: tool.name,
      outputSchema: tool.outputSchema ? toJsonRecord(tool.outputSchema) : undefined,
      rawName: tool.name,
      serverName,
      tags: buildCapabilityTags(serverConfig.tags, "tool")
    } as MCPCapability);
  }

  const instructions = client.getInstructions()?.trim();
  return {
    capabilities: [
      ...toolCapabilities,
      ...resources.map(
        (resource) =>
          ({
            access: "model_and_api" as const,
            annotations: extractAnnotations(resource.annotations),
            description: resource.description,
            displayName: resource.title ?? resource.name,
            id: buildMcpCapabilityId("resource", serverName, resource.uri),
            kind: "resource" as const,
            metadata: toJsonRecord(resource._meta),
            mimeType: resource.mimeType,
            name: resource.name,
            serverName,
            tags: buildCapabilityTags(serverConfig.tags, "resource"),
            title: resource.title,
            uri: resource.uri
          }) as MCPCapability
      ),
      ...resourceTemplates.map(
        (resourceTemplate) =>
          ({
            access: "model_and_api" as const,
            annotations: extractAnnotations(resourceTemplate.annotations),
            description: resourceTemplate.description,
            displayName: resourceTemplate.title ?? resourceTemplate.name,
            id: buildMcpCapabilityId("resource-template", serverName, resourceTemplate.uriTemplate),
            kind: "resource_template" as const,
            metadata: toJsonRecord(resourceTemplate._meta),
            mimeType: resourceTemplate.mimeType,
            name: resourceTemplate.name,
            serverName,
            tags: buildCapabilityTags(serverConfig.tags, "resource_template"),
            title: resourceTemplate.title,
            uriTemplate: resourceTemplate.uriTemplate
          }) as MCPCapability
      ),
      ...prompts.map(
        (prompt) =>
          ({
            access: "api_only" as const,
            annotations: {},
            arguments: prompt.arguments ?? [],
            description: prompt.description,
            displayName: prompt.title ?? prompt.name,
            id: buildMcpCapabilityId("prompt", serverName, prompt.name),
            kind: "prompt" as const,
            metadata: toJsonRecord(prompt._meta),
            name: prompt.name,
            serverName,
            tags: buildCapabilityTags(serverConfig.tags, "prompt"),
            title: prompt.title
          }) as MCPCapability
      )
    ],
    counts: {
      prompts: prompts.length,
      resourceTemplates: resourceTemplates.length,
      resources: resources.length,
      tools: toolCapabilities.length
    },
    ...(instructions ? { instructions: instructions.slice(0, MAX_INSTRUCTIONS_CHARS) } : {}),
    rawToolNamesByInvocationName,
    skippedTools
  };
}

/**
 * Follows `nextCursor` to the end. A misbehaving or malicious server can
 * return a cursor forever, or cycle through a set of them, so a repeated
 * cursor or the page cap stops paging (with a warning), and a cursor over
 * 64 KiB is an error.
 */
export async function collectPaginated<T extends Record<string, unknown>, K extends keyof T & string>(
  request: (cursor?: string) => Promise<T>,
  key: K
): Promise<NonNullable<T[K]> extends Array<infer Item> ? Item[] : never> {
  const items: unknown[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let pageCount = 0;

  do {
    const page = await request(cursor);
    const pageItems = Array.isArray(page[key]) ? page[key] : [];
    items.push(...pageItems);
    pageCount += 1;
    cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;

    if (cursor && Buffer.byteLength(cursor, "utf8") > MAX_MCP_CURSOR_BYTES) {
      throw new Error(`A connected MCP server returned a page cursor over ${MAX_MCP_CURSOR_BYTES} bytes.`);
    }
    if (cursor && seenCursors.has(cursor)) {
      console.warn(`[AIA_MCP_PAGINATION_TRUNCATED] A connected MCP server repeated cursor "${cursor}"; stopping.`);
      break;
    }
    if (cursor) {
      seenCursors.add(cursor);
    }
    if (cursor && pageCount >= MAX_PAGINATION_PAGES) {
      console.warn(
        `[AIA_MCP_PAGINATION_TRUNCATED] A connected MCP server exceeded ${MAX_PAGINATION_PAGES} pages; stopping.`
      );
      break;
    }
  } while (cursor);

  return items as NonNullable<T[K]> extends Array<infer Item> ? Item[] : never;
}

function extractAnnotations(value: Record<string, unknown> | undefined): Record<string, JsonValue> {
  if (!value) {
    return {};
  }
  return Object.fromEntries(
    Object.entries({
      destructiveHint: value.destructiveHint,
      idempotentHint: value.idempotentHint,
      openWorldHint: value.openWorldHint,
      readOnlyHint: value.readOnlyHint,
      title: value.title
    }).filter(([, entry]) => entry !== undefined)
  ) as Record<string, JsonValue>;
}

function buildCapabilityTags(tags: string[], kind: string) {
  return Array.from(new Set([...tags, "mcp", kind]));
}

function normalizeTaskSupport(value: unknown): "forbidden" | "optional" | "required" | undefined {
  return value === "forbidden" || value === "optional" || value === "required" ? value : undefined;
}
