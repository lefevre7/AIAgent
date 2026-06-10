import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  isoTimestampSchema,
  planItemSchema,
  planRecordSchema,
  taskStateSnapshotSchema,
  workingMemoryNoteSchema,
  type PlanItem,
  type PlanRecord,
  type TaskStateSnapshot,
  type WorkingMemoryNote
} from "@/core/contracts";
import { writeJsonAtomic } from "@/core/io/files";
import type { FileSessionStore } from "@/core/sessions";

const workingMemoryStateSchema = z
  .object({
    notes: z.array(workingMemoryNoteSchema).default([]),
    updatedAt: isoTimestampSchema
  })
  .strict();

export interface TaskStateProvider {
  getTaskState(sessionId: string): Promise<TaskStateSnapshot | null>;
}

export type UpdateTaskStateInput = {
  explanation?: string;
  items?: Array<{
    blockedReason?: string;
    id?: string;
    metadata?: Record<string, unknown>;
    notes?: string;
    status: PlanItem["status"];
    title: string;
  }>;
  replaceWorkingMemory?: boolean;
  sessionId: string;
  summary?: string;
  title?: string;
  turnId?: string;
  workingMemory?: Array<{
    id?: string;
    kind: WorkingMemoryNote["kind"];
    metadata?: Record<string, unknown>;
    priority: WorkingMemoryNote["priority"];
    text: string;
  }>;
};

export class TaskStateService implements TaskStateProvider {
  constructor(
    private readonly options: {
      sessions: FileSessionStore;
      stateRoot: string;
    }
  ) {}

  async getPlan(sessionId: string): Promise<PlanRecord | null> {
    return this.readJsonFile(this.planFile(sessionId), planRecordSchema);
  }

  async getTaskState(sessionId: string): Promise<TaskStateSnapshot | null> {
    const session = await this.options.sessions.getSession(sessionId);
    if (!session) {
      return null;
    }

    const [plan, workingMemoryState] = await Promise.all([
      this.getPlan(sessionId),
      this.readJsonFile(this.workingMemoryFile(sessionId), workingMemoryStateSchema)
    ]);
    const workingMemory = workingMemoryState?.notes ?? [];
    const progress = buildProgress(plan?.items ?? []);
    const nextStep =
      findLatestByKind(workingMemory, "next_step") ??
      (plan?.items.find((item) => item.status === "in_progress" || item.status === "pending")
        ? createDerivedWorkingMemoryNote(
            sessionId,
            plan.items.find((item) => item.status === "in_progress" || item.status === "pending")?.title ?? "",
            "next_step",
            "medium",
            plan?.updatedAt ?? session.updatedAt
          )
        : undefined);

    return taskStateSnapshotSchema.parse({
      activePlanId: session.activePlanId,
      blockers: workingMemory.filter((note) => note.kind === "blocker"),
      nextStep,
      plan,
      progress,
      recentAttempts: workingMemory.filter((note) => note.kind === "recent_attempt").slice(-3),
      sessionId,
      summary: plan?.summary,
      updatedAt: latestTimestamp([session.updatedAt, plan?.updatedAt, workingMemoryState?.updatedAt]),
      workingMemory
    });
  }

