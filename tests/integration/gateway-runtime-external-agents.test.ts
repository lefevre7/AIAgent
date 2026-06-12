import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  FileExternalAgentService,
  FileSessionStore,
  createDefaultAppConfig,
  createDefaultToolRuntime,
  gatewayRequestSchema
} from "@/core";
import { GatewayRuntime, createGatewayRuntime } from "@/gateway";

import { createMockCodexConfig } from "../helpers/external-agents";

const tempRoots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close().catch(() => undefined)));
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 })));
});

async function buildRuntime(options: { withExternalAgents: boolean }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-gw-ea-"));
  tempRoots.push(root);
  const config = createDefaultAppConfig({ userStateDirectory: path.join(root, "home", ".aia") });
  config.memory.stateRoot = path.join(root, ".aia");
  const sessions = new FileSessionStore(config.memory.stateRoot);

  const externalAgentService = options.withExternalAgents
    ? new FileExternalAgentService({ agents: { codex: createMockCodexConfig() }, stateRoot: path.join(root, ".aia", "external-agents") })
    : undefined;

  const runtime = new GatewayRuntime({
    approvals: { configVersion: 1, defaultMode: "allow", rules: [] },
    config,
    externalAgentService,
    mcpManager: { close: async () => undefined },
    memoryService: {
      compactSession: async () => undefined,
      getPromptContext: async () => null,
      initializeSessionMemory: async () => undefined,
      registerEmbeddingAdapter: () => undefined,
      setDefaultEmbeddingProvider: () => undefined
    },
    modelRuntime: { generate: async () => ({}), health: async () => ({ status: "healthy" }), registerAdapter: () => undefined },
    sessions,
    taskStateService: { getTaskState: async () => null },
    toolRuntime: createDefaultToolRuntime({}),
    workspaceRoot: root
  } as never);
  await runtime.initialize();
  closers.push(() => runtime.close());
  return { root, runtime };
}

function gwRequest(topic: string, payload: unknown) {
  return gatewayRequestSchema.parse({
    createdAt: "2026-06-11T00:00:00.000Z",
    id: `gateway-request.${topic}.${Math.round(payload ? 1 : 0)}.${topic.replace(/\W/gu, "")}`,
    metadata: { surface: "sdk" },
    payload,
    topic
  });
}

describe("gateway external-agent dispatch", () => {
  test("runs, gets, resumes, cancels, and lists external-agent jobs", async () => {
    const { root, runtime } = await buildRuntime({ withExternalAgents: true });

    const list = await runtime.request(gwRequest("external_agent.list", {}));
    expect(list.ok).toBe(true);
    expect((list.payload as { definitions: Array<{ id: string }> }).definitions.some((d) => d.id === "codex")).toBe(true);

    const jobId = "external-agent.codex.gw.1";
    const run = await runtime.request(
      gwRequest("external_agent.run", {
        agentId: "codex",
        args: [],
        cwd: root,
        id: jobId,
        instructions: "[interrupt] first pass",
        metadata: {},
        mode: "blocking"
      })
    );
    expect(run.ok).toBe(true);
    expect((run.payload as { status: string }).status).toBe("awaiting_resume");

    const got = await runtime.request(gwRequest("external_agent.get", { jobId }));
    expect((got.payload as { id: string }).id).toBe(jobId);

    const resumed = await runtime.request(gwRequest("external_agent.resume", { instructions: "second pass", jobId, mode: "blocking" }));
    expect((resumed.payload as { status: string }).status).toBe("succeeded");

    const cancelled = await runtime.request(gwRequest("external_agent.cancel", { jobId }));
    expect(cancelled.ok).toBe(true);

    const missing = await runtime.request(gwRequest("external_agent.get", { jobId: "external-agent.codex.missing" }));
    expect(missing.ok).toBe(false);
  });

  test("rejects external-agent requests when no service is configured", async () => {
    const { runtime } = await buildRuntime({ withExternalAgents: false });
    const list = await runtime.request(gwRequest("external_agent.list", {}));
    expect(list.ok).toBe(false);
    expect(list.error?.message).toContain("not configured");
  });

  test("registers language-model and embedding adapters on the runtime host", async () => {
    const { runtime } = await buildRuntime({ withExternalAgents: false });
    const host = runtime as unknown as {
      registerEmbeddingAdapter: (registration: unknown) => void;
      registerLanguageModelAdapter: (registration: unknown) => void;
    };

    expect(() =>
      host.registerLanguageModelAdapter({
        adapter: { providerId: "lm_studio" },
        defaultModel: "model-x",
        enabled: true
      })
    ).not.toThrow();

    expect(() =>
      host.registerEmbeddingAdapter({
        adapter: { providerId: "lm_studio" },
        defaultModel: "embed-x",
        makeDefault: true
      })
    ).not.toThrow();
  });

  test("createGatewayRuntime loads config from disk and serves requests", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-gw-factory-"));
    tempRoots.push(root);
    const cwd = path.join(root, "workspace");
    await fs.mkdir(cwd, { recursive: true });

    const runtime = await createGatewayRuntime({
      cwd,
      userHomeDirectory: path.join(root, "home")
    });
    await runtime.initialize();
    closers.push(() => runtime.close());

    const sessions = await runtime.request(gwRequest("session.list", { limit: 5 }));
    expect(sessions.ok).toBe(true);
    expect(Array.isArray((sessions.payload as { sessions: unknown[] }).sessions)).toBe(true);
  });
});
