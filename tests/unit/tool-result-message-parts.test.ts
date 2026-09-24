import { describe, expect, test } from "vitest";

import { createToolResultMessage, toolCallRecordSchema, type MessagePart } from "@/core";

function buildToolCall() {
  return toolCallRecordSchema.parse({
    arguments: {},
    id: "tool-call.audio.1",
    metadata: {},
    sessionId: "session.audio.1",
    startedAt: "2026-06-11T00:00:00.000Z",
    status: "pending",
    toolName: "voice_synthesize_text",
    turnId: "turn.audio.1"
  });
}

function audioPart(message: ReturnType<typeof createToolResultMessage>): (MessagePart & { kind: "audio" }) | undefined {
  return message.parts.find((part): part is MessagePart & { kind: "audio" } => part.kind === "audio");
}

// The audio message part schema requires durationMs to be a positive integer
// when present. buildToolResultMessageParts built it straight from arbitrary
// artifact/tool metadata with only a typeof/finite check, so a malformed
// artifact (a provider bug, or genuinely 0/negative duration) produced a part
// that violated its own schema the moment anything downstream validated it.
describe("createToolResultMessage audio parts", () => {
  test("keeps a genuinely positive integer duration", () => {
    const message = createToolResultMessage("session.audio.1", "turn.audio.1", buildToolCall(), {
      artifacts: [
        {
          id: "artifact.audio.1",
          kind: "audio",
          metadata: { durationMs: 1200 },
          name: "clip.aiff",
          uri: "file:///clip.aiff"
        }
      ],
      result: {}
    });

    expect(audioPart(message)?.durationMs).toBe(1200);
  });

  test("drops a zero duration instead of embedding an invalid part", () => {
    const message = createToolResultMessage("session.audio.1", "turn.audio.1", buildToolCall(), {
      artifacts: [
        {
          id: "artifact.audio.2",
          kind: "audio",
          metadata: { durationMs: 0 },
          name: "clip.aiff",
          uri: "file:///clip.aiff"
        }
      ],
      result: {}
    });

    expect(audioPart(message)?.durationMs).toBeUndefined();
  });

  test("drops a negative duration instead of embedding an invalid part", () => {
    const message = createToolResultMessage("session.audio.1", "turn.audio.1", buildToolCall(), {
      artifacts: [
        {
          id: "artifact.audio.3",
          kind: "audio",
          metadata: { durationMs: -5 },
          name: "clip.aiff",
          uri: "file:///clip.aiff"
        }
      ],
      result: {}
    });

    expect(audioPart(message)?.durationMs).toBeUndefined();
  });

  test("drops a sub-1ms duration that truncates to zero", () => {
    const message = createToolResultMessage("session.audio.1", "turn.audio.1", buildToolCall(), {
      artifacts: [
        {
          id: "artifact.audio.4",
          kind: "audio",
          metadata: { durationMs: 0.5 },
          name: "clip.aiff",
          uri: "file:///clip.aiff"
        }
      ],
      result: {}
    });

    expect(audioPart(message)?.durationMs).toBeUndefined();
  });
});