  async updateTaskState(input: UpdateTaskStateInput): Promise<TaskStateSnapshot> {
    const session = await this.options.sessions.getSession(input.sessionId);
    if (!session) {
      throw new Error(`Cannot update plan for unknown session "${input.sessionId}".`);
    }

    const now = new Date().toISOString();
    const [existingPlan, workingMemoryState] = await Promise.all([
      this.getPlan(input.sessionId),
      this.readJsonFile(this.workingMemoryFile(input.sessionId), workingMemoryStateSchema)
    ]);

    const nextPlan =
      input.items || input.summary || input.title
        ? planRecordSchema.parse({
            createdAt: existingPlan?.createdAt ?? now,
            id: existingPlan?.id ?? `plan.${input.sessionId}.default`,
            items: (input.items ?? existingPlan?.items ?? []).map((item, index) =>
              planItemSchema.parse({
                blockedReason: item.blockedReason,
                id: item.id ?? `plan-item.${input.sessionId}.${index + 1}.${crypto.randomUUID()}`,
                metadata: (item.metadata ?? {}) as Record<string, unknown>,
                notes: item.notes,
                order: index,
                status: item.status,
                title: item.title
              })
            ),
            metadata: {
              ...(existingPlan?.metadata ?? {}),
              ...(input.explanation ? { latestExplanation: input.explanation } : {})
            },
            sessionId: input.sessionId,
            summary: input.summary ?? existingPlan?.summary,
            tags: existingPlan?.tags ?? [],
            title: input.title ?? existingPlan?.title ?? "Task Plan",
            updatedAt: now
          })
        : existingPlan;

    const nextWorkingMemory = resolveWorkingMemory({
      current: workingMemoryState?.notes ?? [],
      now,
      replace: input.replaceWorkingMemory ?? false,
      sessionId: input.sessionId,
      turnId: input.turnId,
      updates: input.workingMemory ?? []
    });

    if (nextPlan) {
      await writeJsonAtomic(this.planFile(input.sessionId), nextPlan);
    }

    if (input.workingMemory || workingMemoryState) {
      await writeJsonAtomic(this.workingMemoryFile(input.sessionId), {
        notes: nextWorkingMemory,
        updatedAt: now
      });
    }

    await this.options.sessions.saveSession({
      ...session,
      activePlanId: nextPlan?.id ?? session.activePlanId,
      lastActiveAt: now,
      updatedAt: now
    });

    return (await this.getTaskState(input.sessionId)) as TaskStateSnapshot;
  }

  private async readJsonFile<TSchema extends z.ZodTypeAny>(
    filePath: string,
    schema: TSchema
  ): Promise<z.output<TSchema> | null> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return schema.parse(JSON.parse(raw) as unknown);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private planFile(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "plan.json");
  }

  private sessionDirectory(sessionId: string): string {
    return path.join(this.options.stateRoot, "sessions", sessionId);
  }

  private workingMemoryFile(sessionId: string): string {
    return path.join(this.sessionDirectory(sessionId), "working-memory.json");
  }
}

function buildProgress(items: PlanItem[]) {
  return {
    blocked: items.filter((item) => item.status === "blocked").length,
    cancelled: items.filter((item) => item.status === "cancelled").length,
    completed: items.filter((item) => item.status === "completed").length,
    inProgress: items.filter((item) => item.status === "in_progress").length,
    pending: items.filter((item) => item.status === "pending").length,
    total: items.length
  };
}

function createDerivedWorkingMemoryNote(
  sessionId: string,
  text: string,
  kind: WorkingMemoryNote["kind"],
  priority: WorkingMemoryNote["priority"],
  createdAt: string
): WorkingMemoryNote {
  return workingMemoryNoteSchema.parse({
    createdAt,
    id: `working-memory.derived.${kind}.${sessionId}`,
    kind,
    metadata: {
      derived: true
    },
    priority,
    sessionId,
    text
  });
}

function findLatestByKind(notes: WorkingMemoryNote[], kind: WorkingMemoryNote["kind"]): WorkingMemoryNote | undefined {
  return notes
    .filter((note) => note.kind === kind)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
}

function latestTimestamp(values: Array<string | undefined | null>): string {
  return values.filter((value): value is string => typeof value === "string").sort().at(-1) ?? new Date().toISOString();
}

function resolveWorkingMemory(params: {
  current: WorkingMemoryNote[];
  now: string;
  replace: boolean;
  sessionId: string;
  turnId?: string;
  updates: UpdateTaskStateInput["workingMemory"];
}): WorkingMemoryNote[] {
  const updates = (params.updates ?? []).map((note) =>
    workingMemoryNoteSchema.parse({
      createdAt: params.now,
      id: note.id ?? `working-memory.${params.sessionId}.${crypto.randomUUID()}`,
      kind: note.kind,
      metadata: (note.metadata ?? {}) as Record<string, unknown>,
      priority: note.priority,
      sessionId: params.sessionId,
      text: note.text,
      turnId: params.turnId
    })
  );

  if (params.replace) {
    return updates;
  }

  const merged = new Map<string, WorkingMemoryNote>();
  for (const note of params.current) {
    merged.set(note.id, note);
  }
  for (const note of updates) {
    merged.set(note.id, note);
  }

  return Array.from(merged.values()).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
