import { describe, expect, test } from "vitest";

import { gatewayEventSchema } from "@/core/contracts";
import { deriveGatewayEventSessionId, eventMatchesGatewaySubscription } from "@/gateway";

function messageDeltaEvent(sessionId: string) {
  return gatewayEventSchema.parse({
    createdAt: "2026-06-10T12:00:00.000Z",
    id: "message-delta.turn.1.abc",
    metadata: { sessionId },
    payload: { delta: "hello", sessionId, turnId: "turn.1" },
    topic: "message.delta"
  });
}

describe("gateway event subscription matching", () => {
  test("derives the session id for message.delta events", () => {
    expect(deriveGatewayEventSessionId(messageDeltaEvent("session.abc"))).toBe("session.abc");
  });

  test("a session-filtered subscription receives matching message.delta events", () => {
    const event = messageDeltaEvent("session.abc");
    expect(eventMatchesGatewaySubscription(event, { sessionId: "session.abc", topics: ["message.delta"] })).toBe(true);
    expect(eventMatchesGatewaySubscription(event, { sessionId: "session.other", topics: ["message.delta"] })).toBe(false);
  });

  test("topic filtering still applies to message.delta", () => {
    const event = messageDeltaEvent("session.abc");
    expect(eventMatchesGatewaySubscription(event, { topics: ["tool.updated"] })).toBe(false);
    expect(eventMatchesGatewaySubscription(event, { topics: ["message.delta"] })).toBe(true);
  });

  test("derives the session id for message.reasoning events too", () => {
    const event = gatewayEventSchema.parse({
      createdAt: "2026-06-10T12:00:00.000Z",
      id: "message-reasoning.turn.1.abc",
      metadata: { sessionId: "session.abc" },
      payload: { delta: "thinking", sessionId: "session.abc", turnId: "turn.1" },
      topic: "message.reasoning"
    });
    expect(deriveGatewayEventSessionId(event)).toBe("session.abc");
    expect(eventMatchesGatewaySubscription(event, { sessionId: "session.abc", topics: ["message.reasoning"] })).toBe(true);
    expect(eventMatchesGatewaySubscription(event, { sessionId: "session.other", topics: ["message.reasoning"] })).toBe(false);
  });

  test("routes live tool output deltas to the owning session only", () => {
    // Command output from a session-owned process must not leak into another
    // session's stream; unowned output (a detached process) has no session id
    // and is only visible to unfiltered subscribers.
    const event = gatewayEventSchema.parse({
      createdAt: "2026-06-10T12:00:00.000Z",
      id: "tool-output.command.1.abc",
      metadata: {},
      payload: {
        chunk: "build ok\n",
        sessionId: "session.abc",
        sourceId: "command.1",
        sourceKind: "command",
        stream: "combined"
      },
      topic: "tool.output.delta"
    });

    expect(deriveGatewayEventSessionId(event)).toBe("session.abc");
    expect(eventMatchesGatewaySubscription(event, { sessionId: "session.abc", topics: ["tool.output.delta"] })).toBe(true);
    expect(eventMatchesGatewaySubscription(event, { sessionId: "session.other", topics: ["tool.output.delta"] })).toBe(false);
    expect(eventMatchesGatewaySubscription(event, { topics: ["tool.updated"] })).toBe(false);
  });

  test("derives the session id from the payload or metadata for every event topic", () => {
    type Derivable = Parameters<typeof deriveGatewayEventSessionId>[0];
    const event = (topic: string, payload: unknown, metadata: unknown = {}): Derivable =>
      ({ createdAt: "2026-06-10T12:00:00.000Z", id: `${topic}.evt`, metadata, payload, topic }) as unknown as Derivable;

    const cases: Array<{ expected: string | undefined; event: Derivable }> = [
      { event: event("approval.requested", { sessionId: "s.approval-req" }), expected: "s.approval-req" },
      { event: event("approval.resolved", {}, { sessionId: "s.approval-res" }), expected: "s.approval-res" },
      { event: event("approval.resolved", {}, {}), expected: undefined },
      { event: event("channel.message", { sessionId: "s.channel" }), expected: "s.channel" },
      { event: event("channel.message", { sessionId: null }), expected: undefined },
      { event: event("external_agent.updated", { request: { sessionId: "s.ext" } }), expected: "s.ext" },
      { event: event("gateway.status", {}, { sessionId: "s.status" }), expected: "s.status" },
      { event: event("log.emitted", {}, { sessionId: "s.log" }), expected: "s.log" },
      { event: event("memory.updated", {}, { sessionId: "s.mem" }), expected: "s.mem" },
      { event: event("message.created", { sessionId: "s.msg" }), expected: "s.msg" },
      { event: event("run.updated", { sessionId: "s.run" }), expected: "s.run" },
      { event: event("session.updated", { id: "s.session" }), expected: "s.session" },
      { event: event("tool.output.delta", { sessionId: "s.tool-output" }), expected: "s.tool-output" },
      { event: event("tool.output.delta", {}), expected: undefined },
      { event: event("tool.updated", { sessionId: "s.tool" }), expected: "s.tool" },
      { event: event("turn.updated", { sessionId: "s.turn" }), expected: "s.turn" }
    ];

    for (const testCase of cases) {
      expect(deriveGatewayEventSessionId(testCase.event)).toBe(testCase.expected);
    }
  });
});
