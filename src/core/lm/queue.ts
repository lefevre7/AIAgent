import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type {
  LanguageModelAdapter,
  LanguageModelProvider,
  LanguageModelQueueJob,
  LanguageModelRequest,
  LanguageModelResponse,
  StructuredError
} from "@/core/contracts";
import { entityIdSchema, isoTimestampSchema, languageModelQueueJobSchema } from "@/core/contracts";
import { normalizeUnknownProviderError } from "@/core/lm/http";
import { writeJsonAtomic, sleep } from "@/core/io/files";

const queueStateSchema = z
  .object({
    activeJobId: entityIdSchema.nullable(),
    queuedJobIds: z.array(entityIdSchema).default([]),
    updatedAt: isoTimestampSchema
  })
  .strict();

type FileLanguageModelQueueOptions = {
  lockStaleMs?: number;
  lockWaitMs?: number;
  resolveAdapter: (provider: LanguageModelProvider) => LanguageModelAdapter;
  stateRoot: string;
};

export interface LanguageModelExecutionQueue {
  close?(): Promise<void>;
  execute(request: LanguageModelRequest): Promise<LanguageModelResponse>;
  getJob(jobId: string): Promise<LanguageModelQueueJob | null>;
  listJobs(): Promise<LanguageModelQueueJob[]>;
}

export class FileLanguageModelQueue implements LanguageModelExecutionQueue {
  private closed = false;
  private processing = false;
  private readonly recoveryPromise: Promise<void>;
  private scheduledPump: NodeJS.Timeout | null = null;

  constructor(private readonly options: FileLanguageModelQueueOptions) {
    this.recoveryPromise = this.recoverState();
    void this.recoveryPromise.then(() => this.triggerPump());
  }

  async execute(request: LanguageModelRequest): Promise<LanguageModelResponse> {
    if (this.closed) {
      throw new Error("Language model queue is closed.");
    }

    await this.ensureRecovered();
    const adapter = this.options.resolveAdapter(request.provider);
    const createdAt = new Date().toISOString();
    const job = languageModelQueueJobSchema.parse({
      attempts: 0,
      createdAt,
      id: request.id,
      logPaths: {
        request: this.requestLogFile(request.id)
      },
      metadata: {},
      providerId: adapter.providerId,
      queueKey: "default",
      request,
      status: "queued",
      updatedAt: createdAt
    });

    await this.withStateLock(async () => {
      const existingJob = await this.readJob(request.id);
      if (existingJob) {
        throw new Error(`Language model queue job "${request.id}" already exists.`);
      }

      await this.writeJob(job);
      await writeJsonAtomic(this.requestLogFile(request.id), {
        request,
        timestamp: createdAt
      });

      const state = await this.readQueueState();
      if (!state.queuedJobIds.includes(job.id)) {
        state.queuedJobIds.push(job.id);
      }
      state.updatedAt = new Date().toISOString();
      await this.writeQueueState(state);
    });

    this.triggerPump();
    return this.waitForTerminalJob(job.id);
  }

  async getJob(jobId: string): Promise<LanguageModelQueueJob | null> {
    await this.ensureRecovered();
    return this.readJob(jobId);
  }

  async listJobs(): Promise<LanguageModelQueueJob[]> {
    await this.ensureRecovered();
    try {
      const entries = await fs.readdir(this.jobsRoot(), { withFileTypes: true });
      const jobs = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map(async (entry) => this.readJob(path.basename(entry.name, ".json")))
      );

      return jobs
        .filter((job): job is LanguageModelQueueJob => job !== null)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.scheduledPump) {
      clearTimeout(this.scheduledPump);
      this.scheduledPump = null;
    }

    await this.recoveryPromise.catch(() => undefined);

