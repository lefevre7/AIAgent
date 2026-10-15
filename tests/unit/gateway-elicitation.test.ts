import { describe, expect, test } from "vitest";

import type { ApprovalRequest, ApprovalResolution } from "@/core/contracts";
import type { McpElicitationRequest } from "@/core/mcp";
import { coerceAnswer, createMcpElicitationBroker, ELICITATION_INTERACTION } from "@/gateway/elicitation";

type Scripted = { comment?: string; decision: ApprovalResolution["decision"] } | "never";

function harness(options: { answers: Scripted[]; reachable?: boolean; timeoutMs?: number }) {
  const asked: ApprovalRequest[] = [];
  const expired: string[] = [];
  const answers = [...options.answers];
  const broker = createMcpElicitationBroker({
    ask: async (request) => {
      asked.push(request);
    },
    canReachOperator: async () => options.reachable ?? true,
    expire: async (requestId) => {
      expired.push(requestId);
    },
    timeoutMs: options.timeoutMs ?? 5_000,
    waitForAnswer: (requestId, signal) =>
      new Promise((resolve) => {
        const next = answers.shift();
        if (!next || next === "never") {
          signal.addEventListener("abort", () => resolve(null), { once: true });
          return;
        }
        resolve({
          actor: "cli",
          ...(next.comment !== undefined ? { comment: next.comment } : {}),
          decidedAt: new Date().toISOString(),
          decision: next.decision,
          id: `resolution.${requestId}`,
          metadata: {},
          requestId
        });
      })
  });
  return { asked, broker, expired };
}

function formRequest(signal = new AbortController().signal): McpElicitationRequest {
  return {
    context: { sessionId: "session.1", toolCallId: "call.1", turnId: "turn.1" },
    params: {
      message: "Who is deploying?",
      requestedSchema: {
        properties: {
          count: { type: "integer" },
          name: { description: "as on your badge", title: "Your name", type: "string" },
          region: { enum: ["us", "eu"], enumNames: ["United States", "Europe"], type: "string" },
          watch: { type: "boolean" }
        },
        required: ["name", "count"],
        type: "object"
      }
    },
    serverName: "deployer",
    signal
  };
}

describe("MCP elicitation broker", () => {
  test("asks one question per field, in order, and returns the typed answers", async () => {
    const { asked, broker } = harness({
      answers: [
        { comment: "2", decision: "approved" },
        { comment: "Ada", decision: "approved" },
        { comment: "2", decision: "approved" },
        { comment: "yes", decision: "approved" }
      ]
    });

    expect(await broker(formRequest())).toEqual({
      action: "accept",
      content: { count: 2, name: "Ada", region: "eu", watch: true }
    });
    expect(asked).toHaveLength(4);
    expect(asked[1]).toMatchObject({
      justification: 'The MCP server "deployer" asks: Who is deploying?\nYour name (as on your badge)',
      metadata: { interaction: ELICITATION_INTERACTION, mcpServer: "deployer" },
      sessionId: "session.1",
      target: { kind: "question", label: "MCP deployer", value: "deployer" },
      toolCallId: "call.1",
      turnId: "turn.1"
    });
    expect(asked[2]?.metadata.options).toEqual([
      { label: "United States", value: "us" },
      { label: "Europe", value: "eu" }
    ]);
  });

  test("an optional field left empty is omitted; a required one that does not fit declines", async () => {
    const skipped = harness({
      answers: [
        { comment: "", decision: "approved" },
        { comment: "Ada", decision: "approved" },
        { decision: "approved" },
        { decision: "approved" }
      ]
    });
    expect(await skipped.broker(formRequest())).toEqual({ action: "decline" });

    const optional = harness({
      answers: [
        { comment: "3", decision: "approved" },
        { comment: "Ada", decision: "approved" },
        { decision: "approved" },
        { decision: "approved" }
      ]
    });
    expect(await optional.broker(formRequest())).toEqual({ action: "accept", content: { count: 3, name: "Ada" } });
  });

  test("a denied question declines, a cancelled one cancels", async () => {
    expect(await harness({ answers: [{ decision: "denied" }] }).broker(formRequest())).toEqual({ action: "decline" });
    expect(await harness({ answers: [{ decision: "cancelled" }] }).broker(formRequest())).toEqual({
      action: "cancel"
    });
  });

  test("a URL request is one question with the link", async () => {
    const { asked, broker } = harness({ answers: [{ comment: "1", decision: "approved" }] });
    const result = await broker({
      context: { sessionId: "session.1", turnId: "turn.1" },
      params: { elicitationId: "e1", message: "Authorize the app.", mode: "url", url: "https://auth.example.com/x" },
      serverName: "deployer",
      signal: new AbortController().signal
    });
    expect(result).toEqual({ action: "accept" });
    expect(asked[0]?.justification).toContain("https://auth.example.com/x");
  });

  test("a form with nothing to fill in is a yes/no question, not an automatic yes", async () => {
    const confirmation = (signal = new AbortController().signal): McpElicitationRequest => ({
      context: { sessionId: "session.1", toolCallId: "call.1", turnId: "turn.1" },
      params: { message: "Drop the table users?", requestedSchema: { properties: {}, type: "object" } },
      serverName: "db",
      signal
    });

    const accepted = harness({ answers: [{ comment: "Accept", decision: "approved" }] });
    expect(await accepted.broker(confirmation())).toEqual({ action: "accept", content: {} });
    expect(accepted.asked).toHaveLength(1);
    expect(accepted.asked[0]?.justification).toBe('The MCP server "db" asks: Drop the table users?');
    expect(accepted.asked[0]?.metadata.options).toEqual([{ label: "Accept" }, { label: "Decline" }]);

    // Only an explicit yes accepts. The CLI's "Enter to skip" approves with
    // no answer, and skipping must not agree to dropping a table.
    for (const answer of [{ decision: "approved" as const }, { comment: "Decline", decision: "approved" as const }]) {
      expect(await harness({ answers: [answer] }).broker(confirmation())).toEqual({ action: "decline" });
    }
    expect(await harness({ answers: [{ decision: "denied" }] }).broker(confirmation())).toEqual({
      action: "decline"
    });
  });

  test("with nobody to ask, or outside a session, it declines without asking", async () => {
    const unreachable = harness({ answers: [], reachable: false });
    expect(await unreachable.broker(formRequest())).toEqual({ action: "decline" });
    expect(unreachable.asked).toEqual([]);

    // Asked, the question would hold the server's call until it expired.
    const sessionless = harness({ answers: [] });
    expect(await sessionless.broker({ ...formRequest(), context: {} })).toEqual({ action: "decline" });
    expect(sessionless.asked).toEqual([]);
  });

  test("an unanswered question expires after the timeout, and one the server withdrew is cancelled", async () => {
    const slow = harness({ answers: ["never"], timeoutMs: 50 });
    expect(await slow.broker(formRequest())).toEqual({ action: "decline" });
    expect(slow.expired).toHaveLength(1);

    const controller = new AbortController();
    const withdrawn = harness({ answers: ["never"] });
    const pending = withdrawn.broker(formRequest(controller.signal));
    setTimeout(() => controller.abort(), 20);
    expect(await pending).toEqual({ action: "cancel" });
    expect(withdrawn.expired).toHaveLength(1);
  });
});

