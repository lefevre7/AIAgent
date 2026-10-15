import crypto from "node:crypto";

import type { ElicitResult } from "@modelcontextprotocol/sdk/types.js";

import { buildQuestionApproval, matchQuestionOption } from "@/core/approvals/questions";
import type { ApprovalRequest, ApprovalResolution } from "@/core/contracts";
import type { McpElicitationHandler, McpElicitationRequest } from "@/core/mcp";

/** `metadata.interaction` of an approval that carries an MCP server's question. */
export const ELICITATION_INTERACTION = "elicitation";

export const DEFAULT_ELICITATION_TIMEOUT_MS = 600_000;

/**
 * Whether an approval is answered while its run waits on it: an MCP server's
 * question, asked in the middle of a tool call. Resolving one needs no resume
 * (the run carries on by itself), and a resume after it started a second run
 * once the first had finished.
 */
export function isLiveApproval(request: { metadata?: Record<string, unknown> }): boolean {
  return request.metadata?.interaction === ELICITATION_INTERACTION;
}

export type ElicitationBrokerDeps = {
  /** Records the question as a pending approval and announces it (approval.requested). */
  ask(request: ApprovalRequest): Promise<void>;
  /** Whether anyone could answer for this session now (a watching surface, a channel). */
  canReachOperator(sessionId: string): Promise<boolean>;
  /** Marks a question nobody answered in time, so no surface shows it afterwards. */
  expire(requestId: string): Promise<void>;
  timeoutMs: number;
  /** Resolves with the operator's answer, or null when the wait is abandoned. */
  waitForAnswer(requestId: string, signal: AbortSignal): Promise<ApprovalResolution | null>;
};

type Field = {
  kind: "array" | "boolean" | "enum" | "number" | "string";
  integer: boolean;
  name: string;
  options: Array<{ label: string; value: string }>;
  required: boolean;
  schema: Record<string, unknown>;
};

/**
 * Answers an MCP server's mid-call question (elicitation) with the question
 * approvals the CLI, the web UI, and channels already show.
 *
 * A form becomes one question per field, in order: text and numbers typed,
 * a boolean or a choice picked from options (a multi-select answered as a
 * comma-separated list). A URL request becomes one question with the link.
 * Denying a question declines the whole request; answering them all accepts
 * it. The call that asked is not timed out meanwhile (the manager pauses its
 * clock), but each question waits at most `mcp.elicitationTimeoutMs`.
 *
 * With nobody to ask (a one-shot `--prompt` run, an SDK host with no
 * listener, a call made outside any session) the request is declined at once,
 * rather than holding the tool call until the timeout.
 */
export function createMcpElicitationBroker(deps: ElicitationBrokerDeps): McpElicitationHandler {
  return async (request) => {
    const context = request.context;
    if (!context?.sessionId || !context.turnId || !(await deps.canReachOperator(context.sessionId))) {
      return { action: "decline" };
    }
    const ask = (question: string, options: Array<{ label: string }>) =>
      askQuestion(deps, request, { question, sessionId: context.sessionId!, turnId: context.turnId!, options });

    const params = request.params;
    if (params.mode === "url") {
      const answer = await ask(
        `The MCP server "${request.serverName}" asks you to open this page: ${params.message}\n${params.url}`,
        [{ label: "Done" }, { label: "Decline" }]
      );
      if (answer.kind !== "answered") {
        return { action: answer.kind === "cancelled" ? "cancel" : "decline" };
      }
      return /^(1|done|ok|opened|yes|y)$/iu.test(answer.text.trim()) ? { action: "accept" } : { action: "decline" };
    }

    const fields = readFields(params.requestedSchema);
    if (fields.length === 0) {
      // A form with nothing to fill in is a confirmation ("Drop the table
      // users?"). Accepting it without asking let a server act as if the
      // operator had agreed to something they never saw.
      const answer = await ask(`The MCP server "${request.serverName}" asks: ${params.message}`, [
        { label: "Accept" },
        { label: "Decline" }
      ]);
      if (answer.kind !== "answered") {
        return { action: answer.kind === "cancelled" ? "cancel" : "decline" };
      }
      // Only an explicit yes accepts: the CLI's "Enter to skip" approves
      // with no answer, and a skipped confirmation must not agree to it.
      return /^(1|accept|accepted|ok|yes|y)$/iu.test(answer.text.trim())
        ? ({ action: "accept", content: {} } satisfies ElicitResult)
        : { action: "decline" };
    }
    const content: Record<string, string | number | boolean | string[]> = {};
    for (const field of fields) {
      const answer = await ask(describeField(request.serverName, params.message, field), field.options);
      if (answer.kind !== "answered") {
        return { action: answer.kind === "cancelled" ? "cancel" : "decline" };
      }
      const value = coerceAnswer(field, answer.text);
      if (value === undefined) {
        if (field.required) {
          return { action: "decline" };
        }
        continue;
      }
      content[field.name] = value;
    }
    return { action: "accept", content } satisfies ElicitResult;
  };
}

