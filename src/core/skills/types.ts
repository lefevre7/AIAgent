import type { SkillDiagnostic, SkillSummary } from "@/core/contracts";

export type { SkillDiagnostic, SkillScope, SkillSummary } from "@/core/contracts";

/** A discovered skill: its summary (see skillSummarySchema) and its instructions. */
export type SkillRecord = SkillSummary & {
  /** The Markdown after the frontmatter: the instructions the model loads. */
  body: string;
};

export type SkillDiscovery = {
  diagnostics: SkillDiagnostic[];
  skills: SkillRecord[];
};

/** The record without its instructions: what `skills.list` and `aia skills list` report. */
export function toSkillSummary(skill: SkillRecord): SkillSummary {
  const { body: _body, ...summary } = skill;
  return summary;
}
