import YAML from "yaml";

import type { SkillRecord } from "@/core/skills/types";

// The Agent Skills spec's limits. Parsing is lenient about them (a skill
// written for another client still loads, with a warning), per the spec's own
// client-implementation guide.
export const MAX_SKILL_NAME_LENGTH = 64;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1_024;
const MAX_SKILL_COMPATIBILITY_LENGTH = 500;
const SPEC_SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
// What a `$name` mention can reach (src/core/skills/mentions.ts).
const MENTIONABLE_SKILL_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_:-]*$/u;
/**
 * Names that, written in capitals, are almost always a shell variable, never
 * a skill (Codex's list): `$HOME` in a message names no skill. Only the
 * capitals: `$home` can name a skill.
 */
export const SHELL_VARIABLE_NAMES: ReadonlySet<string> = new Set([
  "HOME",
  "LANG",
  "PATH",
  "PWD",
  "SHELL",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "XDG_CONFIG_HOME"
]);

export type ParsedSkill = Omit<SkillRecord, "directory" | "enabled" | "filePath" | "scope">;

export type SkillParseResult = { ok: true; skill: ParsedSkill; warnings: string[] } | { error: string; ok: false };

/**
 * Parses a SKILL.md: YAML frontmatter between `---` lines, then the Markdown
 * instructions.
 *
 * A description is the one thing a skill cannot do without (it is how the
 * model decides to use it), so a missing one, or frontmatter that is not YAML
 * even after repair, is an error and the skill is skipped. Everything else the
 * spec asks for (a lowercase-hyphenated name that matches its directory, the
 * length limits) is a warning: the skill still loads.
 */
export function parseSkillFile(content: string, directoryName: string): SkillParseResult {
  const lines = content.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  // Blank lines before the opening --- are skipped, as they were before.
  const opening = lines.findIndex((line) => line.trim().length > 0);
  if (opening < 0 || lines[opening]!.trim() !== "---") {
    return parseWithoutFrontmatter(lines, directoryName);
  }
  const closing = lines.findIndex((line, index) => index > opening && line.trim() === "---");
  if (closing < 0) {
    return { error: "the YAML frontmatter is never closed with ---", ok: false };
  }

  const parsed = parseFrontmatter(lines.slice(opening + 1, closing).join("\n"));
  if (!parsed.ok) {
    return parsed;
  }
  const frontmatter = parsed.value;
  const warnings: string[] = [...parsed.warnings];

  const description = collapse(frontmatter.description);
  if (!description) {
    return { error: "missing field `description`", ok: false };
  }
  warnings.push(...descriptionWarnings(description));

  const declaredName = collapse(frontmatter.name);
  const name = declaredName || directoryName;
  if (!declaredName) {
    warnings.push("missing field `name`; using the directory name");
  } else if (declaredName !== directoryName) {
    warnings.push(`name "${declaredName}" does not match its directory "${directoryName}"`);
  }
  warnings.push(...nameWarnings(name));

  const compatibility = collapse(frontmatter.compatibility);
  if (compatibility && compatibility.length > MAX_SKILL_COMPATIBILITY_LENGTH) {
    warnings.push(
      `compatibility is ${compatibility.length} characters; the spec allows ${MAX_SKILL_COMPATIBILITY_LENGTH}`
    );
  }
  const license = collapse(frontmatter.license);

  return {
    ok: true,
    skill: {
      allowedTools: readAllowedTools(frontmatter["allowed-tools"]),
      body: lines
        .slice(closing + 1)
        .join("\n")
        .trim(),
      ...(compatibility ? { compatibility } : {}),
      description,
      disableModelInvocation: frontmatter["disable-model-invocation"] === true,
      ...(license ? { license } : {}),
      metadata: readMetadata(frontmatter.metadata),
      name
    },
    warnings
  };
}

/**
 * A SKILL.md with no frontmatter, as aia loaded one before it followed the
 * spec: named after its directory, its first line that is not a heading the
 * description. It still loads that way, with a warning naming the format to
 * use; one with no such line has nothing to describe it, and is an error.
 */
function parseWithoutFrontmatter(lines: string[], directoryName: string): SkillParseResult {
  const description = lines.map((line) => line.trim()).find((line) => line.length > 0 && !line.startsWith("#"));
  if (!description) {
    return {
      error: "missing YAML frontmatter delimited by ---, and no line that is not a heading to describe the skill",
      ok: false
    };
  }
  return {
    ok: true,
    skill: {
      allowedTools: [],
      body: lines.join("\n").trim(),
      description,
      disableModelInvocation: false,
      metadata: {},
      name: directoryName
    },
    warnings: [
      "has no YAML frontmatter, so its first line became the description and its directory the name; start it with a --- block holding `name` and `description` (the format Codex and Claude Code read)",
      ...descriptionWarnings(description),
      ...nameWarnings(directoryName)
    ]
  };
}

function descriptionWarnings(description: string): string[] {
  return description.length > MAX_SKILL_DESCRIPTION_LENGTH
    ? [`description is ${description.length} characters; the spec allows ${MAX_SKILL_DESCRIPTION_LENGTH}`]
    : [];
}

