import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { FileExternalAgentService, FileSessionStore } from "@/core";

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
