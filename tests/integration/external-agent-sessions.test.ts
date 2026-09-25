import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { FileExternalAgentSessionService } from "@/core/external-agents/sessions";
import type { ExternalAgentConfig } from "@/core/config";

const MOCK_CLI = path.resolve("tests/fixtures/external-agents/mock-external-agent-cli.mjs");

const roots: string[] = [];
const services: FileExternalAgentSessionService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function createService(
  overrides: Partial<ConstructorParameters<typeof FileExternalAgentSessionService>[0]> = {}
): Promise<{ root: string; service: FileExternalAgentSessionService }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-ext-session-"));
  roots.push(root);

  const agent: ExternalAgentConfig = {
    args: [MOCK_CLI, "interactive"],
    command: process.execPath,
    displayName: "Mock Interactive Agent",
    enabled: true,
    env: {},
    instructionMode: "arg",
    interactive: {
      args: ["--mock-bypass"],
      idleMs: 250,
      readyPattern: "^> $",
      stabilityMs: 150,
      turnTimeoutMs: 15_000
    },
    kind: "claude",
    outputFormatFlag: "--output-format",
    outputFormatValue: "json",
    passEnv: [],
    printFlag: "--print",
    resumeFlag: "--resume"
  };

  const service = new FileExternalAgentSessionService({
    agents: { mock: agent },
    defaultCwd: root,
    stateRoot: path.join(root, "external-agents"),
    ...overrides
  });
  services.push(service);
  return { root, service };
}

