import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";

import { applyEdits, format, modify } from "jsonc-parser";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";

import type {
  AppConfig,
  LoadedAIAgentConfig,
  ResolvedConfigPaths,
  SecretInput
} from "@/core/config";
import { loadAIAgentConfig } from "@/core/config";
import { APP_CONFIG_VERSION } from "@/core/config/constants";
import { deepMerge } from "@/core/config/merge";
import { parseJsoncText } from "@/core/config/jsonc";
import type {
  MCPCapability,
  MCPCapabilitySearchQuery,
  MCPManagerHealth,
  MCPPromptResult,
  MCPResourceReadResult,
  MCPServerStatus,
  MCPToolCapability,
  JsonValue,
  StructuredError
} from "@/core/contracts";
import { mcpManagerHealthSchema, mcpPromptResultSchema, mcpResourceReadResultSchema, mcpServerStatusSchema } from "@/core/contracts";
import { BUILT_IN_MCP_SERVER_TEMPLATES } from "@/core/mcp/templates";
import { loadImportedMcpServers } from "@/core/mcp/imports";
import { sanitizeMcpInvocationName } from "@/core/mcp/names";
import { MCPCapabilityCatalog } from "@/core/mcp/catalog";

type ManagedMCPServer = {
  capabilities: MCPCapability[];
  client: Client;
  config: AppConfig["mcp"]["servers"][string];
  rawToolNamesByInvocationName: Map<string, string>;
  status: MCPServerStatus;
  transport: AppConfig["mcp"]["servers"][string]["type"];
};

export type MCPManagerEvents = {
  refreshed: [{ health: MCPManagerHealth }];
  statuses_changed: [{ statuses: MCPServerStatus[] }];
};

export type MCPManagerOptions = {
  config: AppConfig;
  configPaths?: ResolvedConfigPaths;
  fetchImpl?: typeof fetch;
  reloadConfig?: () => Promise<LoadedAIAgentConfig>;
  watch?: boolean;
};

export class MCPManager extends EventEmitter<MCPManagerEvents> {
  private readonly fetchImpl: typeof fetch;
  private readonly watchEnabled: boolean;
  private readonly configPaths?: ResolvedConfigPaths;
  private config: AppConfig;
  private readonly reloadConfig?: () => Promise<LoadedAIAgentConfig>;
  private readonly connections = new Map<string, ManagedMCPServer>();
  private catalog = new MCPCapabilityCatalog();
  private templateDefinitions: Record<string, AppConfig["mcp"]["templates"][string]> = {};
  private importedFiles: string[] = [];
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private initialized = false;
  private lastRefreshAt: string | undefined;

  constructor(options: MCPManagerOptions) {
    super();
    this.config = options.config;
    this.configPaths = options.configPaths;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.reloadConfig = options.reloadConfig;
    this.watchEnabled = options.watch ?? true;
  }

  async initialize(): Promise<void> {
    await this.refresh();
    if (this.watchEnabled && this.reloadConfig) {
      await this.syncWatchers();
    }
    this.initialized = true;
  }

  async close(): Promise<void> {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }

    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();

