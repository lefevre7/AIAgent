import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ApprovalCoordinator, FileSessionStore, type SessionRecord } from "@/core";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

describe("approval coordinator", () => {
  test('converts denied approvals with operator guidance into queued steering', async () => {
    const root = await createTempRoot();
    const store = new FileSessionStore(path.join(root, ".aia"));
    const session = buildSession();
    const coordinator = new ApprovalCoordinator(store);
    await store.saveSession(session);
    await store.appendApprovalRequest({
      createdAt: "2026-03-27T15:00:00.000Z",
      id: "approval.req.coordinator.1",
      justification: "The write needs review.",
      metadata: {},
      riskSummary: "Workspace write",
      sessionId: session.id,
      status: "pending",
      target: {
        kind: "tool",
        label: "write_file",
        value: "write_file"
      },
      toolCallId: "tool.call.coordinator.1",
      turnId: "turn.coordinator.1"
    });

    const result = await coordinator.resolveApproval({
      actor: "web",
      autoQueueDeniedCommentAsSteering: true,
      resolution: {
        actor: "web",
        comment: "Do not write the file. Inspect it and propose a patch instead.",
        decidedAt: "2026-03-27T15:00:05.000Z",
        decision: "denied",
        id: "approval.resolution.coordinator.1",
        metadata: {},
        requestId: "approval.req.coordinator.1"
      },
      sessionId: session.id
    });

    const snapshot = await store.getSessionSnapshot(session.id);
    const pendingApprovals = await store.readPendingApprovals();

    expect(result.steeringInjection?.message).toContain("Inspect it and propose a patch instead.");
    expect(result.steeringInjection?.source).toBe("operator");
    expect(snapshot?.approvalResolutions).toHaveLength(1);
    expect(snapshot?.steeringInjections).toHaveLength(1);
    expect(snapshot?.steeringInjections[0]?.state).toBe("queued");
    expect(pendingApprovals).toEqual({});
  });
});

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-approval-coordinator-"));
  tempRoots.push(root);
  return root;
}

function buildSession(): SessionRecord {
  const now = "2026-03-27T15:00:00.000Z";
  return {
    createdAt: now,
    cwd: "/workspace",
    goal: "Exercise approval coordinator behavior.",
    id: "session.approval.coordinator.1",
    lastActiveAt: now,
    metadata: {},
    status: "awaiting_approval",
    tags: [],
    title: "Approval Coordinator",
    updatedAt: now
  };
}
