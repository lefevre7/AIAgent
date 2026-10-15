import fs from "node:fs/promises";
import path from "node:path";

import { compareCodePoints, selectModelVisibleSkills, SKILL_FILE_NAME } from "@/core/skills/discovery";
import { MAX_SKILL_DESCRIPTION_LENGTH } from "@/core/skills/parse";
import type { SkillDiagnostic, SkillRecord } from "@/core/skills/types";
import { sliceUtf16 } from "@/core/text/strings";

// Codex's budget: the catalog gets 2% of the model's context window, or 8,000
// characters when the window is unknown. Tokens are estimated at 4 characters.
export const DEFAULT_SKILL_CATALOG_CHARS = 8_000;
const CATALOG_CONTEXT_WINDOW_FRACTION = 0.02;
const CHARS_PER_TOKEN = 4;
const TRUNCATION_MARK = "…";

export function resolveSkillCatalogBudgetChars(params: { configured?: number; contextWindowTokens?: number }): number {
  if (params.configured !== undefined) {
    return params.configured;
  }
  if (params.contextWindowTokens) {
    return Math.floor(params.contextWindowTokens * CATALOG_CONTEXT_WINDOW_FRACTION * CHARS_PER_TOKEN);
  }
  return DEFAULT_SKILL_CATALOG_CHARS;
}

export type SkillCatalog = {
  /** Skills left out entirely because even their names did not fit. */
  omitted: number;
  /** The `<available_skills>` block, or "" when there are no skills. */
  text: string;
  /** Skills whose descriptions were shortened (or dropped) to fit. */
  trimmed: number;
};

/**
 * The skills the model can load, one line each, within a character budget.
 *
 * Only names, descriptions, and locations go here; the instructions load on
 * demand. That is the Agent Skills
 * "progressive disclosure" model: a catalog of dozens of skills costs a few
 * hundred tokens, and only the skills a task needs pay for their bodies.
 *
 * Fitting follows Codex: descriptions are capped at 1,024 characters; when the
 * list is still over budget, the space left after the names is shared out
 * evenly across the descriptions; when the names alone do not fit, the list
 * stops and a closing line says how many skills it left out.
 */
