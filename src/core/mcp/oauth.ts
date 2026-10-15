import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";

import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { withFileLock, writeJsonAtomic } from "@/core/io/files";
import { createMcpFetch } from "@/core/mcp/http";

export const MCP_CREDENTIALS_FILE_NAME = "mcp-credentials.json";
const CREDENTIALS_FILE_VERSION = 1;
const LOGIN_TIMEOUT_MS = 300_000;
const CALLBACK_HOST = "127.0.0.1";

/** The OAuth settings of one HTTP MCP server (`mcp.servers.<name>.oauth`, secrets resolved). */
export type McpOAuthSettings = {
  callbackPort?: number;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
};

type StoredServerCredentials = {
  clientInformation?: OAuthClientInformationMixed;
  discoveryState?: OAuthDiscoveryState;
  redirectUrl?: string;
  serverName: string;
  serverUrl: string;
  tokens?: OAuthTokens;
  updatedAt: string;
};

type CredentialsFile = {
  servers: Record<string, StoredServerCredentials>;
  version: number;
};

export function mcpCredentialsFilePath(userStateDirectory: string): string {
  return path.join(userStateDirectory, MCP_CREDENTIALS_FILE_NAME);
}

/**
 * OAuth tokens and client registrations for MCP servers, in
 * `~/.aia/mcp-credentials.json`.
 *
 * Written with mode 0600, and refused when the path is a symlink or not a
 * regular file, so another local user or a planted link cannot read or
 * redirect the tokens. Entries are keyed by server name and a hash of its
 * URL: pointing a server name at a different URL does not hand it the old
 * server's tokens. Whatever the SDK stamps on a token or registration (the
 * authorization server it came from) is stored unchanged, which is what lets
 * the SDK refuse to present a refresh token to a different issuer.
 */
export class McpCredentialsStore {
  // The file as last parsed, while its mtime and size say it is unchanged:
  // tokens are read on every request a session makes.
  private cache: { file: CredentialsFile; mtimeMs: number; size: number } | undefined;
  // Updates from this process, one at a time (the lock covers other processes).
  private updates: Promise<unknown> = Promise.resolve();
  private warnedUnreadable = false;

  constructor(readonly filePath: string) {}

  async get(serverName: string, serverUrl: string): Promise<StoredServerCredentials | undefined> {
    return (await this.readForLookup()).servers[credentialsKey(serverName, serverUrl)];
  }

  /**
   * Changes one server's entry. Read, changed and written under a lock, so
   * two writers (a session refreshing a token while `aia mcp login` runs in
   * another terminal) cannot drop each other's change.
   */
  async update(
    serverName: string,
    serverUrl: string,
    change: (current: StoredServerCredentials) => StoredServerCredentials
  ): Promise<void> {
    await this.exclusively(async () => {
      const file = await this.readForUpdate();
      const key = credentialsKey(serverName, serverUrl);
      const next = change(file.servers[key] ?? { serverName, serverUrl, updatedAt: new Date().toISOString() });
      file.servers[key] = { ...next, updatedAt: new Date().toISOString() };
      await this.write(file);
    });
  }

  /** Puts one server's entry back as it was (`undefined`: absent), as a failed login must. */
  async restore(serverName: string, serverUrl: string, previous: StoredServerCredentials | undefined): Promise<void> {
    await this.exclusively(async () => {
      const file = await this.readForUpdate();
      const key = credentialsKey(serverName, serverUrl);
      if (previous) {
        file.servers[key] = previous;
      } else {
        delete file.servers[key];
      }
      await this.write(file);
    });
  }

  /** Removes everything stored for `serverName`, whatever its URL. */
  async remove(serverName: string): Promise<boolean> {
    return this.exclusively(async () => {
      const file = await this.readForUpdate();
      const keys = Object.keys(file.servers).filter((key) => file.servers[key]?.serverName === serverName);
      for (const key of keys) {
        delete file.servers[key];
      }
      if (keys.length > 0) {
        await this.write(file);
      }
      return keys.length > 0;
    });
  }

  async hasTokens(serverName: string, serverUrl: string): Promise<boolean> {
    return Boolean((await this.get(serverName, serverUrl))?.tokens?.access_token);
  }

