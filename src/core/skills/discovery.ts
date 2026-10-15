import { existsSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isSkillPathEntry } from "@/core/config/normalize";
import { DEFAULT_SKILLS_CONFIG, type SkillsConfig } from "@/core/config/schema";
import { resolveAbsolutePath } from "@/core/config/paths";
import { findProjectRoot, listDirectoriesUpTo } from "@/core/io/project-root";
import { findPackageInfo } from "@/core/package-info";
import { parseSkillFile, type SkillParseResult } from "@/core/skills/parse";
import type { SkillDiagnostic, SkillDiscovery, SkillRecord, SkillScope } from "@/core/skills/types";

/** The `skills` config section (see src/core/config/schema.ts), with where its extra roots came from. */
export type SkillsSettings = SkillsConfig & {
  /**
   * "project" when `extraRoots` came from a workspace config: they are then
   * searched like the project's own roots (confined to the project, project
   * precedence), never like the operator's. Omitted: the operator's ("extra").
   */
  extraRootsScope?: "extra" | "project";
};

export const DEFAULT_SKILLS_SETTINGS: SkillsSettings = DEFAULT_SKILLS_CONFIG;

export const SKILL_FILE_NAME = "SKILL.md";

// Codex's scan bounds: a skills root is walked breadth-first, at most this
// deep and this wide, so a root pointed at a huge tree cannot stall a run.
const MAX_SCAN_DEPTH = 6;
const MAX_DIRECTORIES_PER_ROOT = 2_000;
const MAX_ENTRIES_PER_ROOT = 20_000;
// The spec recommends under 5,000 tokens; a file far past that is not a skill.
const MAX_SKILL_FILE_BYTES = 1_048_576;
const SKIPPED_DIRECTORIES = new Set(["node_modules"]);

type SkillRoot = {
  directory: string;
  /** The old `<dir>/skills/<name>/` layout: one level deep, and noted as old. */
  legacy?: boolean;
  scope: SkillScope;
};

const SCOPE_ORDER: Record<SkillScope, number> = { bundled: 3, extra: 2, project: 0, user: 1 };

/**
 * Finds every skill that applies to `cwd`.
 *
 * Roots, highest precedence first:
 * - project: `.aia/skills` and `.agents/skills` in each directory from `cwd`
 *   up to the project root, closest first; then the old layout's `skills/`
 *   folders in the same directories, one level deep (`skills/<name>/`), each
 *   skill there noted with the folder to move it to;
 * - user: `~/.aia/skills`, `~/.agents/skills`;
 * - extra: `skills.extraRoots`, in order (project roots instead, when a
 *   workspace config set them: see `SkillsSettings.extraRootsScope`);
 * - bundled: the skills aia ships, unless `skills.bundled` is false.
 *
 * A project root is searched only when its real path is inside the project:
 * a cloned repository whose `.agents/skills` is a symlink to the operator's
 * home must not get that folder scanned, or its files listed to the model.
 *
 * Two skills with the same name resolve to the higher-precedence one; the
 * other is reported as shadowed, as a warning whenever a project skill hides
 * one of the operator's own (user, extra, or bundled): a cloned repository can
 * do that on purpose. Skills named in `skills.disabled` are listed but not
 * enabled. Directories whose names start with "." below a root are not
 * searched (a root itself may be hidden, like `.agents/skills`).
 *
 * The result is ordered by scope, then name, so the catalog built from it is
 * the same from run to run (a stable prompt prefix is what lets a local
 * server reuse its KV cache), and a budget that cannot fit every skill drops
 * the bundled ones first.
 */
