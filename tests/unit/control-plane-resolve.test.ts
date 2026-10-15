import { describe, expect, test } from "vitest";

import { ControlPlaneService } from "@/server/control-plane/service";
import type { ServerRuntimeContext } from "@/server/runtime-context";

function approvalRecord(interaction?: string) {
  return {
    request: {
      createdAt: "2026-10-13T12:00:00.000Z",
      id: "approval.elicitation.1",
      justification: 'The MCP server "db" asks: Proceed?',
      metadata: interaction ? { interaction } : {},
      riskSummary: "The MCP server is waiting for your answer.",
      sessionId: "session.web.1",
      status: "approved",
      target: { kind: "question", label: "MCP db", value: "db" },
      turnId: "turn.web.1"
    },
    resolution: {
      actor: "web",
      decidedAt: "2026-10-13T12:00:05.000Z",
      decision: "approved",
      id: "resolution.approval.elicitation.1",
      metadata: {},
      requestId: "approval.elicitation.1"
    }
  };
}

function serviceRecording(interaction?: string) {
  const topics: string[] = [];
  const context = {
    gatewayRuntime: {
      async request(request: { id: string; topic: string }) {
        topics.push(request.topic);
        if (request.topic === "session.resume") {
          // Busy: another surface resumed it first, which the service accepts.
          return {
            createdAt: new Date().toISOString(),
            error: { code: "busy", details: {}, message: "Session is busy.", retriable: true },
            id: `response.${request.id}`,
            metadata: {},
            ok: false,
            requestId: request.id,
            topic: request.topic
          };
        }
        const payload =
          request.topic === "approval.resolve"
            ? { approval: approvalRecord(interaction) }
            : request.topic === "approval.list"
              ? { approvals: [] }
              : {};
        return {
          createdAt: new Date().toISOString(),
          id: `response.${request.id}`,
          metadata: {},
          ok: true,
          payload,
          requestId: request.id,
          topic: request.topic
        };
      }
    }
  } as unknown as ServerRuntimeContext;
  return { service: new ControlPlaneService(context), topics };
}

describe("ControlPlaneService.resolveApproval", () => {
  // An MCP server's question is answered while its run waits on it; the
  // resume that followed started a second run once the first had finished.
  test("does not resume a session after answering an MCP server's question", async () => {
    const { service, topics } = serviceRecording("elicitation");
    await service.resolveApproval({ decision: "approved", requestId: "approval.elicitation.1" });
    expect(topics).toEqual(["approval.resolve"]);
  });

  test("resumes after the last ordinary approval, as before", async () => {
    const { service, topics } = serviceRecording();
    await service.resolveApproval({ decision: "approved", requestId: "approval.elicitation.1" });
    expect(topics).toEqual(["approval.resolve", "approval.list", "session.resume"]);
  });
});
