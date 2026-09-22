import { describe, expect, test } from "vitest";

import type { ChannelIdentity, ChannelMessage } from "@/core/contracts";
import { createDefaultAppConfig } from "@/core/config";
import {
  isAuthorizedChannelOperator,
  parseChannelCommand,
  resolveChannelOperatorIdentities
} from "@/gateway/channel-commands";

function identity(overrides: Partial<ChannelIdentity> = {}): ChannelIdentity {
  return {
    accountId: "account-1",
    channel: "whatsapp",
    userId: "user-42",
    ...overrides
  };
}

function message(text: string, overrides: Partial<ChannelIdentity> = {}): ChannelMessage {
  return {
    attachments: [],
    createdAt: "2026-03-31T12:00:00.000Z",
    direction: "inbound",
    id: "channel-message.test.1",
    identity: identity(overrides),
    metadata: {},
    parts: [{ kind: "text", text }]
  };
}

describe("parseChannelCommand", () => {
  test("parses approve, deny, and cancel with an optional request id and comment", () => {
    expect(parseChannelCommand(message("/approve"))).toEqual({
      comment: undefined,
      decision: "approved",
      kind: "approval",
      requestId: undefined
    });

    expect(parseChannelCommand(message("/deny approval.abc.1 too risky"))).toEqual({
      comment: "too risky",
      decision: "denied",
      kind: "approval",
      requestId: "approval.abc.1"
    });

    expect(parseChannelCommand(message("/cancel"))?.kind).toBe("approval");
  });

  test("treats a bare /steer as help and a populated one as steering", () => {
    expect(parseChannelCommand(message("/steer"))).toEqual({ kind: "help" });
    expect(parseChannelCommand(message("/steer run the tests first"))).toEqual({
      kind: "steering",
      message: "run the tests first"
    });
  });

  test("ignores ordinary messages and unknown commands", () => {
    expect(parseChannelCommand(message("hello there"))).toBeNull();
    expect(parseChannelCommand(message("/deploy production"))).toBeNull();
  });
});

// Security review H6.
describe("isAuthorizedChannelOperator", () => {
  test("fails closed when no operator is configured", () => {
    expect(isAuthorizedChannelOperator(identity(), [])).toBe(false);
  });

  test("authorizes a listed sender by bare id or channel-qualified id", () => {
    expect(isAuthorizedChannelOperator(identity(), ["user-42"])).toBe(true);
    expect(isAuthorizedChannelOperator(identity(), ["whatsapp:user-42"])).toBe(true);
  });

  test("ignores case and surrounding whitespace in configured entries", () => {
    expect(isAuthorizedChannelOperator(identity(), ["  USER-42 "])).toBe(true);
  });

  test("refuses a sender who is not listed", () => {
    expect(isAuthorizedChannelOperator(identity({ userId: "user-intruder" }), ["user-42"])).toBe(false);
  });

  // A handle listed for one channel must not authorize the same handle
  // arriving over a different one.
  test("does not let a channel-qualified entry authorize another channel", () => {
    expect(isAuthorizedChannelOperator(identity({ channel: "discord" }), ["whatsapp:user-42"])).toBe(false);
  });
});

describe("resolveChannelOperatorIdentities", () => {
  test("reads the per-channel allowlist and treats local surfaces as having none", () => {
    const config = createDefaultAppConfig({ userStateDirectory: "/tmp/aia-state" });
    config.channels.whatsapp.operatorIdentities = ["user-42"];
    config.channels.discord.operatorIdentities = ["discord-user"];

    expect(resolveChannelOperatorIdentities(config.channels, "whatsapp")).toEqual(["user-42"]);
    expect(resolveChannelOperatorIdentities(config.channels, "discord")).toEqual(["discord-user"]);
    expect(resolveChannelOperatorIdentities(config.channels, "teams")).toEqual([]);
    expect(resolveChannelOperatorIdentities(config.channels, "cli")).toEqual([]);
    expect(resolveChannelOperatorIdentities(undefined, "whatsapp")).toEqual([]);
  });
});
