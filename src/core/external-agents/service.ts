import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import type { AppConfig, ExternalAgentConfig as ExternalAgentRuntimeConfig } from "@/core/config";
import type {
  ArtifactReference,
  ExternalAgentDefinition,
  ExternalAgentExecutionMode,
  ExternalAgentJobCancelRequest,
  ExternalAgentJobListQuery,
  ExternalAgentJobRecord,
  ExternalAgentJobRequest,
  ExternalAgentJobResumeRequest,
  ExternalAgentService,
  ExternalAgentKind,
  JsonValue,
  Message,
  StructuredError,
  ToolCallRecord
} from "@/core/contracts";
import {
  externalAgentJobCancelRequestSchema,
  externalAgentJobListQuerySchema,
  externalAgentJobRecordSchema,
  externalAgentJobRequestSchema,
  externalAgentJobResumeRequestSchema,
  jsonValueSchema
} from "@/core/contracts";
import { writeJsonAtomic, sleep } from "@/core/io/files";
import type { FileSessionStore } from "@/core/sessions";
import type { ApprovalEvaluationTarget } from "@/core/approvals/policy";
import type { ToolApprovalDeciderParams } from "@/core/tools/runtime";

const externalAgentRuntimeMetadataSchema = z
  .object({
    adapterKind: z.enum(["claude", "codex", "mistral_vibe"]),
    attempt: z.number().int().positive(),
    attemptRoot: z.string().min(1),
    cancelRequested: z.boolean().optional(),
    finalOutputPath: z.string().min(1).optional(),
    schemaPath: z.string().min(1).optional(),
    sessionLogRoot: z.string().min(1).optional(),
    timeoutRequested: z.boolean().optional(),
    vibeHomePath: z.string().min(1).optional()
  })
  .strict();

type ExternalAgentRuntimeMetadata = z.infer<typeof externalAgentRuntimeMetadataSchema>;

type FileExternalAgentServiceOptions = {
  agents: Record<string, ExternalAgentRuntimeConfig>;
  pollIntervalMs?: number;
  sessions?: FileSessionStore;
  stateRoot: string;
};

type RunningJobMonitor = {
  child?: ChildProcess;
  poller?: NodeJS.Timeout;
  timeout?: NodeJS.Timeout;
};

type PreparedExecution = {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  finalOutputPath?: string;
  resultPath: string;
  schemaPath?: string;
  sessionLogRoot?: string;
  stderrPath: string;
  stdinText?: string;
  stdoutPath: string;
  summaryPath: string;
  vibeHomePath?: string;
};

type HarvestedExecution = {
  metadata?: Record<string, JsonValue>;
  nativeSessionId?: string;
  resultArtifact?: ArtifactReference;
  structuredResult?: JsonValue;
  summary?: string;
};

type ExternalAgentRuntime = {
  config: ExternalAgentRuntimeConfig;
  definition: ExternalAgentDefinition;
};

type BuildExecutionParams = {
  attempt: number;
  attemptRoot: string;
  job?: ExternalAgentJobRecord;
  request: ExternalAgentJobRequest;
  runtime: ExternalAgentRuntime;
  runtimeMetadata?: ExternalAgentRuntimeMetadata;
};

type HarvestExecutionParams = {
  job: ExternalAgentJobRecord;
  runtime: ExternalAgentRuntime;
  runtimeMetadata: ExternalAgentRuntimeMetadata;
};

type ExternalAgentPresetAdapter = {
  buildResume(params: BuildExecutionParams): Promise<PreparedExecution>;
  buildRun(params: BuildExecutionParams): Promise<PreparedExecution>;
  harvest(params: HarvestExecutionParams): Promise<HarvestedExecution>;
  resumeSupported: boolean;
  structuredOutputSupported: boolean;
};

export class FileExternalAgentService implements ExternalAgentService {
  private readonly recoveryPromise: Promise<void>;
  private readonly runtimes = new Map<string, ExternalAgentRuntime>();
  private readonly runningJobs = new Map<string, RunningJobMonitor>();
  private serviceLock: Promise<void> = Promise.resolve();

  constructor(private readonly options: FileExternalAgentServiceOptions) {
    for (const [agentId, config] of Object.entries(options.agents)) {
      if (!config.enabled) {
        continue;
      }
      this.runtimes.set(agentId, {
        config,
        definition: buildExternalAgentDefinition(agentId, config)
      });
    }

    this.recoveryPromise = this.recoverState();
  }

  async cancel(request: ExternalAgentJobCancelRequest): Promise<ExternalAgentJobRecord> {
    const parsed = externalAgentJobCancelRequestSchema.parse(request);
    await this.ensureRecovered();
    const job = await this.getJob(parsed.jobId);
    if (!job) {
      throw externalAgentError("external_agent_job_not_found", `External-agent job "${parsed.jobId}" was not found.`);
    }
    if (job.status === "cancelled" || job.status === "failed" || job.status === "succeeded") {
      return job;
    }

    if (job.status === "awaiting_resume") {
      const cancelled = externalAgentJobRecordSchema.parse({
        ...job,
        completedAt: new Date().toISOString(),
        error: undefined,
        status: "cancelled",
        summary: "The external-agent job was cancelled before it resumed.",
        updatedAt: new Date().toISOString()
      });
      await this.writeJob(cancelled);
      await this.emitDetachedLifecycleMessage(cancelled);
      return cancelled;
    }

    const runtimeMetadata = getRuntimeMetadata(job);
    if (!runtimeMetadata) {
      throw externalAgentError("external_agent_cancel_failed", "The job is missing runtime metadata and cannot be cancelled.");
    }

    const taggedJob = externalAgentJobRecordSchema.parse({
      ...job,
      metadata: setRuntimeMetadata(job.metadata, {
        ...runtimeMetadata,
        cancelRequested: true
      }),
      updatedAt: new Date().toISOString()
    });
    await this.writeJob(taggedJob);
    await this.terminateProcess(taggedJob);
    return this.waitForTerminalJob(taggedJob.id);
  }

  async getDefinition(agentId: string): Promise<ExternalAgentDefinition | null> {
    await this.ensureRecovered();
    return this.runtimes.get(agentId)?.definition ?? null;
  }

  async getJob(jobId: string): Promise<ExternalAgentJobRecord | null> {
    await this.ensureRecovered();
    const job = await this.readJob(jobId);
    if (!job) {
      return null;
    }
    return this.refreshJob(job);
  }

  async listDefinitions(): Promise<ExternalAgentDefinition[]> {
    await this.ensureRecovered();
    return [...this.runtimes.values()].map((runtime) => runtime.definition);
  }

