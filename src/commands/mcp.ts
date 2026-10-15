import { spawn } from "node:child_process";
import readline from "node:readline";
import { parseArgs } from "node:util";

import {
  addMcpServerToConfigFile,
  appConfigFragmentSchema,
  loginToMcpServer,
  materializeOAuthSettings,
  McpCredentialsStore,
  mcpCredentialsFilePath,
  chooseUserConfigFile,
  findMcpServerDefinitions,
  readMcpServerEntries,
  removeMcpServerFromConfigFile,
  resolveMcpServerConfig,
  resolveSecretInput,
  serverFromTemplate,
  stringifyArgv,
  type AppConfig,
  type LoadedAIAgentConfig,
  type SecretInput
} from "@/core";
import { readNetworkErrorCode } from "@/core/io/http";
import {
  loadCommandConfig,
  renderCliError,
  runSubcommands,
  sanitizeForTerminal,
  writeLine,
  type CliStreams
} from "@/commands/io";
import type { AttachWebSocketClient } from "@/gateway/attach-client";
import { listAttachEndpoints, serverAttachUrl } from "@/gateway/attach-endpoint";
import { requestGatewayOverWebSocket } from "@/gateway/socket-request";

type McpServerConfig = AppConfig["mcp"]["servers"][string];

export type McpCliDependencies = {
  createWebSocket?: (url: string) => AttachWebSocketClient;
  fetchImpl?: typeof fetch;
  /** Opens the sign-in page; defaults to the system browser. */
  openBrowser?: (url: string) => Promise<void>;
  /** The lines the operator types during `login --no-browser` (the callback address among them). */
  readLines?: () => AsyncIterable<string>;
  userHomeDirectory?: string;
};

// Codex's rule, minus the characters that would not survive in a tool name.
// Any name config accepts (docs/MCP.md): at most 128 characters, and no
// control characters, which a name is printed through anyway.
// eslint-disable-next-line no-control-regex
const UNUSABLE_SERVER_NAME = /[\u0000-\u001f\u007f-\u009f]/u;
const MASK = "*****";

export function formatMcpCliHelp(): string {
  return [
    "aia mcp — MCP servers: see what is configured, add and remove servers, and sign in. See docs/MCP.md.",
    "",
    "  aia mcp list [--json]              Every configured server: transport, what it runs, whether it is",
    "                                     enabled, and whether it is signed in. Secret values are masked.",
    "  aia mcp get <name> [--json]        One server's settings, masked the same way",
    "  aia mcp add <name> [--workspace] [--force] [--env KEY=VALUE]... [--pass-env NAME]... -- <command> [args...]",
    "  aia mcp add <name> --url <url> [--transport auto|streamable-http|sse] [--header KEY=VALUE]...",
    "  aia mcp add <name> --template <id>",
    "                                     Adds a server to your user config (~/.aia/config.jsonc when it",
    "                                     exists), or the workspace config with --workspace, keeping the",
    "                                     file's comments. --force replaces an existing entry whole.",
    "  aia mcp remove <name> [--workspace]",
    "                                     Removes it from the files that define it",
    "  aia mcp login <name> [--no-browser] [--scopes a,b]",
    "                                     Signs in to an HTTP server with OAuth (browser, PKCE). Running",
    "                                     sessions pick the sign-in up by themselves.",
    "  aia mcp logout <name>              Forgets the saved sign-in",
    "  aia mcp reconnect <name>           Reconnects the server in every running aia session here",
    "",
    "Every command takes --cwd <path> to act on another workspace."
  ].join("\n");
}

export async function runMcpCli(args: string[], streams: CliStreams, deps: McpCliDependencies = {}): Promise<number> {
  return runSubcommands({
    args,
    command: "mcp",
    handlers: {
      add: (options) => addServer(options, streams, deps),
      get: (options) => showServers(options, streams, deps, "get"),
      list: (options) => showServers(options, streams, deps, "list"),
      login: (options) => login(options, streams, deps),
      logout: (options) => logout(options, streams, deps),
      reconnect: (options) => reconnect(options, streams, deps),
      remove: (options) => removeServer(options, streams, deps)
    },
    help: formatMcpCliHelp,
    streams
  });
}

// Listing and editing need no secret, so no secret provider runs for them.
function loadConfig(cwd: string | undefined, deps: McpCliDependencies, resolveSecrets: boolean) {
  return loadCommandConfig({ cwd, resolveSecrets, userHomeDirectory: deps.userHomeDirectory });
}

