import os from "node:os";

import { resolveAbsolutePath } from "@/core/config/paths";
import { skillDirectoryKeys } from "@/core/skills/discovery";
import { SHELL_VARIABLE_NAMES } from "@/core/skills/parse";
import type { SkillRecord } from "@/core/skills/types";

// Codex's grammar: `$` then letters, digits, `_`, `-`, or `:`. A `$` right
// after a word character or another `$` (`US$5`, `$$`) is not a mention.
const MENTION_PATTERN = /(?<![\w$])\$([A-Za-z0-9_:-]+)/gu;
// `[$name](path)`, the form a UI inserts when it knows exactly which skill.
const LINKED_MENTION_PATTERN = /\[\$([A-Za-z0-9_:-]+)\]\s*\(([^)]+)\)/gu;
// Where a `$` is not the operator naming a skill: code (a fenced block, an
// inline span) shows a shell variable, and a URL's `$` is part of an address.
const CODE_PATTERN = /```[\s\S]*?(?:```|$)|`[^`\n]*`/gu;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/\S+/giu;
// Punctuation the grammar allows inside a name but no name ends with: the
// colon in "Run $deploy: now".
const TRAILING_PUNCTUATION = /[:_-]+$/u;

/**
 * The skills an operator named in `text`, in the order they were named, each
 * once.
 *
 * `$name` matches an enabled skill of exactly that name (case matters, as in
 * Codex), less any `:`, `-` or `_` it ends with ("Run $deploy: now"). Code
 * (inline or fenced) and URLs are not read: `` `echo $deploy` `` and
 * `https://x.test/$deploy` name nothing. Neither does an ALL-CAPS shell
 * variable (`$HOME`, `$PATH`); `$home` can name a skill. `[$name](path)`
 * matches the skill whose SKILL.md or directory is `path`, whatever its name:
 * `~` is expanded, a relative path is taken from `cwd` (the session's
 * directory), symlinks are resolved, and case is ignored where the file system
 * ignores it. A skill with `disable-model-invocation` can be named: that is
 * the only way it runs. Nothing is chained: mentions inside a skill's own
 * instructions load nothing.
 */
export function resolveSkillMentions(
  text: string,
  skills: SkillRecord[],
  options: { cwd?: string; userHomeDirectory?: string } = {}
): SkillRecord[] {
  const enabled = skills.filter((skill) => skill.enabled);
  const found: Array<{ index: number; skill: SkillRecord }> = [];
  const linkedSpans: Array<[number, number]> = [];
  // Blanked rather than removed, so every index still points into `text`.
  const withoutCode = blank(text, CODE_PATTERN);

  for (const match of withoutCode.matchAll(LINKED_MENTION_PATTERN)) {
    const [whole, name = "", target = ""] = match;
    linkedSpans.push([match.index, match.index + whole.length]);
    if (SHELL_VARIABLE_NAMES.has(name)) {
      continue;
    }
    const raw = target.trim().replace(/^skill:\/\//u, "");
    const wanted = skillDirectoryKeys(
      resolveAbsolutePath(raw, options.cwd ?? process.cwd(), options.userHomeDirectory ?? os.homedir())
    );
    const skill = enabled.find((candidate) =>
      skillDirectoryKeys(candidate.directory).some((key) => wanted.includes(key))
    );
    if (skill) {
      found.push({ index: match.index, skill });
    }
  }

  for (const match of blank(withoutCode, URL_PATTERN).matchAll(MENTION_PATTERN)) {
    const name = (match[1] ?? "").replace(TRAILING_PUNCTUATION, "");
    // The `$name` inside a link was handled with its link.
    if (linkedSpans.some(([start, end]) => match.index >= start && match.index < end)) {
      continue;
    }
    if (SHELL_VARIABLE_NAMES.has(name)) {
      continue;
    }
    const skill = enabled.find((candidate) => candidate.name === name);
    if (skill) {
      found.push({ index: match.index, skill });
    }
  }

  const seen = new Set<string>();
  return found
    .sort((left, right) => left.index - right.index)
    .flatMap(({ skill }) => {
      if (seen.has(skill.filePath)) {
        return [];
      }
      seen.add(skill.filePath);
      return [skill];
    });
}

function blank(text: string, pattern: RegExp): string {
  return text.replace(pattern, (matched) => " ".repeat(matched.length));
}
