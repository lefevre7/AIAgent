import crypto from "node:crypto";

import {
  CHANNEL_OPERATOR_METADATA_KEY,
  type ApprovalActor,
  type ApprovalResolution,
  type SteeringInjection,
  type SteeringSource
} from "@/core/contracts";
import type { FileSessionStore } from "@/core/sessions";

export class ApprovalCoordinator {
  constructor(private readonly sessions: FileSessionStore) {}

  async resolveApproval(params: {
    actor?: ApprovalActor;
    autoQueueDeniedCommentAsSteering?: boolean;
    resolution: ApprovalResolution;
    sessionId: string;
  }): Promise<{
    steeringInjection?: SteeringInjection;
  }> {
    await this.sessions.appendApprovalResolution(params.resolution, params.sessionId);

    if (
      !params.autoQueueDeniedCommentAsSteering ||
      params.resolution.decision !== "denied" ||
      !params.resolution.comment?.trim()
    ) {
      return {};
    }

    const steeringInjection = createSteeringFromDeniedResolution(params.sessionId, params.resolution, params.actor);
    await this.sessions.appendSteeringInjections([steeringInjection]);
    return {
      steeringInjection
    };
  }
}

export function createSteeringFromDeniedResolution(
  sessionId: string,
  resolution: ApprovalResolution,
  actor: ApprovalActor = resolution.actor
): SteeringInjection {
  return {
    createdAt: resolution.decidedAt,
    id: `steering.approval.${resolution.id}.${crypto.randomUUID()}`,
    message: resolution.comment as string,
    metadata: {
      approvalDecision: resolution.decision,
      approvalRequestId: resolution.requestId,
      // A channel resolves an approval only for an allowlisted operator (the
      // gateway checks before any channel command), so a `/deny` reason is
      // the operator's, like `/steer`: a `$name` in it loads the skill.
      ...(actor === "channel" ? { [CHANNEL_OPERATOR_METADATA_KEY]: true } : {}),
      generatedFrom: "approval_resolution"
    },
    sessionId,
    source: mapApprovalActorToSteeringSource(actor),
    state: "queued"
  };
}

function mapApprovalActorToSteeringSource(actor: ApprovalActor): SteeringSource {
  switch (actor) {
    case "channel":
      return "channel";
    case "gateway":
      return "operator";
    case "sdk":
      return "sdk";
    case "system":
      return "system";
    case "cli":
    case "web":
    default:
      return "operator";
  }
}
