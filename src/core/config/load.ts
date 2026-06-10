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

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export type LoadedAIAgentConfig = {
  approvals: ApprovalSettings;
  config: AppConfig;
  paths: ResolvedConfigPaths;
  resolvedConfig: AppConfig;
  sources: {
    approvals: {
      env: boolean;
      global: string | null;
      workspace: string | null;
    };
    config: {
      env: boolean;
      global: string | null;
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

  const globalConfigFragment = await loadFragment(paths.globalConfigPath, "global config", appConfigFragmentSchema);
  const workspaceConfigFragment = await loadFragment(paths.workspaceConfigPath, "workspace config", appConfigFragmentSchema);
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
    normalizeConfigFragmentPaths(createDefaultAppConfig({ userStateDirectory: paths.userStateDirectory }), paths.workspaceRoot) as unknown,
    normalizeConfigLayer(globalConfigFragment, paths.globalConfigPath) as unknown,
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

  const resolvedConfig = params.resolveSecrets === false ? config : await resolveConfigSecrets(config, env);

  return {
    approvals,
    config,
    paths,
    resolvedConfig,
    sources: {
      approvals: {
        env: Object.keys(environmentOverrides.approvals).length > 0,
        global: globalApprovalsFragment ? paths.globalApprovalsPath : null,
        workspace: workspaceApprovalsFragment ? paths.workspaceApprovalsPath : null
      },
      config: {
        env: Object.keys(environmentOverrides.config).length > 0,
        global: globalConfigFragment ? paths.globalConfigPath : null,
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

async function loadFragment<T>(filePath: string, label: string, schema: ZodType<T, ZodTypeDef, unknown>): Promise<T | null> {
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