export async function findSkills(params: {
  bundledRoot?: string | null;
  cwd: string;
  projectRootMarkers?: string[];
  settings?: SkillsSettings;
  userHomeDirectory?: string;
}): Promise<SkillDiscovery> {
  const settings = params.settings ?? DEFAULT_SKILLS_SETTINGS;
  if (!settings.enabled) {
    return { diagnostics: [], skills: [] };
  }

  const userHomeDirectory = params.userHomeDirectory ?? os.homedir();
  const projectRoot = await findProjectRoot(params.cwd, params.projectRootMarkers ?? [".git"]);
  const bundledRoot = params.bundledRoot === undefined ? resolveBundledSkillsRoot() : params.bundledRoot;
  // Already absolute from config (normalize.ts); a direct caller's are
  // resolved by the same rule, against the start directory.
  const extraRoots = settings.extraRoots.map((directory) => ({
    directory: resolveAbsolutePath(directory, params.cwd, userHomeDirectory),
    scope: settings.extraRootsScope ?? ("extra" as const)
  }));
  const ancestors = listDirectoriesUpTo(params.cwd, projectRoot);
  const roots: SkillRoot[] = [
    ...ancestors.flatMap((directory) => [
      { directory: path.join(directory, ".aia", "skills"), scope: "project" as const },
      { directory: path.join(directory, ".agents", "skills"), scope: "project" as const }
    ]),
    ...extraRoots.filter((root) => root.scope === "project"),
    // Where aia looked before it followed the spec. Still read, so a project
    // laid out that way keeps its skills, and noted, so it can move.
    ...ancestors.map((directory) => ({
      directory: path.join(directory, "skills"),
      legacy: true,
      scope: "project" as const
    })),
    { directory: path.join(userHomeDirectory, ".aia", "skills"), scope: "user" },
    { directory: path.join(userHomeDirectory, ".agents", "skills"), scope: "user" },
    ...extraRoots.filter((root) => root.scope !== "project"),
    ...(settings.bundled && bundledRoot ? [{ directory: bundledRoot, scope: "bundled" as const }] : [])
  ];

  const diagnostics: SkillDiagnostic[] = [];
  const byName = new Map<string, SkillRecord>();
  const disabledNames = new Set(settings.disabled.filter((entry) => !isSkillPathEntry(entry)));
  // A path entry disables the skill in that folder, however the path is
  // written: the SKILL.md or the folder, `~/` or relative, through a symlink,
  // or in another case where the file system ignores case.
  const disabledDirectories = new Set(
    settings.disabled
      .filter(isSkillPathEntry)
      .flatMap((entry) => skillDirectoryKeys(resolveAbsolutePath(entry, params.cwd, userHomeDirectory)))
  );
  const seenFiles = new Set<string>();

  // The roots are searched, and their files read, at once; what they found is
  // then taken in precedence order, so the result does not depend on timing.
  const realProjectRoot = await fs.realpath(projectRoot).catch(() => projectRoot);
  const scanned = await Promise.all(
    roots.map(async (root) => {
      const scan = await scanRoot(root, realProjectRoot);
      const parsed = await Promise.all(scan.files.map((file) => readSkillFile(file.filePath)));
      return { ...scan, parsed, root };
    })
  );
  for (const { diagnostics: scanDiagnostics, files, parsed: parsedFiles, root } of scanned) {
    diagnostics.push(...scanDiagnostics);
    for (const [index, { filePath, realPath }] of files.entries()) {
      // The same file reached through two roots (a symlinked root, an extra
      // root inside the project) is one skill.
      if (seenFiles.has(realPath)) {
        continue;
      }
      seenFiles.add(realPath);

      const parsed = parsedFiles[index]!;
      if (!parsed.ok) {
        diagnostics.push({ kind: "invalid", message: parsed.error, path: filePath, severity: "error" });
        continue;
      }
      if (root.legacy) {
        diagnostics.push({
          kind: "warning",
          message: `is in the old skills/ folder, which aia still reads but other agents do not; move it to .agents/skills/${path.basename(path.dirname(filePath))}/`,
          name: parsed.skill.name,
          path: filePath,
          severity: "warning"
        });
      }
      for (const warning of parsed.warnings) {
        diagnostics.push({
          kind: "warning",
          message: warning,
          name: parsed.skill.name,
          path: filePath,
          severity: "warning"
        });
      }

      const skill: SkillRecord = {
        ...parsed.skill,
        directory: path.dirname(filePath),
        enabled:
          !disabledNames.has(parsed.skill.name) &&
          !skillDirectoryKeys(path.dirname(filePath)).some((key) => disabledDirectories.has(key)),
        filePath,
        scope: root.scope
      };
      const winner = byName.get(skill.name);
      if (winner) {
        const projectOverOwn = winner.scope === "project" && skill.scope !== "project";
        diagnostics.push({
          kind: "shadowed",
          message: projectOverOwn
            ? `The project skill at ${winner.filePath} overrides your ${skill.scope} skill of the same name, so $${skill.name} and the skill tool load the project's.`
            : `Shadowed by the ${winner.scope} skill at ${winner.filePath}.`,
          name: skill.name,
          path: filePath,
          severity: projectOverOwn ? "warning" : "info"
        });
        continue;
      }
      byName.set(skill.name, skill);
    }
  }

  const skills = [...byName.values()].sort(
    (left, right) => SCOPE_ORDER[left.scope] - SCOPE_ORDER[right.scope] || compareCodePoints(left.name, right.name)
  );
  return { diagnostics, skills };
}