    while (this.processing) {
      await sleep(25);
    }
  }

  private async ensureRecovered(): Promise<void> {
    await this.recoveryPromise;
  }

  private async recoverState(): Promise<void> {
    await this.withStateLock(async () => {
      const state = await this.readQueueState();
      if (!state.activeJobId) {
        await this.writeQueueState(state);
        return;
      }

      const activeJob = await this.readJob(state.activeJobId);
      if (activeJob && !isTerminalJobStatus(activeJob.status)) {
        const recoveredJob = languageModelQueueJobSchema.parse({
          ...activeJob,
          completedAt: new Date().toISOString(),
          error: {
            code: "lm_queue_interrupted",
            details: {
              previousStatus: activeJob.status
            },
            message: "The queued language-model request was interrupted by a process restart.",
            retriable: true
          },
          status: "failed",
          updatedAt: new Date().toISOString()
        });
        await this.writeJob(recoveredJob);
        await writeJsonAtomic(this.errorLogFile(recoveredJob.id), {
          error: recoveredJob.error,
          timestamp: recoveredJob.updatedAt
        });
      }

      state.activeJobId = null;
      state.updatedAt = new Date().toISOString();
      await this.writeQueueState(state);
    });
  }

  private async pump(): Promise<void> {
    await this.ensureRecovered();
    if (this.processing) {
      return;
    }

    this.processing = true;
    try {
      while (true) {
        const claimedJob = await this.claimNextJob();
        if (!claimedJob) {
          break;
        }

        const adapter = this.options.resolveAdapter(claimedJob.request.provider);
        let finalizedJob: LanguageModelQueueJob;
        try {
          const response = await adapter.generate(claimedJob.request);
          finalizedJob = languageModelQueueJobSchema.parse({
            ...claimedJob,
            completedAt: new Date().toISOString(),
            logPaths: {
              ...claimedJob.logPaths,
              response: this.responseLogFile(claimedJob.id)
            },
            response,
            status: "completed",
            updatedAt: new Date().toISOString()
          });
          await writeJsonAtomic(this.responseLogFile(claimedJob.id), {
            response,
            timestamp: finalizedJob.updatedAt
          });
        } catch (error) {
          const normalizedError = normalizeUnknownProviderError(error, {
            code: "lm_queue_execution_failed"
          });
          finalizedJob = languageModelQueueJobSchema.parse({
            ...claimedJob,
            completedAt: new Date().toISOString(),
            error: normalizedError,
            logPaths: {
              ...claimedJob.logPaths,
              error: this.errorLogFile(claimedJob.id)
            },
            status: "failed",
            updatedAt: new Date().toISOString()
          });
          await writeJsonAtomic(this.errorLogFile(claimedJob.id), {
            error: normalizedError,
            timestamp: finalizedJob.updatedAt
          });
        }

        await this.finalizeJob(finalizedJob);
      }
    } finally {
      this.processing = false;
    }
  }

  private async claimNextJob(): Promise<LanguageModelQueueJob | null> {
    return this.withStateLock(async () => {
      const state = await this.readQueueState();
      if (state.activeJobId || state.queuedJobIds.length === 0) {
        return null;
      }

      const jobId = state.queuedJobIds.shift() as string;
      const job = await this.readJob(jobId);
      if (!job) {
        state.updatedAt = new Date().toISOString();
        await this.writeQueueState(state);
        return null;
      }

      const runningJob = languageModelQueueJobSchema.parse({
        ...job,
        attempts: job.attempts + 1,
        startedAt: new Date().toISOString(),
        status: "running",
        updatedAt: new Date().toISOString()
      });
      state.activeJobId = runningJob.id;
      state.updatedAt = runningJob.updatedAt;

      await this.writeJob(runningJob);
      await this.writeQueueState(state);
      return runningJob;
    });
  }

  private async finalizeJob(job: LanguageModelQueueJob): Promise<void> {
    await this.withStateLock(async () => {
      const state = await this.readQueueState();
      if (state.activeJobId === job.id) {
        state.activeJobId = null;
      }
      state.updatedAt = new Date().toISOString();
      await this.writeJob(job);
      await this.writeQueueState(state);
    });
  }

  private async waitForTerminalJob(jobId: string): Promise<LanguageModelResponse> {
    while (true) {
      const job = await this.readJob(jobId);
      if (!job) {
        throw new Error(`Language model queue job "${jobId}" disappeared before completion.`);
      }

      if (job.status === "completed") {
        if (!job.response) {
          throw new Error(`Language model queue job "${jobId}" completed without a response.`);
        }
        return job.response;
      }

      if (job.status === "failed" || job.status === "cancelled") {
        throw new Error(formatQueueJobError(job.error));
      }

      await sleep(50);
    }
  }

  private triggerPump(): void {
    if (this.closed || this.scheduledPump) {
      return;
    }

    this.scheduledPump = setTimeout(() => {
      this.scheduledPump = null;
      if (this.closed) {
        return;
      }

      void this.pump();
    }, 0);
  }

  private async withStateLock<T>(operation: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();

    while (true) {
      let handle: fs.FileHandle | null = null;
      try {
        await fs.mkdir(this.queueRoot(), { recursive: true });
        handle = await fs.open(this.lockFile(), "wx");
        await handle.writeFile(JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }));
        const result = await operation();
        await handle.close();
        await fs.rm(this.lockFile(), { force: true });
        return result;
      } catch (error) {
        if (handle) {
          await handle.close().catch(() => undefined);
          await fs.rm(this.lockFile(), { force: true }).catch(() => undefined);
        }

        if (isNodeError(error) && error.code === "EEXIST") {
          const stale = await this.isLockStale();
          if (stale) {
            await fs.rm(this.lockFile(), { force: true }).catch(() => undefined);
            continue;
          }

          if (Date.now() - startedAt > (this.options.lockWaitMs ?? 10_000)) {
            throw new Error("Timed out waiting for the language-model queue lock.");
          }

          await sleep(25);
          continue;
        }

        throw error;
      }
    }
  }

  private async isLockStale(): Promise<boolean> {
    try {
      const stats = await fs.stat(this.lockFile());
      return Date.now() - stats.mtimeMs > (this.options.lockStaleMs ?? 30_000);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private async readJob(jobId: string): Promise<LanguageModelQueueJob | null> {
    try {
      const raw = await fs.readFile(this.jobFile(jobId), "utf8");
      return languageModelQueueJobSchema.parse(JSON.parse(raw) as unknown);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async readQueueState(): Promise<z.infer<typeof queueStateSchema>> {
    try {
      const raw = await fs.readFile(this.queueStateFile(), "utf8");
      return queueStateSchema.parse(JSON.parse(raw) as unknown);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return {
          activeJobId: null,
          queuedJobIds: [],
          updatedAt: new Date().toISOString()
        };
      }
      throw error;
    }
  }

  private async writeJob(job: LanguageModelQueueJob): Promise<void> {
    await writeJsonAtomic(this.jobFile(job.id), job);
  }

  private async writeQueueState(state: z.infer<typeof queueStateSchema>): Promise<void> {
    await writeJsonAtomic(this.queueStateFile(), state);
  }

  private errorLogFile(jobId: string): string {
    return path.join(this.logsRoot(), "errors", `${jobId}.json`);
  }

  private jobFile(jobId: string): string {
    return path.join(this.jobsRoot(), `${jobId}.json`);
  }

  private jobsRoot(): string {
    return path.join(this.queueRoot(), "jobs");
  }

  private lockFile(): string {
    return path.join(this.queueRoot(), "queue.lock");
  }

  private logsRoot(): string {
    return path.join(this.options.stateRoot, "logs", "lm");
  }

  private queueRoot(): string {
    return path.join(this.options.stateRoot, "queues", "lm");
  }

  private queueStateFile(): string {
    return path.join(this.queueRoot(), "queue-state.json");
  }

  private requestLogFile(jobId: string): string {
    return path.join(this.logsRoot(), "requests", `${jobId}.json`);
  }

  private responseLogFile(jobId: string): string {
    return path.join(this.logsRoot(), "responses", `${jobId}.json`);
  }
}

function formatQueueJobError(error: StructuredError | undefined): string {
  if (!error) {
    return "Language model queue job failed without a structured error.";
  }

  return error.message;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function isTerminalJobStatus(status: LanguageModelQueueJob["status"]): boolean {
  return status === "cancelled" || status === "completed" || status === "failed";
}