export function renderSkillCatalog(skills: SkillRecord[], options: { budgetChars: number }): SkillCatalog {
  if (skills.length === 0) {
    return { omitted: 0, text: "", trimmed: 0 };
  }

  const descriptions = skills.map((skill) => escapeXml(sliceUtf16(skill.description, MAX_SKILL_DESCRIPTION_LENGTH)));
  // The location lets the model read the file itself (and find the files
  // beside it) whether or not it has the `skill` tool. The scope tells a
  // cloned repository's skill (project) from the operator's own.
  const lineFor = (skill: SkillRecord, description: string) =>
    `<skill><name>${escapeXml(skill.name)}</name>${
      description ? `<description>${description}</description>` : ""
    }<scope>${skill.scope}</scope><location>${escapeXml(skill.filePath)}</location></skill>`;
  const budget = options.budgetChars - wrap([]).length;

  const full = skills.map((skill, index) => lineFor(skill, descriptions[index]!));
  if (totalLength(full) <= budget) {
    return { omitted: 0, text: wrap(full), trimmed: 0 };
  }

  const bare = skills.map((skill) => lineFor(skill, ""));
  const bareTotal = totalLength(bare);
  if (bareTotal <= budget) {
    // What each description costs on top of its bare line, tags included.
    const wants = descriptions.map((description) => DESCRIPTION_TAGS_LENGTH + description.length);
    const allowances = shareFairly(wants, budget - bareTotal);
    const lines = skills.map((skill, index) =>
      lineFor(skill, fitDescription(descriptions[index]!, allowances[index]! - DESCRIPTION_TAGS_LENGTH))
    );
    return {
      omitted: 0,
      text: wrap(lines),
      trimmed: allowances.filter((allowance, index) => allowance < wants[index]!).length
    };
  }

  const kept: string[] = [];
  let used = 0;
  for (const line of bare) {
    if (used + line.length + 1 > budget) {
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  // The closing line has to fit too; drop listed skills until it does. A
  // budget too small for even that gets no catalog at all, rather than one
  // over budget that lists nothing.
  let omitted = skills.length - kept.length;
  while (kept.length > 0 && used + omissionLine(omitted).length + 1 > budget) {
    used -= kept.pop()!.length + 1;
    omitted += 1;
  }
  if (used + omissionLine(omitted).length + 1 > budget) {
    return { omitted: skills.length, text: "", trimmed: 0 };
  }
  return { omitted, text: wrap([...kept, omissionLine(omitted)]), trimmed: kept.length };
}

/**
 * A note for the operator when the catalog cannot offer every skill whole
 * within `budgetChars`: the model is not told about the skills it leaves out,
 * and reads shortened descriptions for the rest. Null when everything fits.
 * `skills.list` (and so `/skills`) carries it, since nothing else would say.
 */
export function describeCatalogFit(skills: SkillRecord[], budgetChars: number): SkillDiagnostic | null {
  const visible = selectModelVisibleSkills(skills);
  const catalog = renderSkillCatalog(visible, { budgetChars });
  if (catalog.omitted === 0 && catalog.trimmed === 0) {
    return null;
  }
  return {
    kind: "limit",
    message:
      catalog.omitted > 0
        ? `The skill catalog has room for ${visible.length - catalog.omitted} of ${visible.length} skills in ${budgetChars} characters, so the model is not offered the others; raise skills.maxCatalogChars, or disable skills you do not need.`
        : `The skill catalog shortened ${catalog.trimmed} skill ${catalog.trimmed === 1 ? "description" : "descriptions"} to fit ${budgetChars} characters; raise skills.maxCatalogChars, or shorten the descriptions.`,
    path: "skills.maxCatalogChars",
    severity: "warning"
  };
}

const DESCRIPTION_TAGS_LENGTH = "<description></description>".length;

function omissionLine(omitted: number): string {
  return `<!-- ${omitted} more ${omitted === 1 ? "skill is" : "skills are"} not listed for lack of room. -->`;
}

// Max-min fair shares: no description gets more than it wants, and what the
// short ones leave over goes to the long ones. Codex hands out the same space
// a character at a time, round-robin; sorting by want gets there in one pass.
function shareFairly(wants: number[], budget: number): number[] {
  const allowances = wants.map(() => 0);
  const order = wants.map((want, index) => ({ index, want })).sort((left, right) => left.want - right.want);
  let remaining = budget;
  order.forEach(({ index, want }, position) => {
    const share = Math.floor(remaining / (order.length - position));
    allowances[index] = Math.min(want, share);
    remaining -= allowances[index]!;
  });
  return allowances;
}

// `room` counts escaped characters. A cut never splits an entity like `&amp;`,
// and a description cut to almost nothing is left out rather than kept as noise.
function fitDescription(description: string, room: number): string {
  if (description.length <= room) {
    return description;
  }
  const cut = sliceUtf16(description, Math.max(0, room - TRUNCATION_MARK.length)).replace(/&[a-z]*$/u, "");
  return cut.trim().length >= 8 ? `${cut.trimEnd()}${TRUNCATION_MARK}` : "";
}

function totalLength(lines: string[]): number {
  return lines.reduce((total, line) => total + line.length + 1, 0);
}

function wrap(lines: string[]): string {
  return ["<available_skills>", ...lines, "</available_skills>"].join("\n");
}

export type SkillResources = { files: string[]; truncated: boolean };

const MAX_LISTED_RESOURCES = 50;
const MAX_RESOURCE_DEPTH = 3;

/**
 * The files a skill ships besides SKILL.md (scripts/, references/, assets/,
 * …), relative to its directory: listed so the model knows they exist, never
 * read ahead of need. Hidden entries and node_modules are skipped, and
 * symlinks are not followed.
 */
export async function listSkillResources(directory: string): Promise<SkillResources> {
  const files: string[] = [];
  let truncated = false;
  const walk = async (current: string, depth: number): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    entries.sort((left, right) => compareCodePoints(left.name, right.name));
    for (const entry of entries) {
      if (truncated) {
        return;
      }
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_RESOURCE_DEPTH) {
          await walk(absolute, depth + 1);
        }
        continue;
      }
      if (!entry.isFile() || (depth === 0 && entry.name === SKILL_FILE_NAME)) {
        continue;
      }
      if (files.length >= MAX_LISTED_RESOURCES) {
        truncated = true;
        return;
      }
      files.push(path.relative(directory, absolute).split(path.sep).join("/"));
    }
  };
  await walk(directory, 0);
  return { files, truncated };
}

/**
 * A skill's instructions as the model receives them, its files listed: what
 * the `skill` tool returns, what a `$name` mention adds, and what Active Skills
 * restates, alike.
 */
export async function loadSkillContent(skill: SkillRecord): Promise<string> {
  return renderSkillContent(skill, await listSkillResources(skill.directory));
}

/**
 * A skill's instructions as the model receives them, whether it loaded the
 * skill with the `skill` tool or the operator named it (`$name`): the body
 * without its frontmatter, where relative paths resolve, and the bundled files
 * by name.
 */
export function renderSkillContent(skill: SkillRecord, resources: SkillResources): string {
  return [
    `<skill_content name="${escapeXml(skill.name)}">`,
    skill.body,
    "",
    `Skill directory: ${skill.directory}`,
    "Relative paths in this skill resolve against the skill directory; use absolute paths in tool calls.",
    ...(resources.files.length > 0
      ? [
          "<skill_resources>",
          ...resources.files.map((file) => `<file>${escapeXml(file)}</file>`),
          ...(resources.truncated ? ["<!-- more files; list the skill directory to see them -->"] : []),
          "</skill_resources>"
        ]
      : []),
    "</skill_content>"
  ].join("\n");
}

function escapeXml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}
