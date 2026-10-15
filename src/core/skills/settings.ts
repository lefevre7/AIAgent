import { editConfigFile, readConfigFileText, type ResolvedConfigPaths } from "@/core/config";
import { parseJsoncText } from "@/core/config/jsonc";

/**
 * Adds `name` to, or removes it from, `skills.disabled` in the config file at
 * `configPath`. The rest of the file, comments included, is left as it was
 * (see `editConfigFile`), and a missing file is created.
 */
export async function setSkillDisabledInConfigFile(params: {
  configPath: string;
  /** Resolved paths, so an edit to the workspace config keeps its trust when it may. */
  configPaths?: ResolvedConfigPaths;
  disabled: boolean;
  name: string;
}): Promise<{ changed: boolean; disabled: string[] }> {
  let disabled: string[] = [];
  const { written } = await editConfigFile({
    configPath: params.configPath,
    ...(params.configPaths ? { configPaths: params.configPaths } : {}),
    edits: (current) => {
      const before = skillsDisabledOf(current);
      disabled = params.disabled
        ? before.includes(params.name)
          ? before
          : [...before, params.name]
        : before.filter((entry) => entry !== params.name);
      return disabled.length === before.length ? [] : [{ path: ["skills", "disabled"], value: disabled }];
    }
  });
  return { changed: written, disabled };
}

/** The `skills.disabled` list a config file declares (empty when it has none). */
export async function readSkillsDisabled(configPath: string): Promise<string[]> {
  const file = await readConfigFileText(configPath);
  return file === null ? [] : skillsDisabledOf(parseJsoncText(file.text, configPath));
}

function skillsDisabledOf(config: unknown): string[] {
  const skills = typeof config === "object" && config !== null ? (config as { skills?: unknown }).skills : undefined;
  const disabled =
    typeof skills === "object" && skills !== null ? (skills as { disabled?: unknown }).disabled : undefined;
  return Array.isArray(disabled) ? disabled.filter((entry): entry is string => typeof entry === "string") : [];
}
