import path from "node:path";
import { parseArgs } from "node:util";

import {
  chooseUserConfigFile,
  createSkillProvider,
  readSkillsDisabled,
  setSkillDisabledInConfigFile,
  skillsSettingsFromLoadedConfig,
  toSkillSummary,
  type LoadedAIAgentConfig,
  type SkillDiagnostic,
  type SkillSummary
} from "@/core";
import { loadCommandConfig, runSubcommands, sanitizeForTerminal, writeLine, type CliStreams } from "@/commands/io";

export function formatSkillsHelp(): string {
  return [
    "aia skills — Agent Skills (SKILL.md folders) the agent can load. See docs/SKILLS.md.",
    "",
    "  aia skills list [--json] [--cwd <path>]",
    "                            List the skills that apply here, where each was found, and any",
    "                            SKILL.md that could not be used",
    "  aia skills disable <name> Stop using a skill (adds it to skills.disabled in your user config,",
    "                            ~/.aia/config.jsonc when it exists)",
    "  aia skills enable <name>  Use it again (removes it from skills.disabled in every file listing it)",
    "",
    "In a message, $skill-name loads that skill for the task."
  ].join("\n");
}

export async function runSkillsCli(
  args: string[],
  streams: CliStreams,
  deps: { userHomeDirectory?: string } = {}
): Promise<number> {
  return runSubcommands({
    args,
    command: "skills",
    handlers: {
      disable: (options) => setSkillDisabled(options, streams, deps, true),
      enable: (options) => setSkillDisabled(options, streams, deps, false),
      list: (options) => listSkills(options, streams, deps)
    },
    help: formatSkillsHelp,
    streams
  });
}

type SkillsCliDependencies = { userHomeDirectory?: string };

// Nothing here needs a secret, so no secret provider runs.
function loadConfig(cwd: string, deps: SkillsCliDependencies) {
  return loadCommandConfig({ cwd, resolveSecrets: false, userHomeDirectory: deps.userHomeDirectory });
}

function discover(loaded: LoadedAIAgentConfig, deps: SkillsCliDependencies, cwd: string) {
  return createSkillProvider({
    settings: skillsSettingsFromLoadedConfig(loaded),
    ...(deps.userHomeDirectory ? { userHomeDirectory: deps.userHomeDirectory } : {})
  }).discover(cwd);
}

async function listSkills(args: string[], streams: CliStreams, deps: SkillsCliDependencies): Promise<number> {
  const { values } = parseArgs({ args, options: { cwd: { type: "string" }, json: { type: "boolean" } } });
  const cwd = values.cwd ? path.resolve(values.cwd) : process.cwd();
  const discovery = await discover(await loadConfig(cwd, deps), deps, cwd);
  const listing = { diagnostics: discovery.diagnostics, skills: discovery.skills.map(toSkillSummary) };
  writeLine(streams.stdout, values.json ? JSON.stringify(listing, null, 2) : formatSkillList(listing));
  return 0;
}

async function setSkillDisabled(
  args: string[],
  streams: CliStreams,
  deps: SkillsCliDependencies,
  disabled: boolean
): Promise<number> {
  const subcommand = disabled ? "disable" : "enable";
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { cwd: { type: "string" } } });
  const [name, ...extra] = positionals;
  if (!name || extra.length > 0) {
    writeLine(streams.stderr, `Usage: aia skills ${subcommand} <name>`);
    return 1;
  }
  const cwd = values.cwd ? path.resolve(values.cwd) : process.cwd();
  const loaded = await loadConfig(cwd, deps);
  const shown = sanitizeForTerminal(name, { singleLine: true });
  // skills.disabled adds up across the files (docs/CONFIG.md): every file
  // here that lists the name, user files first, then the workspace config.
  const listing: string[] = [];
  for (const configPath of [...loaded.paths.globalConfigPaths, loaded.paths.workspaceConfigPath]) {
    if ((await readSkillsDisabled(configPath)).includes(name)) {
      listing.push(configPath);
    }
  }
  if (disabled) {
    if (listing.length > 0) {
      writeLine(streams.stdout, `"${shown}" is already disabled in ${listing.join(" and ")}.`);
    } else {
      const configPath = await chooseUserConfigFile(loaded.paths);
      await setSkillDisabledInConfigFile({ configPath, configPaths: loaded.paths, disabled: true, name });
      writeLine(streams.stdout, `Disabled "${shown}" in ${configPath}.`);
    }
  } else if (listing.length === 0) {
    writeLine(streams.stdout, `"${shown}" was not disabled: no config file here lists it in skills.disabled.`);
  } else {
    // From every file that lists it: a list left behind would keep it off.
    for (const configPath of listing) {
      await setSkillDisabledInConfigFile({ configPath, configPaths: loaded.paths, disabled: false, name });
    }
    writeLine(streams.stdout, `Enabled "${shown}": removed it from skills.disabled in ${listing.join(" and ")}.`);
  }

  // What the change means here: a typo names no skill at all, and an entry
  // can name a skill by its SKILL.md path instead.
  const reloaded = await loadConfig(cwd, deps);
  const skill = (await discover(reloaded, deps, cwd)).skills.find((candidate) => candidate.name === name);
  if (!skill) {
    writeLine(streams.stdout, `No skill named "${shown}" is found from ${cwd}; the setting applies if one appears.`);
  } else if (!disabled && !skill.enabled) {
    writeLine(
      streams.stdout,
      `"${shown}" is still disabled here: skills.disabled lists its file, ${sanitizeForTerminal(skill.filePath, { singleLine: true })}.`
    );
  }
  return 0;
}

export function formatSkillList(listing: { diagnostics: SkillDiagnostic[]; skills: SkillSummary[] }): string {
  const lines: string[] = [];
  if (listing.skills.length === 0) {
    lines.push("No skills found. Add one as .agents/skills/<name>/SKILL.md (docs/SKILLS.md).");
  }
  // Names, descriptions and paths come from SKILL.md files, a cloned repo's
  // included: printed through sanitizeForTerminal so they cannot drive the
  // terminal.
  const one = (text: string) => sanitizeForTerminal(text, { singleLine: true });
  for (const skill of listing.skills) {
    const notes = [
      skill.scope,
      ...(skill.enabled ? [] : ["disabled"]),
      ...(skill.disableModelInvocation ? [`only as $${skill.name}`] : [])
    ];
    // Cut by code point, so an emoji at the cut is not split in half.
    const characters = Array.from(skill.description);
    const description = characters.length > 120 ? `${characters.slice(0, 119).join("")}…` : skill.description;
    lines.push(`${one(skill.name)}  [${one(notes.join(", "))}]  ${one(description)}`, `  ${one(skill.filePath)}`);
  }
  if (listing.diagnostics.length > 0) {
    lines.push("", "Notes:");
    for (const diagnostic of listing.diagnostics) {
      lines.push(`  ${diagnostic.severity}: ${one(diagnostic.path)}: ${one(diagnostic.message)}`);
    }
  }
  return lines.join("\n");
}