type ListedServer = {
  config?: McpServerConfig;
  definedIn: string;
  name: string;
  state?: "untrusted";
};

/**
 * The servers as configured here. `config` is the unresolved config by
 * default, so a listing shows a secret reference rather than its value; a
 * command that needs the values (login) passes `loaded.resolvedConfig`.
 */
async function collectServers(
  loaded: LoadedAIAgentConfig,
  config: LoadedAIAgentConfig["config"] = loaded.config
): Promise<ListedServer[]> {
  const { servers } = await resolveMcpServerConfig(config.mcp);
  const workspacePath = loaded.sources.config.workspace;
  const workspaceNames = new Set(
    workspacePath && loaded.workspaceTrust.untrustedMcpEntries.length === 0
      ? Object.keys(await readMcpServerEntries(workspacePath))
      : []
  );
  const listed: ListedServer[] = Object.entries(servers).map(([name, config]) => ({
    config,
    definedIn: workspaceNames.has(name)
      ? (workspacePath ?? "workspace")
      : config.provenance?.source === "import"
        ? "an import"
        : "your user config",
    name
  }));
  for (const entry of loaded.workspaceTrust.untrustedMcpEntries) {
    if (entry.kind === "server" && !servers[entry.name]) {
      listed.push({ definedIn: workspacePath ?? "workspace", name: entry.name, state: "untrusted" });
    }
  }
  return listed.sort((left, right) => left.name.localeCompare(right.name));
}

async function showServers(
  args: string[],
  streams: CliStreams,
  deps: McpCliDependencies,
  mode: "get" | "list"
): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: mode === "get",
    options: { cwd: { type: "string" }, json: { type: "boolean" } }
  });
  const loaded = await loadConfig(values.cwd, deps, false);
  const store = new McpCredentialsStore(mcpCredentialsFilePath(loaded.paths.userStateDirectory));
  let servers = await collectServers(loaded);
  if (mode === "get") {
    const [name] = positionals;
    if (!name) {
      writeLine(streams.stderr, "Usage: aia mcp get <name>");
      return 1;
    }
    servers = servers.filter((server) => server.name === name);
    if (servers.length === 0) {
      writeLine(streams.stderr, `No MCP server named "${name}" is configured here.`);
      return 1;
    }
  }

  const described = await Promise.all(
    servers.map(async (server) => ({
      ...server,
      auth: server.config ? await describeAuth(server.name, server.config, store) : null
    }))
  );
  if (values.json) {
    // `auth` is left out where it does not apply (a stdio server, or one not trusted yet).
    const json = described.map((server) => ({
      ...(server.auth ? { auth: server.auth } : {}),
      definedIn: server.definedIn,
      name: server.name,
      ...(server.config ? { server: maskServer(server.config) } : {}),
      ...(server.state ? { state: server.state } : {})
    }));
    writeLine(streams.stdout, JSON.stringify(mode === "get" ? json[0] : json, null, 2));
    return 0;
  }
  if (described.length === 0) {
    writeLine(streams.stdout, "No MCP servers are configured. Add one with aia mcp add.");
    return 0;
  }
  for (const server of described) {
    writeLine(streams.stdout, formatServer(server, mode === "get"));
  }
  return 0;
}

// Names, commands, URLs and values come from config files, a workspace's
// included: printed through sanitizeForTerminal so they cannot drive the
// terminal.
function formatServer(server: ListedServer & { auth: string | null }, detailed: boolean): string {
  const one = (text: string) => sanitizeForTerminal(text, { singleLine: true });
  if (!server.config) {
    return `${one(server.name)}  [untrusted]  declared by ${one(server.definedIn)}; run aia trust there to review it`;
  }
  const config = server.config;
  // Quoted the way `aia trust` and approval prompts show a command line.
  const target =
    config.type === "stdio" ? (stringifyArgv([config.command, ...config.args]) ?? config.command) : config.url;
  const flags = [config.type, config.enabled ? "enabled" : "disabled", ...(config.required ? ["required"] : [])];
  const lines = [`${one(server.name)}  [${flags.join(", ")}]  ${one(target)}`];
  if (server.auth) {
    lines.push(`  auth: ${server.auth}`);
  }
  if (detailed) {
    const masked = maskServer(config);
    lines.push(`  defined in: ${one(server.definedIn)}`);
    for (const [key, value] of Object.entries(masked)) {
      if (!["args", "command", "type", "url"].includes(key)) {
        lines.push(`  ${key}: ${one(JSON.stringify(value))}`);
      }
    }
  }
  return lines.join("\n");
}

