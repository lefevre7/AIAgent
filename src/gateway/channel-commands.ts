import type { ChannelIdentity, ChannelKind, ChannelMessage } from "@/core/contracts";
import type { AppConfig } from "@/core/config";

/**
 * Parsing and authorization for the `/approve`-style control commands that
 * arrive as ordinary channel messages.
 *
 * Extracted out of `GatewayRuntime` so the authorization rule (security review
 * H6) sits next to the parser it guards rather than a thousand lines away in
 * the control plane's largest class.
 */

export type ChannelCommand =
  | {
      decision: "approved" | "cancelled" | "denied";
      kind: "approval";
      requestId?: string;
      comment?: string;
    }
  | {
      kind: "help";
    }
  | {
      kind: "steering";
      message: string;
    };

export function parseChannelCommand(message: ChannelMessage): ChannelCommand | null {
  const text = extractChannelCommandText(message);
  if (!text?.startsWith("/")) {
    return null;
  }

  const [rawCommand, ...rest] = text.split(/\s+/u);
  const command = rawCommand.slice(1).toLowerCase();
  switch (command) {
    case "approve":
    case "cancel":
    case "deny": {
      const [maybeRequestId, ...commentTokens] = rest;
      const hasRequestId =
        typeof maybeRequestId === "string" && maybeRequestId.length > 0 && maybeRequestId.includes(".");
      const comment = (hasRequestId ? commentTokens : rest).join(" ").trim() || undefined;
      return {
        comment,
        decision: command === "approve" ? "approved" : command === "deny" ? "denied" : "cancelled",
        kind: "approval",
        requestId: hasRequestId ? maybeRequestId : undefined
      };
    }
    case "help":
      return {
        kind: "help"
      };
    case "steer": {
      const messageText = rest.join(" ").trim();
      if (!messageText) {
        return {
          kind: "help"
        };
      }
      return {
        kind: "steering",
        message: messageText
      };
    }
    default:
      return null;
  }
}

export function extractChannelCommandText(message: ChannelMessage): string | null {
  const text = message.parts
    .flatMap((part) => {
      switch (part.kind) {
        case "markdown":
          return [part.markdown];
        case "text":
          return [part.text];
        default:
          return [];
      }
    })
    .join("\n")
    .trim();

  return text.length > 0 ? text : null;
}

/**
 * The sender ids allowed to issue control commands on a channel.
 *
 * Returns an empty list for channels that carry no such setting, which the
 * caller must treat as "nobody" — see `isAuthorizedChannelOperator`.
 */
export function resolveChannelOperatorIdentities(
  channelsConfig: AppConfig["channels"] | undefined,
  channel: ChannelKind
): string[] {
  if (!channelsConfig) {
    return [];
  }

  switch (channel) {
    case "discord":
      return channelsConfig.discord.operatorIdentities;
    case "imessage":
      return channelsConfig.imessage.operatorIdentities;
    case "teams":
      return channelsConfig.teams.operatorIdentities;
    case "whatsapp":
      return channelsConfig.whatsapp.operatorIdentities;
    // Local surfaces are not remote correspondents: their "sender" is the
    // operator already sitting at the machine.
    case "cli":
    case "gateway":
    case "sdk":
    case "web":
      return [];
  }
}

/**
 * Whether this sender may approve, deny, cancel, or steer (security review H6).
 *
 * Fails closed: an empty allowlist authorizes nobody. Previously any message
 * beginning with `/approve` resolved the latest pending approval with no
 * identity check at all, so the correspondent — or anyone able to write into
 * the bridge's inbound directory — could approve a dangerous tool call that
 * the approval gate existed to stop.
 *
 * Matching accepts either the bare `userId` or a `channel:userId` spelling so
 * an operator can disambiguate the same handle across channels.
 */
export function isAuthorizedChannelOperator(identity: ChannelIdentity, operatorIdentities: string[]): boolean {
  if (operatorIdentities.length === 0) {
    return false;
  }

  const candidates = new Set([
    identity.userId.toLowerCase(),
    `${identity.channel}:${identity.userId}`.toLowerCase()
  ]);

  return operatorIdentities.some((entry) => candidates.has(entry.trim().toLowerCase()));
}

export function buildChannelHelpText(): string {
  return [
    "Channel commands:",
    "/approve <requestId> to approve the latest pending action.",
    "/deny <requestId> <reason> to reject an action.",
    "/steer <message> to inject steering into the current session."
  ].join("\n");
}

/**
 * What an unauthorized sender is told. Deliberately names the setting and the
 * id to add: the most likely reader is the operator who has not configured the
 * allowlist yet, and a bare "not allowed" would look like a malfunction.
 */
export function buildUnauthorizedChannelCommandText(identity: ChannelIdentity): string {
  return [
    "That command is not available from this conversation.",
    `To allow it, add "${identity.userId}" to channels.${identity.channel}.operatorIdentities in your AIAgent config.`
  ].join(" ");
}
