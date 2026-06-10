import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { FileSessionStore, type SessionRecord } from "@/core";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

describe("file session store", () => {
  test("persists session state, transcript records, and resume metadata", async () => {
    const root = await createTempRoot();
    const stateRoot = path.join(root, ".aia");
    const store = new FileSessionStore(stateRoot);
    const now = "2026-03-27T14:20:00.000Z";

    const session: SessionRecord = {
      createdAt: now,
      cwd: "/workspace",
      goal: "Implement session persistence",
      id: "session.store.1",
      lastActiveAt: now,
      metadata: { source: "cli" },
      status: "awaiting_user",
      tags: ["persistence"],
      title: "Session Store",
      updatedAt: now
    };

    await store.saveSession(session);
    await store.appendTurn({
      approvalRequestIds: ["approval.req.1"],
      executedToolCallIds: ["tool.call.1"],
      id: "turn.store.1",
      inputMessageIds: ["message.user.1"],
      metadata: {},
      outputMessageIds: ["message.assistant.1"],
      requestedToolCallIds: ["tool.call.1"],
      sequence: 0,
      sessionId: session.id,
      startedAt: now,
      status: "completed",
      trigger: "user"
    });
    await store.appendMessages([
      {
        createdAt: now,
        id: "message.user.1",
        metadata: {},
        parts: [{ kind: "text", text: "Please implement the session store." }],
        role: "user",
        sessionId: session.id,
        source: "user",
        tags: [],
        turnId: "turn.store.1",
        visibility: "default"
      },
      {
        createdAt: now,
        id: "message.assistant.1",
        metadata: {},
        parts: [{ kind: "text", text: "I am persisting the session now." }],
        role: "assistant",
        sessionId: session.id,
        source: "assistant",
        tags: [],
        turnId: "turn.store.1",
        visibility: "default"
      }
    ]);
    await store.appendToolCalls([
      {
        arguments: { path: "README.md" },
        id: "tool.call.1",
        metadata: {},
        result: { ok: true },
        sessionId: session.id,
        startedAt: now,
        status: "succeeded",
        toolName: "read_file",
        turnId: "turn.store.1"
      }
    ]);
    await store.appendApprovalRequest({
      createdAt: now,
      id: "approval.req.1",
      justification: "Needs approval metadata persisted.",
      metadata: {},
      riskSummary: "Workspace write",
      sessionId: session.id,
      status: "pending",
      target: {
        kind: "tool",
        label: "write_file",
        value: "write_file"
      },
      toolCallId: "tool.call.1",
      turnId: "turn.store.1"
    });
    await store.appendApprovalResolution(
      {
        actor: "cli",
        comment: "Approved",
        decidedAt: now,
        decision: "approved",
        id: "approval.resolution.1",
        metadata: {},
        requestId: "approval.req.1"
      },
      session.id
    );
    await store.appendSteeringInjections([
      {
        createdAt: now,
        id: "steering.1",
        message: "Use the patch pipeline only.",
        metadata: {},
        sessionId: session.id,
        source: "user",
        state: "applied",
        turnId: "turn.store.1"
      }
    ]);
    await store.appendVoiceCapture({
      completedAt: now,
      id: "voice.capture.1",
      metadata: {},
      providerId: "apple_native",
      sessionId: session.id,
      startedAt: now,
      status: "completed",
      text: "captured transcript",
      transcriptionId: "voice.transcription.capture.1"
    });
    await store.appendVoicePlayback({
      completedAt: now,
      id: "voice.playback.1",
      metadata: {},
      providerId: "local_system",
      sessionId: session.id,
      startedAt: now,
      status: "completed",
      text: "spoken output",
      voice: "Allison"
    });
    await store.appendVoiceTranscription({
      audio: {
        id: "artifact.audio.1",
        kind: "audio",
        metadata: {},
        uri: "file:///workspace/.aia/voice/input.wav"
      },
      completedAt: now,
      id: "voice.transcription.1",
      metadata: {},
      providerId: "apple_native",
      sessionId: session.id,
      startedAt: now,
      status: "completed",
      text: "transcribed input"
    });
    await store.saveResumeMetadata(session.id, {
      activeTurnId: "turn.store.1",
      lastMessageId: "message.assistant.1",
      pendingApprovalIds: [],
      pendingToolCallIds: [],
      statusSummary: "Waiting for the next user turn",
      surface: "cli",
      updatedAt: now
    });

    const snapshot = await store.getSessionSnapshot(session.id);
    expect(snapshot?.session.id).toBe(session.id);
    expect(snapshot?.messages).toHaveLength(2);
    expect(snapshot?.toolCalls).toHaveLength(1);
    expect(snapshot?.approvalRequests).toHaveLength(1);
    expect(snapshot?.approvalResolutions).toHaveLength(1);
    expect(snapshot?.steeringInjections).toHaveLength(1);
    expect(snapshot?.voiceCaptures).toHaveLength(1);
    expect(snapshot?.voicePlaybacks).toHaveLength(1);
    expect(snapshot?.voiceTranscriptions).toHaveLength(1);
    expect(snapshot?.resumeMetadata?.lastMessageId).toBe("message.assistant.1");

    expect((await store.listSessions()).map((entry) => entry.id)).toContain(session.id);
    expect(await store.readPendingApprovals()).toEqual({});

    const globalLog = await fs.readFile(path.join(stateRoot, "logs", "session-events.jsonl"), "utf8");
    expect(globalLog).toContain('"kind":"session_saved"');
    expect(globalLog).toContain('"kind":"message_appended"');
    expect(globalLog).toContain('"kind":"approval_resolution_appended"');
    expect(globalLog).toContain('"kind":"voice_capture_appended"');
  });
});

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-sessions-"));
  tempRoots.push(root);
  return root;
}