// Secret values never leave through `list`/`get`, JSON included: a literal
// value is masked, and a secret reference is shown as the reference it is.
function maskServer(config: McpServerConfig): Record<string, unknown> {
  const maskValues = (values: Record<string, SecretInput>) =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [key, typeof value === "string" ? MASK : describeSecretRef(value)])
    );
  const masked: Record<string, unknown> = { ...config };
  if (config.type === "stdio") {
    masked.env = maskValues(config.env);
  } else {
    masked.headers = maskValues(config.headers);
    if (config.oauth?.clientSecret !== undefined) {
      masked.oauth = {
        ...config.oauth,
        clientSecret:
          typeof config.oauth.clientSecret === "string" ? MASK : describeSecretRef(config.oauth.clientSecret)
      };
    }
  }
  return masked;
}

function describeSecretRef(value: Exclude<SecretInput, string>): string {
  return `secret ${value.source}:${value.id}${value.provider ? ` (provider ${value.provider})` : ""}`;
}

// Null for a stdio server: it has no sign-in to describe.
async function describeAuth(name: string, config: McpServerConfig, store: McpCredentialsStore): Promise<string | null> {
  if (config.type === "stdio") {
    return null;
  }
  if (Object.keys(config.headers).some((key) => key.toLowerCase() === "authorization")) {
    return "Authorization header";
  }
  const signedIn = await store.hasTokens(name, config.url).catch(() => false);
  return signedIn ? "signed in (OAuth)" : "not signed in";
}

async function addServer(args: string[], streams: CliStreams, deps: McpCliDependencies): Promise<number> {
  const separator = args.indexOf("--");
  const optionArgs = separator >= 0 ? args.slice(0, separator) : args;
  const commandArgs = separator >= 0 ? args.slice(separator + 1) : [];
  const { positionals, values } = parseArgs({
    args: optionArgs,
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      env: { multiple: true, type: "string" },
      force: { type: "boolean" },
      header: { multiple: true, type: "string" },
      "pass-env": { multiple: true, type: "string" },
      template: { type: "string" },
      transport: { type: "string" },
      url: { type: "string" },
      workspace: { type: "boolean" }
    }
  });
  const [name, ...extra] = positionals;
  if (!name || extra.length > 0) {
    writeLine(streams.stderr, "Usage: aia mcp add <name> [options] -- <command> [args...]   (see aia mcp --help)");
    return 1;
  }
  if (name.trim().length === 0 || name.length > 128 || UNUSABLE_SERVER_NAME.test(name)) {
    writeLine(
      streams.stderr,
      `"${sanitizeForTerminal(name, { singleLine: true })}" is not a usable server name: up to 128 characters, none of them control characters.`
    );
    return 1;
  }
  const kinds = [commandArgs.length > 0, values.url !== undefined, values.template !== undefined].filter(Boolean);
  if (kinds.length !== 1) {
    writeLine(streams.stderr, "Give exactly one of: a command after --, --url <url>, or --template <id>.");
    return 1;
  }

  const loaded = await loadConfig(values.cwd, deps, false);
  let server: unknown;
  if (values.template) {
    const { templates } = await resolveMcpServerConfig(loaded.config.mcp);
    try {
      server = serverFromTemplate(templates, values.template);
    } catch (error) {
      writeLine(streams.stderr, sanitizeForTerminal(renderCliError(error)));
      return 1;
    }
  } else if (values.url) {
    server = {
      enabled: true,
      headers: parsePairs(values.header ?? [], "--header"),
      required: false,
      tags: [],
      type: values.transport ?? "auto",
      url: values.url
    };
  } else {
    server = {
      args: commandArgs.slice(1),
      command: commandArgs[0],
      enabled: true,
      env: parsePairs(values.env ?? [], "--env"),
      ...(values["pass-env"]?.length ? { passEnv: values["pass-env"] } : {}),
      required: false,
      stderr: "pipe",
      tags: [],
      type: "stdio"
    };
  }
  // Checked against the same schema the loader uses, before anything is written.
  const validated = appConfigFragmentSchema.safeParse({ mcp: { servers: { [name]: server } } });
  if (!validated.success) {
    writeLine(streams.stderr, `That server is not valid config: ${validated.error.issues[0]?.message ?? "invalid"}.`);
    return 1;
  }

  // The file that already defines the server is the one edited; a new one
  // goes to the scope's own file. A definition in the other scope is refused
  // even with --force: the loader would merge the two entries, and the old
  // one's headers (an API key) would go with the new URL.
  const definitions = await findMcpServerDefinitions(loaded.paths, name);
  const shown = sanitizeForTerminal(name, { singleLine: true });
  const inScope = values.workspace ? (definitions.workspace ? [definitions.workspace] : []) : definitions.user;
  const otherScope = values.workspace ? definitions.user : definitions.workspace ? [definitions.workspace] : [];
  if (otherScope.length > 0) {
    writeLine(
      streams.stderr,
      `The MCP server "${shown}" is also defined in ${otherScope.join(" and ")}, and the two entries would be merged. Remove it there first: aia mcp remove ${shown}${values.workspace ? "" : " --workspace"}`
    );
    return 1;
  }
  if (inScope.length > 0 && !values.force) {
    writeLine(
      streams.stderr,
      `${inScope.join(" and ")} already ${inScope.length > 1 ? "define" : "defines"} the MCP server "${shown}". Use --force to replace it.`
    );
    return 1;
  }
  const configPath =
    inScope[0] ?? (values.workspace ? loaded.paths.workspaceConfigPath : await chooseUserConfigFile(loaded.paths));
  const { trusted } = await addMcpServerToConfigFile({
    configPath,
    configPaths: loaded.paths,
    force: true,
    server,
    serverName: name
  });
  // Defined in both user files, it is replaced in one and dropped from the
  // other, or the two would still be merged.
  for (const duplicate of inScope.slice(1)) {
    await removeMcpServerFromConfigFile({ configPath: duplicate, configPaths: loaded.paths, serverName: name });
  }
  writeLine(streams.stdout, `${inScope.length > 0 ? "Replaced" : "Added"} MCP server "${shown}" in ${configPath}.`);
  if (!trusted) {
    writeLine(
      streams.stdout,
      "The workspace config is not trusted, so this server starts only after aia trust --grant."
    );
  }
  if (values.url) {
    writeLine(streams.stdout, `If the server asks for a sign-in: aia mcp login ${shown}`);
  }
  return 0;
}