  private exclusively<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.updates.then(() => withFileLock(`${this.filePath}.lock`, operation));
    this.updates = run.catch(() => undefined);
    return run;
  }

  /**
   * For a lookup: a file that cannot be parsed is warned about once and read
   * as empty, so the servers report needing a sign-in rather than every
   * session failing on it.
   */
  private async readForLookup(): Promise<CredentialsFile> {
    try {
      return await this.read();
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      if (!this.warnedUnreadable) {
        this.warnedUnreadable = true;
        console.warn(
          `[AIA_MCP_CREDENTIALS_UNREADABLE] ${this.filePath} could not be parsed (${error.message}), so no MCP sign-in is used. The next \`aia mcp login\` moves it aside and starts a new one.`
        );
      }
      return emptyCredentials();
    }
  }

  /**
   * For a change: a file that cannot be parsed is moved aside (kept, for the
   * operator to look at) and a new one begun. A corrupt file used to make
   * every login fail until someone deleted it by hand.
   */
  private async readForUpdate(): Promise<CredentialsFile> {
    try {
      return await this.read();
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      const aside = `${this.filePath}.corrupt-${new Date().toISOString().replace(/[:.]/gu, "-")}`;
      await fs.rename(this.filePath, aside);
      this.cache = undefined;
      console.warn(`[AIA_MCP_CREDENTIALS_UNREADABLE] ${this.filePath} could not be parsed; moved it to ${aside}.`);
      return emptyCredentials();
    }
  }

  private async read(): Promise<CredentialsFile> {
    const stat = await fs.lstat(this.filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (!stat) {
      this.cache = undefined;
      return emptyCredentials();
    }
    assertRegularFile(this.filePath, stat);
    if (this.cache && this.cache.mtimeMs === stat.mtimeMs && this.cache.size === stat.size) {
      return structuredClone(this.cache.file);
    }
    const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8")) as Partial<CredentialsFile>;
    const file: CredentialsFile = {
      servers: typeof parsed.servers === "object" && parsed.servers !== null ? parsed.servers : {},
      version: CREDENTIALS_FILE_VERSION
    };
    this.cache = { file: structuredClone(file), mtimeMs: stat.mtimeMs, size: stat.size };
    return file;
  }

  private async write(file: CredentialsFile): Promise<void> {
    const stat = await fs.lstat(this.filePath).catch(() => null);
    if (stat) {
      assertRegularFile(this.filePath, stat);
    }
    this.cache = undefined;
    if (Object.keys(file.servers).length === 0) {
      await fs.rm(this.filePath, { force: true });
      return;
    }
    await writeJsonAtomic(this.filePath, file, { mode: 0o600 });
  }
}

function emptyCredentials(): CredentialsFile {
  return { servers: {}, version: CREDENTIALS_FILE_VERSION };
}

function assertRegularFile(filePath: string, stat: { isFile(): boolean; isSymbolicLink(): boolean }): void {
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to use ${filePath}: it is a symbolic link. MCP credentials must be a regular file.`);
  }
  if (!stat.isFile()) {
    throw new Error(`Refusing to use ${filePath}: it is not a regular file.`);
  }
}

function credentialsKey(serverName: string, serverUrl: string): string {
  return `${serverName}|${crypto.createHash("sha256").update(serverUrl).digest("hex").slice(0, 16)}`;
}

/**
 * The callback path for one server: `/callback/<id>`, where the id is a hash
 * of the server's URL. An authorization code delivered for one server's login
 * cannot complete another's (Codex does the same).
 */
export function mcpOAuthCallbackPath(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.hash = "";
  return `/callback/${crypto.createHash("sha256").update(url.toString()).digest("base64url").slice(0, 12)}`;
}

/** Thrown when a server needs a login that only `aia mcp login` can do. */
export class McpLoginRequiredError extends Error {
  constructor(readonly serverName: string) {
    super(`The MCP server "${serverName}" needs you to sign in. Run \`aia mcp login ${serverName}\`.`);
    this.name = "McpLoginRequiredError";
  }
}

