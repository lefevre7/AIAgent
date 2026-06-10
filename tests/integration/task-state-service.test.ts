import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { FileSessionStore, TaskStateService, createDefaultToolRuntime, type SessionRecord } from "@/core";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

describe("task state service", () => {
  test("persists canonical plan state and derives progress, blockers, and next step", async () => {
    const root = await createTempRoot();
    const stateRoot = path.join(root, ".aia");
    const sessions = new FileSessionStore(stateRoot);
    const session = buildSession();
    await sessions.saveSession(session);

    const service = new TaskStateService({
      sessions,
      stateRoot
    });

    const snapshot = await service.updateTaskState({
      explanation: "Initial task decomposition.",
      items: [
        {
          status: "completed",
          title: "Audit the current architecture"
        },
        {
          status: "in_progress",
          title: "Implement the plan state service"
        },
        {
          blockedReason: "Waiting on an approval surface.",
          status: "blocked",
          title: "Expose the plan to the web control plane"
        }
      ],
      replaceWorkingMemory: true,
      sessionId: session.id,
      summary: "Keep one shared plan and short-lived working memory for the active task.",
      turnId: "turn.task-state.1",
      workingMemory: [
        {
          kind: "recent_attempt",
          priority: "medium",
          text: "Added the task-state service and default tool wiring."
        },
        {
          kind: "next_step",
          priority: "high",
          text: "Add the prompt and UI consumers next."
        },
        {
          kind: "blocker",
          priority: "high",
          text: "Web control plane surface is not implemented yet."
        }
      ]
    });

    const persistedSession = await sessions.getSession(session.id);
    expect(snapshot.progress).toEqual({
      blocked: 1,
      cancelled: 0,
      completed: 1,
      inProgress: 1,
      pending: 0,
      total: 3
    });
    expect(snapshot.nextStep?.text).toBe("Add the prompt and UI consumers next.");
    expect(snapshot.blockers.map((note) => note.text)).toContain("Web control plane surface is not implemented yet.");
    expect(snapshot.recentAttempts).toHaveLength(1);
    expect(persistedSession?.activePlanId).toBe("plan.session.task-state.1.default");
  });

  test("executes update_plan through the default runtime when task state service is configured", async () => {
    const root = await createTempRoot();
    const stateRoot = path.join(root, ".aia");
    const sessions = new FileSessionStore(stateRoot);
    const session = buildSession();
    await sessions.saveSession(session);

    const service = new TaskStateService({
      sessions,
      stateRoot
    });
    const runtime = createDefaultToolRuntime({
      taskStateService: service
    });

    const result = await runtime.execute(
      {
        arguments: {
          items: [
            {
              status: "in_progress",
              title: "Implement update_plan"
            }
          ],
          replaceWorkingMemory: true,
          summary: "Track plan updates.",
          workingMemory: [
            {
              kind: "next_step",
              priority: "high",
              text: "Run the integration tests."
            }
          ]
        },
        id: "tool-call.update-plan.1",
        metadata: {},
        sessionId: session.id,
        startedAt: "2026-03-27T16:10:00.000Z",
        status: "pending",
        toolName: "update_plan",
        turnId: "turn.task-state.1"
      },
      {
        session,
        turn: {
          approvalRequestIds: [],
          executedToolCallIds: [],
          id: "turn.task-state.1",
          inputMessageIds: [],
          metadata: {},
          outputMessageIds: [],
          requestedToolCallIds: [],
          sequence: 0,
          sessionId: session.id,
          startedAt: "2026-03-27T16:10:00.000Z",
          status: "running",
          trigger: "user"
        }
      }
    );

    expect(result.toolCall.status).toBe("succeeded");
    expect(result.toolCall.result).toMatchObject({
      progress: {
        inProgress: 1,
        total: 1
      },
      summary: "Track plan updates."
    });
  });
});

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-task-state-"));
  tempRoots.push(root);
  return root;
}

function buildSession(): SessionRecord {
  const now = "2026-03-27T16:00:00.000Z";
  return {
    createdAt: now,
    cwd: "/workspace",
    goal: "Exercise task-state management.",
    id: "session.task-state.1",
    lastActiveAt: now,
    metadata: {},
    status: "running_model",
    tags: [],
    title: "Task State Session",
    updatedAt: now
  };
}