async function removeServer(args: string[], streams: CliStreams, deps: McpCliDependencies): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { cwd: { type: "string" }, workspace: { type: "boolean" } }
  });
  const [name] = positionals;
  if (!name) {
    writeLine(streams.stderr, "Usage: aia mcp remove <name> [--workspace]");
    return 1;
  }
  const loaded = await loadConfig(values.cwd, deps, false);
  const definitions = await findMcpServerDefinitions(loaded.paths, name);
  const shown = sanitizeForTerminal(name, { singleLine: true });
  // Every file of the scope that defines it: one left behind would still be
  // merged into the server.
  const inScope = values.workspace ? (definitions.workspace ? [definitions.workspace] : []) : definitions.user;
  if (inScope.length > 0) {
    for (const configPath of inScope) {
      await removeMcpServerFromConfigFile({ configPath, configPaths: loaded.paths, serverName: name });
    }
    writeLine(streams.stdout, `Removed MCP server "${shown}" from ${inScope.join(" and ")}.`);
    return 0;
  }
  const elsewhere = values.workspace ? definitions.user : definitions.workspace ? [definitions.workspace] : [];
  writeLine(
    streams.stderr,
    `No MCP server named "${shown}" in ${values.workspace ? "the workspace config" : "your user config"}.${
      elsewhere.length > 0
        ? ` It is defined in ${elsewhere.join(" and ")}; ${values.workspace ? "drop --workspace" : "add --workspace"} to remove it there.`
        : ""
    }`
  );
  return 1;
}