/**
 * Whether a connect failed for want of a sign-in. Our provider says so with
 * McpLoginRequiredError; the SDK's one remaining case (a stored client bound
 * to another authorization server, which a session may not re-register) is a
 * plain Error, recognized by its exact opening words rather than a loose
 * pattern that could match some unrelated "bound to" message.
 */
export function isMcpLoginRequiredError(error: unknown): boolean {
  return (
    error instanceof McpLoginRequiredError ||
    (error instanceof Error && error.message.startsWith("OAuth client information is bound to authorization server "))
  );
}

/**
 * The SDK's OAuth hooks, backed by the credentials store.
 *
 * In a running session (`interactive: false`) it presents stored tokens and
 * refreshes them, but never registers a client or starts a browser login: a
 * server that needs one fails with `McpLoginRequiredError`, which the manager
 * reports as `needs_login`. `aia mcp login` uses `interactive: true`.
 */
export class StoredMcpOAuthProvider implements OAuthClientProvider {
  private verifier: string | undefined;
  private expectedState: string | undefined;
  saveClientInformation?: (clientInformation: OAuthClientInformationMixed) => Promise<void>;

  constructor(
    private readonly params: {
      interactive: boolean;
      onAuthorizationUrl?: (url: URL) => Promise<void> | void;
      redirectUrl?: string;
      serverName: string;
      serverUrl: string;
      settings?: McpOAuthSettings;
      store: McpCredentialsStore;
    }
  ) {
    if (params.interactive) {
      // Dynamic client registration, only while the operator is logging in.
      // The SDK also calls this to bind a client to the authorization server
      // it was first used with. For a client from config, only that binding
      // (its id and issuer) is kept: its secret stays where the operator keeps
      // it (the config, a Keychain lookup) instead of landing in this file.
      this.saveClientInformation = async (clientInformation) => {
        const configuredClientId = this.params.settings?.clientId;
        const record =
          configuredClientId && clientInformation.client_id === configuredClientId
            ? {
                client_id: configuredClientId,
                ...(typeof clientInformation.issuer === "string" ? { issuer: clientInformation.issuer } : {})
              }
            : clientInformation;
        await this.params.store.update(this.params.serverName, this.params.serverUrl, (current) => ({
          ...current,
          clientInformation: record
        }));
      };
    }
  }

