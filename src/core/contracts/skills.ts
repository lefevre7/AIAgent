import { z } from "zod";

/**
 * Where a skill was found. Precedence runs project > user > extra > bundled:
 * a skill in the repository beats the operator's own, which beats a
 * configured extra root, which beats the ones aia ships.
 */
export const skillScopeSchema = z.enum(["bundled", "extra", "project", "user"]);

/**
 * A skill in the Agent Skills format (https://agentskills.io/specification),
 * as `skills.list` reports it: everything but the instructions themselves.
 */
export const skillSummarySchema = z
  .object({
    /** `allowed-tools`, parsed for display. Never used to auto-approve anything. */
    allowedTools: z.array(z.string()),
    compatibility: z.string().optional(),
    description: z.string(),
    /** The skill's directory as it was reached (relative paths in the body resolve against it). */
    directory: z.string(),
    /**
     * `disable-model-invocation`: the skill is left out of the model's catalog
     * and the `skill` tool, and runs only when the operator names it (`$name`).
     */
    disableModelInvocation: z.boolean(),
    /** False when `skills.disabled` names it; it is then listed but never used. */
    enabled: z.boolean(),
    /** The SKILL.md path as it was reached. */
    filePath: z.string(),
    license: z.string().optional(),
    metadata: z.record(z.string(), z.string()),
    name: z.string(),
    scope: skillScopeSchema
  })
  .strict();

/**
 * Something about the skills on disk worth telling the operator: a SKILL.md
 * that could not be used, one shadowed by another of the same name, or a scan
 * that stopped at its limit.
 */
export const skillDiagnosticSchema = z
  .object({
    kind: z.enum(["invalid", "limit", "shadowed", "warning"]),
    message: z.string(),
    name: z.string().optional(),
    path: z.string(),
    severity: z.enum(["error", "info", "warning"])
  })
  .strict();

export type SkillDiagnostic = z.infer<typeof skillDiagnosticSchema>;
export type SkillScope = z.infer<typeof skillScopeSchema>;
export type SkillSummary = z.infer<typeof skillSummarySchema>;