describe("MCP elicitation broker timing", () => {
  // The gateway delivers an answer only to a registered waiter. An answer that
  // came back while the question was still being posted (a subscriber that
  // answers at once) used to find none, and the question sat until its timeout.
  test("an answer that arrives while the question is being posted is not lost", async () => {
    const waiters = new Map<string, (resolution: ApprovalResolution) => void>();
    const broker = createMcpElicitationBroker({
      ask: async (request) => {
        waiters.get(request.id)?.({
          actor: "sdk",
          comment: "yes",
          decidedAt: new Date().toISOString(),
          decision: "approved",
          id: `resolution.${request.id}`,
          metadata: {},
          requestId: request.id
        });
      },
      canReachOperator: async () => true,
      expire: async () => undefined,
      timeoutMs: 60_000,
      waitForAnswer: (requestId, signal) =>
        new Promise((resolve) => {
          waiters.set(requestId, resolve);
          signal.addEventListener("abort", () => resolve(null), { once: true });
        })
    });

    const startedAt = Date.now();
    const result = await broker({
      context: { sessionId: "session.1", turnId: "turn.1" },
      params: { message: "Proceed?", requestedSchema: { properties: {}, type: "object" } },
      serverName: "db",
      signal: new AbortController().signal
    });
    expect(result).toEqual({ action: "accept", content: {} });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

describe("coerceAnswer", () => {
  const options = [
    { label: "Blue", value: "blue" },
    { label: "Green", value: "green" }
  ];
  test("reads numbers, booleans, choices by number or label, and comma lists", () => {
    expect(coerceAnswer({ integer: true, kind: "number", options: [] }, "4")).toBe(4);
    expect(coerceAnswer({ integer: true, kind: "number", options: [] }, "4.5")).toBeUndefined();
    expect(coerceAnswer({ integer: false, kind: "number", options: [] }, "4.5")).toBe(4.5);
    expect(coerceAnswer({ integer: false, kind: "boolean", options: [] }, "No")).toBe(false);
    expect(coerceAnswer({ integer: false, kind: "enum", options }, "2")).toBe("green");
    expect(coerceAnswer({ integer: false, kind: "enum", options }, "blue")).toBe("blue");
    expect(coerceAnswer({ integer: false, kind: "enum", options }, "red")).toBeUndefined();
    expect(coerceAnswer({ integer: false, kind: "array", options }, "1, green")).toEqual(["blue", "green"]);
  });

  test("reads a choice by its own label before its position", () => {
    // Story points: "3" is the label of the first option, not the third one.
    const points = [
      { label: "3", value: "small" },
      { label: "5", value: "medium" },
      { label: "8", value: "large" }
    ];
    expect(coerceAnswer({ integer: false, kind: "enum", options: points }, "3")).toBe("small");
    expect(coerceAnswer({ integer: false, kind: "enum", options: points }, "2")).toBe("medium");
    expect(coerceAnswer({ integer: false, kind: "array", options: points }, "8, 1")).toEqual(["large", "small"]);
  });
});