  get redirectUrl(): string {
    // Must never be empty: the SDK takes a missing redirect URL to mean a
    // machine-to-machine (client credentials) flow.
    return (
      this.params.redirectUrl ??
      `http://${CALLBACK_HOST}:${this.params.settings?.callbackPort ?? 0}${mcpOAuthCallbackPath(this.params.serverUrl)}`
    );
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "aia",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [this.redirectUrl],
      response_types: ["code"],
      token_endpoint_auth_method: this.params.settings?.clientSecret ? "client_secret_post" : "none",
      ...(this.params.settings?.scopes?.length ? { scope: this.params.settings.scopes.join(" ") } : {})
    };
  }

  state(): string {
    this.expectedState = crypto.randomBytes(16).toString("base64url");
    return this.expectedState;
  }

  /** The state the authorization request carried, to check the callback against. */
  get pendingState(): string | undefined {
    return this.expectedState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const clientId = this.params.settings?.clientId;
    if (clientId) {
      // The configured client, plus the authorization server it was bound to
      // at sign-in, so the SDK refuses to present it anywhere else.
      const stored = (await this.stored())?.clientInformation;
      const issuer = stored?.client_id === clientId && typeof stored.issuer === "string" ? stored.issuer : undefined;
      return {
        client_id: clientId,
        ...(this.params.settings?.clientSecret ? { client_secret: this.params.settings.clientSecret } : {}),
        ...(issuer ? { issuer } : {})
      };
    }
    const stored = (await this.stored())?.clientInformation;
    if (!stored && !this.params.interactive) {
      // With no client, the SDK would register one next, which only `aia mcp
      // login` may do. Said here, as our own error, rather than by the
      // SDK's plain one about saving client information.
      throw new McpLoginRequiredError(this.params.serverName);
    }
    // A login listens on a new port each time (unless callbackPort is set),
    // and a client registered for another callback is refused by an
    // authorization server that checks redirect URIs exactly: register again.
    const registeredFor = (stored as { redirect_uris?: unknown } | undefined)?.redirect_uris;
    if (this.params.interactive && Array.isArray(registeredFor) && !registeredFor.includes(this.redirectUrl)) {
      return undefined;
    }
    return stored;
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.stored())?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    await this.params.store.update(this.params.serverName, this.params.serverUrl, (current) => ({
      ...current,
      ...(this.params.interactive ? { redirectUrl: this.redirectUrl } : {}),
      tokens
    }));
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.params.interactive || !this.params.onAuthorizationUrl) {
      throw new McpLoginRequiredError(this.params.serverName);
    }
    await this.params.onAuthorizationUrl(authorizationUrl);
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) {
      throw new Error("No OAuth login is in progress.");
    }
    return this.verifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    await this.params.store.update(this.params.serverName, this.params.serverUrl, (current) => ({
      ...current,
      discoveryState: state
    }));
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.stored())?.discoveryState;
  }

  async invalidateCredentials(scope: "all" | "client" | "discovery" | "tokens" | "verifier"): Promise<void> {
    if (scope === "verifier") {
      this.verifier = undefined;
      return;
    }
    await this.params.store.update(this.params.serverName, this.params.serverUrl, (current) => {
      const next = { ...current };
      if (scope === "all" || scope === "tokens") {
        delete next.tokens;
      }
      if (scope === "all" || scope === "client") {
        delete next.clientInformation;
      }
      if (scope === "all" || scope === "discovery") {
        delete next.discoveryState;
      }
      return next;
    });
  }

  private async stored(): Promise<StoredServerCredentials | undefined> {
    return this.params.store.get(this.params.serverName, this.params.serverUrl);
  }
}

/**
 * Signs in to an HTTP MCP server with OAuth (`aia mcp login <name>`): the
 * authorization server is discovered from the server, aia registers itself as
 * a client when the server supports dynamic registration (or uses the
 * configured `oauth.clientId`), and the operator approves in a browser. PKCE
 * protects the code; the callback listens on 127.0.0.1 only, on a path unique
 * to this server, for up to five minutes. The tokens go to the credentials
 * store, where running sessions pick them up.
 */