async function login(args: string[], streams: CliStreams, deps: McpCliDependencies): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { cwd: { type: "string" }, "no-browser": { type: "boolean" }, scopes: { type: "string" } }
  });
  const [name] = positionals;
  if (!name) {
    writeLine(streams.stderr, "Usage: aia mcp login <name> [--no-browser] [--scopes a,b]");
    return 1;
  }
  // Header and client-secret values may be secret references, so this load
  // resolves them, and the servers are read from what it resolved: from the
  // plain config, a referenced header was dropped and a referenced client
  // secret failed.
  const loaded = await loadConfig(values.cwd, deps, true);
  const server = (await collectServers(loaded, loaded.resolvedConfig)).find((entry) => entry.name === name)?.config;
  if (!server) {
    writeLine(streams.stderr, `No MCP server named "${name}" is configured here.`);
    return 1;
  }
  if (server.type === "stdio") {
    writeLine(streams.stderr, `"${name}" is a stdio server; sign-in applies to HTTP servers only.`);
    return 1;
  }
  const settings = materializeOAuthSettings(server.oauth, name);
  const scopes = values.scopes
    ?.split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  const noBrowser = values["no-browser"] ?? false;
  const headers = Object.fromEntries(
    Object.entries(server.headers).flatMap(([key, value]) => (typeof value === "string" ? [[key, value]] : []))
  );
  const store = new McpCredentialsStore(mcpCredentialsFilePath(loaded.paths.userStateDirectory));
  // With no browser here, a pasted callback address is the other way to finish.
  const pasted = noBrowser
    ? deps.readLines
      ? { close: () => undefined, lines: deps.readLines() }
      : readStdinLines()
    : null;
  try {
    await loginToMcpServer({
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      headers,
      onAuthorizationUrl: (url) => {
        // The URL is built from metadata the server chose.
        const shown = sanitizeForTerminal(url, { singleLine: true });
        writeLine(
          streams.stdout,
          noBrowser
            ? `Open this URL in a browser to sign in to "${name}":\n${shown}\nThen paste the address the browser ends on here (or wait if it is this machine's browser):`
            : `Opening your browser to sign in to "${name}". If it does not open, visit:\n${shown}`
        );
      },
      ...(!noBrowser
        ? {
            openBrowser: async (url: string) => {
              try {
                await (deps.openBrowser ?? openSystemBrowser)(url);
              } catch (error) {
                writeLine(streams.stderr, `Could not open a browser: ${sanitizeForTerminal(renderCliError(error))}`);
              }
            }
          }
        : {}),
      ...(pasted
        ? {
            onPastedLineIgnored: (expected: string) =>
              writeLine(
                streams.stderr,
                `That is not the address this sign-in ends on (it starts with ${expected}?code=). Paste that address, or wait if the browser is on this machine.`
              ),
            pastedLines: pasted.lines
          }
        : {}),
      serverName: name,
      serverUrl: server.url,
      settings: { ...settings, ...(scopes?.length ? { scopes } : {}) },
      store
    });
  } finally {
    pasted?.close();
  }
  writeLine(streams.stdout, `Signed in to "${name}". Running aia sessions reconnect it by themselves.`);
  return 0;
}

async function logout(args: string[], streams: CliStreams, deps: McpCliDependencies): Promise<number> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { cwd: { type: "string" } } });
  const [name] = positionals;
  if (!name) {
    writeLine(streams.stderr, "Usage: aia mcp logout <name>");
    return 1;
  }
  const loaded = await loadConfig(values.cwd, deps, false);
  const store = new McpCredentialsStore(mcpCredentialsFilePath(loaded.paths.userStateDirectory));
  writeLine(
    streams.stdout,
    (await store.remove(name)) ? `Removed the saved sign-in for "${name}".` : `No saved sign-in for "${name}".`
  );
  return 0;
}

