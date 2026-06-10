import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  FileLanguageModelQueue,
  languageModelQueueJobSchema,
  type LanguageModelAdapter,
  type LanguageModelRequest,
  type LanguageModelResponse
} from "@/core";
import { writeJsonAtomic } from "@/core/io/files";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

describe("file language-model queue", () => {
  test("runs one queued request at a time", async () => {
    const root = await createTempRoot();
    const stateRoot = path.join(root, ".aia");
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const executionOrder: string[] = [];

    const adapter: LanguageModelAdapter = {
      generate: async (request) => {
        activeCalls += 1;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        executionOrder.push(request.id);
        await new Promise((resolve) => setTimeout(resolve, 40));
        activeCalls -= 1;
        return buildResponse(request, `Completed ${request.id}`);
      },
      health: async () => ({
        checkedAt: new Date().toISOString(),
        details: {},
        providerId: "lm_studio",
        status: "healthy"
      }),
      listModels: async () => [],
      provider: "lm_studio",
      providerId: "lm_studio"
    };

    const queue = new FileLanguageModelQueue({
      resolveAdapter: () => adapter,
      stateRoot
    });

    const firstPromise = queue.execute(buildRequest("queue.request.1"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const secondPromise = queue.execute(buildRequest("queue.request.2"));
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.message?.parts[0]).toEqual({
      kind: "text",
      text: "Completed queue.request.1"
    });
    expect(second.message?.parts[0]).toEqual({
      kind: "text",
      text: "Completed queue.request.2"
    });
    expect(maxActiveCalls).toBe(1);
    expect(executionOrder.slice().sort()).toEqual(["queue.request.1", "queue.request.2"]);
    expect((await queue.listJobs()).map((job) => job.status)).toEqual(["completed", "completed"]);
  });

  test("recovers interrupted active jobs and preserves queued jobs for retry", async () => {
    const root = await createTempRoot();
    const stateRoot = path.join(root, ".aia");
    const queueRoot = path.join(stateRoot, "queues", "lm");
    const jobsRoot = path.join(queueRoot, "jobs");
    const runningJob = languageModelQueueJobSchema.parse({
      attempts: 1,
      createdAt: "2026-03-27T12:00:00.000Z",
      id: "queue.running.1",
      logPaths: {},
      metadata: {},
      providerId: "lm_studio",
      queueKey: "default",
      request: buildRequest("queue.running.1"),
      startedAt: "2026-03-27T12:00:10.000Z",
      status: "running",
      updatedAt: "2026-03-27T12:00:10.000Z"
    });
    const queuedJob = languageModelQueueJobSchema.parse({
      attempts: 0,
      createdAt: "2026-03-27T12:00:20.000Z",
      id: "queue.queued.1",
      logPaths: {},
      metadata: {},
      providerId: "lm_studio",
      queueKey: "default",
      request: buildRequest("queue.queued.1"),
      status: "queued",
      updatedAt: "2026-03-27T12:00:20.000Z"
    });

    await writeJsonAtomic(path.join(jobsRoot, `${runningJob.id}.json`), runningJob);
    await writeJsonAtomic(path.join(jobsRoot, `${queuedJob.id}.json`), queuedJob);
    await writeJsonAtomic(path.join(queueRoot, "queue-state.json"), {
      activeJobId: runningJob.id,
      queuedJobIds: [queuedJob.id],
      updatedAt: "2026-03-27T12:00:20.000Z"
    });

    const adapter: LanguageModelAdapter = {
      generate: async (request) => buildResponse(request, `Recovered ${request.id}`),
      health: async () => ({
        checkedAt: new Date().toISOString(),
        details: {},
        providerId: "lm_studio",
        status: "healthy"
      }),
      listModels: async () => [],
      provider: "lm_studio",
      providerId: "lm_studio"
    };

    const queue = new FileLanguageModelQueue({
      resolveAdapter: () => adapter,
      stateRoot
    });

    const recoveredRunningJob = await waitFor(async () => await queue.getJob(runningJob.id), (job) => job?.status === "failed");
    const recoveredQueuedJob = await waitFor(async () => await queue.getJob(queuedJob.id), (job) => job?.status === "completed");

    expect(recoveredRunningJob?.error?.code).toBe("lm_queue_interrupted");
    expect(recoveredRunningJob?.error?.retriable).toBe(true);
    expect(recoveredQueuedJob?.response?.message?.parts[0]).toEqual({
      kind: "text",
      text: "Recovered queue.queued.1"
    });
  });
});

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-lm-queue-"));
  tempRoots.push(root);
  return root;
}

function buildRequest(id: string): LanguageModelRequest {
  return {
    availableTools: [],
    id,
    instructions: "Be concise.",
    messages: [
      {
        createdAt: "2026-03-27T12:00:00.000Z",
        id: `message.${id}`,
        metadata: {},
        parts: [{ kind: "text", text: "Inspect the next file." }],
        role: "user",
        sessionId: "session.queue.1",
        source: "user",
        tags: [],
        turnId: "turn.queue.1",
        visibility: "default"
      }
    ],
    metadata: {},
    modelId: "google/gemma-4-26b-a4b-qat",
    provider: "lm_studio",
    responseFormat: {
      kind: "text"
    },
    sessionId: "session.queue.1",
    settings: {
      stopSequences: [],
      toolChoice: "auto"
    },
    turnId: "turn.queue.1"
  };
}

function buildResponse(request: LanguageModelRequest, text: string): LanguageModelResponse {
  return {
    id: `response.${request.id}`,
    message: {
      createdAt: new Date().toISOString(),
      id: `message.response.${request.id}`,
      metadata: {},
      parts: [{ kind: "text", text }],
      role: "assistant",
      sessionId: request.sessionId ?? request.id,
      source: "assistant",
      tags: [],
      turnId: request.turnId,
      visibility: "default"
    },
    metadata: {},
    modelId: request.modelId,
    provider: request.provider,
    stopReason: "end_turn",
    toolCalls: [],
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2
    }
  };
}

async function waitFor<T>(read: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (predicate(value)) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error("Timed out waiting for the expected queue condition.");
}
