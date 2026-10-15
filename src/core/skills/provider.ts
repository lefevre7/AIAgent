import fs from "node:fs/promises";

import type { LoadedAIAgentConfig } from "@/core/config/load";
import { configTrustFilePath } from "@/core/config/trust";
import { DEFAULT_SKILLS_SETTINGS, findSkills, type SkillsSettings } from "@/core/skills/discovery";
import type { SkillDiscovery } from "@/core/skills/types";

/**
 * The skills for a working directory, found the same way for every consumer:
 * the agent loop (catalog, `$name` mentions), the `skill` tool, and
 * `skills.list`. One provider per config, so all three always agree.
 */
export interface SkillProvider {
  discover(cwd: string): Promise<SkillDiscovery>;
  /** The settings the latest discovery used. */
  readonly settings: SkillsSettings;
}

export function createSkillProvider(
  options: {
    bundledRoot?: string | null;
    projectRootMarkers?: string[];
    /**
     * The settings, or a function giving the current ones, asked at each
     * discovery (see `followSkillsSettings`): a running session follows
     * `aia skills disable` without a restart.
     */
    settings?: SkillsSettings | (() => Promise<SkillsSettings>);
    userHomeDirectory?: string;
  } = {}
): SkillProvider {
  const source = options.settings;
  let settings = typeof source === "object" ? source : DEFAULT_SKILLS_SETTINGS;
  return {
    discover: async (cwd) => {
      if (typeof source === "function") {
        settings = await source();
      }
      return findSkills({
        ...(options.bundledRoot !== undefined ? { bundledRoot: options.bundledRoot } : {}),
        cwd,
        ...(options.projectRootMarkers ? { projectRootMarkers: options.projectRootMarkers } : {}),
        settings,
        ...(options.userHomeDirectory ? { userHomeDirectory: options.userHomeDirectory } : {})
      });
    },
    get settings() {
      return settings;
    }
  };
}

/**
 * Skills settings that follow the config files, for a long-running host: a
 * change made while it runs (`aia skills disable` in another terminal) applies
 * from the next discovery. Each discovery only stats the config files and the
 * trust store (which decides whether a workspace's skill settings count); a
 * change to one of them reloads the config. The files are first read as
 * `loaded` was, so an unchanged file never reloads.
 */
export async function followSkillsSettings(params: {
  loaded: LoadedAIAgentConfig;
  reload: () => Promise<LoadedAIAgentConfig>;
}): Promise<() => Promise<SkillsSettings>> {
  const files = [
    ...params.loaded.paths.globalConfigPaths,
    params.loaded.paths.workspaceConfigPath,
    configTrustFilePath(params.loaded.paths.userStateDirectory)
  ];
  let signature = await signatureOf(files);
  let settings = skillsSettingsFromLoadedConfig(params.loaded);
  return async () => {
    const current = await signatureOf(files);
    if (current !== signature) {
      signature = current;
      try {
        settings = skillsSettingsFromLoadedConfig(await params.reload());
      } catch (error) {
        // A file caught mid-edit, or broken: the settings in use stay, and the
        // next change to the files tries again.
        console.warn(
          `[AIA_SKILLS_SETTINGS_RELOAD_FAILED] The config changed, but reading its skills settings failed; the previous ones stay in use: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
    return settings;
  };
}

async function signatureOf(files: string[]): Promise<string> {
  const parts = await Promise.all(
    files.map(async (file) => {
      const stat = await fs.stat(file).catch(() => null);
      return stat ? `${stat.mtimeMs}:${stat.size}` : "-";
    })
  );
  return parts.join("|");
}

/**
 * The skills settings a loaded config gives discovery: its `skills` section,
 * with roots a workspace config contributed searched like the project's own.
 */
export function skillsSettingsFromLoadedConfig(
  loaded: Pick<LoadedAIAgentConfig, "resolvedConfig" | "workspaceSkillExtraRoots">
): SkillsSettings {
  return {
    ...loaded.resolvedConfig.skills,
    ...(loaded.workspaceSkillExtraRoots ? { extraRootsScope: "project" as const } : {})
  };
}
