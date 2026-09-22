import type {
  ApprovalPolicyMode,
  ApprovalPolicyRule,
  ApprovalRequest,
  ApprovalTargetKind,
  JsonValue,
  ToolCallRecord,
  ToolDefinition
} from "@/core/contracts";
import { validateApprovalPattern } from "@/core/contracts";
import type { ApprovalSettings } from "@/core/config";
import { resolveLocalPath } from "@/core/tools/builtins/local-paths";
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

export type ApprovalTargetExtractionOptions = {
  // When provided, path-like argument values are canonicalized against this
  // directory with the same resolution the file tools use (file:// URIs, `~`,
  // relative segments, `..`), so a path rule sees the path that will actually
  // be touched. Security review H9.
  cwd?: string;
};

// Model-influenced strings longer than this are matched on their prefix only,
// and a policy result of "allow" is downgraded to "ask" so an oversized value
// can never sneak past a rule by pushing the interesting part out of range.
export const MAX_APPROVAL_TARGET_VALUE_LENGTH = 8_192;

export class ApprovalPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalPolicyError";
  }
}

type CompiledApprovalRule = {
  matcher: RegExp;
  rule: ApprovalPolicyRule;
};

export class RegexApprovalPolicy {
  private readonly compiledRules: CompiledApprovalRule[];

  constructor(private readonly settings: ApprovalSettings) {
    // Compile once (security review H8: patterns were recompiled on every
    // evaluation) and fail fast on an invalid or backtracking-prone pattern
    // instead of discovering it mid-run on a model-controlled string.
    this.compiledRules = settings.rules.map((rule) => ({
      matcher: compileApprovalPattern(rule),
      rule
    }));
  }

  // Precedence (security review H7): a matching deny rule on ANY target wins
  // regardless of rule or target order, so a broad allow can never shadow a
  // deny. When nothing denies, the first allow/ask match in target order (the
  // more specific command/path targets come first) decides, and the default
  // mode applies when nothing matches at all.
  evaluateTargets(targets: ApprovalEvaluationTarget[]): ApprovalPolicyMatch {
    const evaluations = targets.map((target) => ({
      target,
      truncated: target.value.length > MAX_APPROVAL_TARGET_VALUE_LENGTH,
      value: target.value.slice(0, MAX_APPROVAL_TARGET_VALUE_LENGTH)
    }));
    const anyTruncated = evaluations.some((entry) => entry.truncated);

    for (const evaluation of evaluations) {
      for (const compiled of this.compiledRules) {
        if (compiled.rule.mode === "deny" && this.matches(compiled, evaluation)) {
          return {
            mode: "deny",
            rule: compiled.rule,
            target: evaluation.target
          };
        }
      }
    }

    for (const evaluation of evaluations) {
      for (const compiled of this.compiledRules) {
        if (compiled.rule.mode === "deny" || !this.matches(compiled, evaluation)) {
          continue;
        }

        return {
          mode: compiled.rule.mode === "allow" && anyTruncated ? "ask" : compiled.rule.mode,
          rule: compiled.rule,
          target: evaluation.target
        };
      }
    }

    return {
      mode: this.settings.defaultMode === "allow" && anyTruncated ? "ask" : this.settings.defaultMode,
      target: targets[0] ?? {
        kind: "tool",
        label: "tool",
        value: "tool"
      }
    };
  }

  private matches(
    compiled: CompiledApprovalRule,
    evaluation: { target: ApprovalEvaluationTarget; value: string }
  ): boolean {
    if (compiled.rule.targetKind !== evaluation.target.kind) {
      return false;
    }
    compiled.matcher.lastIndex = 0;
    return compiled.matcher.test(evaluation.value);
  }
}

function compileApprovalPattern(rule: ApprovalPolicyRule): RegExp {
  const problem = validateApprovalPattern(rule.pattern);
  if (problem) {
    throw new ApprovalPolicyError(`Approval rule "${rule.id}" pattern ${problem}.`);
  }

  // Path targets are matched case-insensitively on case-insensitive
  // filesystems so `/Workspace/Secrets/...` cannot dodge a `/workspace/secrets/`
  // deny (security review H9).
  const flags = rule.targetKind === "path" && hasCaseInsensitiveFileSystem() ? "iu" : "u";
  return new RegExp(rule.pattern, flags);
}

