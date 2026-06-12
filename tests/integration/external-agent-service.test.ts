import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { FileExternalAgentService, FileSessionStore, buildExternalAgentArtifacts } from "@/core";

import {
  buildExternalAgentSession,
  createMockClaudeConfig,
  createMockCodexConfig,
  createMockMistralVibeConfig
} from "../helpers/external-agents";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

describe("external-agent service", () => {
  test("runs blocking Codex jobs with structured output and persisted artifacts", async () => {
    const root = await createTempRoot();
    const service = new FileExternalAgentService({
      agents: {
        codex: createMockCodexConfig()
      },
      stateRoot: path.join(root, ".aia", "external-agents")
    });

    const job = await service.run({
      agentId: "codex",
      args: [],
      cwd: root,
      id: "external-job.service.blocking",
      instructions: "structured success",
      metadata: {},
      mode: "blocking",
      resultSchema: {
        properties: {
          message: { type: "string" },
          mode: { type: "string" }
        },
        required: ["message", "mode"],
        type: "object"
      }
    });

    expect(job.status).toBe("succeeded");
    expect(job.nativeSessionId).toMatch(/^mock-codex-session-/u);
    expect(job.structuredResult).toEqual({
      message: "mock codex structured success",
      mode: "codex"
    });
    expect(job.resultArtifact?.kind).toBe("json");
    expect(job.logPaths.stdout).toBeTruthy();
    expect(job.logPaths.summary).toBeTruthy();
    if (!job.resultArtifact?.uri || !job.logPaths.summary) {
      throw new Error("Expected persisted result and summary artifacts.");
    }
    await expect(fs.readFile(new URL(job.resultArtifact.uri), "utf8")).resolves.toContain('"mode": "codex"');
    await expect(fs.readFile(job.logPaths.summary, "utf8")).resolves.toContain("Structured result ready");
  });

  test("fails a blocking job when the agent binary cannot be spawned", async () => {
    const root = await createTempRoot();
    const service = new FileExternalAgentService({
      agents: {
        codex: createMockCodexConfig({ command: path.join(root, "no-such-binary-xyz") })
      },
      stateRoot: path.join(root, ".aia", "external-agents")
    });

    const job = await service.run({
      agentId: "codex",
      args: [],
      cwd: root,
      id: "external-job.service.failstart",
      instructions: "this will never launch",
      metadata: {},
      mode: "blocking"
    });

    expect(job.status).toBe("failed");
    expect(job.error?.message ?? "").not.toBe("");

    const fetched = await service.getJob(job.id);
    expect(fetched?.status).toBe("failed");
  });

  test("recovers detached jobs across service instances and appends compact session messages", async () => {
    const root = await createTempRoot();
    const sessions = new FileSessionStore(path.join(root, ".aia"));
    const session = buildExternalAgentSession({
      cwd: root,
      id: "session.external-agent.recovery"
    });
    await sessions.saveSession(session);

    const options = {
      agents: {
        codex: createMockCodexConfig()
      },
      sessions,
      stateRoot: path.join(root, ".aia", "external-agents")
    };

    const firstService = new FileExternalAgentService(options);
    const started = await firstService.run({
      agentId: "codex",
      args: [],
      cwd: root,
      id: "external-job.service.detached",
      instructions: "[sleep:300] detached success",
      metadata: {},
      mode: "detached",
      sessionId: session.id
    });

    expect(started.status).toBe("running");

    const recoveredService = new FileExternalAgentService(options);
    const terminal = await waitForTerminalJob(recoveredService, started.id);

    expect(terminal.status).toBe("succeeded");
    expect(terminal.monitorState).toBe("recovered");

    const snapshot = await sessions.getSessionSnapshot(session.id);
    const externalAgentMessages = snapshot?.messages.filter((message) => message.source === "external_agent") ?? [];
    expect(externalAgentMessages).toHaveLength(1);
    expect(externalAgentMessages[0]?.visibility).toBe("compact");
    expect(externalAgentMessages[0]?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "status",
          state: "succeeded"
        })
      ])
    );
  });

  test("resumes interrupted Codex jobs using the captured native session id", async () => {
    const root = await createTempRoot();
    const service = new FileExternalAgentService({
      agents: {
        codex: createMockCodexConfig()
      },
      stateRoot: path.join(root, ".aia", "external-agents")
    });

    const interrupted = await service.run({
      agentId: "codex",
      args: [],
      cwd: root,
      id: "external-job.service.resume",
      instructions: "[interrupt] first pass",
      metadata: {},
      mode: "blocking"
    });

    expect(interrupted.status).toBe("awaiting_resume");
    expect(interrupted.nativeSessionId).toMatch(/^mock-codex-session-/u);

    const resumed = await service.resume({
      instructions: "second pass",
      jobId: interrupted.id,
      mode: "blocking"
    });

    expect(resumed.status).toBe("succeeded");
    expect(resumed.attempts).toBe(2);
    expect(resumed.summary).toContain("mock codex result: second pass");
  });

  test("runs blocking Claude jobs and harvests the result text and native session id", async () => {
    const root = await createTempRoot();
    const service = new FileExternalAgentService({
      agents: {
        claude: createMockClaudeConfig()
      },
      stateRoot: path.join(root, ".aia", "external-agents")
    });

    const job = await service.run({
      agentId: "claude",
      args: [],
      cwd: root,
      id: "external-job.service.claude.blocking",
      instructions: "summarize the repository",
      metadata: {},
      mode: "blocking"
    });

    expect(job.status).toBe("succeeded");
    expect(job.nativeSessionId).toMatch(/^mock-claude-session-/u);
    expect(job.resultArtifact?.kind).toBe("text");
    expect(job.summary).toContain("mock claude result: summarize the repository");
    if (!job.logPaths.summary) {
      throw new Error("Expected a persisted summary artifact.");
    }
    await expect(fs.readFile(job.logPaths.summary, "utf8")).resolves.toContain("mock claude result");
  });

  test("resumes Claude jobs using the captured native session id", async () => {
    const root = await createTempRoot();
    const service = new FileExternalAgentService({
      agents: {
        claude: createMockClaudeConfig()
      },
      stateRoot: path.join(root, ".aia", "external-agents")
    });

    const first = await service.run({
      agentId: "claude",
      args: [],
      cwd: root,
      id: "external-job.service.claude.resume",
      instructions: "first pass",
      metadata: {},
      mode: "blocking"
    });

    expect(first.status).toBe("succeeded");
    expect(first.nativeSessionId).toMatch(/^mock-claude-session-/u);

    const resumed = await service.resume({
      instructions: "second pass",
      jobId: first.id,
      mode: "blocking"
    });

    expect(resumed.status).toBe("succeeded");
    expect(resumed.attempts).toBe(2);
    expect(resumed.nativeSessionId).toBe(first.nativeSessionId);
    expect(resumed.summary).toContain("mock claude resumed: second pass");
  });

  test("rejects structured output for the Claude preset", async () => {
    const root = await createTempRoot();
    const service = new FileExternalAgentService({
      agents: {
        claude: createMockClaudeConfig()
      },
      stateRoot: path.join(root, ".aia", "external-agents")
    });

    await expect(
      service.run({
        agentId: "claude",
        args: [],
        cwd: root,
        id: "external-job.service.claude.structured",
        instructions: "structured response",
        metadata: {},
        mode: "blocking",
        resultSchema: {
          type: "object"
        }
      })
    ).rejects.toMatchObject({
      code: "external_agent_structured_output_unsupported"
    });
  });

  test("rejects structured output for the Mistral Vibe preset", async () => {
    const root = await createTempRoot();
    const service = new FileExternalAgentService({
      agents: {
        mistral_vibe: createMockMistralVibeConfig()
      },
      stateRoot: path.join(root, ".aia", "external-agents")
    });

    await expect(
      service.run({
        agentId: "mistral_vibe",
        args: [],
        cwd: root,
        id: "external-job.service.vibe.structured",
        instructions: "structured response",
        metadata: {},
        mode: "blocking",
        resultSchema: {
          type: "object"
        }
      })
    ).rejects.toMatchObject({
      code: "external_agent_structured_output_unsupported"
    });
  });

  test("runs and resumes Mistral Vibe jobs, harvesting the assistant transcript", async () => {
    const root = await createTempRoot();
    const service = new FileExternalAgentService({
      agents: {
        mistral_vibe: createMockMistralVibeConfig()
      },
      stateRoot: path.join(root, ".aia", "external-agents")
    });

    const job = await service.run({
      agentId: "mistral_vibe",
      args: [],
      cwd: root,
      id: "external-job.service.vibe.run",
      instructions: "draft the changelog",
      metadata: {},
      mode: "blocking"
    });

    expect(job.status).toBe("succeeded");
    expect(job.nativeSessionId).toMatch(/^mock-vibe-session-/u);
    expect(job.summary).toContain("mock vibe result: draft the changelog");
    expect(job.resultArtifact).toBeTruthy();

    const resumed = await service.resume({
      instructions: "tighten the wording",
      jobId: job.id,
      mode: "blocking"
    });

    expect(resumed.status).toBe("succeeded");
    expect(resumed.attempts).toBe(2);
    expect(resumed.nativeSessionId).toBe(job.nativeSessionId);
    expect(resumed.summary).toContain("mock vibe result: tighten the wording");
  });

  test("harvests a Mistral Vibe summary from session logs when stdout is empty", async () => {
    const root = await createTempRoot();
    const service = new FileExternalAgentService({
      agents: { mistral_vibe: createMockMistralVibeConfig() },
      stateRoot: path.join(root, ".aia", "external-agents")
    });

    const job = await service.run({
      agentId: "mistral_vibe",
      args: [],
      cwd: root,
      id: "external-job.service.vibe.logsonly",
      instructions: "[logsonly] summarize via logs",
      metadata: {},
      mode: "blocking"
    });

    expect(job.status).toBe("succeeded");
    expect(job.nativeSessionId).toMatch(/^mock-vibe-session-/u);
    expect(job.summary).toContain("mock vibe result: summarize via logs");
  });

  test("cancels a running detached job and terminates the child process", async () => {
    const root = await createTempRoot();
    const service = new FileExternalAgentService({
      agents: {
        codex: createMockCodexConfig()
      },
      stateRoot: path.join(root, ".aia", "external-agents")
    });

    const started = await service.run({
      agentId: "codex",
      args: [],
      cwd: root,
      id: "external-job.service.cancel.detached",
      instructions: "[sleep:5000] long running",
      metadata: {},
      mode: "detached"
    });

    expect(started.status).toBe("running");

    const cancelled = await service.cancel({ jobId: started.id });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.completedAt).toBeTruthy();
  });

  test("cancels a job that is awaiting resume without spawning a new process", async () => {
    const root = await createTempRoot();
    const service = new FileExternalAgentService({
      agents: {
        codex: createMockCodexConfig()
      },
      stateRoot: path.join(root, ".aia", "external-agents")
    });

    const interrupted = await service.run({
      agentId: "codex",
      args: [],
      cwd: root,
      id: "external-job.service.cancel.awaiting",
      instructions: "[interrupt] first pass",
      metadata: {},
      mode: "blocking"
    });

    expect(interrupted.status).toBe("awaiting_resume");

    const cancelled = await service.cancel({ jobId: interrupted.id });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.summary).toContain("cancelled before it resumed");

    // Cancelling an already-terminal job is idempotent.
    const again = await service.cancel({ jobId: interrupted.id });
    expect(again.status).toBe("cancelled");
  });

  test("marks a job failed with a timeout error when it exceeds its budget", async () => {
    const root = await createTempRoot();
    const service = new FileExternalAgentService({
      agents: {
        codex: createMockCodexConfig()
      },
      stateRoot: path.join(root, ".aia", "external-agents")
    });

    const job = await service.run({
      agentId: "codex",
      args: [],
      cwd: root,
      id: "external-job.service.timeout",
      instructions: "[sleep:5000] slow work",
      metadata: {},
      mode: "blocking",
      timeoutMs: 200
    });

    expect(job.status).toBe("failed");
    expect(job.error?.code).toBe("external_agent_timeout");
  });

  test("fails the job when the configured command cannot be spawned", async () => {
    const root = await createTempRoot();
    const service = new FileExternalAgentService({
      agents: {
        codex: createMockCodexConfig({
          args: [],
          command: path.join(root, "no-such-external-agent-binary")
        })
      },
      stateRoot: path.join(root, ".aia", "external-agents")
    });

    const job = await service.run({
      agentId: "codex",
      args: [],
      cwd: root,
      id: "external-job.service.spawn-failure",
      instructions: "should never start",
      metadata: {},
      mode: "blocking"
    });

    expect(job.status).toBe("failed");
    expect(job.error).toBeTruthy();
  });

  test("rejects duplicate job ids", async () => {
    const root = await createTempRoot();
    const service = new FileExternalAgentService({
      agents: {
        codex: createMockCodexConfig()
      },
      stateRoot: path.join(root, ".aia", "external-agents")
    });

    const request = {
      agentId: "codex",
      args: [],
      cwd: root,
      id: "external-job.service.duplicate",
      instructions: "first",
      metadata: {},
      mode: "blocking" as const
    };

    await service.run(request);
    await expect(service.run(request)).rejects.toMatchObject({ code: "external_agent_job_exists" });
  });
});

