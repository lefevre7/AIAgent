import path from "node:path";

import { ZodError, type ZodType, type ZodTypeDef } from "zod";

import { buildEnvironmentOverrides } from "@/core/config/env-overrides";
import { readJsoncFileWithTextIfExists } from "@/core/config/jsonc";
import { deepMerge } from "@/core/config/merge";
import { normalizeConfigFragmentPaths } from "@/core/config/normalize";
import { resolveConfigPaths, type ResolvedConfigPaths } from "@/core/config/paths";
import {
  appConfigFragmentSchema,
  appConfigSchema,
  approvalSettingsFragmentSchema,
  approvalSettingsSchema,
  createDefaultAppConfig,
  DEFAULT_APPROVAL_SETTINGS,
  type AppConfig,
  type AppConfigFragment,
  type ApprovalSettings,
  type ApprovalSettingsFragment
} from "@/core/config/schema";
import { resolveConfigSecrets } from "@/core/config/secrets";
import {
  evaluateApprovalsTextTrust,
  evaluateConfigTextTrust,
  mergeWorkspaceApprovals,
  readConfigTrustStore,
  withoutTrustGatedEntries,
  type ApprovalsTrustEvaluation,
  type ConfigFingerprint,
  type TrustGatedMcpEntry,
  type TrustGatedSecretProvider,
  type TrustGatedSetting
} from "@/core/config/trust";

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export type WorkspaceConfigTrust = {
  /**
   * The workspace `aia.approvals.jsonc`, when there is one: what it asks for
   * that waits for trust, and whether it has it. Its deny and ask rules apply
   * either way.
   */
  approvals: ApprovalsTrustEvaluation | null;
  /**
   * Fingerprint of the workspace config (with the files its `mcp.imports`
   * names) when it declares something trust-gated; null when it does not.
   */
  fingerprint: ConfigFingerprint | null;
  /** True when the workspace config declares anything trust-gated (see trust.ts). */
  required: boolean;
  trusted: boolean;
  /** MCP servers, imports, templates, and `passEnv` held back because this config is not trusted. */
  untrustedMcpEntries: TrustGatedMcpEntry[];
  /** Names of the secret providers held back because this config is not trusted. */
  untrustedProviderNames: string[];
  /** The secret providers held back, with what each would run or read. */
  untrustedProviders: TrustGatedSecretProvider[];
  /** Other settings (endpoints, agents, gateway, …) and secret references held back. */
  untrustedSettings: TrustGatedSetting[];
};

/** The trust state of a workspace whose config files need no trust: what hand-built configs use. */
export function noWorkspaceTrustNeeded(): WorkspaceConfigTrust {
  return {
    approvals: null,
    fingerprint: null,
    required: false,
    trusted: true,
    untrustedMcpEntries: [],
    untrustedProviderNames: [],
    untrustedProviders: [],
    untrustedSettings: []
  };
}

export type LoadedAIAgentConfig = {
  approvals: ApprovalSettings;
  config: AppConfig;
  paths: ResolvedConfigPaths;
  resolvedConfig: AppConfig;
  /**
   * True when `skills.extraRoots` came from the workspace config (which needs
   * trust to set them): skill discovery then confines them to the project.
   */
  workspaceSkillExtraRoots?: boolean;
  workspaceTrust: WorkspaceConfigTrust;
  sources: {
    approvals: {
      env: boolean;
      global: string | null;
      workspace: string | null;
    };
    config: {
      env: boolean;
      global: string[];
      workspace: string | null;
    };
  };
};

