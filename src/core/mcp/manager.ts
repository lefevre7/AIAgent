import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import { ElicitRequestSchema, type ElicitRequest, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";

import type { AppConfig, LoadedAIAgentConfig, ResolvedConfigPaths, TrustGatedMcpEntry } from "@/core/config";
import { configTrustFilePath, loadAIAgentConfig } from "@/core/config";
import type {
  MCPCapability,
  MCPCapabilitySearchQuery,
  MCPManagerHealth,
  MCPPromptResult,
  MCPResourceReadResult,
  MCPServerConnectionState,
  MCPServerStatus,
  MCPServerSummary,
  MCPServerUpdate,
  MCPToolCapability,
  StructuredError
} from "@/core/contracts";
import {
  mcpManagerHealthSchema,
  mcpPromptResultSchema,
  mcpResourceReadResultSchema,
  mcpServerStatusSchema,
  mcpServerSummarySchema,
  mcpTransportTypeSchema
} from "@/core/contracts";
import { McpCallTimer } from "@/core/mcp/call-timer";
import { MCPCapabilityCatalog } from "@/core/mcp/catalog";
import {
  addMcpServerToConfigFile,
  chooseUserConfigFile,
  resolveMcpServerConfig,
  serverFromTemplate
} from "@/core/mcp/config-file";
import {
  connectMcpClient,
  McpStdioConnectError,
  resolveToolTimeoutMs,
  type ConnectMcpClientParams,
  type McpConnection,
  type McpServerConfig,
  type McpTransportKind
} from "@/core/mcp/connection";
import { collectPaginated, enumerateMcpServer, isMcpToolAllowed, type EnumeratedServer } from "@/core/mcp/enumerate";
import { isTransientNetworkError, readNetworkErrorCode } from "@/core/io/http";
import { isMcpAuthorizationError, isMcpSessionExpired } from "@/core/mcp/http";
import { isMcpLoginRequiredError, McpCredentialsStore, mcpCredentialsFilePath } from "@/core/mcp/oauth";
import { toMcpIdSegment } from "@/core/mcp/names";
import type { ProcessGroupStdioClientTransport } from "@/core/mcp/stdio-transport";

/** Codex's defaults: optional servers get a second, then later requests go on without them. */
const DEFAULT_OPTIONAL_STARTUP_GRACE_MS = 1_000;
// A dropped connection is retried after 1 s, doubling to 30 s, five times.
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
export const MAX_MCP_RECONNECT_ATTEMPTS = 5;
// A connection that lasted this long earns a fresh set of reconnect attempts.
// Resetting on every handshake respawned a server that crashed right after
// connecting about every 1.6 s, forever.
const STABLE_CONNECTION_MS = 60_000;
export const MCP_RECONNECT_GAVE_UP_ERROR_CODE = "mcp_reconnect_gave_up";
// How long after a server's last list_changed notice it is listed again.
const RELIST_DEBOUNCE_MS = 300;
// setTimeout's ceiling. The SDK's own request timeout is set this high so the
// pausable McpCallTimer is the only clock on a call.
const SDK_TIMEOUT_CEILING_MS = 2_147_000_000;
const STDERR_TAIL_LINES = 5;

export const MCP_NEEDS_LOGIN_ERROR_CODE = "mcp_needs_login";

type LiveConnection = EnumeratedServer & {
  client: Client;
  stdio?: ProcessGroupStdioClientTransport;
  transport: McpTransportKind;
};

/** Who a tool call runs for, so a question the server asks mid-call reaches the right session. */
export type McpCallContext = {
  sessionId?: string;
  toolCallId?: string;
  turnId?: string;
};

type InFlightCall = { context: McpCallContext; timer: McpCallTimer };

type ServerSlot = {
  config: McpServerConfig;
  connecting?: Promise<void>;
  connection?: LiveConnection;
  // Bumped whenever the slot's connection is replaced or abandoned. A connect
  // attempt, close event, or relist that finds a different epoch is stale and
  // must not touch the slot.
  epoch: number;
  error?: StructuredError;
  inFlight: Set<InFlightCall>;
  lastConnectedAt?: string;
  /** When the current connection was made (ms), for STABLE_CONNECTION_MS. */
  connectedSince?: number;
  reconnectAttempts: number;
  reconnectTimer?: NodeJS.Timeout;
  reinitializing?: Promise<void>;
  relisting: Promise<void>;
  /** The relist a list_changed notice scheduled (one for all three kinds). */
  relistTimer?: NodeJS.Timeout;
  signature: string;
  state: Exclude<MCPServerConnectionState, "untrusted">;
};

/** One prompt as a server lists it (prompts/list). */
export type McpPromptDescriptor = {
  _meta?: Record<string, unknown>;
  arguments?: Array<{ description?: string; name: string; required?: boolean }>;
  description?: string;
  name: string;
  title?: string;
};

/** A question an MCP server asks the operator in the middle of a call (MCP elicitation). */
export type McpElicitationRequest = {
  /** The call that is waiting on the answer, when there is one. */
  context?: McpCallContext;
  params: ElicitRequest["params"];
  serverName: string;
  signal: AbortSignal;
};

export type McpElicitationHandler = (request: McpElicitationRequest) => Promise<ElicitResult>;

export type MCPManagerEvents = {
  refreshed: [{ health: MCPManagerHealth }];
  /** One server changed state or tools (connected, failed, needs a login, reconnected, relisted). */
  server_updated: [{ previousState?: MCPServerStatus["state"]; status: MCPServerStatus }];
  statuses_changed: [{ statuses: MCPServerStatus[] }];
};

/**
 * Servers an untrusted workspace config declared. They are reported (state
 * `untrusted`) so the operator can see what was held back and why, and never
 * started.
 */
export type UntrustedMcpServers = {
  configPath: string;
  entries: TrustGatedMcpEntry[];
};

export type MCPManagerOptions = {
  config: AppConfig;
  configPaths?: ResolvedConfigPaths;
  /** How one server is reached; tests replace it. */
  connectClient?: (params: ConnectMcpClientParams) => Promise<McpConnection>;
  fetchImpl?: typeof fetch;
  /** Where OAuth tokens live; without it no server gets OAuth. */
  oauthStore?: McpCredentialsStore;
  /** Test seam: the first reconnect delay (doubling from there). Default 1 s. */
  reconnectBaseDelayMs?: number;
  reloadConfig?: () => Promise<LoadedAIAgentConfig>;
  /** Test seam: how long a connection must last to earn fresh reconnect attempts. Default 60 s. */
  stableConnectionMs?: number;
  untrusted?: UntrustedMcpServers;
  watch?: boolean;
};

/** The untrusted workspace servers a load withheld, in the form the manager reports. */
export function untrustedMcpServersFromLoaded(loaded: LoadedAIAgentConfig): UntrustedMcpServers {
  return {
    configPath: loaded.workspaceTrust.fingerprint?.path ?? loaded.paths.workspaceConfigPath,
    entries: loaded.workspaceTrust.untrustedMcpEntries.filter((entry) => entry.kind === "server")
  };
}

/**
 * Owns every configured MCP server's connection.
 *
 * Each server has a slot with its own lifecycle: `connecting` → `connected`,
 * or `failed` / `needs_login`; `disabled` when config says so. Servers connect
 * in parallel and in the background: `initialize()` and `refresh()` wait only
 * for `required` servers (and fail if one fails), plus a short grace for the
 * rest (`mcp.optionalStartupGraceMs`, default 1 s, anchored at startup). A
 * server that connects later joins the catalog then, and a call to a server
 * still connecting waits for it.
 *
 * A connection that drops (a stdio server exits, a stream closes) marks the
 * server `failed` with the reason (exit code, last stderr lines) and is
 * retried after 1 s, doubling to 30 s, five times; `reconnect()` does it now.
 * A server that says its tools changed is listed again.
 */
export class MCPManager extends EventEmitter<MCPManagerEvents> {
  private readonly connectClient: (params: ConnectMcpClientParams) => Promise<McpConnection>;
  private readonly fetchImpl: typeof fetch;
  private readonly watchEnabled: boolean;
  private readonly configPaths?: ResolvedConfigPaths;
  private readonly oauthStore?: McpCredentialsStore;
  private config: AppConfig;
  private readonly reloadConfig?: () => Promise<LoadedAIAgentConfig>;
  private readonly reconnectBaseDelayMs: number;
  private readonly stableConnectionMs: number;
  private untrusted: UntrustedMcpServers | undefined;
  private readonly slots = new Map<string, ServerSlot>();
  // The requests in flight on each client, and the clients dropped for an
  // expired session that wait for theirs to be answered (renewExpiredSession).
  private readonly requestsInFlight = new WeakMap<Client, Set<Promise<unknown>>>();
  private readonly drainingClients = new Set<Client>();
  private catalog = new MCPCapabilityCatalog();
  private templateDefinitions: Record<string, AppConfig["mcp"]["templates"][string]> = {};
  private importedFiles: string[] = [];
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private refreshTimer: NodeJS.Timeout | null = null;
  private loginRetryTimer: NodeJS.Timeout | null = null;
  private initialized = false;
  private closed = false;
  private lastRefreshAt: string | undefined;
  private startupStartedAt = Date.now();
  private elicitationHandler: McpElicitationHandler | undefined;
  // Serializes concurrent refresh() calls, so only one reconcile changes the
  // slots at a time. Connections themselves settle in the background.
  private refreshQueue: Promise<void> = Promise.resolve();
  // Bumped whenever the connected capability set may have changed, so cached
  // tool-registry snapshots can cheaply detect staleness.
  private generation = 0;

  constructor(options: MCPManagerOptions) {
    super();
    this.config = options.config;
    this.configPaths = options.configPaths;
    this.connectClient = options.connectClient ?? connectMcpClient;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.oauthStore = options.oauthStore;
    this.reloadConfig = options.reloadConfig;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? RECONNECT_BASE_DELAY_MS;
    this.stableConnectionMs = options.stableConnectionMs ?? STABLE_CONNECTION_MS;
    this.untrusted = options.untrusted;
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
    this.closed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.loginRetryTimer) {
      clearTimeout(this.loginRetryTimer);
      this.loginRetryTimer = null;
    }
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
    await Promise.all(Array.from(this.slots.values()).map((slot) => this.releaseSlot(slot)));
    await Promise.all(Array.from(this.drainingClients, (client) => this.closeDrainedClient(client)));
    this.slots.clear();
    this.catalog = new MCPCapabilityCatalog();
  }

  /**
   * Answers the questions servers ask mid-call. Set by the host that can reach
   * an operator (the gateway); until then every question is declined.
   */
  setElicitationHandler(handler: McpElicitationHandler | undefined): void {
    this.elicitationHandler = handler;
  }

  /**
   * Waits for optional servers still connecting, until they settle or the
   * grace period that began at startup runs out. `0` waits for each server's
   * full startup timeout.
   */
  async waitForStartup(): Promise<void> {
    const pending = Array.from(this.slots.values()).flatMap((slot) =>
      slot.state === "connecting" && slot.connecting ? [slot.connecting] : []
    );
    if (pending.length === 0) {
      return;
    }
    const grace = this.config.mcp.optionalStartupGraceMs ?? DEFAULT_OPTIONAL_STARTUP_GRACE_MS;
    const settled = Promise.allSettled(pending).then(() => undefined);
    if (grace === 0) {
      await settled;
      return;
    }
    const remaining = this.startupStartedAt + grace - Date.now();
    if (remaining <= 0) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remaining);
      })
    ]);
    clearTimeout(timer);
  }

  getToolCapabilities(): MCPToolCapability[] {
    return this.catalog.list().filter((capability): capability is MCPToolCapability => capability.kind === "tool");
  }

  getCatalog(): MCPCapabilityCatalog {
    return this.catalog;
  }

  // Monotonic counter incremented whenever the catalog is rebuilt. Consumers
  // (e.g. the dynamic MCP tool registry) use it to memoize derived state.
  getGeneration(): number {
    return this.generation;
  }

  /** A connected server's own usage notes (its `instructions` from initialize). */
  getServerInstructions(serverName: string): string | undefined {
    return this.slots.get(serverName)?.connection?.instructions;
  }

  getServerStatuses(): MCPServerStatus[] {
    // A withheld workspace server that shares a name with a user-global one is
    // not listed separately: the global server runs as configured, and only
    // the workspace's override of it was held back.
    const untrusted = (this.untrusted?.entries ?? [])
      .filter((entry) => !this.slots.has(entry.name))
      .map((entry) => buildUntrustedServerStatus(entry, this.untrusted?.configPath ?? "the workspace config"));
    return [...Array.from(this.slots.entries()).map(([name, slot]) => buildStatus(name, slot)), ...untrusted].sort(
      (left, right) => left.serverName.localeCompare(right.serverName)
    );
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

  /**
   * The configured servers as of the latest config reload (not the imported
   * ones). The approval policy reads their `trust` from here, so a reload
   * that withholds a workspace's override also withdraws its auto-approval.
   */
  getConfiguredServers(): AppConfig["mcp"]["servers"] {
    return this.config.mcp.servers;
  }

  // Per-server view used by the `mcp_status` tool, the `mcp.list` gateway request,
  // and the CLI `/mcp` command. Includes disabled/failed servers (with their
  // error) and groups each server's exposed tools, so "what MCP servers do you
  // have and their tools?" is answerable even when a server never connected.
  summarizeServers(serverNames?: ReadonlySet<string>): MCPServerSummary[] {
    // The catalog is listed (and sorted) once, not once per server.
    const toolsByServer = new Map<string, MCPToolCapability[]>();
    for (const tool of this.getToolCapabilities()) {
      if (!tool.serverName) {
        continue;
      }
      const tools = toolsByServer.get(tool.serverName) ?? [];
      tools.push(tool);
      toolsByServer.set(tool.serverName, tools);
    }
    return this.getServerStatuses()
      .filter((status) => !serverNames || serverNames.has(status.serverName))
      .map((status) => summarizeStatus(status, toolsByServer.get(status.serverName) ?? []));
  }

  async refresh(nextConfig?: AppConfig): Promise<void> {
    // Chain onto any in-flight refresh so only one reconcile mutates the
    // slots at a time. The second callback of each .then runs refreshOnce even
    // if the prior refresh rejected.
    const run = this.refreshQueue.then(
      () => this.refreshOnce(nextConfig),
      () => this.refreshOnce(nextConfig)
    );
    this.refreshQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  /** Drops a server's connection and connects it again now, resetting its retries. */
  async reconnect(serverName: string): Promise<MCPServerStatus> {
    const slot = this.slots.get(serverName);
    if (!slot) {
      throw new Error(this.describeMissingServer(serverName));
    }
    if (!slot.config.enabled) {
      throw new Error(`MCP server "${serverName}" is disabled in config.`);
    }
    slot.reconnectAttempts = 0;
    await this.reinitialize(serverName, slot);
    // A reload may have replaced (or removed) the slot meanwhile: report the
    // server as it is now.
    const current = this.slots.get(serverName);
    if (!current) {
      throw new Error(this.describeMissingServer(serverName));
    }
    return buildStatus(serverName, current);
  }

  /**
   * Drops the slot's connection and connects again, once however many
   * callers ask at the same time; calls arriving meanwhile wait for it. The
   * old client is closed at once, or when `closeOldClientWhen` settles.
   */
  private reinitialize(serverName: string, slot: ServerSlot, closeOldClientWhen?: Promise<unknown>): Promise<void> {
    slot.reinitializing ??= (async () => {
      // Without its connection it is not "connected", which a status read
      // during the close used to say.
      if (slot.state === "connected") {
        slot.state = "connecting";
        this.notifyChanged(serverName, slot, "connected");
      }
      await this.releaseSlot(slot, closeOldClientWhen);
      if (!this.closed && this.slots.get(serverName) === slot) {
        await this.startConnect(serverName, slot);
      }
    })().finally(() => {
      slot.reinitializing = undefined;
    });
    return slot.reinitializing;
  }

  async callTool(
    serverName: string,
    invocationOrRawToolName: string,
    args: Record<string, unknown> = {},
    context: McpCallContext = {}
  ) {
    return this.request(serverName, context, (connection, options, slot) => {
      const rawName = connection.rawToolNamesByInvocationName.get(invocationOrRawToolName) ?? invocationOrRawToolName;
      // Checked again here: a raw name reaches past the filtered catalog.
      if (!isMcpToolAllowed(slot.config, rawName)) {
        throw new Error(
          `The tool "${rawName}" is disabled for MCP server "${serverName}" (enabledTools/disabledTools).`
        );
      }
      return connection.client.callTool({ arguments: args, name: rawName }, undefined, options);
    });
  }

  async readResource(serverName: string, uri: string): Promise<MCPResourceReadResult> {
    const result = await this.request(serverName, {}, (connection, options) =>
      connection.client.readResource({ uri }, options)
    );
    return mcpResourceReadResultSchema.parse({
      contents: result.contents,
      uri
    });
  }

  async readResourceTemplate(
    serverName: string,
    uriTemplate: string,
    variables: Record<string, string | string[]> = {}
  ) {
    const uri = new UriTemplate(uriTemplate).expand(variables);
    return this.readResource(serverName, uri);
  }

  async listPrompts(
    serverName?: string
  ): Promise<McpPromptDescriptor[] | Array<{ prompts: McpPromptDescriptor[]; serverName: string }>> {
    if (serverName) {
      return this.request(serverName, {}, (connection, options) =>
        collectPaginated(
          async (cursor) => connection.client.listPrompts(cursor ? { cursor } : undefined, options),
          "prompts"
        )
      );
    }

    return Promise.all(
      this.listConnectedServerNames().map(async (name) => ({
        prompts: (await this.listPrompts(name)) as McpPromptDescriptor[],
        serverName: name
      }))
    );
  }

  async getPrompt(serverName: string, name: string, args: Record<string, string> = {}): Promise<MCPPromptResult> {
    const prompt = await this.request(serverName, {}, (connection, options) =>
      connection.client.getPrompt({ arguments: args, name }, options)
    );
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
    const server = serverFromTemplate(this.templateDefinitions, params.templateId, params.overrides);
    // The user scope's file is chosen as `aia mcp add` chooses it.
    const targetPath =
      params.configPath ??
      (params.destination === "user"
        ? this.configPaths && (await chooseUserConfigFile(this.configPaths))
        : this.configPaths?.workspaceConfigPath);
    if (!targetPath) {
      throw new Error("Unable to resolve the MCP template install target path.");
    }

    const installedServerName = params.serverName ?? defaultInstalledServerName(params.templateId);
    await addMcpServerToConfigFile({
      ...(this.configPaths ? { configPaths: this.configPaths } : {}),
      configPath: targetPath,
      force: true,
      server,
      serverName: installedServerName
    });
    return {
      configPath: targetPath,
      installedServerName
    };
  }

  private async refreshOnce(nextConfig?: AppConfig): Promise<void> {
    // A refresh can be queued, or be waiting on a config load, when the
    // manager closes (a watcher fired during shutdown). Run on, it started
    // servers and watchers nothing would ever stop, and the process stayed up.
    if (this.closed) {
      return;
    }
    if (nextConfig) {
      this.config = nextConfig;
    } else if (this.reloadConfig && this.initialized) {
      const loaded = await this.reloadConfig();
      if (this.closed) {
        return;
      }
      this.config = loaded.resolvedConfig;
      // Trust can change between loads (`aia trust --grant` in another
      // terminal), so the withheld set is re-read with the config itself.
      this.untrusted = untrustedMcpServersFromLoaded(loaded);
    }

    const resolved = await resolveMcpServerConfig(this.config.mcp);
    if (this.closed) {
      return;
    }
    this.startupStartedAt = Date.now();

    // A slot leaves the map before its connection closes (up to a few
    // seconds for a process group): a call meanwhile used to find it
    // "connected" with no connection, and fail.
    for (const [name, slot] of this.slots) {
      if (!Object.hasOwn(resolved.servers, name)) {
        this.slots.delete(name);
        await this.releaseSlot(slot);
      }
    }

    // Connected (or connecting) servers whose config is unchanged are kept.
    // Failed ones are not, so a transient failure (a server not up yet, a
    // brief network error) is retried by the next refresh instead of being
    // pinned as failed until restart; a login elsewhere is picked up the same
    // way.
    const required: ServerSlot[] = [];
    for (const [name, config] of Object.entries(resolved.servers)) {
      const signature = JSON.stringify(config);
      const existing = this.slots.get(name);
      if (
        existing &&
        existing.signature === signature &&
        (existing.state === "connected" || existing.state === "connecting")
      ) {
        if (config.required && existing.state === "connecting") {
          required.push(existing);
        }
        continue;
      }
      const slot: ServerSlot = {
        config,
        epoch: 0,
        inFlight: new Set(),
        reconnectAttempts: 0,
        relisting: Promise.resolve(),
        signature,
        state: config.enabled ? "connecting" : "disabled"
      };
      this.slots.set(name, slot);
      if (existing) {
        // A call meanwhile waits for the new connection (requireReadySlot).
        slot.reinitializing = this.releaseSlot(existing);
        await slot.reinitializing;
        slot.reinitializing = undefined;
      }
      if (this.closed) {
        return;
      }
      if (config.enabled) {
        void this.startConnect(name, slot);
        if (config.required) {
          required.push(slot);
        }
      }
    }

    this.templateDefinitions = resolved.templates;
    this.importedFiles = resolved.importedFiles;
    this.lastRefreshAt = new Date().toISOString();
    this.rebuildCatalog();
    if (this.watchEnabled && this.reloadConfig) {
      await this.syncWatchers();
    }
    this.emitStatusesChanged();
    if (this.listenerCount("refreshed") > 0) {
      this.emit("refreshed", { health: await this.getHealth() });
    }

    // Required servers hold the caller up; the rest get the startup grace and
    // then join whenever they are ready.
    await Promise.all(required.map((slot) => slot.connecting));
    await this.waitForStartup();
    const failures = Array.from(this.slots.entries()).filter(
      ([, slot]) => required.includes(slot) && slot.state !== "connected"
    );
    if (failures.length > 0) {
      throw new Error(
        `Required MCP servers failed to connect:\n${failures
          .map(([name, slot]) => `- ${name}: ${slot.error?.message ?? slot.state}`)
          .join("\n")}`
      );
    }
  }

  private startConnect(serverName: string, slot: ServerSlot): Promise<void> {
    const epoch = ++slot.epoch;
    const previousState = slot.state;
    slot.state = "connecting";
    delete slot.error;
    if (previousState !== "connecting") {
      this.notifyChanged(serverName, slot, previousState);
    }

    const onListChanged = this.relistOnChange(serverName, slot, epoch);
    const attempt = (async () => {
      let connection: McpConnection | undefined;
      try {
        connection = await this.connectClient({
          configureClient: (client) =>
            client.setRequestHandler(ElicitRequestSchema, (request, extra) =>
              this.handleElicitation(serverName, slot, request, extra.signal)
            ),
          elicitation: true,
          fetchImpl: this.fetchImpl,
          globalPassEnv: this.config.mcp.passEnv ?? [],
          listChanged: {
            prompts: onListChanged,
            resources: onListChanged,
            tools: onListChanged
          },
          ...(this.oauthStore ? { oauthStore: this.oauthStore } : {}),
          serverConfig: slot.config,
          serverName
        });
        const enumerated = await enumerateMcpServer({
          client: connection.client,
          serverConfig: slot.config,
          serverName,
          transport: connection.transport
        });
        if (this.isStale(slot, epoch)) {
          await connection.client.close().catch(() => undefined);
          return;
        }
        slot.connection = {
          ...enumerated,
          client: connection.client,
          ...(connection.stdio ? { stdio: connection.stdio } : {}),
          transport: connection.transport
        };
        slot.state = "connected";
        slot.lastConnectedAt = new Date().toISOString();
        // The attempt count is kept until the connection proves stable (see
        // handleConnectionLost), so a crash loop still runs out of attempts.
        slot.connectedSince = Date.now();
        const client = connection.client;
        client.onclose = () => this.handleConnectionLost(serverName, slot, epoch);
        if (connection.transport !== "stdio") {
          // An HTTP server that goes away is not a close: the event stream
          // and later requests fail instead, and the server stayed
          // "connected" until restart.
          client.onerror = (error) => {
            if (isTransientNetworkError(error)) {
              this.handleConnectionLost(serverName, slot, epoch, describeError(error));
            }
          };
        }
      } catch (error) {
        const failure = describeConnectFailure(serverName, error, connection?.stdio);
        await connection?.client.close().catch(() => undefined);
        if (this.isStale(slot, epoch)) {
          return;
        }
        slot.state = failure.code === MCP_NEEDS_LOGIN_ERROR_CODE ? "needs_login" : "failed";
        slot.error = failure;
        // Part of recovering a dropped connection, or a process that started
        // and died during the handshake: keep trying on schedule. A command
        // that does not exist (it never started) is not worth retrying.
        const crashed = error instanceof McpStdioConnectError && error.crashed;
        if ((slot.reconnectAttempts > 0 || crashed) && slot.state === "failed") {
          this.scheduleReconnect(serverName, slot);
        }
      } finally {
        if (!this.isStale(slot, epoch)) {
          slot.connecting = undefined;
          this.rebuildCatalog();
          this.notifyChanged(serverName, slot, "connecting");
        }
      }
    })();
    slot.connecting = attempt;
    return attempt;
  }

  private handleConnectionLost(serverName: string, slot: ServerSlot, epoch: number, cause?: string): void {
    if (this.closed || this.isStale(slot, epoch) || slot.state !== "connected") {
      return;
    }
    const reason =
      cause ?? (slot.connection?.stdio ? describeStdioExit(slot.connection.stdio) : "the connection closed");
    if (slot.connectedSince !== undefined && Date.now() - slot.connectedSince >= this.stableConnectionMs) {
      slot.reconnectAttempts = 0;
    }
    slot.epoch += 1;
    slot.connection = undefined;
    slot.state = "failed";
    slot.error = {
      code: "mcp_connection_lost",
      details: {},
      message: `Lost the connection to MCP server "${serverName}": ${reason}.`,
      retriable: true
    };
    this.rebuildCatalog();
    this.notifyChanged(serverName, slot, "connected");
    this.scheduleReconnect(serverName, slot);
  }

  private scheduleReconnect(serverName: string, slot: ServerSlot): void {
    if (this.closed) {
      return;
    }
    if (slot.reconnectAttempts >= MAX_MCP_RECONNECT_ATTEMPTS) {
      if (slot.error) {
        slot.error = {
          ...slot.error,
          // Its own code, so a surface can say this once rather than every try.
          code: MCP_RECONNECT_GAVE_UP_ERROR_CODE,
          message: `${slot.error.message} Gave up after ${MAX_MCP_RECONNECT_ATTEMPTS} reconnect attempts; reconnect it with /mcp reconnect ${serverName}.`
        };
        this.notifyChanged(serverName, slot, slot.state);
      }
      return;
    }
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, this.reconnectBaseDelayMs * 2 ** slot.reconnectAttempts);
    slot.reconnectAttempts += 1;
    const epoch = slot.epoch;
    slot.reconnectTimer = setTimeout(() => {
      slot.reconnectTimer = undefined;
      if (!this.closed && !this.isStale(slot, epoch)) {
        void this.startConnect(serverName, slot);
      }
    }, delay);
    slot.reconnectTimer.unref?.();
  }

  // The SDK's list-changed notification handler, debounced. Its own refresh
  // reads only the first page, so the server is listed again the full way.
  // A server announces tools, prompts and resources changes separately, and
  // often together. Each kind used to list everything again on its own; one
  // debounced relist per server now covers whichever changed.
  private relistOnChange(serverName: string, slot: ServerSlot, epoch: number) {
    return {
      autoRefresh: false,
      // Debounced here, once per server, rather than by the SDK per kind.
      debounceMs: 0,
      onChanged: () => {
        if (this.isStale(slot, epoch)) {
          return;
        }
        clearTimeout(slot.relistTimer);
        slot.relistTimer = setTimeout(() => {
          slot.relistTimer = undefined;
          slot.relisting = slot.relisting.then(() => this.relist(serverName, slot, epoch));
        }, RELIST_DEBOUNCE_MS);
        slot.relistTimer.unref?.();
      }
    };
  }

  private async relist(serverName: string, slot: ServerSlot, epoch: number): Promise<void> {
    const connection = slot.connection;
    if (this.isStale(slot, epoch) || !connection) {
      return;
    }
    try {
      const enumerated = await enumerateMcpServer({
        client: connection.client,
        serverConfig: slot.config,
        serverName,
        transport: connection.transport
      });
      if (this.isStale(slot, epoch) || slot.connection !== connection) {
        return;
      }
      slot.connection = { ...connection, ...enumerated };
      this.rebuildCatalog();
      this.notifyChanged(serverName, slot, slot.state);
    } catch (error) {
      // Its connection was replaced meanwhile (closed, perhaps, which is why
      // it failed); the new one was listed when it connected.
      if (this.isStale(slot, epoch) || slot.connection !== connection) {
        return;
      }
      console.warn(
        `[AIA_MCP_RELIST_FAILED] MCP server "${serverName}" said its list changed, but listing it again failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async handleElicitation(
    serverName: string,
    slot: ServerSlot,
    request: ElicitRequest,
    signal: AbortSignal
  ): Promise<ElicitResult> {
    const handler = this.elicitationHandler;
    if (!handler) {
      return { action: "decline" };
    }
    // A server is shared by every session, and a question does not say which
    // call it is for. With calls from one session waiting, it is that
    // session's; with calls from several, asking any one operator could show
    // them another session's question, so it is declined. It used to go to
    // whichever call had started last.
    const waiting = Array.from(slot.inFlight);
    const sessions = new Set(waiting.map((call) => call.context.sessionId ?? null));
    if (sessions.size > 1) {
      console.warn(
        `[AIA_MCP_ELICITATION_AMBIGUOUS] MCP server "${serverName}" asked a question while calls from ${sessions.size} sessions were waiting on it. It was declined: which session it belongs to cannot be told.`
      );
      return { action: "decline" };
    }
    // The call waiting on the answer must not time out while a person thinks.
    for (const call of waiting) {
      call.timer.pause();
    }
    try {
      return await handler({
        ...(waiting.length > 0 ? { context: waiting[waiting.length - 1]!.context } : {}),
        params: request.params,
        serverName,
        signal
      });
    } catch (error) {
      // Declined, but said: a broker that throws is a bug to see.
      console.warn(
        `[AIA_MCP_ELICITATION_FAILED] MCP server "${serverName}": answering its question failed, so it was declined: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return { action: "decline" };
    } finally {
      for (const call of waiting) {
        call.timer.resume();
      }
    }
  }

  // Every request a caller makes of a server goes through here: it waits
  // until the server is ready, is timed (runTimedCall), and replays once on
  // a streamable-HTTP session the server forgot (withSessionRecovery).
  private async request<T>(
    serverName: string,
    context: McpCallContext,
    run: (connection: LiveConnection, options: RequestOptions, slot: ServerSlot) => Promise<T>
  ): Promise<T> {
    const slot = await this.requireReadySlot(serverName);
    return this.withSessionRecovery(serverName, slot, (connection) =>
      this.runTimedCall(serverName, slot, context, (options) => run(connection, options, slot))
    );
  }

  // A call gets toolTimeoutMs without progress; the McpCallTimer is the only
  // clock (the SDK's is set past it) so an elicitation can pause it.
  private async runTimedCall<T>(
    serverName: string,
    slot: ServerSlot,
    context: McpCallContext,
    run: (options: RequestOptions) => Promise<T>
  ): Promise<T> {
    const timeoutMs = resolveToolTimeoutMs(slot.config);
    const controller = new AbortController();
    const timer = new McpCallTimer(timeoutMs, () => controller.abort());
    const entry: InFlightCall = { context, timer };
    slot.inFlight.add(entry);
    timer.start();
    try {
      return await run({
        onprogress: () => timer.reset(),
        signal: controller.signal,
        timeout: SDK_TIMEOUT_CEILING_MS
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(
          `The MCP server "${serverName}" did not finish within ${Math.round(timeoutMs / 1000)} s without reporting progress (toolTimeoutMs).`
        );
      }
      throw error;
    } finally {
      timer.stop();
      slot.inFlight.delete(entry);
    }
  }

  // A streamable-HTTP server that forgot our session answers 404: connect
  // again (once, however many calls noticed) and replay the operation once.
  private async withSessionRecovery<T>(
    serverName: string,
    slot: ServerSlot,
    operation: (connection: LiveConnection) => Promise<T>
  ): Promise<T> {
    const connection = slot.connection!;
    const epoch = slot.epoch;
    // The same connection is the same client: a relist replaces the
    // connection record (with the new lists), not the client.
    const stillCurrent = () => slot.connection?.client === connection.client;
    try {
      return await this.trackRequest(connection.client, operation(connection));
    } catch (error) {
      // An HTTP server that cannot be reached any more: the connection is
      // gone, so say so and reconnect on schedule. The call itself is not
      // replayed; whether it ran is unknown.
      if (connection.transport !== "stdio" && isTransientNetworkError(error) && stillCurrent()) {
        this.handleConnectionLost(serverName, slot, epoch, describeError(error));
        throw error;
      }
      if (connection.transport !== "streamable-http" || !isMcpSessionExpired(error)) {
        throw error;
      }
      // Compared by record, a relist made the recovery think someone else
      // had reconnected already, and the operation was replayed on the
      // expired session.
      if (stillCurrent()) {
        await this.renewExpiredSession(serverName, slot);
      } else {
        await slot.reinitializing;
      }
      if (!slot.connection || slot.state !== "connected") {
        throw error;
      }
      return this.trackRequest(slot.connection.client, operation(slot.connection));
    }
  }

  private trackRequest<T>(client: Client, request: Promise<T>): Promise<T> {
    let requests = this.requestsInFlight.get(client);
    if (!requests) {
      requests = new Set();
      this.requestsInFlight.set(client, requests);
    }
    requests.add(request);
    const settled = () => requests.delete(request);
    request.then(settled, settled);
    return request;
  }

  // The server forgot the session, so every other request in flight on it
  // gets a 404 too, and replays itself: a 404 means it never ran. Closing the
  // client at once failed those requests instead ("Connection closed"), and a
  // request that did run cannot be told apart, so the old client is closed
  // once they all have their answers. Each is bounded by toolTimeoutMs.
  private renewExpiredSession(serverName: string, slot: ServerSlot): Promise<void> {
    const client = slot.connection?.client;
    const answered = client ? Promise.allSettled(this.requestsInFlight.get(client) ?? []) : undefined;
    return this.reinitialize(serverName, slot, answered);
  }

  private async requireReadySlot(serverName: string): Promise<ServerSlot & { connection: LiveConnection }> {
    let slot = this.slots.get(serverName);
    if (!slot) {
      throw new Error(this.describeMissingServer(serverName));
    }
    // A reload can replace the slot while we wait, so look again after each
    // wait. A slot being reconnected (reconnect(), an expired session) is
    // waited for too, rather than refused for its moment without a connection.
    while (slot.reinitializing || (slot.state === "connecting" && slot.connecting)) {
      await (slot.reinitializing ?? slot.connecting);
      const current = this.slots.get(serverName);
      if (!current) {
        throw new Error(this.describeMissingServer(serverName));
      }
      slot = current;
    }
    if (slot.state !== "connected" || !slot.connection) {
      throw new Error(
        `MCP server "${serverName}" is not connected (state: ${slot.state})${slot.error ? `: ${slot.error.message}` : "."}`
      );
    }
    return slot as ServerSlot & { connection: LiveConnection };
  }

  private describeMissingServer(serverName: string): string {
    if (this.untrusted?.entries.some((entry) => entry.name === serverName)) {
      return `MCP server "${serverName}" was declared by ${this.untrusted.configPath}, which has not been trusted, so it was not started. Run \`aia trust\` in that workspace to review it.`;
    }
    return `No MCP server named "${serverName}" is registered.`;
  }

  // Abandons the slot's current connection (and any pending retry) without
  // treating it as a crash: the epoch moves on first, so the close event that
  // follows is ignored.
  private async releaseSlot(slot: ServerSlot, closeClientWhen?: Promise<unknown>): Promise<void> {
    slot.epoch += 1;
    if (slot.reconnectTimer) {
      clearTimeout(slot.reconnectTimer);
      slot.reconnectTimer = undefined;
    }
    clearTimeout(slot.relistTimer);
    slot.relistTimer = undefined;
    const client = slot.connection?.client;
    slot.connection = undefined;
    slot.connecting = undefined;
    if (client && closeClientWhen) {
      this.drainingClients.add(client);
      void closeClientWhen.then(() => this.closeDrainedClient(client));
      return;
    }
    await client?.close().catch(() => undefined);
  }

  private async closeDrainedClient(client: Client): Promise<void> {
    if (this.drainingClients.delete(client)) {
      await client.close().catch(() => undefined);
    }
  }

  // Every slot that leaves the map is released at once, which moves its
  // epoch on, so the epoch alone tells a stale attempt or event.
  private isStale(slot: ServerSlot, epoch: number): boolean {
    return slot.epoch !== epoch;
  }

  // Every server's status, built only for a listener: it runs on each
  // server's every transition, and most hosts listen to server_updated alone.
  private emitStatusesChanged(): void {
    if (this.listenerCount("statuses_changed") > 0) {
      this.emit("statuses_changed", { statuses: this.getServerStatuses() });
    }
  }

  private notifyChanged(serverName: string, slot: ServerSlot, previousState: ServerSlot["state"]): void {
    if (this.closed) {
      return;
    }
    // Called from background connects and close events: a listener that
    // throws must not become an unhandled rejection or stop the others.
    try {
      this.emit("server_updated", { previousState, status: buildStatus(serverName, slot) });
      this.emitStatusesChanged();
    } catch (error) {
      console.warn(
        `[AIA_MCP_LISTENER_FAILED] A listener for MCP server updates threw: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private rebuildCatalog(): void {
    this.catalog = new MCPCapabilityCatalog([
      ...Array.from(this.slots.values()).flatMap((slot) =>
        slot.state === "connected" ? (slot.connection?.capabilities ?? []) : []
      ),
      ...buildTemplateCapabilities(this.templateDefinitions)
    ]);
    this.generation += 1;
  }

  private listConnectedServerNames() {
    return Array.from(this.slots.entries())
      .filter(([, slot]) => slot.state === "connected")
      .map(([name]) => name)
      .sort((left, right) => left.localeCompare(right));
  }

  private async syncWatchers(): Promise<void> {
    if (this.closed) {
      return;
    }
    const watchTargets = new Map<string, string>();
    for (const filePath of [
      ...(this.configPaths?.globalConfigPaths ?? []),
      this.configPaths?.workspaceConfigPath,
      // A grant or revoke changes which workspace servers may start, so the
      // trust store is watched like a config file.
      this.configPaths ? configTrustFilePath(this.configPaths.userStateDirectory) : undefined,
      // `aia mcp login` in another terminal: servers waiting on a login retry.
      this.oauthStore?.filePath,
      ...this.importedFiles
    ]) {
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
      // A sign-in elsewhere changes no config: only servers waiting on one
      // are tried again. It used to reload everything and retry every failed
      // server, on every token refresh any session wrote.
      const onChange =
        target === this.oauthStore?.filePath ? () => this.scheduleLoginRetry() : () => this.scheduleReload();
      try {
        const watcher = fs.watch(directory, { persistent: false }, (_eventType, fileName) => {
          if (fileName && fileName.toString() !== basename) {
            return;
          }
          onChange();
        });
        this.watchers.set(target, watcher);
      } catch {
        // The target's directory may not exist yet (e.g. a not-yet-created
        // workspace or user config dir). Watching is best-effort, so skip this
        // target rather than failing initialization; a later refresh re-attempts.
      }
    }
  }

  private scheduleLoginRetry(): void {
    if (this.closed) {
      return;
    }
    if (this.loginRetryTimer) {
      clearTimeout(this.loginRetryTimer);
    }
    this.loginRetryTimer = setTimeout(() => {
      this.loginRetryTimer = null;
      for (const [serverName, slot] of this.slots) {
        if (!this.closed && slot.state === "needs_login") {
          slot.reconnectAttempts = 0;
          void this.startConnect(serverName, slot);
        }
      }
    }, 150);
    this.loginRetryTimer.unref?.();
  }

  private scheduleReload(): void {
    if (!this.reloadConfig || this.closed) {
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
    oauthStore: new McpCredentialsStore(mcpCredentialsFilePath(params.loaded.paths.userStateDirectory)),
    reloadConfig: async () =>
      loadAIAgentConfig({
        cwd: params.cwd,
        env: params.env,
        userHomeDirectory: params.userHomeDirectory,
        // Said once, at startup. A reload on every config or trust-store
        // write repeated it; what was withheld shows in /mcp as `untrusted`.
        warnWhenUntrusted: false
      }),
    untrusted: untrustedMcpServersFromLoaded(params.loaded),
    watch: params.watch
  });
}

function buildStatus(serverName: string, slot: ServerSlot): MCPServerStatus {
  return mcpServerStatusSchema.parse({
    capabilities: slot.connection?.counts ?? { prompts: 0, resourceTemplates: 0, resources: 0, tools: 0 },
    checkedAt: new Date().toISOString(),
    ...(slot.error ? { error: slot.error } : {}),
    ...(slot.connection?.instructions ? { instructions: slot.connection.instructions } : {}),
    ...(slot.lastConnectedAt ? { lastConnectedAt: slot.lastConnectedAt } : {}),
    serverName,
    state: slot.state,
    transport: slot.connection?.transport ?? slot.config.type
  });
}

/** One server's status with the tools it exposes, for the model and the operator. */
/** A server's state without its tools or instructions, as the `mcp.updated` event carries it. */
export function summarizeServerUpdate(status: MCPServerStatus): MCPServerUpdate {
  // Spread optional fields in conditionally rather than assigning possibly
  // undefined values: zod keeps a key that was handed an explicit undefined,
  // and a summary carrying one cannot be serialized as a JsonValue when it
  // travels out on an event.
  return {
    capabilities: status.capabilities,
    ...(status.error?.message ? { error: status.error.message, errorCode: status.error.code } : {}),
    ...(status.lastConnectedAt ? { lastConnectedAt: status.lastConnectedAt } : {}),
    serverName: status.serverName,
    state: status.state,
    transport: status.transport
  };
}

export function summarizeStatus(status: MCPServerStatus, tools: MCPToolCapability[]): MCPServerSummary {
  return mcpServerSummarySchema.parse({
    ...summarizeServerUpdate(status),
    ...(status.instructions ? { instructions: status.instructions } : {}),
    tools: tools
      .filter((tool) => tool.serverName === status.serverName)
      .map((tool) => ({
        ...(tool.description ? { description: tool.description } : {}),
        invocationName: tool.invocationName,
        name: tool.name
      }))
      .sort((left, right) => left.invocationName.localeCompare(right.invocationName))
  });
}

function describeError(error: unknown): string {
  const code = readNetworkErrorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return code && !message.includes(code) ? `${message} (${code})` : message;
}

function describeConnectFailure(
  serverName: string,
  failure: unknown,
  connectedStdio: ProcessGroupStdioClientTransport | undefined
): StructuredError {
  const stdio = connectedStdio ?? (failure instanceof McpStdioConnectError ? failure.stdio : undefined);
  const error = failure instanceof McpStdioConnectError ? failure.cause : failure;
  // The OAuth provider only runs for a server signed in (or configured) for
  // OAuth, so these mean a sign-in is needed or has lapsed.
  if (isMcpLoginRequiredError(error)) {
    return {
      code: MCP_NEEDS_LOGIN_ERROR_CODE,
      details: {},
      message: `MCP server "${serverName}" needs you to sign in: run \`aia mcp login ${serverName}\`.`,
      retriable: false
    };
  }
  // A plain 401 could be either: a server that wants OAuth, or a credential
  // header in config that is wrong.
  if (isMcpAuthorizationError(error)) {
    return {
      code: MCP_NEEDS_LOGIN_ERROR_CODE,
      details: {},
      message: `MCP server "${serverName}" refused the connection as unauthorized (401). If it uses OAuth, sign in with \`aia mcp login ${serverName}\`; otherwise check the credentials in its headers.`,
      retriable: false
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const exit = stdio?.exitStatus ? ` (${describeStdioExit(stdio)})` : "";
  return {
    code: "mcp_connection_error",
    details: { name: error instanceof Error ? error.name : "Error" },
    message: `${message}${exit}`,
    retriable: true
  };
}

/** "exited with code 1; stderr: …" from what the stdio transport saw. */
function describeStdioExit(stdio: ProcessGroupStdioClientTransport): string {
  const exit = stdio.exitStatus;
  const how = !exit
    ? "the process closed its output"
    : exit.signal
      ? `the process was stopped by ${exit.signal}`
      : `the process exited with code ${exit.code ?? "unknown"}`;
  const tail = stdio.recentStderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-STDERR_TAIL_LINES)
    .join(" | ");
  return tail ? `${how}; last stderr: ${tail}` : how;
}

function buildTemplateCapabilities(templates: Record<string, AppConfig["mcp"]["templates"][string]>): MCPCapability[] {
  return Object.entries(templates).map(([templateId, template]) => ({
    access: "api_only" as const,
    annotations: {},
    bootstrap: template.bootstrap,
    description: template.description,
    displayName: template.displayName,
    id: `mcp.server-template.${toMcpIdSegment(templateId)}`,
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

function buildUntrustedServerStatus(entry: TrustGatedMcpEntry, configPath: string): MCPServerStatus {
  return mcpServerStatusSchema.parse({
    capabilities: {
      prompts: 0,
      resourceTemplates: 0,
      resources: 0,
      tools: 0
    },
    checkedAt: new Date().toISOString(),
    error: {
      code: "mcp_server_untrusted",
      details: { configPath },
      message:
        `Declared by ${configPath}, which has not been trusted, so it was not started. ` +
        "Run `aia trust` in that workspace to review what it would run, then grant trust if you agree.",
      retriable: false
    },
    serverName: entry.name,
    state: "untrusted",
    transport: resolveDeclaredTransport(entry)
  });
}

// The transport an untrusted entry would have used, for display only. An
// override that sets neither a command nor a url has none of its own.
function resolveDeclaredTransport(entry: TrustGatedMcpEntry): MCPServerStatus["transport"] {
  const declared = mcpTransportTypeSchema.safeParse(entry.transport);
  if (declared.success) {
    return declared.data;
  }
  return entry.command ? "stdio" : "auto";
}

function defaultInstalledServerName(templateId: string): string {
  return templateId.replace(/[^A-Za-z0-9_-]+/g, "_");
}
