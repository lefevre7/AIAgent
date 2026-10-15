import { z } from "zod";

import type { JsonValue, ToolDefinition } from "@/core/contracts";
import {
  loadSkillContent,
  readSkillActivations,
  selectModelVisibleSkills,
  SKILL_ACTIVATION_METADATA_KEY,
  SKILL_NAME_METADATA_KEY,
  SKILL_TOOL_NAME,
  type SkillProvider,
  type SkillRecord
} from "@/core/skills";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

const inputSchema = z.object({
  name: z.string().min(1).max(512)
});

/**
 * Loads a skill's instructions into the conversation.
 *
 * The agent loop narrows `name` to this session's skills (see
 * `narrowSkillToolDefinition`). A call is still checked here, against the
 * skills on disk now, because on a server that does not constrain tool calls
 * to their schema the model can name anything.
 */
export function createSkillTool(options: { skills: SkillProvider }): RuntimeTool {
  return {
    definition: skillToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const requested = inputSchema
        .parse(call.arguments as unknown)
        .name.trim()
        .replace(/^\$/u, "");
      // The run's own skills when the loop calls; a direct call finds them.
      const { skills } = context.skills ?? (await options.skills.discover(context.session.cwd));
      const visible = selectModelVisibleSkills(skills);
      const skill = findSkill(visible, requested);
      if (!skill) {
        throw explainMissingSkill(requested, skills, visible);
      }

      const metadata: Record<string, JsonValue> = { [SKILL_NAME_METADATA_KEY]: skill.name };
      if (readSkillActivations(context.session.metadata).some((activation) => activation.name === skill.name)) {
        return {
          metadata: { ...metadata, [SKILL_ACTIVATION_METADATA_KEY]: "already_loaded" },
          result: `The "${skill.name}" skill is already loaded in this session. Follow the instructions it gave earlier in the conversation (or under Active Skills in your instructions); there is no need to load it again.`
        };
      }
      return {
        metadata: { ...metadata, [SKILL_ACTIVATION_METADATA_KEY]: "loaded" },
        // A string result reaches the model as plain text, so the Markdown
        // reads as written rather than as an escaped JSON string.
        result: await loadSkillContent(skill)
      };
    }
  };
}

// Exact first; then, for a model that changed the case, the one skill whose
// name matches ignoring case.
function findSkill(skills: SkillRecord[], name: string): SkillRecord | undefined {
  const exact = skills.find((skill) => skill.name === name);
  if (exact) {
    return exact;
  }
  const folded = skills.filter((skill) => skill.name.toLowerCase() === name.toLowerCase());
  return folded.length === 1 ? folded[0] : undefined;
}

function explainMissingSkill(name: string, all: SkillRecord[], visible: SkillRecord[]) {
  const known = all.find((skill) => skill.name === name);
  const available = visible.map((skill) => skill.name);
  const message = !known
    ? `No skill is named "${name}". ${available.length > 0 ? `Available skills: ${available.join(", ")}.` : "No skills are available."}`
    : !known.enabled
      ? `The "${name}" skill is disabled in this configuration (skills.disabled).`
      : `The "${name}" skill runs only when the operator names it as $${name}.`;
  return {
    code: "skill_not_found",
    details: { available, name },
    message,
    retriable: false
  };
}

export const skillToolDefinition: ToolDefinition = {
  aliases: ["load_skill", "use_skill"],
  annotations: {
    idempotentHint: true,
    meta: {
      family: "skills"
    },
    openWorldHint: false,
    readOnlyHint: true,
    title: "Skill"
  },
  approvalMode: "never",
  descriptor: {
    approvalNotes:
      "No operator approval is required: it only reads a skill's instructions. Whatever those instructions lead to goes through the normal approval of each tool it uses.",
    examples: ['skill({ "name": "skill-creator" }) before writing a new SKILL.md.'],
    purpose: "Load the full instructions of a skill listed under Available Skills.",
    sideEffectSummary: "Reads a SKILL.md and lists the files in its directory.",
    whenNotToUse: [
      "Do not load a skill whose description does not match the task.",
      "Do not load a skill again once it is loaded; its instructions stay in the conversation."
    ],
    whenToUse: ["Use as soon as a task matches the description of one of the Available Skills, before acting."]
  },
  description:
    "Load a skill's instructions by name. Use it when the task matches one of the Available Skills, then follow what it returns.",
  displayName: "Skill",
  execution: {
    inputMode: "json",
    resumable: false,
    taskSupport: "forbidden"
  },
  idempotent: true,
  inputSchema: {
    additionalProperties: false,
    properties: {
      name: {
        description: "The skill's name, exactly as listed under Available Skills.",
        type: "string"
      }
    },
    required: ["name"],
    type: "object"
  },
  invocationName: SKILL_TOOL_NAME,
  kind: "skill",
  metadata: {},
  name: SKILL_TOOL_NAME,
  outputKind: "markdown",
  outputSchema: {
    type: "string"
  },
  retryable: false,
  searchTags: ["instructions", "skill", "skills", "workflow"],
  sideEffects: ["workspace_read"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.builtin.skill",
  usageGuidance:
    "Call it with a name from Available Skills when the task matches that skill's description, then follow the instructions it returns. Each skill needs loading only once per session.",
  version: "1.0.0"
};