describe("FileExternalAgentSessionService", () => {
  test("starts a session, answers a turn, and reports the rendered screen", async () => {
    const chunks: string[] = [];
    const { service } = await createService({ onOutput: (event) => chunks.push(event.chunk) });

    const record = await service.startSession({ agentId: "mock", sessionId: "session.owner.1" });
    expect(record.status).toBe("running");
    expect(record.args).toEqual([MOCK_CLI, "interactive", "--mock-bypass"]);
    expect(record.sessionId).toBe("session.owner.1");

    const turn = await service.sendToSession({
      externalSessionId: record.id,
      noWait: false,
      text: "build the thing"
    });

    expect(turn.turnEndReason).toBe("ready_pattern");
    expect(turn.screen).toContain("answer: build the thing");
    // The spinner frames were overwritten in place, so they must not survive
    // into the screen the model is shown.
    expect(turn.screen).not.toContain("working \\");
    expect(turn.record.turnCount).toBe(1);
    expect(chunks.join("")).toContain("mock interactive agent ready");
  });

  test("refuses an agent write while a human is typing in the shared terminal", async () => {
    const { service } = await createService({ humanLockMs: 60_000 });
    const record = await service.startSession({ agentId: "mock" });

    await service.writeHumanInput(record.id, "hello from the human");

    await expect(
      service.sendToSession({ externalSessionId: record.id, noWait: true, text: "agent turn" })
    ).rejects.toThrow(/A human is typing/u);
  });

  test("fails closed when the human-input timestamp is unreadable", async () => {
    const { service } = await createService({ humanLockMs: 60_000 });
    const record = await service.startSession({ agentId: "mock" });
    await service.writeHumanInput(record.id, "hello from the human");

    // A damaged record used to disable the lock silently: Date.parse returns
    // NaN, every comparison against it is false, and the agent's write went
    // straight into whatever the human was halfway through typing.
    const stored = await service.listSessions();
    const live = stored.find((entry) => entry.id === record.id);
    if (!live) {
      throw new Error("Expected the started session to be listed.");
    }
    Object.assign(live, { lastHumanInputAt: "not-a-timestamp" });

    await expect(
      service.sendToSession({ externalSessionId: record.id, noWait: true, text: "agent turn" })
    ).rejects.toThrow(/unreadable lastHumanInputAt/u);
  });

  test("summarizes a turn when a summarizer is available and survives one that fails", async () => {
    const { service } = await createService({
      summarize: async ({ instruction, screen }) =>
        screen.includes("boom") ? Promise.reject(new Error("model down")) : `summary of ${instruction}`
    });
    const record = await service.startSession({ agentId: "mock" });

    const good = await service.sendToSession({ externalSessionId: record.id, noWait: false, text: "first" });
    expect(good.summary).toBe("summary of first");

    const failing = await service.sendToSession({ externalSessionId: record.id, noWait: false, text: "boom" });
    // A missing summary is never fatal: the screen is still the source of truth.
    expect(failing.summary).toBeUndefined();
    expect(failing.screen).toContain("answer: boom");
  });

  test("stops a session and keeps it readable from the durable log", async () => {
    const { service } = await createService();
    const record = await service.startSession({ agentId: "mock" });
    await service.sendToSession({ externalSessionId: record.id, noWait: false, text: "remember me" });

    const stopped = await service.stopSession({ externalSessionId: record.id });
    expect(stopped.status).toBe("stopped");
    expect(stopped.endedAt).toBeDefined();

    const read = await service.readSession({ externalSessionId: record.id, includeScrollback: false });
    expect(read.screen).toContain("remember me");

    const listed = await service.listSessions();
    expect(listed.map((entry) => entry.id)).toContain(record.id);
  });

  test("sweeps sessions that a previous process left marked running", async () => {
    const { root, service } = await createService();
    const record = await service.startSession({ agentId: "mock" });
    await service.stopSession({ externalSessionId: record.id });

    // Simulate a crash: the record claims running but no child exists.
    const recordPath = path.join(root, "external-agents", "sessions", record.id, "session.json");
    const stale = JSON.parse(await fs.readFile(recordPath, "utf8")) as Record<string, unknown>;
    delete stale.endedAt;
    await fs.writeFile(recordPath, JSON.stringify({ ...stale, status: "running" }), "utf8");

    const restarted = new FileExternalAgentSessionService({
      agents: {},
      defaultCwd: root,
      stateRoot: path.join(root, "external-agents")
    });
    services.push(restarted);

    const sessions = await restarted.listSessions();
    expect(sessions.find((entry) => entry.id === record.id)?.status).toBe("stopped");
  });

  test("reports a log-file write failure instead of crashing the host process", async () => {
    const createWriteStreamSpy = vi.spyOn(fsSync, "createWriteStream");
    const warnings: string[] = [];
    const { service } = await createService({ onWarning: (message) => warnings.push(message) });

    const record = await service.startSession({ agentId: "mock" });
    const logStream = createWriteStreamSpy.mock.results.at(-1)?.value as fsSync.WriteStream;
    expect(logStream).toBeDefined();

    // Simulate a real write failure (disk full, permission revoked mid-session)
    // on the same stream instance the service is using. Before the fix, an
    // unhandled 'error' event here is an uncaught exception that takes down
    // the whole host process; the fix attaches a listener that reports it
    // through `onWarning` instead.
    logStream.emit("error", new Error("ENOSPC: no space left on device"));

    expect(warnings.some((message) => message.includes(record.id) && message.includes("ENOSPC"))).toBe(true);

    // The session itself must still be usable — only the log write failed.
    const turn = await service.sendToSession({ externalSessionId: record.id, noWait: false, text: "still alive" });
    expect(turn.screen).toContain("answer: still alive");

    createWriteStreamSpy.mockRestore();
  });

  test("rejects an unknown or disabled agent id", async () => {
    const { service } = await createService();
    await expect(service.startSession({ agentId: "nope" })).rejects.toThrow(/not configured/u);
  });

  // GatewayRuntime.close() awaits shutdown(), so a child that handles or
  // ignores SIGTERM (a TUI confirming exit, an agent run through an
  // interactive shell) held the REPL's exit and server shutdown open forever.
  test("shutdown() escalates to SIGKILL when a child ignores SIGTERM", async () => {
    const stubborn: ExternalAgentConfig = {
      args: ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('> '); setInterval(() => {}, 1000);"],
      command: process.execPath,
      displayName: "SIGTERM-ignoring agent",
      enabled: true,
      env: {},
      instructionMode: "arg",
      interactive: { args: [], idleMs: 100, readyPattern: "^> $", stabilityMs: 50, turnTimeoutMs: 5_000 },
      kind: "claude",
      outputFormatFlag: "--output-format",
      outputFormatValue: "json",
      passEnv: [],
      printFlag: "--print",
      resumeFlag: "--resume"
    };
    const { service } = await createService({ agents: { stubborn }, shutdownGraceMs: 200 });
    const record = await service.startSession({ agentId: "stubborn" });

    const started = Date.now();
    await service.shutdown();

    expect(Date.now() - started).toBeLessThan(5_000);
    const [stored] = await service.listSessions();
    expect(stored?.id).toBe(record.id);
    expect(stored?.status).not.toBe("running");
  });
});
