import { readJsoncFileWithTextIfExists } from "@/core/config/jsonc";
import type { AppConfig } from "@/core/config/schema";

/**
 * Reads MCP servers out of other clients' config files (`mcp.imports`). Lives
 * in the config layer because workspace trust has to see the same servers the
 * MCP manager will start: it shows them before a grant and hashes the files
 * into the grant, so editing an imported file revokes trust like editing the
 * config itself.
 */

type ImportedServerRecord = AppConfig["mcp"]["servers"];
type McpImportConfig = AppConfig["mcp"]["imports"][string];

/** One imported file as read: its servers and the exact text they came from. */
export type ImportedMcpFile = {
  path: string;
  servers: ImportedServerRecord;
  /** Servers left out because their name was empty or too long. */
  skippedNames: number;
  /** Null when the file does not exist. */
  text: string | null;
};

/**
 * Reads one import file. A missing file is not an error (imports often name a
 * file another client creates later); an unparsable one is.
 */
export async function readImportedMcpFile(config: Pick<McpImportConfig, "format" | "path">): Promise<ImportedMcpFile> {
  const read = await readJsoncFileWithTextIfExists(config.path);
  if (read === null) {
    return { path: config.path, servers: {}, skippedNames: 0, text: null };
  }
  return { path: config.path, ...normalizeImportedServers(read.value, config.format), text: read.text };
}

export async function loadImportedMcpServers(
  imports: AppConfig["mcp"]["imports"]
): Promise<{ files: string[]; servers: ImportedServerRecord }> {
  const loadedFiles: string[] = [];
  const servers: ImportedServerRecord = {};

  for (const [importId, config] of Object.entries(imports)) {
    if (!config.enabled) {
      continue;
    }

    const file = await readImportedMcpFile(config);
    if (file.text === null) {
      continue;
    }
    if (file.skippedNames > 0) {
      console.warn(
        `[AIA_MCP_IMPORT_SKIPPED] ${config.path}: skipped ${file.skippedNames} server(s) whose name is empty or longer than ${MAX_SERVER_NAME_LENGTH} characters.`
      );
    }

    loadedFiles.push(config.path);
    for (const [serverName, serverConfig] of Object.entries(file.servers)) {
      servers[serverName] = {
        ...serverConfig,
        provenance: {
          importId,
          source: "import",
          ...(serverConfig.provenance ?? {})
        }
      };
    }
  }

  return {
    files: loadedFiles,
    servers
  };
}

// As for a configured server (src/core/config/schema.ts).
const MAX_SERVER_NAME_LENGTH = 128;

function normalizeImportedServers(
  raw: unknown,
  format: AppConfig["mcp"]["imports"][string]["format"]
): { servers: ImportedServerRecord; skippedNames: number } {
  const root = coerceRecord(raw) ?? {};
  const candidate =
    format === "generic_mcp_servers_json"
      ? (coerceRecord(root.mcpServers) ?? root)
      : (coerceRecord(root.mcpServers) ?? {});

  const servers: ImportedServerRecord = {};
  let skippedNames = 0;
  for (const [serverName, value] of Object.entries(candidate)) {
    // The limits a configured name has (src/core/config/schema.ts): a name
    // past them failed every status report the server appeared in.
    if (serverName.trim().length === 0 || serverName.length > MAX_SERVER_NAME_LENGTH) {
      skippedNames += 1;
      continue;
    }
    const normalized = normalizeImportedServer(value);
    if (normalized) {
      servers[serverName] = normalized;
    }
  }
  return { servers, skippedNames };
}

function normalizeImportedServer(value: unknown): ImportedServerRecord[string] | null {
  const record = coerceRecord(value);
  if (!record) {
    return null;
  }

  const enabled = record.enabled === undefined ? record.disabled !== true : Boolean(record.enabled);
  const required = record.required === true;
  const timeoutMs =
    typeof record.timeout === "number"
      ? record.timeout * 1000
      : typeof record.timeoutMs === "number"
        ? record.timeoutMs
        : undefined;
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((entry): entry is string => typeof entry === "string")
    : [];
  const description = typeof record.description === "string" ? record.description : undefined;

  if (typeof record.command === "string" && record.command.trim().length > 0) {
    return {
      args: Array.isArray(record.args) ? record.args.filter((entry): entry is string => typeof entry === "string") : [],
      command: record.command,
      cwd:
        typeof record.cwd === "string"
          ? record.cwd
          : typeof record.working_directory === "string"
            ? record.working_directory
            : undefined,
      description,
      enabled,
      env: normalizeStringRecord(record.env),
      provenance: {
        source: "import"
      },
      required,
      stderr: "pipe",
      tags,
      timeoutMs,
      type: "stdio"
    };
  }

  const url =
    typeof record.url === "string"
      ? record.url
      : typeof record.serverUrl === "string"
        ? record.serverUrl
        : typeof record.httpUrl === "string"
          ? record.httpUrl
          : null;

  if (!url) {
    return null;
  }

  return {
    description,
    enabled,
    headers: normalizeStringRecord(record.headers),
    provenance: {
      source: "import"
    },
    required,
    tags,
    timeoutMs,
    type: normalizeImportedTransport(record.type),
    url
  };
}

function normalizeImportedTransport(value: unknown): "auto" | "sse" | "streamable-http" {
  if (value === "sse") {
    return "sse";
  }
  if (value === "streamable-http" || value === "streamableHttp") {
    return "streamable-http";
  }
  return "auto";
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  const record = coerceRecord(value);
  if (!record) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(record).flatMap(([key, entry]) => (typeof entry === "string" ? [[key, entry]] : []))
  );
}

function coerceRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}
