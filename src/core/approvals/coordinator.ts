import crypto from "node:crypto";

import type { ApprovalActor, ApprovalResolution, SteeringInjection, SteeringSource } from "@/core/contracts";
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
