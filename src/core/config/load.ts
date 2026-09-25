import path from "node:path";

import { ZodError, type ZodType, type ZodTypeDef } from "zod";

import { buildEnvironmentOverrides } from "@/core/config/env-overrides";
import { readJsoncFileIfExists } from "@/core/config/jsonc";
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
  type ApprovalSettings
} from "@/core/config/schema";
import { resolveConfigSecrets } from "@/core/config/secrets";
import {
  collectTrustGatedProviderNames,
  fingerprintConfigFile,
  isConfigTrusted,
  readConfigTrustStore,
  type ConfigFingerprint
} from "@/core/config/trust";

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export type WorkspaceConfigTrust = {
  /**
   * Fingerprint of the workspace config when it declares a trust-gated
   * provider; null when it declares none, or when the file can no longer be read.
   */
  fingerprint: ConfigFingerprint | null;
  /** True when the workspace config declares a trust-gated (`exec`/`file`) secret provider. */
  required: boolean;
  trusted: boolean;
  /** Providers held back because this config is not trusted. */
  untrustedProviderNames: string[];
};

export type LoadedAIAgentConfig = {
  approvals: ApprovalSettings;
  config: AppConfig;
  paths: ResolvedConfigPaths;
  resolvedConfig: AppConfig;
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
  const workspaceConfigFragment = await loadFragment(
    paths.workspaceConfigPath,
    "workspace config",
    appConfigFragmentSchema
  );
  const globalApprovalsFragment = await loadFragment(
    paths.globalApprovalsPath,
    "global approvals",
    approvalSettingsFragmentSchema
  );
  const workspaceApprovalsFragment = await loadFragment(
    paths.workspaceApprovalsPath,
    "workspace approvals",
    approvalSettingsFragmentSchema
  );
  const environmentOverrides = parseEnvironmentOverrides(env);

  const mergedConfig = deepMerge(
    normalizeConfigFragmentPaths(
      createDefaultAppConfig({ userStateDirectory: paths.userStateDirectory }),
      paths.workspaceRoot
    ) as unknown,
    ...globalConfigLayers.map((layer) => normalizeConfigLayer(layer.fragment, layer.path) as unknown),
    normalizeConfigLayer(workspaceConfigFragment, paths.workspaceConfigPath) as unknown,
    normalizeConfigFragmentPaths(environmentOverrides.config, paths.workspaceRoot) as unknown
  ) as unknown;
  const config = parseMerged<AppConfig>(appConfigSchema, mergedConfig, "merged runtime config");

  const mergedApprovals = deepMerge(
    DEFAULT_APPROVAL_SETTINGS,
    globalApprovalsFragment ?? undefined,
    workspaceApprovalsFragment ?? undefined,
    environmentOverrides.approvals
  );
  const approvals = parseMerged(approvalSettingsSchema, mergedApprovals, "merged approval settings");

  // Security review H3: a workspace config discovered by walking up from cwd
  // can declare `exec`/`file` secret providers, which run a command or read an
  // arbitrary path on load. Those stay inert until the operator trusts this
  // exact file and its exact contents.
  const workspaceTrust = await resolveWorkspaceConfigTrust({
    fragment: workspaceConfigFragment,
    workspaceConfigPath: paths.workspaceConfigPath,
    userStateDirectory: paths.userStateDirectory
  });

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
  const raw = await readJsoncFileIfExists(filePath);
  if (raw === null) {
    return null;
  }

  try {
    return schema.parse(raw);
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
 * Decides whether this workspace's config may use its trust-gated secret
 * providers (security review H3).
 *
 * Fails closed and *continues*: untrusted providers are simply withheld, with
 * one warning naming them. Nothing breaks unless a config value actually
 * references one, in which case that resolution raises a
 * `SecretResolutionError` explaining how to grant trust. Refusing to load
 * outright would block every headless surface over a provider nothing uses.
 */
async function resolveWorkspaceConfigTrust(params: {
  fragment: AppConfigFragment | null;
  userStateDirectory: string;
  workspaceConfigPath: string;
}): Promise<WorkspaceConfigTrust> {
  const gatedProviderNames = collectTrustGatedProviderNames(params.fragment);
  if (gatedProviderNames.length === 0) {
    return {
      fingerprint: null,
      required: false,
      trusted: true,
      untrustedProviderNames: []
    };
  }

  const fingerprint = await fingerprintConfigFile(params.workspaceConfigPath);
  if (!fingerprint) {
    // The fragment came from somewhere we can no longer read; withhold rather
    // than assume.
    return {
      fingerprint: null,
      required: true,
      trusted: false,
      untrustedProviderNames: gatedProviderNames
    };
  }

  const store = await readConfigTrustStore(params.userStateDirectory);
  if (isConfigTrusted(store, fingerprint)) {
    return {
      fingerprint,
      required: true,
      trusted: true,
      untrustedProviderNames: []
    };
  }

  process.emitWarning(
    `The workspace config "${fingerprint.path}" declares secret provider(s) that can run commands or read ` +
      `arbitrary files (${gatedProviderNames.join(", ")}), and this exact file has not been trusted. ` +
      "They will not be used. Run `aia trust` in this workspace to see what they would do, then grant it if you agree.",
    { code: "AIA_UNTRUSTED_CONFIG" }
  );

  return {
    fingerprint,
    required: true,
    trusted: false,
    untrustedProviderNames: gatedProviderNames
  };
}