/** A skill as `discoverSkills` reported it before skills followed the Agent Skills spec. */
export type DiscoveredSkill = {
  /** The whole SKILL.md, frontmatter included. */
  content: string;
  description: string;
  name: string;
  skillDirectory: string;
  skillFilePath: string;
  source: "extra" | "user" | "workspace";
};

/**
 * @deprecated Use `findSkills`, or a `SkillProvider`: they report disabled
 * skills, scopes, and the files that could not be used. Kept for callers of
 * the earlier API, in its shape: the enabled skills from the project, user,
 * and `extraRoots` roots (not the bundled ones), by name, each with its whole
 * SKILL.md as `content`.
 */
export async function discoverSkills(params: {
  cwd: string;
  extraRoots?: string[];
  projectRootMarkers?: string[];
  userHomeDirectory?: string;
}): Promise<DiscoveredSkill[]> {
  const { skills } = await findSkills({
    bundledRoot: null,
    cwd: params.cwd,
    ...(params.projectRootMarkers ? { projectRootMarkers: params.projectRootMarkers } : {}),
    settings: { ...DEFAULT_SKILLS_SETTINGS, bundled: false, extraRoots: params.extraRoots ?? [] },
    ...(params.userHomeDirectory ? { userHomeDirectory: params.userHomeDirectory } : {})
  });
  const discovered = await Promise.all(
    skills
      .filter((skill) => skill.enabled)
      .map(async (skill) => ({ ...toDiscoveredSkill(skill), content: await fs.readFile(skill.filePath, "utf8") }))
  );
  return discovered.sort((left, right) => left.name.localeCompare(right.name));
}

/** A skill's fields under their earlier names (`DiscoveredSkill`), less `content`. */
export function toDiscoveredSkill(skill: SkillRecord): Omit<DiscoveredSkill, "content"> {
  return {
    description: skill.description,
    name: skill.name,
    skillDirectory: skill.directory,
    skillFilePath: skill.filePath,
    source: skill.scope === "project" ? "workspace" : skill.scope === "user" ? "user" : "extra"
  };
}

/** The skills the model may load: enabled, and not reserved for the operator to name. */
export function selectModelVisibleSkills(skills: SkillRecord[]): SkillRecord[] {
  return skills.filter((skill) => skill.enabled && !skill.disableModelInvocation);
}

