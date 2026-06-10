import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { APPROVALS_CONFIG_FILE_NAME, APP_CONFIG_FILE_NAME, DEFAULT_GLOBAL_APPROVALS_PATH, DEFAULT_GLOBAL_CONFIG_PATH, USER_STATE_DIRECTORY_NAME } from "@/core/config/constants";

export type ResolvedConfigPaths = {
  globalApprovalsPath: string;
  globalConfigPath: string;
  userStateDirectory: string;
  workspaceApprovalsPath: string;
  workspaceConfigPath: string;
  workspaceRoot: string;
};

export async function resolveConfigPaths(params: {
  cwd: string;
  env?: Record<string, string | undefined>;
  userHomeDirectory?: string;
}): Promise<ResolvedConfigPaths> {
  const env = params.env ?? process.env;
  const userHomeDirectory = params.userHomeDirectory ?? os.homedir();
  const userStateDirectory = path.join(userHomeDirectory, USER_STATE_DIRECTORY_NAME);

  const explicitWorkspaceConfig = env.AIA_CONFIG_PATH ? resolveAbsolutePath(env.AIA_CONFIG_PATH, params.cwd) : null;
  const explicitWorkspaceApprovals = env.AIA_APPROVALS_PATH
    ? resolveAbsolutePath(env.AIA_APPROVALS_PATH, params.cwd)
    : null;

  const discoveredWorkspaceConfig =
    explicitWorkspaceConfig ?? (await findNearestFile(params.cwd, APP_CONFIG_FILE_NAME));
  const discoveredWorkspaceApprovals =
    explicitWorkspaceApprovals ?? (await findNearestFile(params.cwd, APPROVALS_CONFIG_FILE_NAME));

  const workspaceRoot = path.dirname(
    discoveredWorkspaceConfig ?? discoveredWorkspaceApprovals ?? path.resolve(params.cwd)
  );

  return {
    globalApprovalsPath: env.AIA_USER_APPROVALS_PATH
      ? resolveAbsolutePath(env.AIA_USER_APPROVALS_PATH, params.cwd)
      : DEFAULT_GLOBAL_APPROVALS_PATH.replace(os.homedir(), userHomeDirectory),
    globalConfigPath: env.AIA_USER_CONFIG_PATH
      ? resolveAbsolutePath(env.AIA_USER_CONFIG_PATH, params.cwd)
      : DEFAULT_GLOBAL_CONFIG_PATH.replace(os.homedir(), userHomeDirectory),
    userStateDirectory,
    workspaceApprovalsPath: discoveredWorkspaceApprovals ?? path.join(workspaceRoot, APPROVALS_CONFIG_FILE_NAME),
    workspaceConfigPath: discoveredWorkspaceConfig ?? path.join(workspaceRoot, APP_CONFIG_FILE_NAME),
    workspaceRoot
  };
}

export function resolveAbsolutePath(value: string, baseDirectory: string): string {
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }

  return path.isAbsolute(value) ? value : path.resolve(baseDirectory, value);
}

async function findNearestFile(startDirectory: string, fileName: string): Promise<string | null> {
  let current = path.resolve(startDirectory);

  while (true) {
    const candidate = path.join(current, fileName);
    if (await pathExists(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