function hasCaseInsensitiveFileSystem(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
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
    const match = policy.evaluateTargets([
      ...additionalTargets,
      ...extractApprovalTargets(input.call, input.definition, { cwd: input.session.cwd })
    ]);
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

// Synthesize mcp_server "allow" rules for servers configured as trusted and
// append them AFTER the operator's rules. A trusted server's tools are
// auto-approved, while an explicit operator deny rule (server-level mcp_server
// or tool-level mcp_tool/tool) always takes precedence because the policy
// evaluates deny rules on every target before any allow/ask rule. Untrusted
// servers are unaffected and flow through the normal approval policy.
export function withMcpTrustRules(
  settings: ApprovalSettings,
  servers: Record<string, { trust?: "prompt" | "trusted" }>
): ApprovalSettings {
  const trustRules: ApprovalPolicyRule[] = Object.entries(servers)
    .filter(([, config]) => config.trust === "trusted")
    .map(([serverName]) => ({
      id: `rule.mcp.trust.${serverName.replace(/[^A-Za-z0-9._:-]+/g, "-")}`,
      mode: "allow",
      notes: `Auto-approved: MCP server "${serverName}" is configured as trusted.`,
      pattern: `^${escapeRegExpLiteral(serverName)}$`,
      targetKind: "mcp_server"
    }));

  if (trustRules.length === 0) {
    return settings;
  }

  return { ...settings, rules: [...settings.rules, ...trustRules] };
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

export function extractApprovalTargets(
  call: ToolCallRecord,
  definition: ToolDefinition,
  options: ApprovalTargetExtractionOptions = {}
): ApprovalEvaluationTarget[] {
  const targets: ApprovalEvaluationTarget[] = [];
  const pushUnique = (target: ApprovalEvaluationTarget) => {
    if (!targets.some((entry) => entry.kind === target.kind && entry.value === target.value)) {
      targets.push(target);
    }
  };

  // Executable-plus-argv tools (exec_command) split the command line across
  // `command` and `args`. The command target must see the full line, otherwise
  // an allow rule for `git status` would also cover `git push --force`
  // (security review M6).
  const argvSuffix = stringifyArgv(call.arguments.args);

  for (const [key, value] of Object.entries(call.arguments)) {
    if (looksLikeCommandKey(key)) {
      const commandValue = stringifyCommandValue(value);
      if (commandValue) {
        pushUnique({
          kind: "command",
          label: key,
          value: argvSuffix ? `${commandValue} ${argvSuffix}` : commandValue
        });
      }
    }

    if (looksLikePathKey(key)) {
      for (const pathValue of stringifyPathValues(value)) {
        pushUnique({
          kind: "path",
          label: key,
          value: options.cwd ? canonicalizePathTarget(pathValue, options.cwd) : pathValue
        });
      }
    }
  }

  if (definition.kind === "mcp" && definition.source.serverName) {
    // Evaluate the more specific mcp_tool target BEFORE the coarse mcp_server
    // target so a tool-granularity operator rule (e.g. denying a single tool on
    // an otherwise-trusted server) is honored ahead of a server-level allow.
    pushUnique({
      kind: "mcp_tool",
      label: definition.displayName,
      value: definition.name
    });
    pushUnique({
      kind: "mcp_server",
      label: definition.source.serverName,
      value: definition.source.serverName
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

/**
 * Renders an argv array as one shell-looking command line for approval
 * matching and operator display. Exported so every producer of a `command`
 * approval target quotes identically — a policy regex has to match one
 * spelling, not several.
 */
export function stringifyArgv(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every((entry) => typeof entry === "string")) {
    return null;
  }
  return value.map((entry) => (/\s/u.test(entry) ? `'${entry.replace(/'/gu, "'\\''")}'` : entry)).join(" ");
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

// file:// URIs are local paths in disguise (the file tools resolve them), so
// they must reach the path rules; any other URL scheme is not a local path.
function isLikelyLocalPath(value: string): boolean {
  return /^file:\/\//iu.test(value) || !/^[a-z]+:\/\//iu.test(value);
}

function canonicalizePathTarget(value: string, cwd: string): string {
  try {
    return resolveLocalPath(value, cwd);
  } catch {
    // An unparseable file:// URI still goes through the policy as-is rather
    // than vanishing from the target list.
    return value;
  }
}