type Answer = { kind: "answered"; text: string } | { kind: "cancelled" } | { kind: "declined" };

async function askQuestion(
  deps: ElicitationBrokerDeps,
  request: McpElicitationRequest,
  question: { options: Array<{ label: string }>; question: string; sessionId: string; turnId: string }
): Promise<Answer> {
  const approval = buildQuestionApproval({
    id: `approval.elicitation.${crypto.randomUUID()}`,
    interaction: ELICITATION_INTERACTION,
    metadata: { mcpServer: request.serverName },
    options: question.options,
    question: question.question,
    riskSummary: `The MCP server "${request.serverName}" is waiting for your answer before its tool call can finish. Answer it as the comment; deny to decline.`,
    sessionId: question.sessionId,
    target: { label: `MCP ${request.serverName}`, value: request.serverName },
    ...(request.context?.toolCallId ? { toolCallId: request.context.toolCallId } : {}),
    turnId: question.turnId
  });
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  request.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  timer.unref?.();
  try {
    // Waiting starts before the question goes out: an answer can come back
    // while it is still being posted (a subscriber that answers at once), and
    // one that arrived with nobody waiting was lost until the timeout.
    const answered = deps.waitForAnswer(approval.id, controller.signal);
    await deps.ask(approval);
    const resolution = await answered;
    if (!resolution) {
      await deps.expire(approval.id).catch(() => undefined);
      return { kind: request.signal.aborted ? "cancelled" : "declined" };
    }
    if (resolution.decision === "approved") {
      return { kind: "answered", text: resolution.comment ?? "" };
    }
    return { kind: resolution.decision === "cancelled" ? "cancelled" : "declined" };
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
    // Releases the waiter when posting the question failed.
    controller.abort();
  }
}

function readFields(schema: unknown): Field[] {
  const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    isRecord(schema) && Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : []
  );
  return Object.entries(properties).flatMap(([name, raw]): Field[] => {
    if (!isRecord(raw)) {
      return [];
    }
    const base = { integer: raw.type === "integer", name, required: required.has(name), schema: raw };
    const choices = readChoices(raw);
    if (raw.type === "array") {
      return [{ ...base, kind: "array", options: readChoices(isRecord(raw.items) ? raw.items : {}) }];
    }
    if (choices.length > 0) {
      return [{ ...base, kind: "enum", options: choices }];
    }
    if (raw.type === "boolean") {
      return [
        {
          ...base,
          kind: "boolean",
          options: [
            { label: "Yes", value: "true" },
            { label: "No", value: "false" }
          ]
        }
      ];
    }
    if (raw.type === "number" || raw.type === "integer") {
      return [{ ...base, kind: "number", options: [] }];
    }
    return [{ ...base, kind: "string", options: [] }];
  });
}

// `enum` (with optional `enumNames`), `oneOf`/`anyOf` of `{ const, title }`.
function readChoices(schema: Record<string, unknown>): Array<{ label: string; value: string }> {
  if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return schema.enum.map((value, index) => ({
      label: typeof names[index] === "string" ? (names[index] as string) : String(value),
      value: String(value)
    }));
  }
  const variants = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : [];
  return variants.flatMap((variant) =>
    isRecord(variant) && variant.const !== undefined
      ? [
          {
            label: typeof variant.title === "string" ? variant.title : String(variant.const),
            value: String(variant.const)
          }
        ]
      : []
  );
}

function describeField(serverName: string, message: string, field: Field): string {
  const title = typeof field.schema.title === "string" ? field.schema.title : field.name;
  const description = typeof field.schema.description === "string" ? ` (${field.schema.description})` : "";
  const hint =
    field.kind === "array"
      ? "; several may be given, separated by commas"
      : field.kind === "number"
        ? `; ${field.integer ? "a whole number" : "a number"}`
        : "";
  return `The MCP server "${serverName}" asks: ${message}\n${title}${description}${field.required ? "" : " (optional)"}${hint}`;
}

/** The answer as the field's type, or undefined when it is empty or does not fit. */
export function coerceAnswer(field: Pick<Field, "integer" | "kind" | "options">, text: string) {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  // The rule every surface shares (matchQuestionOption): an option's value
  // or label first, a position only after.
  const pick = (entry: string) => matchQuestionOption(field.options, entry);
  switch (field.kind) {
    case "boolean": {
      if (/^(1|y|yes|true)$/iu.test(trimmed)) {
        return true;
      }
      return /^(2|n|no|false)$/iu.test(trimmed) ? false : undefined;
    }
    case "number": {
      const value = Number(trimmed);
      if (!Number.isFinite(value) || (field.integer && !Number.isInteger(value))) {
        return undefined;
      }
      return value;
    }
    case "enum":
      return pick(trimmed)?.value;
    case "array": {
      const entries = trimmed
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      if (field.options.length === 0) {
        return entries;
      }
      const values = entries.map((entry) => pick(entry)?.value);
      return values.every((value): value is string => value !== undefined) ? values : undefined;
    }
    case "string":
      return trimmed;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
