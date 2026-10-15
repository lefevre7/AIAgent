import type {
  ApprovalPolicyMode,
  ApprovalPolicyRule,
  ApprovalRequest,
  ApprovalTarget,
  ApprovalTargetKind,
  ToolCallRecord,
  ToolDefinition
} from "@/core/contracts";
import { APPROVAL_TARGETS_METADATA_KEY, validateApprovalPattern } from "@/core/contracts";
import type { ApprovalSettings } from "@/core/config";
import { buildQuestionApproval, readQuestionOptions } from "@/core/approvals/questions";
import { analyzeShellCommand, type ShellCommandAnalysis } from "@/core/approvals/shell-command";
import { toMcpIdSegment } from "@/core/mcp/names";
import { resolveLocalPath } from "@/core/tools/builtins/local-paths";
import type { ToolApprovalDecider, ToolApprovalDeciderParams, ToolApprovalDecision } from "@/core/tools/runtime";

/** The approval policy's name for `ApprovalTarget`, kept for code written against it. */
export type ApprovalEvaluationTarget = ApprovalTarget;

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
  // mode applies when nothing matches at all. A command line is matched one
  // command at a time (see decideCommandLine).
  evaluateTargets(targets: ApprovalEvaluationTarget[]): ApprovalPolicyMatch {
    const evaluations = targets.map((target) => {
      const value = target.value.slice(0, MAX_APPROVAL_TARGET_VALUE_LENGTH);
      return {
        shell: target.kind === "command" ? analyzeShellCommand(value) : null,
        target,
        truncated: target.value.length > MAX_APPROVAL_TARGET_VALUE_LENGTH,
        value
      };
    });
    const anyTruncated = evaluations.some((entry) => entry.truncated);

    for (const evaluation of evaluations) {
      // A deny rule sees the whole line and each command in it, so wrapping a
      // command in a group or a pipeline cannot hide it.
      const candidates = [evaluation.value, ...(evaluation.shell?.segments ?? [])];
      for (const compiled of this.compiledRules) {
        if (
          compiled.rule.mode === "deny" &&
          candidates.some((candidate) => this.matches(compiled, evaluation.target.kind, candidate))
        ) {
          return {
            mode: "deny",
            rule: compiled.rule,
            target: evaluation.target
          };
        }
      }
    }

    for (const evaluation of evaluations) {
      if (evaluation.shell) {
        const decision = this.decideCommandLine(evaluation.target, evaluation.shell, evaluation.value, anyTruncated);
        if (decision) {
          return decision;
        }
        continue;
      }

      for (const compiled of this.compiledRules) {
        if (compiled.rule.mode === "deny" || !this.matches(compiled, evaluation.target.kind, evaluation.value)) {
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

  // A command line is allowed only when every command in it is, and nothing
  // in it needs a shell to know what it does: `$(…)`, backticks, process
  // substitution, or a redirect that writes a file turn an allow into a
  // question. An ask rule on any command asks. A command no rule covers leaves
  // the decision to the other targets and the default mode, as a lone
  // unmatched command always did.
  private decideCommandLine(
    target: ApprovalEvaluationTarget,
    shell: ShellCommandAnalysis,
    value: string,
    anyTruncated: boolean
  ): ApprovalPolicyMatch | null {
    const commands = shell.segments.length > 0 ? shell.segments : [value];
    const matched = commands.map((command) =>
      this.compiledRules.find((compiled) => compiled.rule.mode !== "deny" && this.matches(compiled, "command", command))
    );

    const asked = matched.find((compiled) => compiled?.rule.mode === "ask");
    if (asked) {
      return { mode: "ask", rule: asked.rule, target };
    }
    const [first] = matched;
    if (!first || matched.some((compiled) => compiled === undefined)) {
      return null;
    }
    return { mode: shell.opaque || anyTruncated ? "ask" : "allow", rule: first.rule, target };
  }

  private matches(compiled: CompiledApprovalRule, kind: ApprovalTargetKind, value: string): boolean {
    if (compiled.rule.targetKind !== kind) {
      return false;
    }
    compiled.matcher.lastIndex = 0;
    return compiled.matcher.test(value);
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

function uniqueTargets(targets: ApprovalEvaluationTarget[]): ApprovalEvaluationTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.kind}\u0000${target.value}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function hasCaseInsensitiveFileSystem(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}

export function createToolApprovalDecider(params: {
  /**
   * @deprecated A tool adds the targets it reaches through its own
   * `resolveApprovalScope` (as `external_agent` does). Still honoured, and
   * weighed like a scope's targets, for hosts that pass it.
   */
  resolveAdditionalTargets?: (input: ToolApprovalDeciderParams) => Promise<ApprovalEvaluationTarget[]>;
  /**
   * The settings, or a function returning the current ones: the rules a
   * trusted MCP server adds come and go with config reloads (a workspace
   * whose trust was revoked must stop auto-approving its server at once).
   * Compiled again only when the returned object changes.
   */
  settings: ApprovalSettings | (() => ApprovalSettings);
}): ToolApprovalDecider {
  let compiledFor: ApprovalSettings | undefined;
  let compiled: RegexApprovalPolicy | undefined;
  const currentPolicy = (): RegexApprovalPolicy => {
    const settings = typeof params.settings === "function" ? params.settings() : params.settings;
    if (!compiled || settings !== compiledFor) {
      compiled = new RegexApprovalPolicy(settings);
      compiledFor = settings;
    }
    return compiled;
  };

  return async (input) => {
    const policy = currentPolicy();
    // A tool acting through another capability (web_search running an MCP
    // search tool) is approved as that capability: its scope's mode wins.
    const approvalMode = input.scope?.approvalMode ?? input.definition.approvalMode;
    // A scope's path targets (a resource URI a template expands to) are
    // treated like the paths in a call's own arguments: a local one (a plain
    // path or a file:// URI) is resolved against the session's directory, and
    // any other URL scheme is not a local path at all.
    const additionalTargets = (await params.resolveAdditionalTargets?.(input)) ?? [];
    const scopeTargets = [...(input.scope?.targets ?? []), ...additionalTargets].flatMap((target) => {
      if (target.kind !== "path") {
        return [target];
      }
      return isLikelyLocalPath(target.value)
        ? [{ ...target, value: canonicalizePathTarget(target.value, input.session.cwd) }]
        : [];
    });

    if (approvalMode === "never") {
      if (scopeTargets.length === 0) {
        return {
          mode: "execute"
        };
      }
      // It still never asks, but it reaches an MCP server, and an operator's
      // deny rule on that server has to hold here too. Built-ins like
      // mcp_read_resource used to skip the policy entirely, so a server the
      // operator had denied stayed readable through them. Only a deny *rule*
      // refuses it: a `defaultMode` of deny covers what would otherwise ask,
      // and a never-mode tool never asks.
      const match = policy.evaluateTargets([
        ...scopeTargets,
        ...extractApprovalTargets(input.call, input.definition, { cwd: input.session.cwd })
      ]);
      return match.mode === "deny" && match.rule ? buildDenialDecision(match) : { mode: "execute" };
    }

    if (isReadOnlyExternalAgentAction(input)) {
      return {
        mode: "execute"
      };
    }

    // A target named twice (a host's resolveAdditionalTargets repeating what
    // the tool's scope adds) is weighed and shown once.
    const targets = uniqueTargets([
      ...scopeTargets,
      ...extractApprovalTargets(input.call, input.definition, { cwd: input.session.cwd })
    ]);
    const match = policy.evaluateTargets(targets);
    const resolvedMode = resolveApprovalMode(approvalMode, match.mode);

    if (resolvedMode === "allow") {
      return {
        mode: "execute"
      };
    }

    if (resolvedMode === "deny") {
      return buildDenialDecision(match);
    }

    return {
      mode: "request",
      request: isQuestionInteraction(input.definition)
        ? buildQuestionApprovalRequest(input)
        : buildApprovalRequest(input, match, targets, approvalMode)
    };
  };
}

function buildDenialDecision(match: ApprovalPolicyMatch): Extract<ToolApprovalDecision, { mode: "deny" }> {
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
      id: `rule.mcp.trust.${toMcpIdSegment(serverName)}`,
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

/**
 * `withMcpTrustRules` that follows config reloads: a function returning the
 * operator's settings plus the trust rules of the servers `readServers`
 * returns now, rebuilt only when it returns a different object. A reload that
 * drops a server's `trust: "trusted"` (a workspace whose trust was revoked)
 * stops its auto-approval at the next tool call, not the next restart.
 */
export function followMcpTrustRules(
  settings: ApprovalSettings,
  readServers: () => Record<string, { trust?: "prompt" | "trusted" }>
): () => ApprovalSettings {
  let servers = readServers();
  let current = withMcpTrustRules(settings, servers);
  return () => {
    const next = readServers();
    if (next !== servers) {
      servers = next;
      current = withMcpTrustRules(settings, next);
    }
    return current;
  };
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isQuestionInteraction(definition: ToolDefinition): boolean {
  return definition.annotations.meta.interaction === "question";
}

function buildQuestionApprovalRequest(params: ToolApprovalDeciderParams): ApprovalRequest {
  return buildQuestionApproval({
    id: `approval.${params.call.id}.${params.turn.id}.question`,
    interaction: "question",
    metadata: { approvalMode: params.definition.approvalMode, toolKind: params.definition.kind },
    options: readQuestionOptions(params.call.arguments.options),
    question:
      typeof params.call.arguments.question === "string"
        ? params.call.arguments.question
        : params.definition.displayName,
    riskSummary: "The agent is asking you a question before it continues. Resolve it with your answer as the comment.",
    sessionId: params.session.id,
    target: { label: params.definition.displayName, value: params.definition.invocationName },
    toolCallId: params.call.id,
    turnId: params.turn.id
  });
}

/**
 * The approval targets of a call that reaches an MCP server. The specific
 * mcp_tool target comes BEFORE the coarse mcp_server one, so a tool-level rule
 * (denying one tool of an otherwise trusted server, say) is honoured ahead of
 * a server-level allow. Direct MCP tool calls and the built-ins that act
 * through a server (web_search, mcp_read_resource) share this, so a rule
 * written for one matches all of them.
 *
 * `tool.name` is `formatMcpToolName(server, rawToolName)`.
 */
export function buildMcpApprovalTargets(params: {
  serverName: string;
  tool?: { label: string; name: string };
}): ApprovalEvaluationTarget[] {
  return [
    ...(params.tool ? [{ kind: "mcp_tool" as const, label: params.tool.label, value: params.tool.name }] : []),
    { kind: "mcp_server" as const, label: params.serverName, value: params.serverName }
  ];
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
    for (const target of buildMcpApprovalTargets({
      serverName: definition.source.serverName,
      tool: { label: definition.displayName, name: definition.name }
    })) {
      pushUnique(target);
    }
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

function buildApprovalRequest(
  params: ToolApprovalDeciderParams,
  match: ApprovalPolicyMatch,
  targets: ApprovalEvaluationTarget[],
  approvalMode: ToolDefinition["approvalMode"]
): ApprovalRequest {
  return {
    createdAt: new Date().toISOString(),
    id: `approval.${params.call.id}.${params.turn.id}.${match.target.kind}`,
    justification:
      match.rule?.notes ??
      `The tool "${params.definition.name}" requires approval before it can run because it matched the configured policy.`,
    metadata: {
      approvalMode,
      // Everything the policy weighed, not only the target that decided: a
      // prompt for "write_file" alone never said which file it would write.
      [APPROVAL_TARGETS_METADATA_KEY]: targets.map((target) => ({
        kind: target.kind,
        label: target.label,
        value: target.value
      })),
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
