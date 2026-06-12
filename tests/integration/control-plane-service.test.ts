import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ControlPlaneService, createServerRuntimeContext, type ServerRuntimeContext } from "@/server";

const tempRoots: string[] = [];
const contexts: ServerRuntimeContext[] = [];

afterEach(async () => {
  await Promise.all(
    contexts.splice(0).map(async (context) => {
      await context.channelService.close().catch(() => undefined);
      await context.gatewayRuntime.close().catch(() => undefined);
    })
  );
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
    })
  );
});

describe("control-plane service over a real runtime context", () => {
  test("aggregates dashboard reads and supports session creation through the gateway", async () => {
    const { service, context } = await createService();

    const gateway = await service.getGatewaySummary();
    expect(gateway.status).toEqual({ ok: true, status: "ready" });
    expect(gateway.authMode).toBe("loopback_only");
    expect(gateway.websocketPath).toBe(context.loaded.resolvedConfig.gateway.websocketPath);

    const settings = await service.getSettingsSummary();
    expect(settings.gateway.port).toBe(context.loaded.resolvedConfig.gateway.port);
    expect(settings.memory.embeddingsEnabled).toBe(false);
    expect(Array.isArray(settings.channels)).toBe(true);

    const channels = await service.getChannels();
    expect(channels.routes).toEqual([]);
    expect(Array.isArray(channels.statuses)).toBe(true);
    expect(Array.isArray(channels.webhookEndpoints)).toBe(true);

    const tunnel = await service.getTunnelStatus();
    expect(tunnel).toBeTruthy();

    await expect(service.listApprovals()).resolves.toEqual([]);
    await expect(service.listSessions()).resolves.toEqual([]);

    const logs = await service.getLogs({ limit: 5 });
    expect(Array.isArray(logs.events)).toBe(true);

    const memory = await service.getMemory({ text: "progress updates" });
    expect(memory.query).toBe("progress updates");
    expect(Array.isArray(memory.hits)).toBe(true);
    expect(memory.status).toBeTruthy();

    const created = await service.createSession({
      cwd: context.cwd,
      goal: "Inspect the control plane",
      title: "Control Plane Session"
    });
    expect(created.session.id).toMatch(/^session\./u);

    const sessions = await service.listSessions();
    expect(sessions.map((session) => session.id)).toContain(created.session.id);

    const view = await service.getSessionView(created.session.id);
    expect(view.snapshot.snapshot.session.id).toBe(created.session.id);
    expect(view.route).toBeNull();

    const dashboard = await service.getDashboard();
    expect(dashboard.sessions.items.length).toBeGreaterThan(0);
    expect(dashboard.gateway.status.ok).toBe(true);
    expect(dashboard.bootstrap.name).toBeTruthy();
  });

  test("streams gateway events to subscribers (for SSE)", async () => {
    const { service, context } = await createService();
    const events: string[] = [];
    const unsubscribe = service.subscribeEvents((event) => {
      events.push(event.topic);
    });

    try {
      await service.createSession({ cwd: context.cwd, goal: "Stream events", title: "Events" });
      // session creation emits at least a session.updated/message event synchronously.
      expect(events.length).toBeGreaterThan(0);
    } finally {
      unsubscribe();
    }
  });

  test("queues steering for an existing session", async () => {
    const { service, context } = await createService();
    const created = await service.createSession({
      cwd: context.cwd,
      goal: "Steerable session",
      title: "Steering"
    });

    const steering = await service.injectSteering({
      message: "Focus on the smallest change first.",
      sessionId: created.session.id
    });

    expect(steering.sessionId).toBe(created.session.id);
    expect(steering.message).toContain("smallest change");
  });

  test("queues a session message and rejects resolving an unknown approval", async () => {
    const { service, context } = await createService();
    const created = await service.createSession({
      cwd: context.cwd,
      goal: "Message handling",
      title: "Messaging"
    });

    const sent = await service.sendSessionMessage({ sessionId: created.session.id, text: "hello there" });
    expect(sent).toBeTruthy();

    await expect(service.resolveApproval({ decision: "approved", requestId: "approval.does-not-exist" })).rejects.toBeTruthy();
  });
});

async function createService(): Promise<{ context: ServerRuntimeContext; service: ControlPlaneService }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-control-plane-"));
  tempRoots.push(root);
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });

  const context = await createServerRuntimeContext({
    cwd: workspace,
    env: {
      AIA_DEFAULT_MODEL: "fake-model",
      AIA_DEFAULT_PROVIDER: "lm_studio",
      AIA_LM_STUDIO_BASE_URL: "http://127.0.0.1:9/v1",
      AIA_MEMORY_CHAT_SESSION_ROOT: path.join(root, "chat-session-memory"),
      AIA_MEMORY_EMBEDDINGS_ENABLED: "false",
      AIA_MEMORY_HARD_FAIL_ON_STARTUP: "false",
      AIA_MEMORY_SQLITE_PATH: path.join(root, "state", "memory.sqlite"),
      AIA_MEMORY_STATE_ROOT: path.join(root, "state"),
      AIA_MEMORY_USER_GLOBAL_ROOT: path.join(root, "user-memory"),
      AIA_MEMORY_WORKSPACE_ROOT: path.join(root, "workspace-memory"),
      AIA_OLLAMA_BASE_URL: "http://127.0.0.1:9"
    }
  });
  contexts.push(context);

  return { context, service: new ControlPlaneService(context) };
}