    for (const server of this.connections.values()) {
      await server.client.close().catch(() => undefined);
    }
    this.connections.clear();
    this.catalog = new MCPCapabilityCatalog();
  }

  getToolCapabilities(): MCPToolCapability[] {
    return this.catalog
      .list()
      .filter((capability): capability is MCPToolCapability => capability.kind === "tool");
  }

  getCatalog(): MCPCapabilityCatalog {
    return this.catalog;
  }

  getServerStatuses(): MCPServerStatus[] {
    return Array.from(this.connections.values())
      .map((entry) => entry.status)
      .sort((left, right) => left.serverName.localeCompare(right.serverName));
  }

  async getHealth(): Promise<MCPManagerHealth> {
    return mcpManagerHealthSchema.parse({
      checkedAt: new Date().toISOString(),
      imports: this.importedFiles.length,
      lastRefreshAt: this.lastRefreshAt,
      servers: this.getServerStatuses(),
      templates: Object.keys(this.templateDefinitions).length
    });
  }

  searchCapabilities(query: MCPCapabilitySearchQuery) {
    return this.catalog.search(query);
  }

  async refresh(nextConfig?: AppConfig): Promise<void> {
    if (nextConfig) {
      this.config = nextConfig;
    } else if (this.reloadConfig && this.initialized) {
      const loaded = await this.reloadConfig();
      this.config = loaded.resolvedConfig;
    }

    const resolved = await this.resolveConfig();
    const previousConnections = new Map(this.connections);
    const nextConnections = new Map<string, ManagedMCPServer>();
    const requiredFailures: Error[] = [];

    for (const [serverName, serverConfig] of Object.entries(resolved.servers)) {
      const previous = previousConnections.get(serverName);
      const configSignature = JSON.stringify(serverConfig);
      const previousSignature = previous ? JSON.stringify(previous.config) : null;

      if (previous && previousSignature === configSignature) {
        nextConnections.set(serverName, previous);
        previousConnections.delete(serverName);
        continue;
      }

      if (previous) {
        await previous.client.close().catch(() => undefined);
        previousConnections.delete(serverName);
      }

      if (!serverConfig.enabled) {
        nextConnections.set(serverName, {
          capabilities: [],
          client: new Client({ name: "AIAgent", version: "0.1.0" }, { capabilities: {} }),
          config: serverConfig,
          rawToolNamesByInvocationName: new Map(),
          status: mcpServerStatusSchema.parse({
            capabilities: {
              prompts: 0,
              resourceTemplates: 0,
              resources: 0,
              tools: 0
            },
            checkedAt: new Date().toISOString(),
            serverName,
            state: "disabled",
            transport: serverConfig.type
          }),
          transport: serverConfig.type
        });
        continue;
      }

      try {
        const connected = await this.connectServer(serverName, serverConfig);
        nextConnections.set(serverName, connected);
      } catch (error) {
        const structured = normalizeMcpError(error);
        const failedEntry: ManagedMCPServer = {
          capabilities: [],
          client: new Client({ name: "AIAgent", version: "0.1.0" }, { capabilities: {} }),
          config: serverConfig,
          rawToolNamesByInvocationName: new Map(),
          status: mcpServerStatusSchema.parse({
            capabilities: {
              prompts: 0,
              resourceTemplates: 0,
              resources: 0,
              tools: 0
            },
            checkedAt: new Date().toISOString(),
            error: structured,
            serverName,
            state: "failed",
            transport: serverConfig.type
          }),
          transport: serverConfig.type
        };
        nextConnections.set(serverName, failedEntry);
        if (serverConfig.required) {
          requiredFailures.push(new Error(`${serverName}: ${structured.message}`));
        }
      }
    }

    for (const leftover of previousConnections.values()) {
      await leftover.client.close().catch(() => undefined);
    }

    this.connections.clear();
    for (const [serverName, connection] of nextConnections) {
      this.connections.set(serverName, connection);
    }

    this.templateDefinitions = resolved.templates;
    this.importedFiles = resolved.importedFiles;
    this.catalog = new MCPCapabilityCatalog([
      ...Array.from(this.connections.values()).flatMap((entry) => entry.capabilities),
      ...buildTemplateCapabilities(this.templateDefinitions)
    ]);
    this.lastRefreshAt = new Date().toISOString();

    if (this.watchEnabled && this.reloadConfig) {
      await this.syncWatchers();
    }

    const health = await this.getHealth();
    this.emit("statuses_changed", { statuses: this.getServerStatuses() });
    this.emit("refreshed", { health });

    if (requiredFailures.length > 0) {
      throw new Error(`Required MCP servers failed to connect:\n${requiredFailures.map((item) => `- ${item.message}`).join("\n")}`);
    }
  }

  async callTool(serverName: string, invocationOrRawToolName: string, args: Record<string, unknown> = {}) {
    const server = this.getConnectedServer(serverName);
    const rawName = server.rawToolNamesByInvocationName.get(invocationOrRawToolName) ?? invocationOrRawToolName;
    return server.client.callTool({
      arguments: args,
      name: rawName
    });
  }

  async readResource(serverName: string, uri: string): Promise<MCPResourceReadResult> {
    const server = this.getConnectedServer(serverName);
    const result = await server.client.readResource({ uri });
    return mcpResourceReadResultSchema.parse({
      contents: result.contents,
      uri
    });
  }

  async readResourceTemplate(serverName: string, uriTemplate: string, variables: Record<string, string | string[]> = {}) {
    const uri = new UriTemplate(uriTemplate).expand(variables);
    return this.readResource(serverName, uri);
  }

  async listPrompts(
    serverName?: string
  ): Promise<
    | Array<{
        _meta?: Record<string, unknown>;
        arguments?: Array<{ description?: string; name: string; required?: boolean }>;
        description?: string;
        name: string;
        title?: string;
      }>
    | Array<{
        prompts: Array<{
          _meta?: Record<string, unknown>;
          arguments?: Array<{ description?: string; name: string; required?: boolean }>;
          description?: string;
          name: string;
          title?: string;
        }>;
        serverName: string;
      }>
  > {
    if (serverName) {
      const server = this.getConnectedServer(serverName);
      const prompts = await collectPaginated(async (cursor) => server.client.listPrompts(cursor ? { cursor } : undefined), "prompts");
      return prompts;
    }

    const entries: Array<{
      prompts: Array<{
        _meta?: Record<string, unknown>;
        arguments?: Array<{ description?: string; name: string; required?: boolean }>;
        description?: string;
        name: string;
        title?: string;
      }>;
      serverName: string;
    }> = await Promise.all(
      this.listConnectedServerNames().map(async (name) => ({
        prompts: (await this.listPrompts(name)) as Array<{
          _meta?: Record<string, unknown>;
          arguments?: Array<{ description?: string; name: string; required?: boolean }>;
          description?: string;
          name: string;
          title?: string;
        }>,
        serverName: name
      }))
    );
    return entries;
  }

  async getPrompt(serverName: string, name: string, args: Record<string, string> = {}): Promise<MCPPromptResult> {
    const server = this.getConnectedServer(serverName);
    const prompt = await server.client.getPrompt({
      arguments: args,
      name
    });
    return mcpPromptResultSchema.parse({
      description: prompt.description,
      messages: prompt.messages
    });
  }

  listTemplates() {
    return this.templateDefinitions;
  }

  async installTemplate(params: {
    configPath?: string;
    destination?: "user" | "workspace";
    overrides?: Partial<AppConfig["mcp"]["servers"][string]>;
    serverName?: string;
    templateId: string;
  }): Promise<{ configPath: string; installedServerName: string }> {
    const template = this.templateDefinitions[params.templateId];
    if (!template) {
      throw new Error(`Unknown MCP server template "${params.templateId}".`);
    }

    const targetPath =
      params.configPath ??
      (params.destination === "user" ? this.configPaths?.globalConfigPath : this.configPaths?.workspaceConfigPath);
    if (!targetPath) {
      throw new Error("Unable to resolve the MCP template install target path.");
    }

    const installedServerName = params.serverName ?? defaultInstalledServerName(params.templateId);
    const installedServer = deepMerge(template.server, params.overrides ?? {}, {
      provenance: {
        source: "template",
        templateId: params.templateId
      }
    });

    const existingText = await readFileTextIfExists(targetPath);
    const baseDocument =
      existingText ??
      JSON.stringify(
        {
          configVersion: APP_CONFIG_VERSION
        },
        null,
        2
      );
    const parsed = parseJsoncText(baseDocument, targetPath);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Config file at ${targetPath} must contain an object.`);
    }

    let nextText = applyJsoncEdit(baseDocument, ["configVersion"], APP_CONFIG_VERSION);
    nextText = applyJsoncEdit(nextText, ["mcp", "servers", installedServerName], installedServer);
    nextText = applyEdits(
      nextText,
      format(nextText, undefined, {
        insertSpaces: true,
        tabSize: 2
      })
    );
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.writeFile(targetPath, `${nextText.trimEnd()}\n`, "utf8");

    return {
      configPath: targetPath,
      installedServerName
    };
  }

  private async resolveConfig(): Promise<{
    importedFiles: string[];
    servers: AppConfig["mcp"]["servers"];
    templates: AppConfig["mcp"]["templates"];
  }> {
    const imported = await loadImportedMcpServers(this.config.mcp.imports);
    return {
      importedFiles: imported.files,
      servers: deepMerge(imported.servers, this.config.mcp.servers),
      templates: deepMerge(BUILT_IN_MCP_SERVER_TEMPLATES, this.config.mcp.templates)
    };
  }

  private async connectServer(
    serverName: string,
    serverConfig: AppConfig["mcp"]["servers"][string]
  ): Promise<ManagedMCPServer> {
    const { client, transport } = await connectClient({
      fetchImpl: this.fetchImpl,
      serverConfig,
      serverName
    });

    const tools = await collectPaginated(async (cursor) => client.listTools(cursor ? { cursor } : undefined), "tools");
    const resources = await collectPaginated(async (cursor) => client.listResources(cursor ? { cursor } : undefined), "resources");
    const resourceTemplates = await collectPaginated(
      async (cursor) => client.listResourceTemplates(cursor ? { cursor } : undefined),
      "resourceTemplates"
    );
    const prompts = await collectPaginated(async (cursor) => client.listPrompts(cursor ? { cursor } : undefined), "prompts");

    const rawToolNamesByInvocationName = new Map<string, string>();
    const capabilities: MCPCapability[] = [
      ...tools.map((tool) => {
        const invocationName = sanitizeMcpInvocationName(serverName, tool.name);
        rawToolNamesByInvocationName.set(invocationName, tool.name);
        return {
          access: "model_and_api" as const,
          annotations: extractAnnotations(tool.annotations),
          description: tool.description,
          displayName: tool.title ?? tool.annotations?.title ?? tool.name,
          execution: {
            taskSupport: normalizeTaskSupport(tool.execution?.taskSupport)
          },
          id: `mcp.tool.${serverName}.${tool.name}`,
          inputSchema: toJsonRecord(tool.inputSchema as Record<string, unknown>),
          invocationName,
          kind: "tool" as const,
          metadata: toJsonRecord(tool._meta),
          name: tool.name,
          outputSchema: tool.outputSchema
            ? toJsonRecord(tool.outputSchema as Record<string, unknown>)
            : undefined,
          rawName: tool.name,
          serverName,
          tags: buildCapabilityTags(serverConfig.tags, "tool")
        } as MCPCapability;
      }),
      ...resources.map((resource) => ({
        access: "model_and_api" as const,
        annotations: extractAnnotations(resource.annotations),
        description: resource.description,
        displayName: resource.title ?? resource.name,
        id: `mcp.resource.${serverName}.${resource.uri}`,
        kind: "resource" as const,
        metadata: toJsonRecord(resource._meta),
        mimeType: resource.mimeType,
        name: resource.name,
        serverName,
        tags: buildCapabilityTags(serverConfig.tags, "resource"),
        title: resource.title,
        uri: resource.uri
      }) as MCPCapability),
      ...resourceTemplates.map((resourceTemplate) => ({
        access: "model_and_api" as const,
        annotations: extractAnnotations(resourceTemplate.annotations),
        description: resourceTemplate.description,
        displayName: resourceTemplate.title ?? resourceTemplate.name,
        id: `mcp.resource-template.${serverName}.${resourceTemplate.uriTemplate}`,
        kind: "resource_template" as const,
        metadata: toJsonRecord(resourceTemplate._meta),
        mimeType: resourceTemplate.mimeType,
        name: resourceTemplate.name,
        serverName,
        tags: buildCapabilityTags(serverConfig.tags, "resource_template"),
        title: resourceTemplate.title,
        uriTemplate: resourceTemplate.uriTemplate
      }) as MCPCapability),
      ...prompts.map((prompt) => ({
        access: "api_only" as const,
        annotations: {},
        arguments: prompt.arguments ?? [],
        description: prompt.description,
        displayName: prompt.title ?? prompt.name,
        id: `mcp.prompt.${serverName}.${prompt.name}`,
        kind: "prompt" as const,
        metadata: toJsonRecord(prompt._meta),
        name: prompt.name,
        serverName,
        tags: buildCapabilityTags(serverConfig.tags, "prompt"),
        title: prompt.title
      }) as MCPCapability)
    ];

    return {
      capabilities,
      client,
      config: serverConfig,
      rawToolNamesByInvocationName,
      status: mcpServerStatusSchema.parse({
        capabilities: {
          prompts: prompts.length,
          resourceTemplates: resourceTemplates.length,
          resources: resources.length,
          tools: tools.length
        },
        checkedAt: new Date().toISOString(),
        lastConnectedAt: new Date().toISOString(),
        serverName,
        state: "connected",
        transport
      }),
      transport
    };
  }

  private getConnectedServer(serverName: string): ManagedMCPServer {
    const server = this.connections.get(serverName);
    if (!server) {
      throw new Error(`No MCP server named "${serverName}" is registered.`);
    }
    if (server.status.state !== "connected") {
      throw new Error(`MCP server "${serverName}" is not connected (state: ${server.status.state}).`);
    }
    return server;
  }

  private listConnectedServerNames() {
    return Array.from(this.connections.values())
      .filter((entry) => entry.status.state === "connected")
      .map((entry) => entry.status.serverName)
      .sort((left, right) => left.localeCompare(right));
  }

  private async syncWatchers(): Promise<void> {
    const watchTargets = new Map<string, string>();
    for (const filePath of [this.configPaths?.globalConfigPath, this.configPaths?.workspaceConfigPath, ...this.importedFiles]) {
      if (typeof filePath !== "string" || filePath.trim().length === 0) {
        continue;
      }
      watchTargets.set(filePath, filePath);
    }

    for (const [target, watcher] of this.watchers.entries()) {
      if (!watchTargets.has(target)) {
        watcher.close();
        this.watchers.delete(target);
      }
    }

    for (const target of watchTargets.keys()) {
      if (this.watchers.has(target)) {
        continue;
      }

      const directory = path.dirname(target);
      const basename = path.basename(target);
      const watcher = fs.watch(directory, { persistent: false }, (_eventType, fileName) => {
        if (fileName && fileName.toString() !== basename) {
          return;
        }
        this.scheduleReload();
      });
      this.watchers.set(target, watcher);
    }
  }

  private scheduleReload(): void {
    if (!this.reloadConfig) {
      return;
    }
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh().catch(() => undefined);
    }, 150);
  }
}

export function createMcpManagerFromLoadedConfig(params: {
  cwd: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  loaded: LoadedAIAgentConfig;
  userHomeDirectory?: string;
  watch?: boolean;
}) {
  return new MCPManager({
    config: params.loaded.resolvedConfig,
    configPaths: params.loaded.paths,
    fetchImpl: params.fetchImpl,
    reloadConfig: async () =>
      loadAIAgentConfig({
        cwd: params.cwd,
        env: params.env,
        userHomeDirectory: params.userHomeDirectory
      }),
    watch: params.watch
  });
}

async function connectClient(params: {
  fetchImpl: typeof fetch;
  serverConfig: AppConfig["mcp"]["servers"][string];
  serverName: string;
}): Promise<{ client: Client; transport: AppConfig["mcp"]["servers"][string]["type"] }> {
  if (params.serverConfig.type === "stdio") {
    const transport = new StdioClientTransport({
      args: params.serverConfig.args,
      command: params.serverConfig.command,
      cwd: params.serverConfig.cwd,
      env: {
        ...getDefaultEnvironment(),
        ...materializeSecrets(params.serverConfig.env, params.serverName, "env")
      },
      stderr: params.serverConfig.stderr
    });
    const client = new Client({ name: "AIAgent", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    return {
      client,
      transport: "stdio"
    };
  }

  if (params.serverConfig.type === "sse") {
    const client = new Client({ name: "AIAgent", version: "0.1.0" }, { capabilities: {} });
    const transport = new SSEClientTransport(new URL(params.serverConfig.url), {
      fetch: params.fetchImpl,
      requestInit: {
        headers: materializeSecrets(params.serverConfig.headers, params.serverName, "headers")
      }
    });
    await client.connect(transport);
    return {
      client,
      transport: "sse"
    };
  }

  const httpConfig = params.serverConfig;
  const requestHeaders = materializeSecrets(httpConfig.headers, params.serverName, "headers");
  const connectStreamable = async () => {
    const client = new Client({ name: "AIAgent", version: "0.1.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(httpConfig.url), {
      fetch: params.fetchImpl,
      requestInit: {
        headers: requestHeaders
      }
    });
    await client.connect(transport);
    return client;
  };

  if (params.serverConfig.type === "streamable-http") {
    const client = await connectStreamable();
    return {
      client,
      transport: "streamable-http"
    };
  }

  try {
    const client = await connectStreamable();
    return {
      client,
      transport: "streamable-http"
    };
  } catch (error) {
    if (!shouldFallbackToSse(error)) {
      throw error;
    }

    const client = new Client({ name: "AIAgent", version: "0.1.0" }, { capabilities: {} });
    const transport = new SSEClientTransport(new URL(httpConfig.url), {
      fetch: params.fetchImpl,
      requestInit: {
        headers: requestHeaders
      }
    });
    await client.connect(transport);
    return {
      client,
      transport: "sse"
    };
  }
}

async function collectPaginated<T extends Record<string, unknown>, K extends keyof T & string>(
  request: (cursor?: string) => Promise<T>,
  key: K
): Promise<NonNullable<T[K]> extends Array<infer Item> ? Item[] : never> {
  const items: unknown[] = [];
  let cursor: string | undefined;

  do {
    const page = await request(cursor);
    const pageItems = Array.isArray(page[key]) ? page[key] : [];
    items.push(...pageItems);
    cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
  } while (cursor);

  return items as NonNullable<T[K]> extends Array<infer Item> ? Item[] : never;
}

function buildTemplateCapabilities(
  templates: Record<string, AppConfig["mcp"]["templates"][string]>
): MCPCapability[] {
  return Object.entries(templates).map(([templateId, template]) => ({
    access: "api_only" as const,
    annotations: {},
    bootstrap: template.bootstrap,
    description: template.description,
    displayName: template.displayName,
    id: `mcp.server-template.${templateId}`,
    kind: "server_template" as const,
    marketplace: template.marketplace,
    metadata: {
      prerequisites: template.prerequisites
    },
    name: templateId,
    source: template.server.provenance?.source === "template" ? "built_in" : "config",
    tags: template.tags,
    title: template.title,
    transport: template.server.type
  }));
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

function toJsonRecord(value: Record<string, unknown> | undefined): Record<string, JsonValue> {
  if (!value) {
    return {};
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
}

function buildCapabilityTags(tags: string[], kind: string) {
  return Array.from(new Set([...tags, "mcp", kind]));
}

function normalizeTaskSupport(value: unknown): "forbidden" | "optional" | "required" | undefined {
  return value === "forbidden" || value === "optional" || value === "required" ? value : undefined;
}

function materializeSecrets(
  values: Record<string, SecretInput>,
  serverName: string,
  label: "env" | "headers"
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      if (typeof value !== "string") {
        throw new Error(`MCP server "${serverName}" has unresolved secret-backed ${label} value "${key}". Use resolvedConfig.`);
      }
      return [key, value];
    })
  );
}

function shouldFallbackToSse(error: unknown): boolean {
  return error instanceof StreamableHTTPError || error instanceof SseError || error instanceof Error;
}

function normalizeMcpError(error: unknown): StructuredError {
  if (error instanceof Error) {
    return {
      code: "mcp_connection_error",
      details: {
        name: error.name
      },
      message: error.message,
      retriable: true
    };
  }

  return {
    code: "mcp_connection_error",
    details: {},
    message: String(error),
    retriable: true
  };
}

function defaultInstalledServerName(templateId: string): string {
  return templateId.replace(/[^A-Za-z0-9_-]+/g, "_");
}

async function readFileTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function applyJsoncEdit(document: string, pathSegments: (string | number)[], value: unknown): string {
  const edits = modify(document, pathSegments, value, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2
    }
  });
  return applyEdits(document, edits);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