  async listJobs(query?: ExternalAgentJobListQuery): Promise<ExternalAgentJobRecord[]> {
    const parsed = externalAgentJobListQuerySchema.parse(query ?? {});
    await this.ensureRecovered();
    const entries = await this.readAllJobs();
    const refreshed = await Promise.all(entries.map(async (job) => this.refreshJob(job)));
    return refreshed
      .filter((job) => (parsed.agentId ? job.request.agentId === parsed.agentId : true))
      .filter((job) => (parsed.sessionId ? job.request.sessionId === parsed.sessionId : true))
      .filter((job) => (parsed.status ? job.status === parsed.status : true))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, parsed.limit);
  }

  async resume(request: ExternalAgentJobResumeRequest): Promise<ExternalAgentJobRecord> {
    const parsed = externalAgentJobResumeRequestSchema.parse(request);
    await this.ensureRecovered();
    const current = await this.getJob(parsed.jobId);
    if (!current) {
      throw externalAgentError("external_agent_job_not_found", `External-agent job "${parsed.jobId}" was not found.`);
    }
    if (current.status === "running" && current.pid && (await isProcessAlive(current.pid))) {
      throw externalAgentError(
        "external_agent_resume_conflict",
        `The external-agent job "${current.id}" is still running and cannot be resumed concurrently.`,
        {
          pid: current.pid
        }
      );
    }

    if (!current.nativeSessionId) {
      throw externalAgentError(
        "external_agent_resume_unsupported",
        `The external-agent job "${current.id}" cannot be resumed because no native session id was captured.`
      );
    }

    const runtime = this.requireRuntime(current.request.agentId);
    const adapter = PRESET_ADAPTERS[runtime.config.kind];
    if (!adapter.resumeSupported) {
      throw externalAgentError(
        "external_agent_resume_unsupported",
        `The external agent "${runtime.definition.displayName}" does not support native resume.`
      );
    }

    const resumedJob = externalAgentJobRecordSchema.parse({
      ...current,
      completedAt: undefined,
      error: undefined,
      exitCode: undefined,
      metadata: current.metadata,
      request: externalAgentJobRequestSchema.parse({
        ...current.request,
        instructions: parsed.instructions ?? current.request.instructions,
        mode: parsed.mode,
        timeoutMs: parsed.timeoutMs ?? current.request.timeoutMs
      }),
      startedAt: undefined,
      status: "queued",
      summary: undefined,
      updatedAt: new Date().toISOString()
    });

    await this.writeJob(resumedJob);
    const started = await this.startAttempt(resumedJob, "resume");
    if (started.request.mode === "blocking") {
      return this.waitForTerminalJob(started.id);
    }
    return started;
  }

  async run(request: ExternalAgentJobRequest): Promise<ExternalAgentJobRecord> {
    const parsed = externalAgentJobRequestSchema.parse(request);
    await this.ensureRecovered();
    const runtime = this.requireRuntime(parsed.agentId);
    const adapter = PRESET_ADAPTERS[runtime.config.kind];
    if (parsed.resultSchema && !adapter.structuredOutputSupported) {
      throw externalAgentError(
        "external_agent_structured_output_unsupported",
        `The external agent "${runtime.definition.displayName}" does not support structured output for this preset.`
      );
    }

    const createdAt = new Date().toISOString();
    const job = externalAgentJobRecordSchema.parse({
      attempts: 0,
      createdAt,
      id: parsed.id,
      metadata: {},
      request: parsed,
      status: "queued",
      updatedAt: createdAt
    });

    const existing = await this.readJob(job.id);
    if (existing) {
      throw externalAgentError("external_agent_job_exists", `External-agent job "${job.id}" already exists.`, {
        jobId: job.id
      });
    }

    await this.writeJob(job);
    const started = await this.startAttempt(job, "run");
    if (parsed.mode === "blocking") {
      return this.waitForTerminalJob(started.id);
    }
    return started;
  }

  private async ensureRecovered(): Promise<void> {
    await this.recoveryPromise;
  }

  private async recoverState(): Promise<void> {
    const jobs = await this.readAllJobs();
    for (const job of jobs) {
      if (job.status !== "running") {
        continue;
      }

      const hydrated = await this.hydrateJob(job);
      if (hydrated.pid && (await isProcessAlive(hydrated.pid))) {
        const recovered = externalAgentJobRecordSchema.parse({
          ...hydrated,
          monitorState: "recovered",
          updatedAt: new Date().toISOString()
        });
        await this.writeJob(recovered);
        this.attachRecoveredPoller(recovered.id);
        continue;
      }

      await this.finalizeJob(hydrated.id, {});
    }
  }

  private async startAttempt(job: ExternalAgentJobRecord, mode: "resume" | "run"): Promise<ExternalAgentJobRecord> {
    const runtime = this.requireRuntime(job.request.agentId);
    const attempt = job.attempts + 1;
    const attemptRoot = this.attemptRoot(job.id, attempt);
    const adapter = PRESET_ADAPTERS[runtime.config.kind];
    const runtimeMetadata = getRuntimeMetadata(job);
    const prepared =
      mode === "resume"
        ? await adapter.buildResume({
            attempt,
            attemptRoot,
            job,
            request: job.request,
            runtime,
            runtimeMetadata: runtimeMetadata ?? undefined
          })
        : await adapter.buildRun({
            attempt,
            attemptRoot,
            job,
            request: job.request,
            runtime
          });

    const startedAt = new Date().toISOString();
    const queued = externalAgentJobRecordSchema.parse({
      ...job,
      attempts: attempt,
      completedAt: undefined,
      error: undefined,
      exitCode: undefined,
      logPaths: {
        result: prepared.resultPath,
        stderr: prepared.stderrPath,
        stdout: prepared.stdoutPath,
        summary: prepared.summaryPath
      },
      metadata: setRuntimeMetadata(job.metadata, {
        adapterKind: runtime.config.kind,
        attempt,
        attemptRoot,
        finalOutputPath: prepared.finalOutputPath,
        schemaPath: prepared.schemaPath,
        sessionLogRoot: prepared.sessionLogRoot,
        vibeHomePath: prepared.vibeHomePath
      }),
      monitorState: "attached",
      pid: undefined,
      resultArtifact: undefined,
      startedAt,
      status: "running",
      structuredResult: undefined,
      summary: undefined,
      updatedAt: startedAt
    });
    await this.writeJob(queued);

    return this.launchProcess(queued, prepared);
  }

  private async launchProcess(job: ExternalAgentJobRecord, prepared: PreparedExecution): Promise<ExternalAgentJobRecord> {
    await fs.mkdir(path.dirname(prepared.stdoutPath), { recursive: true });

    if (job.request.mode === "blocking") {
      return this.launchBlockingProcess(job, prepared);
    }

    return this.launchDetachedProcess(job, prepared);
  }

  private async launchBlockingProcess(job: ExternalAgentJobRecord, prepared: PreparedExecution): Promise<ExternalAgentJobRecord> {
    const stdoutStream = fsSync.createWriteStream(prepared.stdoutPath, { flags: "a" });
    const stderrStream = fsSync.createWriteStream(prepared.stderrPath, { flags: "a" });

    let child: ChildProcess;
    try {
      child = spawn(prepared.command, prepared.args, {
        cwd: prepared.cwd,
        env: prepared.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      stdoutStream.end();
      stderrStream.end();
      const failed = await this.failToStart(job, error);
      return failed;
    }

    const monitor: RunningJobMonitor = {
      child
    };
    this.runningJobs.set(job.id, monitor);
    this.configureTimeout(job, monitor);

    const pid = child.pid;
    const running = externalAgentJobRecordSchema.parse({
      ...job,
      pid: typeof pid === "number" ? pid : undefined,
      updatedAt: new Date().toISOString()
    });
    await this.writeJob(running);

    child.stdout?.on("data", (chunk) => {
      stdoutStream.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderrStream.write(chunk);
    });
    child.once("error", (error) => {
      stdoutStream.end();
      stderrStream.end();
      void this.handleChildError(job.id, error);
    });
    child.once("exit", (code, signal) => {
      stdoutStream.end();
      stderrStream.end();
      void this.handleChildExit(job.id, code, signal);
    });

    if (prepared.stdinText) {
      child.stdin?.end(prepared.stdinText);
    } else {
      child.stdin?.end();
    }

    return running;
  }

  private async launchDetachedProcess(job: ExternalAgentJobRecord, prepared: PreparedExecution): Promise<ExternalAgentJobRecord> {
    if (prepared.stdinText) {
      throw externalAgentError(
        "external_agent_stdin_unsupported",
        "Detached external-agent jobs do not support stdin-driven instruction mode."
      );
    }

    let stdoutFd: number | undefined;
    let stderrFd: number | undefined;
    try {
      stdoutFd = fsSync.openSync(prepared.stdoutPath, "a");
      stderrFd = fsSync.openSync(prepared.stderrPath, "a");
      const child = spawn(prepared.command, prepared.args, {
        cwd: prepared.cwd,
        detached: true,
        env: prepared.env,
        stdio: ["ignore", stdoutFd, stderrFd]
      });

      const monitor: RunningJobMonitor = {
        child
      };
      this.runningJobs.set(job.id, monitor);
      this.configureTimeout(job, monitor);

      const running = externalAgentJobRecordSchema.parse({
        ...job,
        pid: typeof child.pid === "number" ? child.pid : undefined,
        updatedAt: new Date().toISOString()
      });
      await this.writeJob(running);

      child.once("error", (error) => {
        void this.handleChildError(job.id, error);
      });
      child.once("exit", (code, signal) => {
        void this.handleChildExit(job.id, code, signal);
      });
      child.unref();
      return running;
    } catch (error) {
      const failed = await this.failToStart(job, error);
      return failed;
    } finally {
      if (stdoutFd !== undefined) {
        fsSync.closeSync(stdoutFd);
      }
      if (stderrFd !== undefined) {
        fsSync.closeSync(stderrFd);
      }
    }
  }

  private configureTimeout(job: ExternalAgentJobRecord, monitor: RunningJobMonitor): void {
    const timeoutMs = job.request.timeoutMs ?? this.requireRuntime(job.request.agentId).config.timeoutMs;
    if (!timeoutMs) {
      return;
    }

    monitor.timeout = setTimeout(() => {
      void this.markTimedOut(job.id);
    }, timeoutMs);
    monitor.timeout.unref?.();
  }

  private attachRecoveredPoller(jobId: string): void {
    const existing = this.runningJobs.get(jobId);
    if (existing?.poller) {
      return;
    }

    const monitor = existing ?? {};
    monitor.poller = setInterval(() => {
      void this.pollRecoveredJob(jobId);
    }, this.options.pollIntervalMs ?? 500);
    monitor.poller.unref?.();
    this.runningJobs.set(jobId, monitor);
  }

  private async pollRecoveredJob(jobId: string): Promise<void> {
    const current = await this.readJob(jobId);
    if (!current) {
      this.cleanupMonitor(jobId);
      return;
    }
    if (current.status !== "running") {
      this.cleanupMonitor(jobId);
      return;
    }
    if (current.pid && (await isProcessAlive(current.pid))) {
      return;
    }
    await this.finalizeJob(jobId, {});
  }

  private async markTimedOut(jobId: string): Promise<void> {
    const job = await this.readJob(jobId);
    if (!job || job.status !== "running") {
      return;
    }
    const runtimeMetadata = getRuntimeMetadata(job);
    if (!runtimeMetadata) {
      return;
    }

    await this.writeJob(
      externalAgentJobRecordSchema.parse({
        ...job,
        metadata: setRuntimeMetadata(job.metadata, {
          ...runtimeMetadata,
          timeoutRequested: true
        }),
        updatedAt: new Date().toISOString()
      })
    );
    await this.terminateProcess(job);
  }

  private async terminateProcess(job: ExternalAgentJobRecord): Promise<void> {
    const monitor = this.runningJobs.get(job.id);
    const pid = monitor?.child?.pid ?? job.pid;
    if (!pid) {
      await this.finalizeJob(job.id, {});
      return;
    }

    if (!(await isProcessAlive(pid))) {
      await this.finalizeJob(job.id, {});
      return;
    }

    try {
      if (monitor?.child) {
        monitor.child.kill("SIGTERM");
      } else {
        killProcess(job.request.mode, pid, "SIGTERM");
      }
    } catch {
      // Ignore and escalate below.
    }

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (!(await isProcessAlive(pid))) {
        await this.finalizeJob(job.id, {});
        return;
      }
      await sleep(100);
    }

    try {
      if (monitor?.child) {
        monitor.child.kill("SIGKILL");
      } else {
        killProcess(job.request.mode, pid, "SIGKILL");
      }
    } catch {
      // Best effort.
    }
  }

  private async handleChildError(jobId: string, error: unknown): Promise<void> {
    const job = await this.readJob(jobId);
    if (!job) {
      this.cleanupMonitor(jobId);
      return;
    }
    const failed = externalAgentJobRecordSchema.parse({
      ...job,
      completedAt: new Date().toISOString(),
      error: normalizeProcessError(error),
      status: "failed",
      updatedAt: new Date().toISOString()
    });
    await this.writeJob(failed);
    this.cleanupMonitor(jobId);
    if (failed.request.mode === "detached") {
      await this.emitDetachedLifecycleMessage(failed);
    }
  }

  private async handleChildExit(jobId: string, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    await this.finalizeJob(jobId, {
      exitCode: code ?? undefined,
      signal: signal ?? undefined
    });
  }

  private async finalizeJob(
    jobId: string,
    exit: {
      exitCode?: number;
      signal?: string;
    }
  ): Promise<ExternalAgentJobRecord> {
    const current = await this.readJob(jobId);
    if (!current) {
      this.cleanupMonitor(jobId);
      throw externalAgentError("external_agent_job_not_found", `External-agent job "${jobId}" was not found.`);
    }
    if (isTerminalJob(current.status)) {
      this.cleanupMonitor(jobId);
      return current;
    }

    const hydrated = await this.hydrateJob(current);
    const runtimeMetadata = getRuntimeMetadata(hydrated);
    if (!runtimeMetadata) {
      const failed = externalAgentJobRecordSchema.parse({
        ...hydrated,
        completedAt: new Date().toISOString(),
        error: externalAgentError(
          "external_agent_missing_runtime_metadata",
          "The external-agent job lost its runtime metadata before completion."
        ),
        exitCode: exit.exitCode,
        status: "failed",
        updatedAt: new Date().toISOString()
      });
      await this.writeJob(failed);
      this.cleanupMonitor(jobId);
      if (failed.request.mode === "detached") {
        await this.emitDetachedLifecycleMessage(failed);
      }
      return failed;
    }

    const nextStatus = resolveTerminalStatus(hydrated, runtimeMetadata, exit);
    const terminal = externalAgentJobRecordSchema.parse({
      ...hydrated,
      completedAt: new Date().toISOString(),
      error: buildTerminalError(hydrated, runtimeMetadata, nextStatus, exit),
      exitCode: exit.exitCode ?? hydrated.exitCode,
      status: nextStatus,
      updatedAt: new Date().toISOString()
    });
    await this.writeJob(terminal);
    this.cleanupMonitor(jobId);
    if (terminal.request.mode === "detached") {
      await this.emitDetachedLifecycleMessage(terminal);
    }
    return terminal;
  }

  private async refreshJob(job: ExternalAgentJobRecord): Promise<ExternalAgentJobRecord> {
    const hydrated = await this.hydrateJob(job);
    if (hydrated.status !== "running") {
      return hydrated;
    }
    if (hydrated.pid && (await isProcessAlive(hydrated.pid))) {
      return hydrated;
    }
    return this.finalizeJob(hydrated.id, {
      exitCode: hydrated.exitCode
    });
  }

  private async hydrateJob(job: ExternalAgentJobRecord): Promise<ExternalAgentJobRecord> {
    const runtimeMetadata = getRuntimeMetadata(job);
    if (!runtimeMetadata) {
      return job;
    }

    const runtime = this.requireRuntime(job.request.agentId);
    const adapter = PRESET_ADAPTERS[runtime.config.kind];
    const harvested = await adapter.harvest({
      job,
      runtime,
      runtimeMetadata
    });

    const patches: Partial<ExternalAgentJobRecord> = {};
    if (harvested.metadata && Object.keys(harvested.metadata).length > 0) {
      patches.metadata = {
        ...job.metadata,
        ...harvested.metadata
      };
    }
    if (harvested.nativeSessionId && harvested.nativeSessionId !== job.nativeSessionId) {
      patches.nativeSessionId = harvested.nativeSessionId;
    }
    if (harvested.resultArtifact && harvested.resultArtifact.uri !== job.resultArtifact?.uri) {
      patches.resultArtifact = harvested.resultArtifact;
    }
    if (harvested.summary && harvested.summary !== job.summary) {
      patches.summary = harvested.summary;
    }
    if (harvested.structuredResult !== undefined) {
      patches.structuredResult = harvested.structuredResult;
    }

    if (Object.keys(patches).length === 0) {
      return job;
    }

    const updated = externalAgentJobRecordSchema.parse({
      ...job,
      ...patches,
      updatedAt: new Date().toISOString()
    });
    await this.writeJob(updated);
    return updated;
  }

  private async emitDetachedLifecycleMessage(job: ExternalAgentJobRecord): Promise<void> {
    if (!this.options.sessions || !job.request.sessionId) {
      return;
    }

    const parts: Message["parts"] = [
      {
        kind: "status",
        state: job.status,
        summary:
          job.summary ??
          (job.status === "awaiting_resume"
            ? `${job.request.agentId} stopped and is ready to resume.`
            : `${job.request.agentId} is now ${job.status}.`)
      }
    ];

    if (job.resultArtifact) {
      parts.push({
        artifact: job.resultArtifact,
        kind: "file",
        title: job.resultArtifact.name,
        uri: job.resultArtifact.uri
      });
    }

    await this.options.sessions.appendMessages([
      {
        createdAt: new Date().toISOString(),
        id: `message.external-agent.${job.id}.${job.status}`,
        metadata: {},
        parts,
        role: "status",
        sessionId: job.request.sessionId,
        source: "external_agent",
        tags: ["external-agent"],
        visibility: "compact"
      }
    ]);
  }

  private async failToStart(job: ExternalAgentJobRecord, error: unknown): Promise<ExternalAgentJobRecord> {
    const failed = externalAgentJobRecordSchema.parse({
      ...job,
      completedAt: new Date().toISOString(),
      error: normalizeProcessError(error),
      status: "failed",
      updatedAt: new Date().toISOString()
    });
    await this.writeJob(failed);
    return failed;
  }

  private cleanupMonitor(jobId: string): void {
    const monitor = this.runningJobs.get(jobId);
    if (!monitor) {
      return;
    }
    if (monitor.timeout) {
      clearTimeout(monitor.timeout);
    }
    if (monitor.poller) {
      clearInterval(monitor.poller);
    }
    this.runningJobs.delete(jobId);
  }

  private requireRuntime(agentId: string): ExternalAgentRuntime {
    const runtime = this.runtimes.get(agentId);
    if (!runtime) {
      throw externalAgentError("external_agent_not_configured", `External agent "${agentId}" is not enabled in configuration.`);
    }
    return runtime;
  }

  private async readAllJobs(): Promise<ExternalAgentJobRecord[]> {
    try {
      const entries = await fs.readdir(this.jobsRoot(), { withFileTypes: true });
      const jobs = await Promise.all(
        entries.filter((entry) => entry.isDirectory()).map(async (entry) => this.readJobFile(path.join(this.jobsRoot(), entry.name, "job.json")))
      );
      return jobs.filter((job): job is ExternalAgentJobRecord => job !== null);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async readJob(jobId: string): Promise<ExternalAgentJobRecord | null> {
    return this.readJobFile(this.jobFile(jobId));
  }

  private async readJobFile(filePath: string): Promise<ExternalAgentJobRecord | null> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return externalAgentJobRecordSchema.parse(JSON.parse(raw) as unknown);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async writeJob(job: ExternalAgentJobRecord): Promise<void> {
    await this.withLock(async () => {
      await writeJsonAtomic(this.jobFile(job.id), job);
    });
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.serviceLock;
    let release: () => void = () => undefined;
    this.serviceLock = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  private jobsRoot(): string {
    return path.join(this.options.stateRoot, "jobs");
  }

  private jobDirectory(jobId: string): string {
    return path.join(this.jobsRoot(), encodeURIComponent(jobId));
  }

  private jobFile(jobId: string): string {
    return path.join(this.jobDirectory(jobId), "job.json");
  }

  private attemptRoot(jobId: string, attempt: number): string {
    return path.join(this.jobDirectory(jobId), "attempts", `attempt-${attempt}`);
  }

  private async waitForTerminalJob(jobId: string): Promise<ExternalAgentJobRecord> {
    while (true) {
      const current = await this.readJob(jobId);
      if (!current) {
        throw externalAgentError("external_agent_job_not_found", `External-agent job "${jobId}" disappeared before completion.`);
      }
      if (current.status !== "running") {
        if (isTerminalJob(current.status) || current.status === "awaiting_resume") {
          return current;
        }
        await sleep(150);
        continue;
      }
      if (current.pid && (await isProcessAlive(current.pid))) {
        await sleep(150);
        continue;
      }
      const refreshed = await this.refreshJob(current);
      if (isTerminalJob(refreshed.status) || refreshed.status === "awaiting_resume") {
        return refreshed;
      }
      await sleep(150);
    }
  }
}

export function createExternalAgentServiceFromConfig(params: {
  config: AppConfig;
  sessions?: FileSessionStore;
}): FileExternalAgentService | null {
  if (!params.config.externalAgents.enabled) {
    return null;
  }

  const enabledAgents = Object.fromEntries(
    Object.entries(params.config.externalAgents.agents).filter(([, config]) => config.enabled)
  );
  if (Object.keys(enabledAgents).length === 0) {
    return null;
  }

  return new FileExternalAgentService({
    agents: enabledAgents,
    pollIntervalMs: params.config.externalAgents.pollIntervalMs,
    sessions: params.sessions,
    stateRoot: params.config.externalAgents.stateRoot
  });
}

export function createExternalAgentApprovalTargetResolver(params: {
  service: Pick<ExternalAgentService, "getDefinition" | "getJob">;
}) {
  return async (input: ToolApprovalDeciderParams): Promise<ApprovalEvaluationTarget[]> => {
    if (input.definition.kind !== "external_agent") {
      return [];
    }

    const action = typeof input.call.arguments.action === "string" ? input.call.arguments.action : undefined;
    if (action === "get" || action === "list") {
      return [];
    }

    const resolved = await resolveApprovalJobContext(params.service, input.call);
    if (!resolved.agentId) {
      return [];
    }

    const definition = await params.service.getDefinition(resolved.agentId);
    const targets: ApprovalEvaluationTarget[] = [
      {
        kind: "external_agent",
        label: definition?.displayName ?? resolved.agentId,
        value: resolved.agentId
      }
    ];

    if (definition) {
      targets.push({
        kind: "command",
        label: "command",
        value: [definition.command, ...definition.defaultArgs].join(" ").trim()
      });
    }

    const cwd = typeof input.call.arguments.cwd === "string" ? input.call.arguments.cwd : resolved.cwd;
    if (cwd) {
      targets.push({
        kind: "path",
        label: "cwd",
        value: cwd
      });
    }

    return targets;
  };
}

export async function buildExternalAgentArtifacts(job: ExternalAgentJobRecord): Promise<ArtifactReference[]> {
  const artifacts: ArtifactReference[] = [];
  if (job.resultArtifact) {
    artifacts.push(job.resultArtifact);
  }

  if (job.logPaths.stdout && (await fileExists(job.logPaths.stdout))) {
    artifacts.push(
      await createArtifactReference(job.logPaths.stdout, "log", {
        mediaType: "text/plain",
        name: path.basename(job.logPaths.stdout)
      })
    );
  }
  if (job.logPaths.stderr && (await fileExists(job.logPaths.stderr))) {
    artifacts.push(
      await createArtifactReference(job.logPaths.stderr, "log", {
        mediaType: "text/plain",
        name: path.basename(job.logPaths.stderr)
      })
    );
  }
  if (job.logPaths.summary && (await fileExists(job.logPaths.summary))) {
    artifacts.push(
      await createArtifactReference(job.logPaths.summary, "text", {
        mediaType: "text/plain",
        name: path.basename(job.logPaths.summary)
      })
    );
  }

  return dedupeArtifacts(artifacts);
}

const PRESET_ADAPTERS: Record<ExternalAgentKind, ExternalAgentPresetAdapter> = {
  claude: {
    async buildResume(params) {
      const config = expectClaudeConfig(params.runtime.config);
      if (config.instructionMode !== "arg") {
        throw externalAgentError(
          "external_agent_instruction_mode_unsupported",
          `The Claude preset only supports instructionMode "arg"; received "${config.instructionMode}".`
        );
      }
      const args = [...config.args, config.printFlag, ...params.request.args, config.outputFormatFlag, config.outputFormatValue];
      args.push(config.resumeFlag, extractResumeSessionId(params));
      appendInstructions(args, params.request.instructions, config.instructionMode);

      return {
        args,
        command: config.command,
        cwd: params.request.cwd,
        env: buildProcessEnvironment(config),
        resultPath: path.join(params.attemptRoot, "final-output.txt"),
        stderrPath: path.join(params.attemptRoot, "stderr.log"),
        stdinText: undefined,
        stdoutPath: path.join(params.attemptRoot, "stdout.log"),
        summaryPath: path.join(params.attemptRoot, "summary.txt")
      };
    },
    async buildRun(params) {
      const config = expectClaudeConfig(params.runtime.config);
      if (config.instructionMode !== "arg") {
        throw externalAgentError(
          "external_agent_instruction_mode_unsupported",
          `The Claude preset only supports instructionMode "arg"; received "${config.instructionMode}".`
        );
      }
      const args = [...config.args, config.printFlag, ...params.request.args, config.outputFormatFlag, config.outputFormatValue];
      appendInstructions(args, params.request.instructions, config.instructionMode);

      return {
        args,
        command: config.command,
        cwd: params.request.cwd,
        env: buildProcessEnvironment(config),
        resultPath: path.join(params.attemptRoot, "final-output.txt"),
        stderrPath: path.join(params.attemptRoot, "stderr.log"),
        stdinText: undefined,
        stdoutPath: path.join(params.attemptRoot, "stdout.log"),
        summaryPath: path.join(params.attemptRoot, "summary.txt")
      };
    },
    async harvest(params) {
      const stdoutText = params.job.logPaths.stdout ? await readFileIfExists(params.job.logPaths.stdout) : null;
      const parsed = stdoutText ? parseClaudeStdout(stdoutText) : {};
      const resultPath = params.job.logPaths.result ?? path.join(params.runtimeMetadata.attemptRoot, "final-output.txt");
      let summary = parsed.result ?? (stdoutText ? stdoutText.trim() : undefined);
      let resultArtifact: ArtifactReference | undefined;

      if (summary && summary.length > 0) {
        await writeTextFile(resultPath, summary);
        resultArtifact = await createArtifactReference(resultPath, "text", {
          mediaType: "text/plain",
          name: path.basename(resultPath)
        });
      } else {
        summary = undefined;
      }

      if (summary && params.job.logPaths.summary) {
        await writeTextFile(params.job.logPaths.summary, clipSummary(summary));
      }

      return {
        nativeSessionId: parsed.sessionId ?? params.job.nativeSessionId,
        resultArtifact,
        summary: summary ? clipSummary(summary) : undefined
      };
    },
    resumeSupported: true,
    structuredOutputSupported: false
  },
  codex: {
    async buildResume(params) {
      const config = expectCodexConfig(params.runtime.config);
      if (config.instructionMode !== "arg") {
        throw externalAgentError(
          "external_agent_instruction_mode_unsupported",
          `The Codex preset only supports instructionMode "arg"; received "${config.instructionMode}".`
        );
      }
      const resultPath = path.join(params.attemptRoot, params.request.resultSchema ? "final-output.json" : "final-output.txt");
      const schemaPath = params.request.resultSchema ? path.join(params.attemptRoot, "result-schema.json") : undefined;
      if (params.request.resultSchema && schemaPath) {
        await writeJsonAtomic(schemaPath, params.request.resultSchema);
      }

      const args = [...config.args, ...config.resumeSubcommand, ...params.request.args];
      const resumeSessionId = extractResumeSessionId(params);
      args.push(resumeSessionId);
      args.push(config.jsonFlag);
      if (config.skipGitRepoCheck) {
        args.push(config.skipGitRepoCheckFlag);
      }
      if (schemaPath) {
        args.push(config.schemaFlag, schemaPath);
      }
      args.push(config.outputLastMessageFlag, resultPath);
      appendInstructions(args, params.request.instructions, config.instructionMode);

      return {
        args,
        command: config.command,
        cwd: params.request.cwd,
        env: buildProcessEnvironment(config),
        finalOutputPath: resultPath,
        resultPath,
        schemaPath,
        stderrPath: path.join(params.attemptRoot, "stderr.log"),
        stdinText: undefined,
        stdoutPath: path.join(params.attemptRoot, "stdout.log"),
        summaryPath: path.join(params.attemptRoot, "summary.txt")
      };
    },
    async buildRun(params) {
      const config = expectCodexConfig(params.runtime.config);
      if (config.instructionMode !== "arg") {
        throw externalAgentError(
          "external_agent_instruction_mode_unsupported",
          `The Codex preset only supports instructionMode "arg"; received "${config.instructionMode}".`
        );
      }
      const resultPath = path.join(params.attemptRoot, params.request.resultSchema ? "final-output.json" : "final-output.txt");
      const schemaPath = params.request.resultSchema ? path.join(params.attemptRoot, "result-schema.json") : undefined;
      if (params.request.resultSchema && schemaPath) {
        await writeJsonAtomic(schemaPath, params.request.resultSchema);
      }

      const args = [...config.args, "exec", ...params.request.args, config.jsonFlag];
      if (config.skipGitRepoCheck) {
        args.push(config.skipGitRepoCheckFlag);
      }
      if (schemaPath) {
        args.push(config.schemaFlag, schemaPath);
      }
      args.push(config.outputLastMessageFlag, resultPath);
      appendInstructions(args, params.request.instructions, config.instructionMode);

      return {
        args,
        command: config.command,
        cwd: params.request.cwd,
        env: buildProcessEnvironment(config),
        finalOutputPath: resultPath,
        resultPath,
        schemaPath,
        stderrPath: path.join(params.attemptRoot, "stderr.log"),
        stdinText: undefined,
        stdoutPath: path.join(params.attemptRoot, "stdout.log"),
        summaryPath: path.join(params.attemptRoot, "summary.txt")
      };
    },
    async harvest(params) {
      const runtimeMetadata = params.runtimeMetadata;
      const resultPath = runtimeMetadata.finalOutputPath ?? params.job.logPaths.result;
      const fallbackResultPath = resultPath ?? path.join(runtimeMetadata.attemptRoot, "final-output.txt");
      const stdoutText = params.job.logPaths.stdout ? await readFileIfExists(params.job.logPaths.stdout) : null;
      const parsed = stdoutText ? parseCodexStdout(stdoutText) : null;
      let resultArtifact: ArtifactReference | undefined;
      let structuredResult: JsonValue | undefined;
      let summary = parsed?.lastAssistantText;

      if (resultPath && (await fileExists(resultPath))) {
        if (params.job.request.resultSchema) {
          const parsedJson = JSON.parse((await fs.readFile(resultPath, "utf8")) as string) as unknown;
          structuredResult = jsonValueSchema.parse(parsedJson);
          resultArtifact = await createArtifactReference(resultPath, "json", {
            mediaType: "application/json",
            name: path.basename(resultPath)
          });
          summary = summary ?? "External-agent job completed with structured JSON output.";
        } else {
          const finalText = (await fs.readFile(resultPath, "utf8")).trim();
          if (finalText.length > 0) {
            summary = finalText;
            resultArtifact = await createArtifactReference(resultPath, "text", {
              mediaType: "text/plain",
              name: path.basename(resultPath)
            });
          }
        }
      } else if (summary) {
        await writeTextFile(fallbackResultPath, summary);
        resultArtifact = await createArtifactReference(fallbackResultPath, "text", {
          mediaType: "text/plain",
          name: path.basename(fallbackResultPath)
        });
      }

      if (summary && params.job.logPaths.summary) {
        await writeTextFile(params.job.logPaths.summary, clipSummary(summary));
      }

      return {
        metadata: parsed?.usage ? { usage: parsed.usage } : undefined,
        nativeSessionId: parsed?.threadId ?? params.job.nativeSessionId,
        resultArtifact,
        structuredResult,
        summary: summary ? clipSummary(summary) : undefined
      };
    },
    resumeSupported: true,
    structuredOutputSupported: true
  },
  mistral_vibe: {
    async buildResume(params) {
      const config = expectMistralVibeConfig(params.runtime.config);
      if (config.instructionMode !== "arg") {
        throw externalAgentError(
          "external_agent_instruction_mode_unsupported",
          `The Mistral Vibe preset only supports instructionMode "arg"; received "${config.instructionMode}".`
        );
      }
      const vibeHomePath = path.join(params.attemptRoot, "vibe-home");
      const sessionLogRoot = path.join(vibeHomePath, "logs", "session");
      const args = [...config.args, ...params.request.args, config.resumeFlag, extractResumeSessionId(params)];
      appendInstructions(args, params.request.instructions, config.instructionMode, config.promptFlag);
      args.push(config.outputFlag, config.outputJsonValue, config.workdirFlag, params.request.cwd);

      return {
        args,
        command: config.command,
        cwd: params.request.cwd,
        env: buildProcessEnvironment(config, {
          VIBE_HOME: vibeHomePath
        }),
        resultPath: path.join(params.attemptRoot, "final-output.json"),
        sessionLogRoot,
        stderrPath: path.join(params.attemptRoot, "stderr.log"),
        stdinText: undefined,
        stdoutPath: path.join(params.attemptRoot, "stdout.log"),
        summaryPath: path.join(params.attemptRoot, "summary.txt"),
        vibeHomePath
      };
    },
    async buildRun(params) {
      const config = expectMistralVibeConfig(params.runtime.config);
      if (config.instructionMode !== "arg") {
        throw externalAgentError(
          "external_agent_instruction_mode_unsupported",
          `The Mistral Vibe preset only supports instructionMode "arg"; received "${config.instructionMode}".`
        );
      }
      const vibeHomePath = path.join(params.attemptRoot, "vibe-home");
      const sessionLogRoot = path.join(vibeHomePath, "logs", "session");
      const args = [...config.args, ...params.request.args];
      appendInstructions(args, params.request.instructions, config.instructionMode, config.promptFlag);
      args.push(config.outputFlag, config.outputJsonValue, config.workdirFlag, params.request.cwd);

      return {
        args,
        command: config.command,
        cwd: params.request.cwd,
        env: buildProcessEnvironment(config, {
          VIBE_HOME: vibeHomePath
        }),
        resultPath: path.join(params.attemptRoot, "final-output.json"),
        sessionLogRoot,
        stderrPath: path.join(params.attemptRoot, "stderr.log"),
        stdinText: undefined,
        stdoutPath: path.join(params.attemptRoot, "stdout.log"),
        summaryPath: path.join(params.attemptRoot, "summary.txt"),
        vibeHomePath
      };
    },
    async harvest(params) {
      const stdoutText = params.job.logPaths.stdout ? await readFileIfExists(params.job.logPaths.stdout) : null;
      const sessionId = params.runtimeMetadata.sessionLogRoot
        ? await readVibeSessionId(params.runtimeMetadata.sessionLogRoot)
        : undefined;
      let parsedJson: JsonValue | undefined;
      let summary = await extractVibeSummary(stdoutText);
      let resultArtifact: ArtifactReference | undefined;

      if (stdoutText && stdoutText.trim().length > 0) {
        const resultPath = params.job.logPaths.result ?? path.join(params.runtimeMetadata.attemptRoot, "final-output.json");
        try {
          parsedJson = jsonValueSchema.parse(JSON.parse(stdoutText) as unknown);
          await writeTextFile(resultPath, JSON.stringify(parsedJson, null, 2));
          resultArtifact = await createArtifactReference(resultPath, "json", {
            mediaType: "application/json",
            name: path.basename(resultPath)
          });
        } catch {
          const fallbackPath = params.job.logPaths.result ?? path.join(params.runtimeMetadata.attemptRoot, "final-output.txt");
          await writeTextFile(fallbackPath, stdoutText.trim());
          resultArtifact = await createArtifactReference(fallbackPath, "text", {
            mediaType: "text/plain",
            name: path.basename(fallbackPath)
          });
        }
      }

      if (!summary && params.runtimeMetadata.sessionLogRoot) {
        summary = await extractVibeSummaryFromLogs(params.runtimeMetadata.sessionLogRoot);
      }

      if (summary && params.job.logPaths.summary) {
        await writeTextFile(params.job.logPaths.summary, clipSummary(summary));
      }

      return {
        nativeSessionId: sessionId ?? params.job.nativeSessionId,
        resultArtifact,
        structuredResult: parsedJson,
        summary: summary ? clipSummary(summary) : undefined
      };
    },
    resumeSupported: true,
    structuredOutputSupported: false
  }
};

function buildExternalAgentDefinition(agentId: string, config: ExternalAgentRuntimeConfig): ExternalAgentDefinition {
  const adapter = PRESET_ADAPTERS[config.kind];
  return {
    command: config.command,
    defaultArgs: config.args,
    displayName: config.displayName,
    id: agentId,
    kind: config.kind,
    metadata: {},
    resumeSupported: adapter.resumeSupported,
    structuredOutputSupported: adapter.structuredOutputSupported
  };
}

function buildProcessEnvironment(
  config: ExternalAgentRuntimeConfig,
  overrides: Record<string, string> = {}
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env
  };
  for (const key of config.passEnv ?? []) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  for (const [key, value] of Object.entries(config.env ?? {})) {
    env[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  Object.assign(env, overrides);
  return env;
}

function appendInstructions(args: string[], instructions: string, mode: "arg" | "stdin", promptFlag?: string): void {
  if (mode === "stdin") {
    return;
  }
  if (promptFlag) {
    args.push(promptFlag, instructions);
    return;
  }
  args.push(instructions);
}

function getRuntimeMetadata(job: ExternalAgentJobRecord): ExternalAgentRuntimeMetadata | null {
  const candidate = job.metadata.externalAgentRuntime;
  const parsed = externalAgentRuntimeMetadataSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function setRuntimeMetadata(metadata: Record<string, JsonValue>, runtimeMetadata: ExternalAgentRuntimeMetadata) {
  return {
    ...metadata,
    externalAgentRuntime: Object.fromEntries(
      Object.entries(runtimeMetadata).filter(([, value]) => value !== undefined)
    ) as JsonValue
  };
}

function resolveTerminalStatus(
  job: ExternalAgentJobRecord,
  runtimeMetadata: ExternalAgentRuntimeMetadata,
  exit: { exitCode?: number; signal?: string }
): ExternalAgentJobRecord["status"] {
  if (runtimeMetadata.cancelRequested) {
    return "cancelled";
  }
  if (runtimeMetadata.timeoutRequested) {
    return "failed";
  }
  if (exit.exitCode === 0) {
    return "succeeded";
  }
  if ((job.resultArtifact || job.structuredResult !== undefined) && exit.exitCode === undefined && !exit.signal) {
    return "succeeded";
  }
  if (job.nativeSessionId) {
    return "awaiting_resume";
  }
  return "failed";
}

function buildTerminalError(
  job: ExternalAgentJobRecord,
  runtimeMetadata: ExternalAgentRuntimeMetadata,
  status: ExternalAgentJobRecord["status"],
  exit: { exitCode?: number; signal?: string }
): StructuredError | undefined {
  if (status === "cancelled" || status === "succeeded") {
    return undefined;
  }
  if (runtimeMetadata.timeoutRequested) {
    return externalAgentError(
      "external_agent_timeout",
      `The external-agent job "${job.id}" exceeded its configured timeout and was terminated.`,
      {
        attempt: runtimeMetadata.attempt
      },
      true
    );
  }
  if (status === "awaiting_resume") {
    return externalAgentError(
      "external_agent_interrupted",
      `The external-agent job "${job.id}" stopped before completion and can be resumed with its native session id.`,
      {
        exitCode: exit.exitCode ?? null,
        signal: exit.signal ?? null
      },
      true
    );
  }
  return externalAgentError(
    "external_agent_execution_failed",
    `The external-agent job "${job.id}" exited before producing a resumable result.`,
    {
      exitCode: exit.exitCode ?? null,
      signal: exit.signal ?? null
    },
    true
  );
}

async function resolveApprovalJobContext(
  service: Pick<ExternalAgentService, "getJob">,
  call: ToolCallRecord
): Promise<{ agentId: string | null; cwd?: string }> {
  if (typeof call.arguments.agentId === "string") {
    return {
      agentId: call.arguments.agentId
    };
  }
  if (typeof call.arguments.jobId === "string") {
    const job = await service.getJob(call.arguments.jobId);
    return {
      agentId: job?.request.agentId ?? null,
      cwd: job?.request.cwd
    };
  }
  return {
    agentId: null
  };
}

function normalizeProcessError(error: unknown): StructuredError {
  if (error instanceof Error) {
    return externalAgentError(
      "external_agent_process_error",
      error.message,
      {
        name: error.name
      },
      true
    );
  }
  return externalAgentError("external_agent_process_error", String(error), {}, true);
}

function externalAgentError(
  code: string,
  message: string,
  details: Record<string, JsonValue> = {},
  retriable = false
): StructuredError {
  return {
    code,
    details,
    message,
    retriable
  };
}

async function isProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function killProcess(mode: ExternalAgentExecutionMode, pid: number, signal: NodeJS.Signals): void {
  if (mode === "detached" && process.platform !== "win32") {
    process.kill(-pid, signal);
    return;
  }
  process.kill(pid, signal);
}

async function createArtifactReference(
  filePath: string,
  kind: ArtifactReference["kind"],
  options: {
    mediaType?: string;
    metadata?: Record<string, JsonValue>;
    name?: string;
  } = {}
): Promise<ArtifactReference> {
  const content = await fs.readFile(filePath);
  return {
    byteLength: content.byteLength,
    id: `artifact.${crypto.randomUUID()}`,
    kind,
    mediaType: options.mediaType,
    metadata: options.metadata ?? {},
    name: options.name ?? path.basename(filePath),
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
    uri: pathToFileURL(filePath).toString()
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeTextFile(filePath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${value}\n`, "utf8");
}

function parseClaudeStdout(stdout: string): { result?: string; sessionId?: string } {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return {};
  }
  // `--output-format json` prints a single (possibly multi-line) JSON object.
  const whole = tryParseClaudeRecord(trimmed);
  if (whole.result !== undefined || whole.sessionId !== undefined) {
    return whole;
  }
  // `--output-format stream-json` prints NDJSON; the trailing result line carries
  // the final assistant text and session id.
  let result: string | undefined;
  let sessionId: string | undefined;
  for (const line of trimmed
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)) {
    const parsed = tryParseClaudeRecord(line);
    if (parsed.sessionId !== undefined) {
      sessionId = parsed.sessionId;
    }
    if (parsed.result !== undefined) {
      result = parsed.result;
    }
  }
  return { result, sessionId };
}

function tryParseClaudeRecord(text: string): { result?: string; sessionId?: string } {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      result: typeof parsed.result === "string" ? parsed.result : undefined,
      sessionId: typeof parsed.session_id === "string" && parsed.session_id.length > 0 ? parsed.session_id : undefined
    };
  } catch {
    return {};
  }
}

function parseCodexStdout(stdout: string): {
  lastAssistantText?: string;
  threadId?: string;
  usage?: JsonValue;
} {
  let lastAssistantText: string | undefined;
  let threadId: string | undefined;
  let usage: JsonValue | undefined;

  for (const line of stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.type === "thread.started" && typeof parsed.thread_id === "string") {
        threadId = parsed.thread_id;
      }
      const item = typeof parsed.item === "object" && parsed.item !== null ? (parsed.item as Record<string, unknown>) : null;
      if (parsed.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
        lastAssistantText = item.text;
      }
      if (parsed.type === "turn.completed" && parsed.usage !== undefined) {
        const normalized = jsonValueSchema.safeParse(parsed.usage);
        if (normalized.success) {
          usage = normalized.data;
        }
      }
    } catch {
      continue;
    }
  }

  return {
    lastAssistantText,
    threadId,
    usage
  };
}

async function extractVibeSummary(stdoutText: string | null): Promise<string | undefined> {
  if (!stdoutText || stdoutText.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(stdoutText) as unknown;
    return findLastAssistantContent(parsed) ?? clipSummary(stdoutText.trim());
  } catch {
    return clipSummary(stdoutText.trim());
  }
}

async function readVibeSessionId(sessionLogRoot: string): Promise<string | undefined> {
  try {
    const entries = await fs.readdir(sessionLogRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const raw = await readFileIfExists(path.join(sessionLogRoot, entry.name, "meta.json"));
      if (!raw) {
        continue;
      }
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.session_id === "string" && parsed.session_id.length > 0) {
        return parsed.session_id;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function extractVibeSummaryFromLogs(sessionLogRoot: string): Promise<string | undefined> {
  try {
    const entries = await fs.readdir(sessionLogRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const raw = await readFileIfExists(path.join(sessionLogRoot, entry.name, "messages.jsonl"));
      if (!raw) {
        continue;
      }
      const lines = raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      for (const line of lines.reverse()) {
        try {
          const parsed = JSON.parse(line) as unknown;
          const content = findAssistantContent(parsed);
          if (content) {
            return clipSummary(content);
          }
        } catch {
          continue;
        }
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function findLastAssistantContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const entry of [...value].reverse()) {
    const content = findAssistantContent(entry);
    if (content) {
      return clipSummary(content);
    }
  }
  return undefined;
}

function findAssistantContent(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.role !== "assistant") {
    return undefined;
  }
  return extractContentText(record.content);
}

function extractContentText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const pieces = value
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        if (typeof entry === "object" && entry !== null && typeof (entry as Record<string, unknown>).text === "string") {
          return (entry as Record<string, string>).text;
        }
        return null;
      })
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    if (pieces.length > 0) {
      return pieces.join("\n").trim();
    }
  }
  return undefined;
}

function clipSummary(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized.length > 280 ? `${normalized.slice(0, 277)}...` : normalized;
}

function dedupeArtifacts(artifacts: ArtifactReference[]): ArtifactReference[] {
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    if (seen.has(artifact.uri)) {
      return false;
    }
    seen.add(artifact.uri);
    return true;
  });
}

function extractResumeSessionId(params: BuildExecutionParams): string {
  const nativeSessionId = readResumeSessionId(params);
  if (!nativeSessionId) {
    throw externalAgentError(
      "external_agent_resume_unsupported",
      `The external-agent job "${params.request.id}" cannot be resumed because no native session id was available.`
    );
  }
  return nativeSessionId;
}

function readResumeSessionId(params: BuildExecutionParams): string | undefined {
  const metadata = params.request.metadata;
  const explicit = metadata.resumeFromSessionId;
  if (typeof explicit === "string" && explicit.length > 0) {
    return explicit;
  }
  if (params.job?.nativeSessionId) {
    return params.job.nativeSessionId;
  }
  return undefined;
}

function expectClaudeConfig(config: ExternalAgentRuntimeConfig) {
  if (config.kind !== "claude") {
    throw new Error(`Expected a Claude external-agent config, received ${config.kind}.`);
  }
  return config;
}

function expectCodexConfig(config: ExternalAgentRuntimeConfig) {
  if (config.kind !== "codex") {
    throw new Error(`Expected a Codex external-agent config, received ${config.kind}.`);
  }
  return config;
}

function expectMistralVibeConfig(config: ExternalAgentRuntimeConfig) {
  if (config.kind !== "mistral_vibe") {
    throw new Error(`Expected a Mistral Vibe external-agent config, received ${config.kind}.`);
  }
  return config;
}

function isTerminalJob(status: ExternalAgentJobRecord["status"]): boolean {
  return status === "cancelled" || status === "failed" || status === "succeeded";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
