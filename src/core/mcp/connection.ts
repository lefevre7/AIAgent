import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ListChangedHandlers } from "@modelcontextprotocol/sdk/types.js";

import { materializeSecretRecord, type AppConfig } from "@/core/config";
import { createMcpFetch, retryTransientMcpFailures } from "@/core/mcp/http";
import { StoredMcpOAuthProvider, type McpCredentialsStore, type McpOAuthSettings } from "@/core/mcp/oauth";
import { createStdioClientTransport, ProcessGroupStdioClientTransport } from "@/core/mcp/stdio-transport";
import { readPackageVersion } from "@/core/package-info";
import { buildChildProcessEnvironment } from "@/core/process/environment";

export type McpServerConfig = AppConfig["mcp"]["servers"][string];
export type McpTransportKind = "sse" | "stdio" | "streamable-http";

export const DEFAULT_MCP_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_MCP_TOOL_TIMEOUT_MS = 300_000;

/** The per-phase connect budget (Codex's 30 s), with `timeoutMs` as the older spelling. */
export function resolveStartupTimeoutMs(config: McpServerConfig): number {
  return config.startupTimeoutMs ?? config.timeoutMs ?? DEFAULT_MCP_STARTUP_TIMEOUT_MS;
}

/** How long a tool call may go without progress (Codex's 300 s). */
export function resolveToolTimeoutMs(config: McpServerConfig): number {
  return config.toolTimeoutMs ?? config.timeoutMs ?? DEFAULT_MCP_TOOL_TIMEOUT_MS;
}

export type McpConnection = {
  client: Client;
  /** The stdio transport, for the server's stderr tail and exit status. */
  stdio?: ProcessGroupStdioClientTransport;
  transport: McpTransportKind;
};

export type ConnectMcpClientParams = {
  /** Registers request handlers (elicitation) on each client before it connects. */
  configureClient?: (client: Client) => void;
  /** Advertise elicitation (form and URL) to the server. */
  elicitation: boolean;
  fetchImpl: typeof fetch;
  /** `mcp.passEnv`: variables every stdio server gets. */
  globalPassEnv: readonly string[];
  listChanged?: ListChangedHandlers;
  /** Where OAuth tokens live; without it no OAuth is attempted. */
  oauthStore?: McpCredentialsStore;
  serverConfig: McpServerConfig;
  serverName: string;
};

/**
 * Starts (stdio) or reaches (HTTP) one MCP server and runs the handshake,
 * within the server's startup budget. An HTTP handshake that fails
 * transiently (a network error, 408, 429, 5xx) is tried again after 250 ms and
 * after 1 s, each time with a fresh client, since a failed connect closes its
 * client.
 */
export async function connectMcpClient(params: ConnectMcpClientParams): Promise<McpConnection> {
  const timeout = resolveStartupTimeoutMs(params.serverConfig);
  const config = params.serverConfig;

  if (config.type === "stdio") {
    const stdio = createStdioClientTransport({
      args: config.args,
      command: config.command,
      cwd: config.cwd,
      env: buildChildProcessEnvironment({
        env: materializeSecretRecord(config.env, `MCP server "${params.serverName}"`, "env value"),
        passEnv: [...params.globalPassEnv, ...(config.passEnv ?? [])]
      }),
      stderr: config.stderr
    });
    const client = newMcpClient(params);
    try {
      await connectOrClose(client, stdio, timeout);
    } catch (error) {
      // The process may have started and died during the handshake: its exit
      // code and stderr are the explanation, and the transport holds them.
      throw stdio instanceof ProcessGroupStdioClientTransport ? new McpStdioConnectError(error, stdio) : error;
    }
    return {
      client,
      ...(stdio instanceof ProcessGroupStdioClientTransport ? { stdio } : {}),
      transport: "stdio"
    };
  }

  const headers = materializeSecretRecord(config.headers, `MCP server "${params.serverName}"`, "header");
  warnIfInsecureMcpUrl(params.serverName, config.url);
  const mcpFetch = createMcpFetch({ fetchImpl: params.fetchImpl, headers, serverUrl: config.url });
  // OAuth only for a server signed in with `aia mcp login`, or configured for
  // it, and never over an Authorization header from config (as in Codex). A
  // server using an API key header must not be sent through OAuth discovery
  // when its key is wrong.
  const hasAuthorizationHeader = Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
  const useOAuth =
    params.oauthStore !== undefined &&
    !hasAuthorizationHeader &&
    (config.oauth !== undefined ||
      (await params.oauthStore.get(params.serverName, config.url).catch(warnUnreadableCredentials)) !== undefined);
  const authProvider =
    useOAuth && params.oauthStore
      ? new StoredMcpOAuthProvider({
          interactive: false,
          serverName: params.serverName,
          serverUrl: config.url,
          settings: materializeOAuthSettings(config.oauth, params.serverName),
          store: params.oauthStore
        })
      : undefined;
  const url = new URL(config.url);
  // For SSE the SDK derives the EventSource's fetch from `fetch` too, so the
  // headers and the redirect rules reach the stream as well as the POSTs.
  const transportOptions = { fetch: mcpFetch, ...(authProvider ? { authProvider } : {}) };
  const connectOver = (createTransport: () => Transport) =>
    retryTransientMcpFailures(async () => {
      const client = newMcpClient(params);
      await connectOrClose(client, createTransport(), timeout);
      return client;
    });
  const connectStreamable = () => connectOver(() => new StreamableHTTPClientTransport(url, transportOptions));
  const connectSse = () => connectOver(() => new SSEClientTransport(url, transportOptions));

  if (config.type === "sse") {
    return { client: await connectSse(), transport: "sse" };
  }
  if (config.type === "streamable-http") {
    return { client: await connectStreamable(), transport: "streamable-http" };
  }
  try {
    return { client: await connectStreamable(), transport: "streamable-http" };
  } catch (error) {
    if (!shouldFallbackToSse(error)) {
      throw error;
    }
    return { client: await connectSse(), transport: "sse" };
  }
}

