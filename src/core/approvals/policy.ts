import type {
  ApprovalPolicyMode,
  ApprovalPolicyRule,
  ApprovalRequest,
  ApprovalTargetKind,
  JsonValue,
  ToolCallRecord,
  ToolDefinition
} from "@/core/contracts";
import type { ApprovalSettings } from "@/core/config";
import type { ToolApprovalDecider, ToolApprovalDeciderParams } from "@/core/tools/runtime";

export type ApprovalEvaluationTarget = {
  kind: ApprovalTargetKind;
  label: string;
  value: string;
};

export type ApprovalPolicyMatch = {
  mode: ApprovalPolicyMode;
  rule?: ApprovalPolicyRule;
  target: ApprovalEvaluationTarget;
};

export class RegexApprovalPolicy {
  constructor(private readonly settings: ApprovalSettings) {}

  evaluateTargets(targets: ApprovalEvaluationTarget[]): ApprovalPolicyMatch {
    for (const target of targets) {
      for (const rule of this.settings.rules) {
        if (rule.targetKind !== target.kind) {
          continue;
        }

        const matcher = new RegExp(rule.pattern, "u");
        if (!matcher.test(target.value)) {
          continue;
        }

        return {
          mode: rule.mode,
          rule,
          target
        };
      }
    }

    return {
      mode: this.settings.defaultMode,
      target: targets[0] ?? {
        kind: "tool",
        label: "tool",
        value: "tool"
      }
    };
  }
}

export function createToolApprovalDecider(params: {
  resolveAdditionalTargets?: (input: ToolApprovalDeciderParams) => Promise<ApprovalEvaluationTarget[]>;
  settings: ApprovalSettings;
}): ToolApprovalDecider {
  const policy = new RegexApprovalPolicy(params.settings);

  return async (input) => {
    if (input.definition.approvalMode === "never") {
      return {
        mode: "execute"
      };
    }

    if (isReadOnlyExternalAgentAction(input)) {
      return {
        mode: "execute"
      };
    }

    const additionalTargets = (await params.resolveAdditionalTargets?.(input)) ?? [];
    const match = policy.evaluateTargets([...additionalTargets, ...extractApprovalTargets(input.call, input.definition)]);
    const resolvedMode = resolveApprovalMode(input.definition.approvalMode, match.mode);

    if (resolvedMode === "allow") {
      return {
        mode: "execute"
      };
    }

    if (resolvedMode === "deny") {
      return {
        error: {
          code: "tool_execution_denied_by_policy",
          details: {
            matchedRuleId: match.rule?.id ?? null,
            targetKind: match.target.kind,
            targetValue: match.target.value
          },
          message: buildDeniedMessage(match),
          retriable: false
        },
        metadata: {
          approvalPolicyMode: "deny",
          matchedApprovalRuleId: match.rule?.id ?? null,
          matchedApprovalTargetKind: match.target.kind,
          matchedApprovalTargetValue: match.target.value
        },
        mode: "deny"
      };
    }

    return {
      mode: "request",
      request: isQuestionInteraction(input.definition)
        ? buildQuestionApprovalRequest(input)
        : buildApprovalRequest(input, match)
    };
  };
}

function isQuestionInteraction(definition: ToolDefinition): boolean {
  return definition.annotations.meta.interaction === "question";
}

function buildQuestionApprovalRequest(params: ToolApprovalDeciderParams): ApprovalRequest {
  const question =
    typeof params.call.arguments.question === "string" ? params.call.arguments.question : params.definition.displayName;
  const options = Array.isArray(params.call.arguments.options) ? (params.call.arguments.options as JsonValue) : [];

  return {
    createdAt: new Date().toISOString(),
    id: `approval.${params.call.id}.${params.turn.id}.question`,
    justification: question,
    metadata: {
      approvalMode: params.definition.approvalMode,
      interaction: "question",
      options,
      toolKind: params.definition.kind
    },
    riskSummary: "The agent is asking you a question before it continues. Resolve it with your answer as the comment.",
    sessionId: params.session.id,
    status: "pending",
    target: {
      kind: "question",
      label: params.definition.displayName,
      value: params.definition.invocationName
    },
    toolCallId: params.call.id,
    turnId: params.turn.id
  };
}

