import type { JsonValue, SessionRecord, ToolCallRecord, ToolDefinition } from "@/core/contracts";

/** The built-in tool that loads a skill (src/core/tools/builtins/skill.ts). */
export const SKILL_TOOL_NAME = "skill";

/**
 * Call metadata the `skill` tool leaves for the agent loop: which skill a call
 * loaded, and whether it was newly loaded ("loaded") or already in the
 * session ("already_loaded").
 */
export const SKILL_NAME_METADATA_KEY = "skillName";
export const SKILL_ACTIVATION_METADATA_KEY = "skillActivation";

/**
 * Session metadata key: the skills loaded in the session, each with the id of
 * the message that carried its instructions (the `skill` tool's result, or the
 * message a `$name` mention added). The agent loop keeps it; the `skill` tool
 * reads it so a second load of the same skill costs nothing.
 */
export const SKILL_ACTIVATIONS_METADATA_KEY = "activatedSkills";

export type SkillActivation = { messageId: string; name: string };

export function readSkillActivations(metadata: Record<string, JsonValue | undefined>): SkillActivation[] {
  const raw = metadata[SKILL_ACTIVATIONS_METADATA_KEY];
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return [];
    }
    const { messageId, name } = entry as Record<string, unknown>;
    return typeof messageId === "string" && typeof name === "string" ? [{ messageId, name }] : [];
  });
}

/**
 * The session with each skill a tool call newly loaded recorded, with the
 * message carrying its instructions. Read from the call's own metadata, which
 * only the `skill` tool sets, so every path that runs a tool records loads the
 * same way: the agent loop (each call as it finishes), an approved call
 * resumed later, and a direct `tool.execute`. A load the loop recorded only
 * at the end of a turn was lost when the turn paused for approval, and loaded
 * twice when the model asked for it twice in one response.
 */
export function recordSkillLoads(
  session: SessionRecord,
  calls: Array<{ resultMessageId?: string | undefined; toolCall: ToolCallRecord }>
): SessionRecord {
  const loads = calls.flatMap(({ resultMessageId, toolCall }): SkillActivation[] => {
    const name = toolCall.metadata[SKILL_NAME_METADATA_KEY];
    return toolCall.status === "succeeded" &&
      toolCall.metadata[SKILL_ACTIVATION_METADATA_KEY] === "loaded" &&
      typeof name === "string"
      ? [{ messageId: resultMessageId ?? `message.tool.${toolCall.id}`, name }]
      : [];
  });
  return loads.length > 0 ? withSkillActivations(session, loads) : session;
}

/** The session with `added` recorded as loaded (see `mergeSkillActivations`). */
export function withSkillActivations(session: SessionRecord, added: SkillActivation[]): SessionRecord {
  return {
    ...session,
    metadata: {
      ...session.metadata,
      [SKILL_ACTIVATIONS_METADATA_KEY]: mergeSkillActivations(readSkillActivations(session.metadata), added)
    }
  };
}

/** The activations with `added` appended, keeping the first activation of each name. */
export function mergeSkillActivations(existing: SkillActivation[], added: SkillActivation[]): SkillActivation[] {
  const merged = [...existing];
  for (const activation of added) {
    if (!merged.some((entry) => entry.name === activation.name)) {
      merged.push(activation);
    }
  }
  return merged;
}

/**
 * The `skill` tool with `name` narrowed to `names`: what the agent loop
 * exposes for a session, so a server that constrains tool calls to their
 * schema (llama.cpp does) can only produce a skill that exists.
 */
export function narrowSkillToolDefinition(definition: ToolDefinition, names: string[]): ToolDefinition {
  const properties = (definition.inputSchema.properties ?? {}) as Record<string, JsonValue>;
  const nameProperty = (properties.name ?? {}) as Record<string, JsonValue>;
  return {
    ...definition,
    inputSchema: {
      ...definition.inputSchema,
      properties: { ...properties, name: { ...nameProperty, enum: names } }
    }
  };
}