describe("buildExternalAgentArtifacts", () => {
  test("collects the result, stdout, stderr, and summary logs and dedupes by uri", async () => {
    const root = await createTempRoot();
    const stdoutPath = path.join(root, "stdout.log");
    const stderrPath = path.join(root, "stderr.log");
    const summaryPath = path.join(root, "summary.txt");
    await fs.writeFile(stdoutPath, "stdout body");
    await fs.writeFile(stderrPath, "stderr body");
    await fs.writeFile(summaryPath, "summary body");

    const job = {
      attempts: 1,
      createdAt: "2026-06-10T00:00:00.000Z",
      id: "external-job.artifacts",
      logPaths: {
        result: stdoutPath,
        stderr: stderrPath,
        stdout: stdoutPath,
        summary: summaryPath
      },
      metadata: {},
      request: {
        agentId: "codex",
        args: [],
        cwd: root,
        id: "external-job.artifacts",
        instructions: "x",
        metadata: {},
        mode: "blocking" as const
      },
      resultArtifact: {
        byteLength: 11,
        id: "artifact.result",
        kind: "log" as const,
        metadata: {},
        sha256: "deadbeef",
        uri: `file://${stdoutPath}`
      },
      status: "succeeded" as const,
      updatedAt: "2026-06-10T00:00:00.000Z"
    };

    const artifacts = await buildExternalAgentArtifacts(job);
    const uris = artifacts.map((artifact) => artifact.uri);
    // resultArtifact and stdout share a uri → deduped to a single entry.
    expect(uris.filter((uri) => uri === `file://${stdoutPath}`)).toHaveLength(1);
    expect(uris.some((uri) => uri.endsWith("stderr.log"))).toBe(true);
    expect(uris.some((uri) => uri.endsWith("summary.txt"))).toBe(true);
  });

  test("returns an empty list when no logs exist on disk", async () => {
    const root = await createTempRoot();
    const job = {
      attempts: 0,
      createdAt: "2026-06-10T00:00:00.000Z",
      id: "external-job.empty",
      logPaths: {
        stderr: path.join(root, "missing-stderr.log"),
        stdout: path.join(root, "missing-stdout.log")
      },
      metadata: {},
      request: {
        agentId: "codex",
        args: [],
        cwd: root,
        id: "external-job.empty",
        instructions: "x",
        metadata: {},
        mode: "blocking" as const
      },
      status: "queued" as const,
      updatedAt: "2026-06-10T00:00:00.000Z"
    };

    await expect(buildExternalAgentArtifacts(job)).resolves.toEqual([]);
  });
});

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-external-agents-"));
  tempRoots.push(root);
  return root;
}

async function waitForTerminalJob(service: FileExternalAgentService, jobId: string) {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const job = await service.getJob(jobId);
    if (job && job.status !== "running" && job.status !== "queued") {
      return job;
    }
    await sleep(50);
  }

  throw new Error(`Timed out waiting for external-agent job "${jobId}" to finish.`);
}

async function sleep(ms: number) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
