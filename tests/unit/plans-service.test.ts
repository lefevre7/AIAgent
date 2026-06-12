import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { FileSessionStore, TaskStateService, sessionRecordSchema } from "@/core";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function buildService() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-plans-"));
  tempRoots.push(root);
  const stateRoot = path.join(root, ".aia");
  const sessions = new FileSessionStore(stateRoot);
  const session = sessionRecordSchema.parse({
    createdAt: "2026-06-11T00:00:00.000Z",
    cwd: "/workspace",
    goal: "plan work",
    id: "session.plan.1",
    lastActiveAt: "2026-06-11T00:00:00.000Z",
    metadata: {},
    status: "running_model",
    tags: [],
    title: "Plan",
    updatedAt: "2026-06-11T00:00:00.000Z"
  });
  await sessions.saveSession(session);
  return { service: new TaskStateService({ sessions, stateRoot }), sessionId: session.id };
}

describe("TaskStateService", () => {
  test("derives a next step and progress from a plan with no explicit next-step note", async () => {
    const { service, sessionId } = await buildService();

    const updated = await service.updateTaskState({
      items: [
        { status: "completed", title: "scaffold" },
        { status: "in_progress", title: "write the feature" },
        { status: "pending", title: "add tests" }
      ],
      sessionId,
      summary: "Building the feature",
      title: "Feature Plan"
    });
    expect(updated.progress).toMatchObject({ completed: 1, inProgress: 1, pending: 1, total: 3 });

    const state = await service.getTaskState(sessionId);
    expect(state?.nextStep?.text).toBe("write the feature");
    expect(state?.summary).toBe("Building the feature");

    const plan = await service.getPlan(sessionId);
    expect(plan?.title).toBe("Feature Plan");
    expect(plan?.items).toHaveLength(3);
  });

  test("returns null task state for an unknown session", async () => {
    const { service } = await buildService();
    await expect(service.getTaskState("session.unknown")).resolves.toBeNull();
  });

  test("rejects updates for an unknown session", async () => {
    const { service } = await buildService();
    await expect(service.updateTaskState({ sessionId: "session.unknown", title: "x" })).rejects.toThrow(/unknown session/u);
  });
});