// The SKILL.md files below a root, each with its real path (its directory's,
// which the walk resolves anyway), and what got in the way.
async function scanRoot(
  root: SkillRoot,
  realProjectRoot: string
): Promise<{ diagnostics: SkillDiagnostic[]; files: Array<{ filePath: string; realPath: string }> }> {
  const diagnostics: SkillDiagnostic[] = [];
  const rootReal = await fs.realpath(root.directory).catch(() => null);
  if (!rootReal) {
    return { diagnostics, files: [] };
  }
  // The root itself counts, not only symlinks found below it: `.agents/skills`
  // (or `.agents`) can be a symlink too.
  if (root.scope === "project" && !isInsideProject(rootReal, realProjectRoot)) {
    diagnostics.push({
      kind: "limit",
      message: `This project skills folder leads outside the project (to ${rootReal}), so it was not searched.`,
      path: root.directory,
      severity: "warning"
    });
    return { diagnostics, files: [] };
  }
  const found: Array<{ filePath: string; realPath: string }> = [];
  const visited = new Set<string>();
  const queue: Array<{ depth: number; directory: string; real?: string }> = [
    { depth: 0, directory: root.directory, real: rootReal }
  ];
  let entriesSeen = 0;

  while (queue.length > 0) {
    const next = queue.shift()!;
    const { depth, directory } = next;
    const real = next.real ?? (await fs.realpath(directory).catch(() => null));
    if (!real || visited.has(real)) {
      continue;
    }
    if (visited.size >= MAX_DIRECTORIES_PER_ROOT) {
      diagnostics.push({
        kind: "limit",
        message: `Stopped after ${MAX_DIRECTORIES_PER_ROOT} directories; skills deeper in this root were not searched.`,
        path: root.directory,
        severity: "warning"
      });
      break;
    }
    visited.add(real);

    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    entriesSeen += entries.length;
    if (entriesSeen > MAX_ENTRIES_PER_ROOT) {
      diagnostics.push({
        kind: "limit",
        message: `Stopped after ${MAX_ENTRIES_PER_ROOT} entries; skills later in this root were not searched.`,
        path: root.directory,
        severity: "warning"
      });
      break;
    }
    entries.sort((left, right) => compareCodePoints(left.name, right.name));

    // A skill is a directory below the root with a regular SKILL.md in it. A
    // symlinked SKILL.md is ignored, as Codex does: it could point anywhere.
    // A skill's own subdirectories are not searched, so a template SKILL.md in
    // a skill's assets/ is not mistaken for another skill. The name is matched
    // in any case, as aia did before (`skill.md`), with a note to rename it.
    const skillFile = depth > 0 ? findSkillFile(entries) : undefined;
    if (skillFile) {
      const filePath = path.join(directory, skillFile);
      if (skillFile !== SKILL_FILE_NAME) {
        diagnostics.push({
          kind: "warning",
          message: `is named ${skillFile}; aia reads it, but other agents look for ${SKILL_FILE_NAME} exactly, so rename it`,
          path: filePath,
          severity: "warning"
        });
      }
      found.push({ filePath, realPath: path.join(real, skillFile) });
      continue;
    }
    if (depth >= (root.legacy ? 1 : MAX_SCAN_DEPTH)) {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIPPED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push({ depth: depth + 1, directory: child });
        continue;
      }
      if (entry.isSymbolicLink() && (await followsIntoAllowedDirectory(child, root.scope, realProjectRoot))) {
        queue.push({ depth: depth + 1, directory: child });
      }
    }
  }

  return { diagnostics, files: found };
}

function findSkillFile(entries: Array<{ isFile(): boolean; name: string }>): string | undefined {
  const files = entries.filter((entry) => entry.isFile());
  return (
    files.find((entry) => entry.name === SKILL_FILE_NAME) ??
    files.find((entry) => entry.name.toLowerCase() === SKILL_FILE_NAME.toLowerCase())
  )?.name;
}

// A symlinked directory is followed for the operator's own roots. In a
// project, only when it stays inside the project: a cloned repo must not be
// able to aim the scan (and the resource listing the skill tool returns) at
// the operator's home.
async function followsIntoAllowedDirectory(link: string, scope: SkillScope, realProjectRoot: string): Promise<boolean> {
  const target = await fs.realpath(link).catch(() => null);
  if (!target) {
    return false;
  }
  const stat = await fs.stat(target).catch(() => null);
  if (!stat?.isDirectory()) {
    return false;
  }
  if (scope !== "project") {
    return true;
  }
  return isInsideProject(target, realProjectRoot);
}

