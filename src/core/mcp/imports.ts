import type { AppConfig } from "@/core/config";
import { readJsoncFileIfExists } from "@/core/config/jsonc";

type ImportedServerRecord = AppConfig["mcp"]["servers"];

export async function loadImportedMcpServers(
  imports: AppConfig["mcp"]["imports"]
): Promise<{ files: string[]; servers: ImportedServerRecord }> {
  const loadedFiles: string[] = [];
  const servers: ImportedServerRecord = {};

  for (const [importId, config] of Object.entries(imports)) {
    if (!config.enabled) {
      continue;
    }

    const raw = await readJsoncFileIfExists(config.path);
    if (raw === null) {
      continue;
    }

    loadedFiles.push(config.path);
    const normalized = normalizeImportedServers(raw, config.format);
    for (const [serverName, serverConfig] of Object.entries(normalized)) {
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

function normalizeImportedServers(
  raw: unknown,
  format: AppConfig["mcp"]["imports"][string]["format"]
): ImportedServerRecord {
  const root = coerceRecord(raw) ?? {};
  const candidate =
    format === "generic_mcp_servers_json"
      ? (coerceRecord(root.mcpServers) ?? root)
      : coerceRecord(root.mcpServers) ?? {};

  const servers: ImportedServerRecord = {};
  for (const [serverName, value] of Object.entries(candidate)) {
    const normalized = normalizeImportedServer(value);
    if (normalized) {
      servers[serverName] = normalized;
    }
  }

  return servers;
}

function normalizeImportedServer(value: unknown): ImportedServerRecord[string] | null {
  const record = coerceRecord(value);
  if (!record) {
    return null;
  }

  const enabled = record.enabled === undefined ? record.disabled !== true : Boolean(record.enabled);
  const required = record.required === true;
  const timeoutMs = typeof record.timeout === "number" ? record.timeout * 1000 : typeof record.timeoutMs === "number" ? record.timeoutMs : undefined;
  const tags = Array.isArray(record.tags) ? record.tags.filter((entry): entry is string => typeof entry === "string") : [];
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
