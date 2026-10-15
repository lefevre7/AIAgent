import { deepMerge, editConfigFile, readConfigFileText, type AppConfig, type ResolvedConfigPaths } from "@/core/config";
import { parseJsoncText } from "@/core/config/jsonc";
import { loadImportedMcpServers } from "@/core/config/mcp-imports";
import { BUILT_IN_MCP_SERVER_TEMPLATES } from "@/core/mcp/templates";

type McpServerConfig = AppConfig["mcp"]["servers"][string];

/**
 * The servers a config runs (its imports, with its own `mcp.servers` over
 * them) and the templates it offers (the built-in ones, with its own over
 * them). Running sessions and `aia mcp` both resolve servers here, so they
 * cannot disagree about what is configured.
 */
export async function resolveMcpServerConfig(mcp: AppConfig["mcp"]): Promise<{
  importedFiles: string[];
  servers: AppConfig["mcp"]["servers"];
  templates: AppConfig["mcp"]["templates"];
}> {
  const imported = await loadImportedMcpServers(mcp.imports);
  return {
    importedFiles: imported.files,
    servers: deepMerge(imported.servers, mcp.servers),
    templates: deepMerge(BUILT_IN_MCP_SERVER_TEMPLATES, mcp.templates)
  };
}

/**
 * A server entry made from a template: the template's server with
 * `overrides` over it, stamped with the template it came from. Throws for an
 * unknown template, naming the known ones.
 */
export function serverFromTemplate(
  templates: AppConfig["mcp"]["templates"],
  templateId: string,
  overrides: Partial<McpServerConfig> = {}
): McpServerConfig {
  const template = templates[templateId];
  if (!template) {
    throw new Error(`No MCP server template "${templateId}". Known: ${Object.keys(templates).sort().join(", ")}.`);
  }
  return deepMerge(template.server, overrides, { provenance: { source: "template", templateId } });
}

/** What a config file declares under `mcp.servers`, read without resolving anything. */
export async function readMcpServerEntries(configPath: string): Promise<Record<string, unknown>> {
  const file = await readConfigFileText(configPath);
  return file === null ? {} : mcpServerEntriesOf(parseJsoncText(file.text, configPath));
}

function mcpServerEntriesOf(config: unknown): Record<string, unknown> {
  const servers = (config as { mcp?: { servers?: unknown } } | null)?.mcp?.servers;
  return typeof servers === "object" && servers !== null && !Array.isArray(servers)
    ? (servers as Record<string, unknown>)
    : {};
}

/**
 * Adds a server entry, keeping the rest of the file (see `editConfigFile`).
 * Refuses to replace one unless `force`, which replaces the whole entry: a
 * merge would keep the old entry's headers (an API key) for a new URL.
 * `trusted` says whether the file is the operator's afterwards (an
 * untrusted workspace config is not trusted by the edit).
 */
export async function addMcpServerToConfigFile(params: {
  configPaths?: ResolvedConfigPaths;
  configPath: string;
  force?: boolean;
  server: unknown;
  serverName: string;
}): Promise<{ replaced: boolean; trusted: boolean }> {
  let replaced = false;
  const { trusted } = await editConfigFile({
    configPath: params.configPath,
    ...(params.configPaths ? { configPaths: params.configPaths } : {}),
    edits: (current) => {
      replaced = Object.hasOwn(mcpServerEntriesOf(current), params.serverName);
      if (replaced && !params.force) {
        throw new Error(
          `${params.configPath} already defines the MCP server "${params.serverName}". Use --force to replace it.`
        );
      }
      return [{ path: ["mcp", "servers", params.serverName], value: params.server }];
    }
  });
  return { replaced, trusted };
}

/** Removes a server entry; says whether there was one. */
export async function removeMcpServerFromConfigFile(params: {
  configPaths?: ResolvedConfigPaths;
  configPath: string;
  serverName: string;
}): Promise<boolean> {
  const { written } = await editConfigFile({
    configPath: params.configPath,
    ...(params.configPaths ? { configPaths: params.configPaths } : {}),
    edits: (current) =>
      Object.hasOwn(mcpServerEntriesOf(current), params.serverName)
        ? [{ path: ["mcp", "servers", params.serverName], value: undefined }]
        : []
  });
  return written;
}

/**
 * The files that define server `serverName`, among the user-global config
 * files (base first) and the workspace config. `aia mcp add|remove` edit the
 * file that already defines an entry, and refuse to add a second definition
 * that the loader would merge with the first.
 */
export async function findMcpServerDefinitions(
  paths: ResolvedConfigPaths,
  serverName: string
): Promise<{ user: string[]; workspace: string | null }> {
  const user: string[] = [];
  for (const filePath of paths.globalConfigPaths) {
    if (Object.hasOwn(await readMcpServerEntries(filePath), serverName)) {
      user.push(filePath);
    }
  }
  const workspace = Object.hasOwn(await readMcpServerEntries(paths.workspaceConfigPath), serverName)
    ? paths.workspaceConfigPath
    : null;
  return { user, workspace };
}

/**
 * Where a new user-global entry goes: `~/.aia/config.jsonc` when it exists
 * (where most operators keep their servers), else the write target the paths
 * name. With `AIA_USER_CONFIG_PATH` set there is only that file.
 */
export async function chooseUserConfigFile(paths: ResolvedConfigPaths): Promise<string> {
  const [base] = paths.globalConfigPaths;
  if (paths.globalConfigPaths.length > 1 && base && (await readConfigFileText(base)) !== null) {
    return base;
  }
  return paths.globalConfigPath;
}