function nameWarnings(name: string): string[] {
  const warnings: string[] = [];
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    warnings.push(`name is ${name.length} characters; the spec allows ${MAX_SKILL_NAME_LENGTH}`);
  }
  if (SHELL_VARIABLE_NAMES.has(name)) {
    warnings.push(`name "${name}" cannot be mentioned: $${name} is read as a shell variable; use lowercase letters`);
  } else if (!SPEC_SKILL_NAME_PATTERN.test(name)) {
    warnings.push(
      MENTIONABLE_SKILL_NAME_PATTERN.test(name)
        ? `name "${name}" is not lowercase letters, digits, and single hyphens, as the spec asks`
        : `name "${name}" cannot be mentioned as $${name}; use lowercase letters, digits, and hyphens`
    );
  }
  return warnings;
}

function parseFrontmatter(
  text: string
): { ok: true; value: Record<string, unknown>; warnings: string[] } | { error: string; ok: false } {
  let parsed: { value: unknown; warnings: string[] };
  try {
    parsed = parseYaml(text);
  } catch (error) {
    if (error instanceof YamlAliasError) {
      // Not sloppiness the repair below is for: quoting would quietly turn
      // the alias into a string.
      return { error: `invalid YAML: ${error.message}`, ok: false };
    }
    // Skills written for other clients often have values their parsers accept
    // but YAML does not, above all an unquoted value containing ": "
    // (`description: Use this when: …`). Quote those and try once more.
    try {
      parsed = parseYaml(repairFrontmatter(text));
    } catch {
      return { error: `invalid YAML: ${firstLine(error)}`, ok: false };
    }
  }
  const { value } = parsed;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: "frontmatter is not a YAML mapping", ok: false };
  }
  return { ok: true, value: value as Record<string, unknown>, warnings: parsed.warnings };
}

/**
 * Frontmatter comes from any repository, so it is parsed defensively. Aliases
 * (`&a` / `*a`) are refused: no skill needs one, an alias can make a structure
 * that refers to itself (which crashed every run in a workspace holding one),
 * and alias chains are the classic way to make a small file expand into a
 * huge value. The YAML library's own warnings come back as skill warnings
 * instead of being printed straight to the operator's terminal.
 */
function parseYaml(text: string): { value: unknown; warnings: string[] } {
  const document = YAML.parseDocument(text, { logLevel: "silent" });
  const [first] = document.errors;
  if (first) {
    throw first;
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw error instanceof ReferenceError ? new YamlAliasError() : error;
  }
  return { value, warnings: document.warnings.map((warning) => `YAML: ${firstLine(warning)}`) };
}

class YamlAliasError extends Error {
  constructor() {
    super("anchors and aliases (&name, *name) are not allowed");
    this.name = "YamlAliasError";
  }
}

/**
 * Codex's repair for sloppy frontmatter: a `key: value` line whose value
 * contains ": ", or starts with a character YAML reads as syntax, is
 * single-quoted (`'` doubled). Block scalars and quoted values are left alone,
 * as is a flow value that already parses.
 */
export function repairFrontmatter(text: string): string {
  let blockIndent: number | null = null;
  return text
    .split("\n")
    .map((line) => {
      const indent = line.length - line.trimStart().length;
      if (blockIndent !== null) {
        if (line.trim().length === 0 || indent > blockIndent) {
          return line;
        }
        blockIndent = null;
      }
      // Greedy, and the value trimmed afterwards: a lazy `(.*?)\s*$` backtracks
      // quadratically on a long run of spaces, and a SKILL.md may be 1 MiB.
      const match = /^(\s*)([A-Za-z0-9_.-]+):[ \t]+(.*)$/u.exec(line);
      if (!match) {
        return line;
      }
      const [, lead = "", key = ""] = match;
      const value = (match[3] ?? "").trimEnd();
      // A block scalar's header: `|` or `>`, an indentation indicator and a
      // chomping indicator in either order (`|2-`, `>-2`), maybe a comment.
      if (/^[|>](?:[1-9][+-]?|[+-][1-9]?)?(?:[ \t]+#.*)?$/u.test(value)) {
        blockIndent = lead.length;
        return line;
      }
      if (/^["']/u.test(value)) {
        return line;
      }
      const risky = value.includes(": ") || value.endsWith(":") || /^[[{@`]/u.test(value);
      if (!risky || (/^[[{]/u.test(value) && parsesAsValue(value))) {
        return line;
      }
      return `${lead}${key}: '${value.replace(/'/gu, "''")}'`;
    })
    .join("\n");
}

function parsesAsValue(value: string): boolean {
  try {
    parseYaml(`value: ${value}`);
    return true;
  } catch {
    return false;
  }
}

function collapse(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function readAllowedTools(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(/\s+/u).filter((entry) => entry.length > 0);
  }
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

// The spec's `metadata` is a map of string to string; anything else is kept as text.
function readMetadata(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      typeof entry === "string" ? entry : typeof entry === "object" ? stringifyValue(entry) : String(entry)
    ])
  );
}

function stringifyValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Unreachable with aliases refused, but a value that cannot be written
    // as JSON must not take the whole skill down.
    return String(value);
  }
}

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0] ?? message;
}
