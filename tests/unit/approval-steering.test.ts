import { describe, expect, test } from "vitest";

import { CHANNEL_OPERATOR_METADATA_KEY, createSteeringFromDeniedResolution, type ApprovalResolution } from "@/core";

const resolution: ApprovalResolution = {
  actor: "channel",
  comment: "Use $release-notes instead.",
  decidedAt: "2026-10-14T00:00:00.000Z",
  decision: "denied",
  id: "approval-resolution.1",
  metadata: {},
  requestId: "approval.1"
};

describe("steering from a denied approval", () => {
  test("from a channel, it is marked as the operator's, as /steer is", () => {
    // A channel resolves an approval only for an allowlisted operator, but the
    // reason became steering without the mark, so a $name in it never loaded.
    const steering = createSteeringFromDeniedResolution("session.1", resolution, "channel");
    expect(steering).toMatchObject({
      message: "Use $release-notes instead.",
      metadata: { [CHANNEL_OPERATOR_METADATA_KEY]: true },
      source: "channel"
    });
  });

  test("from any other surface, it carries no channel mark", () => {
    const steering = createSteeringFromDeniedResolution("session.1", { ...resolution, actor: "web" }, "web");
    expect(steering.metadata).not.toHaveProperty(CHANNEL_OPERATOR_METADATA_KEY);
    expect(steering.source).toBe("operator");
  });
});