async function reconnect(args: string[], streams: CliStreams, deps: McpCliDependencies): Promise<number> {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { cwd: { type: "string" } } });
  const [name] = positionals;
  if (!name) {
    writeLine(streams.stderr, "Usage: aia mcp reconnect <name>");
    return 1;
  }
  const loaded = await loadConfig(values.cwd, deps, false);
  const gateway = loaded.config.gateway;
  // A listener that published no token of its own runs with the configured
  // one, which may be a secret reference: resolved only then, and once.
  let configuredToken: Promise<string | undefined> | undefined;
  const tokenFromConfig = () =>
    (configuredToken ??=
      gateway.auth.token === undefined
        ? Promise.resolve(undefined)
        : resolveSecretInput(gateway.auth.token, loaded.config, process.env, {
            untrustedProviderNames: loaded.workspaceTrust.untrustedProviderNames
          }));
  // Each interactive session publishes its listener; a server (`aia serve`,
  // the dashboard) listens where the config says, and publishes nothing.
  const published = await listAttachEndpoints(loaded.config.memory.stateRoot);
  const targets =
    published.length > 0
      ? published.map((endpoint) => ({
          configured: false,
          label: `Session ${endpoint.pid}`,
          token: endpoint.token,
          url: endpoint.url
        }))
      : [{ configured: true, label: "The gateway", token: undefined, url: serverAttachUrl(gateway) }];

  // Every session at once: one that is slow to answer holds up no other.
  const outcomes = await Promise.all(
    targets.map(async (target): Promise<{ line: string; ok: boolean } | "nothing_running"> => {
      try {
        const token = target.token ?? (await tokenFromConfig());
        const response = await requestGatewayOverWebSocket({
          ...(deps.createWebSocket ? { createWebSocket: deps.createWebSocket } : {}),
          payload: { serverName: name },
          topic: "mcp.reconnect",
          ...(token ? { token } : {}),
          url: target.url
        });
        if (!response.ok) {
          throw new Error(response.error?.message ?? "the session refused the request");
        }
        const server = (response.payload as { server?: { error?: string; state?: string } } | undefined)?.server;
        return {
          line: `${target.label}: ${sanitizeForTerminal(name, { singleLine: true })} is ${server?.state ?? "unknown"}${
            server?.error ? ` (${sanitizeForTerminal(server.error)})` : ""
          }.`,
          ok: true
        };
      } catch (error) {
        if (target.configured && readNetworkErrorCode(error) === "ECONNREFUSED") {
          return "nothing_running";
        }
        return { line: `${target.label}: ${sanitizeForTerminal(renderCliError(error))}`, ok: false };
      }
    })
  );

  if (outcomes.every((outcome) => outcome === "nothing_running")) {
    writeLine(
      streams.stdout,
      "No aia session is running in this workspace, so there is nothing to reconnect: servers connect when a session starts."
    );
    return 0;
  }
  let failed = false;
  for (const outcome of outcomes) {
    if (outcome === "nothing_running") {
      continue;
    }
    writeLine(outcome.ok ? streams.stdout : streams.stderr, outcome.line);
    failed ||= !outcome.ok;
  }
  // Any session that could not be asked is a failure: scripts check this.
  return failed ? 1 : 0;
}

function parsePairs(values: string[], flag: string): Record<string, string> {
  return Object.fromEntries(
    values.map((entry) => {
      const index = entry.indexOf("=");
      if (index <= 0) {
        throw new Error(`${flag} takes KEY=VALUE, got "${entry}".`);
      }
      return [entry.slice(0, index), entry.slice(index + 1)];
    })
  );
}

// The lines typed at the terminal (null without one), and a way to stop
// reading so an unused reader does not keep the process alive. The iterator is
// made now, so a line typed before the address is wanted is kept (and set
// aside as not the address) rather than lost.
function readStdinLines(): { close(): void; lines: AsyncIterable<string> } | null {
  if (!process.stdin.isTTY) {
    return null;
  }
  const reader = readline.createInterface({ input: process.stdin });
  const lines = reader[Symbol.asyncIterator]();
  return { close: () => reader.close(), lines: { [Symbol.asyncIterator]: () => lines } };
}

/**
 * Opens the authorization URL in the system browser. The URL comes from the
 * authorization server's metadata, which the MCP server chooses, so it is
 * checked first: only http(s) is opened (a `file:` URL or an app's own scheme
 * would launch whatever handles it). Nothing goes through a shell: on Windows
 * `cmd /c start` would read the URL's `&` as a command separator, cutting the
 * sign-in URL short and running the rest as commands, so the URL handler is
 * called directly.
 */
export async function openSystemBrowser(url: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const [command, args] = browserCommandFor(url, platform);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args as string[], { detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** The command and arguments that open `url` in the browser on `platform`; throws for anything but http(s). */
export function browserCommandFor(url: string, platform: NodeJS.Platform): [string, string[]] {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new Error(`Not opening "${url}": it is not a valid URL.`);
  }
  if (protocol !== "https:" && protocol !== "http:") {
    throw new Error(`Not opening a ${protocol} URL: sign-in pages are http(s) only. Open it yourself if you trust it.`);
  }
  if (platform === "darwin") {
    return ["open", [url]];
  }
  if (platform === "win32") {
    return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  }
  return ["xdg-open", [url]];
}