export function extractApprovalTargets(call: ToolCallRecord, definition: ToolDefinition): ApprovalEvaluationTarget[] {
  const targets: ApprovalEvaluationTarget[] = [];
  const pushUnique = (target: ApprovalEvaluationTarget) => {
    if (!targets.some((entry) => entry.kind === target.kind && entry.value === target.value)) {
      targets.push(target);
    }
  };

  for (const [key, value] of Object.entries(call.arguments)) {
    if (looksLikeCommandKey(key)) {
      const commandValue = stringifyCommandValue(value);
      if (commandValue) {
        pushUnique({
          kind: "command",
          label: key,
          value: commandValue
        });
      }
    }

    if (looksLikePathKey(key)) {
      for (const pathValue of stringifyPathValues(value)) {
        pushUnique({
          kind: "path",
          label: key,
          value: pathValue
        });
      }
    }
  }

  if (definition.kind === "mcp" && definition.source.serverName) {
    pushUnique({
      kind: "mcp_server",
      label: definition.source.serverName,
      value: definition.source.serverName
    });
    pushUnique({
      kind: "mcp_tool",
      label: definition.displayName,
      value: definition.name
    });
  }

  if (definition.kind === "browser") {
    pushUnique({
      kind: "browser_action",
      label: definition.displayName,
      value: definition.invocationName
    });
  }

  if (definition.kind === "external_agent") {
    pushUnique({
      kind: "external_agent",
      label: definition.displayName,
      value: definition.invocationName
    });
  }

  if (definition.kind === "voice" && isVoiceActionDefinition(definition)) {
    pushUnique({
      kind: "voice_action",
      label: definition.displayName,
      value: definition.invocationName
    });
  }

  pushUnique({
    kind: "tool",
    label: definition.displayName,
    value: definition.invocationName
  });

  return targets;
}

function buildApprovalRequest(params: ToolApprovalDeciderParams, match: ApprovalPolicyMatch): ApprovalRequest {
  return {
    createdAt: new Date().toISOString(),
    id: `approval.${params.call.id}.${params.turn.id}.${match.target.kind}`,
    justification:
      match.rule?.notes ??
      `The tool "${params.definition.name}" requires approval before it can run because it matched the configured policy.`,
    metadata: {
      approvalMode: params.definition.approvalMode,
      matchedApprovalRuleId: match.rule?.id ?? null,
      matchedApprovalTargetKind: match.target.kind,
      matchedApprovalTargetValue: match.target.value,
      toolKind: params.definition.kind
    },
    riskSummary: buildRiskSummary(params.definition, match),
    sessionId: params.session.id,
    status: "pending",
    target: {
      kind: match.target.kind,
      label: match.target.label,
      value: match.target.value
    },
    toolCallId: params.call.id,
    turnId: params.turn.id
  };
}

function resolveApprovalMode(
  toolApprovalMode: ToolDefinition["approvalMode"],
  policyMode: ApprovalPolicyMode
): ApprovalPolicyMode {
  if (toolApprovalMode === "always") {
    return policyMode === "deny" ? "deny" : "ask";
  }

  return policyMode;
}

function buildDeniedMessage(match: ApprovalPolicyMatch): string {
  if (match.rule?.notes) {
    return `The action was denied by approval rule "${match.rule.id}": ${match.rule.notes}`;
  }

  return `The action was denied by approval policy for ${match.target.kind} "${match.target.value}".`;
}

function buildRiskSummary(definition: ToolDefinition, match: ApprovalPolicyMatch): string {
  if (match.target.kind === "command") {
    return "This action can execute a local command.";
  }
  if (match.target.kind === "external_agent") {
    return "This action can invoke a configured external agent CLI and persist local job artifacts.";
  }
  if (match.target.kind === "voice_action") {
    return "This action can access the microphone or play audio through local speakers.";
  }
  if (match.target.kind === "path") {
    return "This action targets a workspace path that requires operator review.";
  }
  if (definition.annotations.destructiveHint || definition.sideEffects.includes("workspace_write")) {
    return "This tool can modify local workspace state.";
  }
  if (definition.annotations.openWorldHint || definition.sideEffects.includes("network_write")) {
    return "This tool can affect remote systems.";
  }

  return `This tool requires approval because policy resolved it to "${match.mode}".`;
}

function looksLikeCommandKey(value: string): boolean {
  return /^(cmd|command|commands)$/iu.test(value);
}

function isReadOnlyExternalAgentAction(input: ToolApprovalDeciderParams): boolean {
  if (input.definition.kind !== "external_agent") {
    return false;
  }
  const action = input.call.arguments.action;
  return action === "get" || action === "list";
}

function isVoiceActionDefinition(definition: ToolDefinition): boolean {
  return definition.annotations.meta.voiceAction === true;
}

function looksLikePathKey(value: string): boolean {
  return /^(cwd|dir|directory|file|files|path|paths|targetPath|uri)$/iu.test(value);
}

function stringifyCommandValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value.join(" ");
  }

  return null;
}

function stringifyPathValues(value: unknown): string[] {
  if (typeof value === "string") {
    return isLikelyLocalPath(value) ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && isLikelyLocalPath(entry));
  }

  return [];
}

function isLikelyLocalPath(value: string): boolean {
  return !/^[a-z]+:\/\//iu.test(value);
}