const warnedCredentialErrors = new Set<string>();

// A credentials file that cannot be used (a symlink, no permission) means no
// sign-in for any server: said once per reason, never silently.
function warnUnreadableCredentials(error: unknown): undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (!warnedCredentialErrors.has(message)) {
    warnedCredentialErrors.add(message);
    console.warn(`[AIA_MCP_CREDENTIALS_UNREADABLE] ${message} MCP sign-ins are not used until it is fixed.`);
  }
  return undefined;
}

/** A stdio server that failed to connect, with the transport that saw how its process ended. */
export class McpStdioConnectError extends Error {
  constructor(
    cause: unknown,
    readonly stdio: ProcessGroupStdioClientTransport
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "McpStdioConnectError";
  }

  /** Whether the process started and then exited, as opposed to never starting (ENOENT). */
  get crashed(): boolean {
    return this.stdio.exitStatus !== undefined;
  }
}

export function shouldFallbackToSse(error: unknown): boolean {
  // Per the MCP Streamable-HTTP backwards-compatibility flow, only fall back to
  // the legacy SSE transport when the server rejects the initialize POST with a
  // 4xx (i.e. it does not speak Streamable HTTP) — excluding auth failures
  // (401/403), which mean bad credentials rather than the wrong transport. Any
  // other failure (network, TLS, timeout, 5xx) surfaces as-is instead of being
  // masked by a second, misleading SSE connection error.
  return (
    error instanceof StreamableHTTPError &&
    typeof error.code === "number" &&
    error.code >= 400 &&
    error.code < 500 &&
    error.code !== 401 &&
    error.code !== 403
  );
}

/** The clientInfo servers see: aia and its real version. */
export function newMcpClient(params: Pick<ConnectMcpClientParams, "configureClient" | "elicitation" | "listChanged">) {
  const client = new Client(
    { name: "aia", title: "AIAgent", version: readPackageVersion() },
    {
      capabilities: params.elicitation ? { elicitation: { form: {}, url: {} } } : {},
      ...(params.listChanged ? { listChanged: params.listChanged } : {})
    }
  );
  params.configureClient?.(client);
  return client;
}

async function connectOrClose(client: Client, transport: Transport, timeout: number): Promise<void> {
  // The SDK's timeout covers the initialize request, not the transport's
  // start: an SSE server that accepts the stream but never sends its endpoint
  // event held the connect (and a required server, startup) forever.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Did not finish connecting within ${timeout} ms (startupTimeoutMs).`)),
      timeout
    );
  });
  try {
    await Promise.race([client.connect(transport, { timeout }), timedOut]);
  } catch (error) {
    // Close the transport (and any spawned child process) so a failed connect
    // does not leak resources; then surface the original error.
    await client.close().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function materializeOAuthSettings(
  settings: Extract<McpServerConfig, { type: "auto" | "sse" | "streamable-http" }>["oauth"],
  serverName: string
): McpOAuthSettings | undefined {
  if (!settings) {
    return undefined;
  }
  if (settings.clientSecret !== undefined && typeof settings.clientSecret !== "string") {
    throw new Error(
      `MCP server "${serverName}" has an unresolved secret-backed oauth.clientSecret. Use resolvedConfig.`
    );
  }
  return {
    ...(settings.callbackPort ? { callbackPort: settings.callbackPort } : {}),
    ...(settings.clientId ? { clientId: settings.clientId } : {}),
    ...(typeof settings.clientSecret === "string" ? { clientSecret: settings.clientSecret } : {}),
    ...(settings.scopes ? { scopes: settings.scopes } : {})
  };
}

const warnedInsecureUrls = new Set<string>();

/**
 * Plain http to anything but this machine sends the server's headers (an API
 * key) and every tool call in clear text. Allowed, because a server on a
 * private network may have nothing else, but said once per server and URL.
 */
function warnIfInsecureMcpUrl(serverName: string, rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`MCP server "${serverName}" has an invalid URL: ${rawUrl}`);
  }
  // Imported servers do not pass through the config schema, which checks this too.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`MCP server "${serverName}" must be reached over http:// or https://, not ${url.protocol}`);
  }
  if (url.protocol !== "http:" || isLoopbackHostname(url.hostname)) {
    return;
  }
  const key = `${serverName}\u0000${rawUrl}`;
  if (warnedInsecureUrls.has(key)) {
    return;
  }
  warnedInsecureUrls.add(key);
  process.emitWarning(
    `MCP server "${serverName}" is reached over plain http (${url.origin}), so its headers and every tool call ` +
      "travel unencrypted. Use https unless the network between you is trusted.",
    { code: "AIA_MCP_INSECURE_URL" }
  );
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127(?:\.\d{1,3}){3}$/u.test(host);
}