export async function loadAIAgentConfig(params: {
  cwd: string;
  env?: Record<string, string | undefined>;
  resolveSecrets?: boolean;
  userHomeDirectory?: string;
  /**
   * Emit the `AIA_UNTRUSTED_CONFIG` warning when the workspace config needs
   * trust it does not have. Defaults to true; the interactive CLI turns it off
   * because it asks the operator about the same file directly.
   */
  warnWhenUntrusted?: boolean;
}): Promise<LoadedAIAgentConfig> {
  const env = params.env ?? process.env;
  const paths = await resolveConfigPaths({
    cwd: params.cwd,
    env,
    userHomeDirectory: params.userHomeDirectory
  });

  const globalConfigLayers: { fragment: AppConfigFragment; path: string }[] = [];
  for (const globalConfigPath of paths.globalConfigPaths) {
    const fragment = await loadFragment(globalConfigPath, "global config", appConfigFragmentSchema);
    if (fragment) {
      globalConfigLayers.push({ fragment, path: globalConfigPath });
    }
  }
  const workspaceConfig = await loadFragmentWithText(
    paths.workspaceConfigPath,
    "workspace config",
    appConfigFragmentSchema
  );
  const workspaceConfigFragment = workspaceConfig?.fragment ?? null;
  const globalApprovalsFragment = await loadFragment(
    paths.globalApprovalsPath,
    "global approvals",
    approvalSettingsFragmentSchema
  );
  const workspaceApprovals = await loadFragmentWithText(
    paths.workspaceApprovalsPath,
    "workspace approvals",
    approvalSettingsFragmentSchema
  );
  const workspaceApprovalsFragment = workspaceApprovals?.fragment ?? null;
  const environmentOverrides = parseEnvironmentOverrides(env);

  // Security review H3 / M11: a workspace config discovered by walking up from
  // cwd can declare things that run a command, send the operator's data or
  // credentials somewhere, or read outside the project (see trust.ts). Trust
  // is decided before the merge, because an untrusted workspace layer is
  // merged without them. The approvals file is decided against the operator's
  // own settings (defaults plus user-global), which it may only tighten.
  const approvalsBase = parseMerged(
    approvalSettingsSchema,
    deepMerge(DEFAULT_APPROVAL_SETTINGS, globalApprovalsFragment ?? undefined),
    "approval settings"
  );
  const workspaceTrust = await resolveWorkspaceTrust({
    approvals: workspaceApprovals,
    approvalsBase,
    fragment: workspaceConfigFragment,
    text: workspaceConfig?.text ?? null,
    userStateDirectory: paths.userStateDirectory,
    warn: params.warnWhenUntrusted ?? true,
    workspaceApprovalsPath: paths.workspaceApprovalsPath,
    workspaceConfigPath: paths.workspaceConfigPath
  });
  const mergeableWorkspaceFragment = workspaceTrust.trusted
    ? workspaceConfigFragment
    : withoutTrustGatedEntries(workspaceConfigFragment);

  const layers: unknown[] = [
    normalizeConfigFragmentPaths(
      createDefaultAppConfig({ userStateDirectory: paths.userStateDirectory }),
      paths.workspaceRoot
    ),
    ...globalConfigLayers.map((layer) => normalizeConfigLayer(layer.fragment, layer.path)),
    normalizeConfigLayer(mergeableWorkspaceFragment, paths.workspaceConfigPath),
    normalizeConfigFragmentPaths(environmentOverrides.config, paths.workspaceRoot)
  ];
  const mergedConfig = withSkillsDisabledFromEveryLayer(deepMerge(layers[0], ...layers.slice(1)), layers);
  const config = parseMerged<AppConfig>(appConfigSchema, mergedConfig, "merged runtime config");

  const mergedApprovals = deepMerge(
    mergeWorkspaceApprovals(approvalsBase, workspaceApprovalsFragment, workspaceTrust.approvals?.trusted ?? true),
    environmentOverrides.approvals
  );
  const approvals = parseMerged(approvalSettingsSchema, mergedApprovals, "merged approval settings");

  const resolvedConfig =
    params.resolveSecrets === false
      ? config
      : await resolveConfigSecrets(config, env, {
          untrustedProviderNames: workspaceTrust.untrustedProviderNames
        });

  return {
    approvals,
    config,
    paths,
    resolvedConfig,
    // Arrays replace on merge and no environment override sets skill roots,
    // so when the workspace layer set them, every merged root is its own.
    workspaceSkillExtraRoots: Array.isArray(mergeableWorkspaceFragment?.skills?.extraRoots),
    workspaceTrust,
    sources: {
      approvals: {
        env: Object.keys(environmentOverrides.approvals).length > 0,
        global: globalApprovalsFragment ? paths.globalApprovalsPath : null,
        workspace: workspaceApprovalsFragment ? paths.workspaceApprovalsPath : null
      },
      config: {
        env: Object.keys(environmentOverrides.config).length > 0,
        global: globalConfigLayers.map((layer) => layer.path),
        workspace: workspaceConfigFragment ? paths.workspaceConfigPath : null
      }
    }
  };
}

