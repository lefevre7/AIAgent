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
});