function isInsideProject(realPath: string, realProjectRoot: string): boolean {
  return realPath === realProjectRoot || realPath.startsWith(`${realProjectRoot}${path.sep}`);
}

// Parsed once per file version: skills are re-discovered at the start of every
// run, and re-parsing unchanged files each time would be wasted work.
// Bounded by the bytes it holds, oldest first out: a long-lived gateway
// serving several workspaces kept up to 1,000 bodies of up to 1 MiB each.
const parseCache = new Map<string, { mtimeMs: number; result: SkillParseResult; size: number }>();
const PARSE_CACHE_MAX_BYTES = 16 * 1_048_576;
let parseCacheBytes = 0;

async function readSkillFile(filePath: string): Promise<SkillParseResult> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    // Gone (or moved): its entry goes too.
    forgetParsed(filePath);
    return { error: `failed to read file: ${describe(error)}`, ok: false };
  }
  if (stat.size > MAX_SKILL_FILE_BYTES) {
    return { error: `file is ${stat.size} bytes; skills are limited to ${MAX_SKILL_FILE_BYTES}`, ok: false };
  }
  const cached = parseCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.result;
  }

  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    return { error: `failed to read file: ${describe(error)}`, ok: false };
  }
  let result: SkillParseResult;
  try {
    result = parseSkillFile(content, path.basename(path.dirname(filePath)));
  } catch (error) {
    // Whatever a hostile SKILL.md manages, it fails only itself: discovery
    // runs before every model turn, and one throw here failed them all.
    result = { error: `could not be parsed: ${describe(error)}`, ok: false };
  }
  forgetParsed(filePath);
  parseCache.set(filePath, { mtimeMs: stat.mtimeMs, result, size: stat.size });
  parseCacheBytes += stat.size;
  for (const [oldest, entry] of parseCache) {
    if (parseCacheBytes <= PARSE_CACHE_MAX_BYTES) {
      break;
    }
    parseCache.delete(oldest);
    parseCacheBytes -= entry.size;
  }
  return result;
}

function forgetParsed(filePath: string): void {
  const entry = parseCache.get(filePath);
  if (entry) {
    parseCache.delete(filePath);
    parseCacheBytes -= entry.size;
  }
}

const CASE_INSENSITIVE_FILE_SYSTEM = process.platform === "darwin" || process.platform === "win32";

/**
 * The skill directory a path names (the directory itself, or its SKILL.md,
 * with or without a trailing slash), as keys to compare: as written and as
 * its real path, folded to lower case where the file system ignores case.
 * `skills.disabled` paths and `[$name](path)` mentions match skills by these.
 */
export function skillDirectoryKeys(value: string): string[] {
  const normalized = path.normalize(value);
  const trimmed = normalized.length > 1 ? normalized.replace(/[\\/]+$/u, "") : normalized;
  const directory =
    path.basename(trimmed).toLowerCase() === SKILL_FILE_NAME.toLowerCase() ? path.dirname(trimmed) : trimmed;
  let real = directory;
  try {
    real = realpathSync.native(directory);
  } catch {
    // Not on disk (or not readable): compared as written.
  }
  return [...new Set([directory, real])].map((key) => (CASE_INSENSITIVE_FILE_SYSTEM ? key.toLowerCase() : key));
}

let bundledRoot: string | null | undefined;

/** The skills aia ships: `bundled-skills/` at the package root. */
export function resolveBundledSkillsRoot(): string | null {
  if (bundledRoot === undefined) {
    const root = findPackageInfo()?.root;
    const candidate = root ? path.join(root, "bundled-skills") : null;
    bundledRoot = candidate && existsSync(candidate) ? candidate : null;
  }
  return bundledRoot;
}

/** Locale-independent ordering, so every machine lists skills alike. */
export function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