export async function loginToMcpServer(params: {
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  /** Opens the browser; when absent (`--no-browser`) only `onAuthorizationUrl` sees the URL. */
  openBrowser?: (url: string) => Promise<void>;
  onAuthorizationUrl: (url: string) => void;
  /** Told that a pasted line is not this sign-in's callback address; gets the address it starts with. */
  onPastedLineIgnored?: (expected: string) => void;
  /**
   * Lines the operator pastes, as another way to finish (a browser on another
   * machine): the first that is this sign-in's callback address is used.
   */
  pastedLines?: AsyncIterable<string>;
  serverName: string;
  serverUrl: string;
  settings?: McpOAuthSettings;
  store: McpCredentialsStore;
  timeoutMs?: number;
}): Promise<void> {
  const callbackPath = mcpOAuthCallbackPath(params.serverUrl);
  const fetchFn = createMcpFetch({
    fetchImpl: params.fetchImpl ?? fetch,
    headers: params.headers,
    serverUrl: params.serverUrl
  });
  const callback = await startCallbackListener(callbackPath, params.settings?.callbackPort);
  const redirectUrl = `http://${CALLBACK_HOST}:${callback.port}${callbackPath}`;
  // What was stored before, put back if this attempt fails: a registration
  // made for a login that never finished is not left behind.
  const before = await params.store.get(params.serverName, params.serverUrl);
  let finished = false;
  try {
    const provider = new StoredMcpOAuthProvider({
      interactive: true,
      onAuthorizationUrl: async (url) => {
        params.onAuthorizationUrl(url.toString());
        await params.openBrowser?.(url.toString()).catch(() => undefined);
      },
      redirectUrl,
      serverName: params.serverName,
      serverUrl: params.serverUrl,
      ...(params.settings ? { settings: params.settings } : {}),
      store: params.store
    });

    const started = await auth(provider, {
      fetchFn,
      ...(params.settings?.scopes?.length ? { scope: params.settings.scopes.join(" ") } : {}),
      serverUrl: params.serverUrl
    });
    if (started === "AUTHORIZED") {
      finished = true;
      return;
    }

    const timeoutMs = params.timeoutMs ?? LOGIN_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`No sign-in arrived within ${Math.round(timeoutMs / 1000)} seconds.`)),
        timeoutMs
      );
    });
    const pasted = params.pastedLines
      ? firstPastedCallback(
          params.pastedLines,
          (line) => {
            const result = parseCallbackUrl(line, callbackPath);
            // The address an earlier attempt ended on carries another state.
            return result && ("error" in result || result.state === provider.pendingState) ? result : null;
          },
          () => params.onPastedLineIgnored?.(redirectUrl)
        )
      : new Promise<never>(() => undefined);
    // Lost to the browser's redirect, the paste may still fail later.
    pasted.catch(() => undefined);
    let result: CallbackResult;
    try {
      result = await Promise.race([callback.result, pasted, timedOut]);
    } finally {
      clearTimeout(timer);
    }

    if ("error" in result) {
      throw new Error(`The authorization server refused the sign-in: ${result.error}.`);
    }
    if (!provider.pendingState || result.state !== provider.pendingState) {
      throw new Error("The sign-in response did not match the request (state mismatch); nothing was saved.");
    }
    const exchanged = await auth(provider, {
      authorizationCode: result.code,
      fetchFn,
      serverUrl: params.serverUrl
    });
    if (exchanged !== "AUTHORIZED") {
      throw new Error("The authorization server did not issue tokens.");
    }
    finished = true;
  } finally {
    await callback.close();
    if (!finished) {
      await params.store.restore(params.serverName, params.serverUrl, before).catch(() => undefined);
    }
  }
}

type CallbackResult = { code: string; state: string | null } | { error: string };

/**
 * The first pasted line `accept` takes. Any other line (a stray Enter, a wrong
 * paste, an earlier attempt's address) is reported and skipped, so it does not
 * use up the only paste; once the input ends, only the browser's own redirect
 * can finish the sign-in.
 */
async function firstPastedCallback(
  lines: AsyncIterable<string>,
  accept: (line: string) => CallbackResult | null,
  onIgnored: () => void
): Promise<CallbackResult> {
  for await (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const result = accept(line);
    if (result) {
      return result;
    }
    onIgnored();
  }
  return new Promise<never>(() => undefined);
}

async function startCallbackListener(
  callbackPath: string,
  port: number | undefined
): Promise<{ close(): Promise<void>; port: number; result: Promise<CallbackResult> }> {
  let deliver: (result: CallbackResult) => void = () => undefined;
  const result = new Promise<CallbackResult>((resolve) => {
    deliver = resolve;
  });
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const parsed = parseCallbackUrl(`http://${CALLBACK_HOST}${request.url ?? "/"}`, callbackPath);
    if (!parsed) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found.");
      return;
    }
    response
      .writeHead("error" in parsed ? 400 : 200, { "content-type": "text/html; charset=utf-8" })
      .end(
        "error" in parsed
          ? "<!doctype html><title>aia</title><p>The sign-in was refused. You can close this tab.</p>"
          : "<!doctype html><title>aia</title><p>Signed in. You can close this tab and return to aia.</p>"
      );
    deliver(parsed);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port ?? 0, CALLBACK_HOST, () => resolve());
  });
  const address = server.address();
  return {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    port: typeof address === "object" && address ? address.port : (port ?? 0),
    result
  };
}

// Only the exact callback path counts, so a stray request (a favicon, a
// probe) never completes the login.
function parseCallbackUrl(value: string, callbackPath: string): CallbackResult | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.pathname !== callbackPath) {
    return null;
  }
  const error = url.searchParams.get("error");
  if (error) {
    const description = url.searchParams.get("error_description");
    return { error: description ? `${error} (${description})` : error };
  }
  const code = url.searchParams.get("code");
  return code ? { code, state: url.searchParams.get("state") } : null;
}
