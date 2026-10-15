import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { APP_CONFIG_FILE_NAME } from "@/core/config/constants";
import type { LoadedAIAgentConfig } from "@/core/config/load";

/**
 * Raised when the state directory cannot be created or written.
 *
 * Every runtime surface writes under `memory.stateRoot` (sessions, logs, the
 * model queue), so it is checked once, before anything else starts. Left to
 * whichever service wrote first, the failure surfaced as a bare errno
 * ("EACCES: permission denied, mkdir '/Users/.aia'") that named neither the
 * rule that chose the directory nor a way to move it — and, when it came
 * after the MCP servers were spawned, it left them running.
 */
export class StateRootUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StateRootUnavailableError";
  }
}

export async function ensureStateRootWritable(
  loaded: Pick<LoadedAIAgentConfig, "paths" | "resolvedConfig" | "sources">
): Promise<string> {
  const stateRoot = loaded.resolvedConfig.memory.stateRoot;
  try {
    await fs.mkdir(stateRoot, { recursive: true });
    await fs.access(stateRoot, fsConstants.W_OK);
  } catch (error) {
    throw new StateRootUnavailableError(describeStateRootFailure(loaded, stateRoot, error), { cause: error });
  }
  return stateRoot;
}

function describeStateRootFailure(
  loaded: Pick<LoadedAIAgentConfig, "paths" | "sources">,
  stateRoot: string,
  error: unknown
): string {
  const workspaceRoot = path.resolve(loaded.paths.workspaceRoot);
  const workspaceConfig = loaded.sources.config.workspace;
  const where =
    path.resolve(stateRoot) !== path.join(workspaceRoot, ".aia")
      ? "memory.stateRoot (or AIA_MEMORY_STATE_ROOT) points there."
      : workspaceConfig
        ? `The workspace is ${workspaceRoot}, the directory holding ${path.basename(workspaceConfig)}, and state lives in its .aia folder.`
        : `No ${APP_CONFIG_FILE_NAME} was found from ${workspaceRoot} upward, so the workspace is the directory aia started in, and state lives in its .aia folder.`;

  return [
    `Cannot create or write the state directory ${stateRoot} (${describeFileSystemError(error)}).`,
    where,
    "Start aia in a directory you can write to, or set memory.stateRoot (or AIA_MEMORY_STATE_ROOT) to a writable directory."
  ].join(" ");
}

function describeFileSystemError(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
  switch (code) {
    case "EACCES":
    case "EPERM":
      return "permission denied";
    case "EROFS":
      return "read-only file system";
    case "ENOSPC":
      return "no space left on the device";
    default:
      return error instanceof Error ? error.message : String(error);
  }
}