/**
 * Resolves the secrets of a config loaded with `resolveSecrets: false`, as
 * that load would have. Lets a caller look at the config first (and ask the
 * operator about trust) without reading it twice or running an `exec`
 * provider before the answer.
 */
export async function resolveLoadedConfigSecrets(
  loaded: LoadedAIAgentConfig,
  env: Record<string, string | undefined> = process.env
): Promise<LoadedAIAgentConfig> {
  return {
    ...loaded,
    resolvedConfig: await resolveConfigSecrets(loaded.config, env, {
      untrustedProviderNames: loaded.workspaceTrust.untrustedProviderNames
    })
  };
}

/**
 * `skills.disabled` adds up across config layers, where other lists replace:
 * a skill disabled in any file stays disabled. A workspace list used to
 * replace the operator's, silently turning back on a skill they had disabled
 * (and `aia skills disable` replaced theirs the same way). `aia skills enable`
 * removes a name from every file that lists it.
 */
function withSkillsDisabledFromEveryLayer(merged: unknown, layers: unknown[]): unknown {
  if (!isRecord(merged) || !isRecord(merged.skills)) {
    return merged;
  }
  const disabled = new Set<string>();
  for (const layer of layers) {
    const list = isRecord(layer) && isRecord(layer.skills) ? layer.skills.disabled : undefined;
    for (const entry of Array.isArray(list) ? list : []) {
      if (typeof entry === "string") {
        disabled.add(entry);
      }
    }
  }
  return { ...merged, skills: { ...merged.skills, disabled: [...disabled] } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEnvironmentOverrides(env: Record<string, string | undefined>) {
  try {
    return buildEnvironmentOverrides(env);
  } catch (error) {
    throw new ConfigValidationError(`Invalid environment overrides: ${describeUnknownError(error)}`);
  }
}

async function loadFragment<T>(
  filePath: string,
  label: string,
  schema: ZodType<T, ZodTypeDef, unknown>
): Promise<T | null> {
  return (await loadFragmentWithText(filePath, label, schema))?.fragment ?? null;
}

async function loadFragmentWithText<T>(
  filePath: string,
  label: string,
  schema: ZodType<T, ZodTypeDef, unknown>
): Promise<{ fragment: T; text: string } | null> {
  const read = await readJsoncFileWithTextIfExists(filePath);
  if (read === null) {
    return null;
  }

  try {
    return { fragment: schema.parse(read.value), text: read.text };
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => `- ${issue.path.join(".") || "<root>"}: ${issue.message}`).join("\n");
      throw new ConfigValidationError(`Invalid ${label} at ${filePath}:\n${details}`);
    }
    throw error;
  }
}

function parseMerged<T>(schema: ZodType<T, ZodTypeDef, unknown>, value: unknown, label: string): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      const details = error.issues.map((issue) => `- ${issue.path.join(".") || "<root>"}: ${issue.message}`).join("\n");
      throw new ConfigValidationError(`Invalid ${label}:\n${details}`);
    }
    throw error;
  }
}

function normalizeConfigLayer(fragment: AppConfigFragment | null, filePath: string): AppConfigFragment | undefined {
  if (!fragment) {
    return undefined;
  }
  return normalizeConfigFragmentPaths(fragment as AppConfigFragment, path.dirname(filePath)) as AppConfigFragment;
}

function describeUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Decides what this workspace's config and approvals files may use (security
 * review H3, M11; see trust.ts for what waits for trust).
 *
 * Fails closed and *continues*: what is untrusted is simply withheld, with one
 * warning naming it. A withheld secret provider breaks nothing unless a config
 * value actually references one, in which case that resolution raises a
 * `SecretResolutionError` explaining how to grant trust; a withheld MCP server
 * is reported as `untrusted` instead of started. Refusing to load outright
 * would block every headless surface over an entry nothing needs.
 */
async function resolveWorkspaceTrust(params: {
  approvals: { fragment: ApprovalSettingsFragment; text: string } | null;
  approvalsBase: ApprovalSettings;
  fragment: AppConfigFragment | null;
  text: string | null;
  userStateDirectory: string;
  warn: boolean;
  workspaceApprovalsPath: string;
  workspaceConfigPath: string;
}): Promise<WorkspaceConfigTrust> {
  const store = await readConfigTrustStore(params.userStateDirectory);
  // The bytes that were parsed, not a second read of the file.
  const config = await evaluateConfigTextTrust({
    filePath: params.workspaceConfigPath,
    fragment: params.fragment,
    store,
    text: params.fragment === null ? null : params.text,
    userStateDirectory: params.userStateDirectory
  });
  const approvals = await evaluateApprovalsTextTrust({
    base: params.approvalsBase,
    filePath: params.workspaceApprovalsPath,
    fragment: params.approvals?.fragment ?? null,
    store,
    text: params.approvals?.text ?? null,
    userStateDirectory: params.userStateDirectory
  });

  const withheld = !config.required || config.trusted ? null : config.gates;
  if (params.warn && withheld && config.fingerprint) {
    process.emitWarning(describeUntrustedWorkspaceConfig(config.fingerprint.path, withheld), {
      code: "AIA_UNTRUSTED_CONFIG"
    });
  }
  if (params.warn && approvals?.required && !approvals.trusted) {
    process.emitWarning(describeUntrustedApprovals(approvals), { code: "AIA_UNTRUSTED_CONFIG" });
  }

  return {
    approvals,
    fingerprint: config.fingerprint,
    required: config.required,
    trusted: config.trusted,
    untrustedMcpEntries: withheld?.mcpEntries ?? [],
    untrustedProviderNames: withheld?.providers.map((provider) => provider.name) ?? [],
    untrustedProviders: withheld?.providers ?? [],
    untrustedSettings: withheld?.settings ?? []
  };
}

function describeUntrustedWorkspaceConfig(
  configPath: string,
  withheld: { mcpEntries: TrustGatedMcpEntry[]; providers: TrustGatedSecretProvider[]; settings: TrustGatedSetting[] }
): string {
  const held = [
    ...(withheld.providers.length > 0
      ? [`secret providers (${withheld.providers.map((provider) => provider.name).join(", ")})`]
      : []),
    ...(withheld.mcpEntries.length > 0
      ? [
          `MCP entries that can start or reach servers (${withheld.mcpEntries.map((entry) => (entry.kind === "pass_env" ? `passEnv ${entry.name}` : `${entry.kind} ${entry.name}`)).join(", ")})`
        ]
      : []),
    ...(withheld.settings.length > 0
      ? [`settings that need trust (${withheld.settings.map((setting) => setting.path).join(", ")})`]
      : [])
  ];
  return (
    `The workspace config "${configPath}" declares ${held.join(" and ")}, and this exact file has not been trusted. ` +
    "They will not be used. Run `aia trust` in this workspace to see what they would do, then grant it if you agree."
  );
}

function describeUntrustedApprovals(approvals: ApprovalsTrustEvaluation): string {
  const held = [
    ...(approvals.withheld.allowRules.length > 0 ? [`${approvals.withheld.allowRules.length} allow rule(s)`] : []),
    ...(approvals.withheld.defaultMode
      ? [
          `defaultMode "${approvals.withheld.defaultMode.requested}" (yours is "${approvals.withheld.defaultMode.current}")`
        ]
      : [])
  ];
  return (
    `The workspace approvals file "${approvals.path}" asks for ${held.join(" and ")}, and this exact file has not been ` +
    "trusted, so only its deny and ask rules apply. Run `aia trust` in this workspace to review it."
  );
}
