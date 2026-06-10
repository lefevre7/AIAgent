import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
  memoryEntrySchema,
  memoryHitSchema,
  memoryQuerySchema,
  type EmbeddingAdapter,
  type MemoryEntry,
  type MemoryHit,
  type MemoryQuery,
  type MemoryStore,
  type SessionRecord
} from "@/core/contracts";
import { writeJsonAtomic } from "@/core/io/files";
import type { EmbeddingRuntime } from "@/core/memory/embeddings";
import {
  MemoryRetrievalEngine,
  type IndexedMemoryDocument,
  type MemoryRetrievalOptions,
  type MemoryRetrievalQueryResult,
  type MemoryRetrievalStatus
} from "@/core/memory/retrieval";
import type { FileSessionStore, SessionSnapshot } from "@/core/sessions";

const memoryCompactionRecordSchema = z
  .object({
    createdAt: z.string().min(1),
    id: z.string().min(1),
    outputTokenCount: z.number().int().nonnegative(),
    phase: z.enum(["startup_phase_1", "startup_phase_2", "session_completion", "threshold"]),
    placeholderMode: z.boolean(),
    sessionId: z.string().min(1),
    sourceTokenCount: z.number().int().nonnegative(),
    summary: z.string().min(1),
    trigger: z.enum(["completion", "startup", "threshold"]),
    updatedAt: z.string().min(1)
  })
  .strict();

export type MemoryPromptContext = {
  sessionSummary?: string;
  userGlobalSummary?: string;
  workspaceSummary?: string;
};

export interface MemoryContextProvider {
  getPromptContext(sessionId: string): Promise<MemoryPromptContext | null>;
}

export interface SessionMemoryLifecycle {
  compactSession(params: {
    sessionId: string;
    sourceTokenCount?: number;
    threshold?: number;
    trigger: "completion" | "threshold";
  }): Promise<void>;
  initializeSessionMemory(session: SessionRecord): Promise<void>;
}

type MemorySourceDescriptor =
  | {
      absolutePath: string;
      displayPath: string;
      scope: MemoryEntry["scope"];
      type: "file";
    }
  | {
      absolutePath: string;
      displayPrefix: string;
      scope: MemoryEntry["scope"];
      type: "directory";
    };

export type MemoryDetailedQueryResult = {
  hits: MemoryHit[];
  retrieval: MemoryRetrievalQueryResult["retrieval"];
};

export type MemorySystemStatus = MemoryRetrievalStatus & {
  lastCompaction: {
    phase: z.infer<typeof memoryCompactionRecordSchema>["phase"];
    sessionId: string;
    summary: string;
    trigger: z.infer<typeof memoryCompactionRecordSchema>["trigger"];
    updatedAt: string;
  } | null;
  sources: {
    chatSessionRoot: string;
    extraPaths: string[];
    includeSessionSummaries: boolean;
    userGlobalRoot: string;
    workspaceRoot: string;
  };
};

export class FileBackedMemoryService implements MemoryStore, MemoryContextProvider, SessionMemoryLifecycle {
  private readonly retrievalEngine?: MemoryRetrievalEngine;

  constructor(
    private readonly options: {
      chatSessionRoot: string;
      embeddingRuntime?: EmbeddingRuntime;
      extraPaths?: string[];
      includeSessionSummaries?: boolean;
      retrieval?: Omit<MemoryRetrievalOptions, "loadDocuments">;
      sessions: FileSessionStore;
      stateRoot: string;
      userGlobalRoot: string;
      workspaceRoot: string;
    }
  ) {
    if (options.retrieval) {
      this.retrievalEngine = new MemoryRetrievalEngine(
        {
          ...options.retrieval,
          loadDocuments: async () => this.loadIndexedDocuments()
        },
        options.embeddingRuntime
      );
    }
  }

  async getPromptContext(sessionId: string): Promise<MemoryPromptContext | null> {
    const [sessionSummary, workspaceSummary, userGlobalSummary] = await Promise.all([
      this.readTextFile(this.chatSessionSummaryFile(sessionId)),
      this.readTextFile(this.workspaceMemorySummaryFile()),
      this.readTextFile(this.userGlobalMemorySummaryFile())
    ]);

    if (!sessionSummary && !workspaceSummary && !userGlobalSummary) {
      return null;
    }

    return {
      sessionSummary: sessionSummary ?? undefined,
      userGlobalSummary: userGlobalSummary ?? undefined,
      workspaceSummary: workspaceSummary ?? undefined
    };
  }

  async initializeSessionMemory(session: SessionRecord): Promise<void> {
    await this.ensureScopeDirectories();
    const entries = await this.readCompactionHistory(session.id);
    const existingPhases = new Set(entries.map((entry) => entry.phase));

    if (!existingPhases.has("startup_phase_1")) {
      await this.appendCompactionRecord({
        id: `memory-compaction.${session.id}.startup-phase-1`,
        outputTokenCount: 0,
        phase: "startup_phase_1",
        placeholderMode: true,
        sessionId: session.id,
        sourceTokenCount: 0,
        summary: `Startup phase 1 placeholder for session goal: ${session.goal}`,
        trigger: "startup"
      });
    }

    if (!existingPhases.has("startup_phase_2")) {
      await this.appendCompactionRecord({
        id: `memory-compaction.${session.id}.startup-phase-2`,
        outputTokenCount: 0,
        phase: "startup_phase_2",
        placeholderMode: true,
        sessionId: session.id,
        sourceTokenCount: 0,
        summary: "Startup phase 2 placeholder. Richer model-assisted consolidation will plug into this seam later.",
        trigger: "startup"
      });
    }

    await this.initializeRetrieval();
  }

  async initializeRetrieval(): Promise<void> {
    await this.ensureScopeDirectories();
    await this.retrievalEngine?.initialize();
  }

  registerEmbeddingAdapter(adapter: EmbeddingAdapter): void {
    if (!this.options.embeddingRuntime) {
      throw new Error("Embedding registration requires an active embedding runtime.");
    }

    this.options.embeddingRuntime.registerAdapter(adapter);
  }

  setDefaultEmbeddingProvider(params: { embeddingModel?: string; providerId: string }): void {
    if (!this.options.embeddingRuntime || !this.retrievalEngine) {
      throw new Error("Embedding provider overrides require an initialized retrieval engine.");
    }

    this.options.embeddingRuntime.setDefaultProvider(params.providerId);
    this.retrievalEngine.setEmbeddingProvider(params);
  }

  async compactSession(params: {
    sessionId: string;
    sourceTokenCount?: number;
    threshold?: number;
    trigger: "completion" | "threshold";
  }): Promise<void> {
    const snapshot = await this.options.sessions.getSessionSnapshot(params.sessionId);
    if (!snapshot) {
      return;
    }

    const assistantMessages = snapshot.messages.filter((message) => message.role === "assistant");
    const toolCalls = snapshot.toolCalls.filter((call) => call.status === "succeeded");
    const sourceTokenCount = params.sourceTokenCount ?? estimateTokenCountFromSnapshot(snapshot.messages);
    const summary = buildSessionSummary(snapshot.session.goal, assistantMessages, toolCalls);

    await fs.mkdir(this.options.chatSessionRoot, { recursive: true });
    await fs.writeFile(this.chatSessionSummaryFile(params.sessionId), summary, "utf8");

    const summaryEntry = memoryEntrySchema.parse({
      confidence: 0.8,
      content: summary,
      createdAt: new Date().toISOString(),
      id: `memory.session-summary.${params.sessionId}`,
      kind: "summary",
      metadata: {
        trigger: params.trigger
      },
      provenance: {
        messageIds: snapshot.messages.map((message) => message.id),
        sourceLabel: "session_compaction",
        toolCallIds: snapshot.toolCalls.map((call) => call.id)
      },
      recencyScore: 1,
      scope: "session",
      sessionId: params.sessionId,
      summary: `Compacted session summary for ${params.sessionId}`,
      tags: ["compaction", "session-summary"],
      updatedAt: new Date().toISOString()
    });
    await this.upsert(summaryEntry);

    await this.appendCompactionRecord({
      id: `memory-compaction.${params.sessionId}.${crypto.randomUUID()}`,
      outputTokenCount: Math.max(1, Math.round(summary.length / 4)),
      phase: params.trigger === "completion" ? "session_completion" : "threshold",
      placeholderMode: true,
      sessionId: params.sessionId,
      sourceTokenCount,
      summary: `Compacted session ${params.sessionId} via ${params.trigger} trigger.`,
      trigger: params.trigger
    });
    this.retrievalEngine?.markDirty();
  }

  async query(query: MemoryQuery): Promise<MemoryHit[]> {
    return (await this.queryDetailed(query)).hits;
  }

  async queryDetailed(query: MemoryQuery): Promise<MemoryDetailedQueryResult> {
    const parsed = memoryQuerySchema.parse(query);
    if (this.retrievalEngine) {
      const result = await this.retrievalEngine.search(parsed);
      return {
        hits: result.hits,
        retrieval: result.retrieval
      };
    }
    const entries = await this.loadEntriesForScopes(parsed.scopes, parsed.sessionId);
    const normalizedQuery = parsed.text.trim().toLowerCase();

    return {
      hits: entries
        .filter((entry) => (parsed.includeKinds.length > 0 ? parsed.includeKinds.includes(entry.kind) : true))
        .filter((entry) => entry.confidence >= parsed.minConfidence)
        .map((entry) => {
          const haystack = `${entry.summary ?? ""}\n${entry.content}\n${entry.tags.join(" ")}`.toLowerCase();
          const occurrences = haystack.includes(normalizedQuery) ? 1 : 0;
          const score = entry.confidence * 50 + entry.recencyScore * 25 + occurrences * 25;
          return {
            entry,
            explanation: occurrences > 0 ? "Matched lexical memory content." : "Returned as a confidence/recency fallback.",
            score
          };
        })
        .filter((hit) => hit.score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, parsed.limit)
        .map((hit) => memoryHitSchema.parse(hit)),
      retrieval: {
        activeMode: "lexical",
        fallbackUsed: false,
        modelId: null,
        providerId: null,
        semanticAvailable: false,
        semanticStatus: "unavailable",
        warning: null
      }
    };
  }

  async remove(entryId: string): Promise<void> {
    await this.ensureScopeDirectories();
    for (const filePath of [this.workspaceIndexFile(), this.userGlobalIndexFile(), this.sessionIndexFile()]) {
      const entries = await this.readEntryIndex(filePath);
      if (entries.some((entry) => entry.id === entryId)) {
        const next = entries.filter((entry) => entry.id !== entryId);
        await writeJsonAtomic(filePath, next);
      }
    }

    await Promise.all([this.refreshWorkspaceSummaries(), this.refreshUserGlobalSummaries()]);
    this.retrievalEngine?.markDirty();
  }

  async upsert(entry: MemoryEntry): Promise<void> {
    const parsed = memoryEntrySchema.parse(entry);
    const filePath = this.resolveIndexFile(parsed.scope);
    const entries = await this.readEntryIndex(filePath);
    const next = [...entries.filter((existing) => existing.id !== parsed.id), parsed].sort((left, right) =>
      left.updatedAt.localeCompare(right.updatedAt)
    );
    await writeJsonAtomic(filePath, next);

    if (parsed.scope === "workspace") {
      await this.refreshWorkspaceSummaries();
    }
    if (parsed.scope === "user_global") {
      await this.refreshUserGlobalSummaries();
    }
    this.retrievalEngine?.markDirty();
  }

  async getMemoryFile(params: {
    lineCount?: number;
    path: string;
    startLine?: number;
  }): Promise<{
    content: string;
    endLine: number;
    missing: boolean;
    path: string;
    startLine: number;
  }> {
    const resolved = await this.resolveMemoryFilePath(params.path);
    if (resolved.missing) {
      return {
        content: "",
        endLine: 0,
        missing: true,
        path: resolved.displayPath,
        startLine: params.startLine ?? 1
      };
    }

    const raw = await fs.readFile(resolved.absolutePath, "utf8");
    const lines = raw.split("\n");
    const startLine = Math.max(1, params.startLine ?? 1);
    const lineCount = Math.max(1, params.lineCount ?? lines.length);
    const slice = lines.slice(startLine - 1, startLine - 1 + lineCount);

    return {
      content: slice.join("\n"),
      endLine: startLine - 1 + slice.length,
      missing: false,
      path: resolved.displayPath,
      startLine
    };
  }

  async getMemoryStatus(): Promise<MemorySystemStatus> {
    if (!this.retrievalEngine) {
      return {
        dirty: false,
        embeddings: {
          enabled: false,
          hardFailOnStartup: false,
          modelId: null,
          providerId: null,
          status: "unavailable"
        },
        index: {
          chunkCount: 0,
          configFingerprint: null,
          documentCount: 0,
          embeddingDimensions: null,
          fileCount: 0,
          lastIndexedAt: null,
          schemaVersion: 1,
          sqlitePath: path.join(this.options.stateRoot, "memory.sqlite")
        },
        lexical: {
          enabled: false,
          ready: false
        },
        modes: ["lexical"],
        lastCompaction: await this.readLatestCompactionRecord(),
        sources: {
          chatSessionRoot: this.options.chatSessionRoot,
          extraPaths: this.options.extraPaths ?? [],
          includeSessionSummaries: this.options.includeSessionSummaries ?? true,
          userGlobalRoot: this.options.userGlobalRoot,
          workspaceRoot: this.options.workspaceRoot
        }
      };
    }

    const retrievalStatus = await this.retrievalEngine.status();
    return {
      ...retrievalStatus,
      lastCompaction: await this.readLatestCompactionRecord(),
      sources: {
        chatSessionRoot: this.options.chatSessionRoot,
        extraPaths: this.options.extraPaths ?? [],
        includeSessionSummaries: this.options.includeSessionSummaries ?? true,
        userGlobalRoot: this.options.userGlobalRoot,
        workspaceRoot: this.options.workspaceRoot
      }
    };
  }

  async reindexMemory(): Promise<MemorySystemStatus> {
    if (!this.retrievalEngine) {
      return this.getMemoryStatus();
    }

    await this.retrievalEngine.sync();
    return this.getMemoryStatus();
  }

  private async appendCompactionRecord(
    record: Omit<z.infer<typeof memoryCompactionRecordSchema>, "createdAt" | "updatedAt">
  ): Promise<void> {
    const now = new Date().toISOString();
    await fs.mkdir(path.dirname(this.compactionHistoryFile(record.sessionId)), { recursive: true });
    await fs.appendFile(
      this.compactionHistoryFile(record.sessionId),
      `${JSON.stringify(
        memoryCompactionRecordSchema.parse({
          ...record,
          createdAt: now,
          updatedAt: now
        })
      )}\n`,
      "utf8"
    );
  }

  private async ensureScopeDirectories(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.options.workspaceRoot, { recursive: true }),
      fs.mkdir(this.options.userGlobalRoot, { recursive: true }),
      fs.mkdir(path.dirname(this.sessionIndexFile()), { recursive: true }),
      fs.mkdir(this.options.chatSessionRoot, { recursive: true })
    ]);
  }

  private chatSessionSummaryFile(sessionId: string): string {
    return path.join(this.options.chatSessionRoot, `${sessionId}.md`);
  }

  private compactionHistoryFile(sessionId: string): string {
    return path.join(this.options.stateRoot, "memory", "compactions", `${sessionId}.jsonl`);
  }

  private async loadEntriesForScopes(scopes: MemoryQuery["scopes"], sessionId?: string): Promise<MemoryEntry[]> {
    const entries = await Promise.all(
      scopes.map(async (scope) => {
        if (scope === "workspace") {
          return this.readEntryIndex(this.workspaceIndexFile());
        }
        if (scope === "user_global") {
          return this.readEntryIndex(this.userGlobalIndexFile());
        }
        if (scope === "session") {
          return this.readEntryIndex(this.sessionIndexFile()).then((items) =>
            sessionId ? items.filter((entry) => entry.sessionId === sessionId) : items
          );
        }

        return [];
      })
    );

    return entries.flat();
  }

  private async readCompactionHistory(sessionId: string) {
    try {
      const raw = await fs.readFile(this.compactionHistoryFile(sessionId), "utf8");
      return raw
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => memoryCompactionRecordSchema.parse(JSON.parse(line) as unknown));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async readEntryIndex(filePath: string): Promise<MemoryEntry[]> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return z.array(memoryEntrySchema).parse(JSON.parse(raw) as unknown);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async readTextFile(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async refreshUserGlobalSummaries(): Promise<void> {
    const entries = await this.readEntryIndex(this.userGlobalIndexFile());
    await fs.mkdir(this.options.userGlobalRoot, { recursive: true });
    await fs.writeFile(this.userGlobalMemorySummaryFile(), renderMemorySummary("User Global Memory", entries), "utf8");
  }

  private async refreshWorkspaceSummaries(): Promise<void> {
    const entries = await this.readEntryIndex(this.workspaceIndexFile());
    await fs.mkdir(this.options.workspaceRoot, { recursive: true });
    await fs.writeFile(this.workspaceMemorySummaryFile(), renderMemorySummary("Workspace Memory", entries), "utf8");
    const rootMemoryFile = path.join(path.dirname(this.options.workspaceRoot), "MEMORY.md");
    await fs.writeFile(rootMemoryFile, renderMemorySummary("Workspace Memory", entries), "utf8");
  }

  private resolveIndexFile(scope: MemoryEntry["scope"]): string {
    if (scope === "workspace") {
      return this.workspaceIndexFile();
    }
    if (scope === "user_global") {
      return this.userGlobalIndexFile();
    }
    return this.sessionIndexFile();
  }

  private sessionIndexFile(): string {
    return path.join(this.options.stateRoot, "memory", "session-index.json");
  }

  private userGlobalIndexFile(): string {
    return path.join(this.options.userGlobalRoot, "index.json");
  }

  private userGlobalMemorySummaryFile(): string {
    return path.join(this.options.userGlobalRoot, "summary.md");
  }

  private workspaceIndexFile(): string {
    return path.join(this.options.workspaceRoot, "index.json");
  }

  private workspaceMemorySummaryFile(): string {
    return path.join(this.options.workspaceRoot, "workspace-memory.md");
  }

  private async loadIndexedDocuments(): Promise<IndexedMemoryDocument[]> {
    const documents: IndexedMemoryDocument[] = [];
    const seen = new Set<string>();
    for (const source of this.getMemorySources()) {
      if (source.type === "file") {
        const document = await this.readIndexedDocument(source.absolutePath, source.displayPath, source.scope);
        if (!document) {
          continue;
        }
        const realPath = await safeRealPath(source.absolutePath);
        const dedupeKey = realPath ?? source.absolutePath;
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          documents.push(document);
        }
        continue;
      }

      for (const entry of await this.listMarkdownFiles(source.absolutePath, source.displayPrefix)) {
        const realPath = await safeRealPath(entry.absolutePath);
        const dedupeKey = realPath ?? entry.absolutePath;
        if (seen.has(dedupeKey)) {
          continue;
        }
        const document = await this.readIndexedDocument(entry.absolutePath, entry.displayPath, source.scope);
        if (!document) {
          continue;
        }
        seen.add(dedupeKey);
        documents.push(document);
      }
    }
    return documents;
  }

  private getMemorySources(): MemorySourceDescriptor[] {
    const workspaceBase = path.dirname(this.options.workspaceRoot);
    const extraPaths = this.options.extraPaths ?? [];
    const sources: MemorySourceDescriptor[] = [
      {
        absolutePath: path.join(workspaceBase, "MEMORY.md"),
        displayPath: "MEMORY.md",
        scope: "workspace",
        type: "file"
      },
      {
        absolutePath: path.join(workspaceBase, "memory.md"),
        displayPath: "memory.md",
        scope: "workspace",
        type: "file"
      },
      {
        absolutePath: this.options.workspaceRoot,
        displayPrefix: path.basename(this.options.workspaceRoot),
        scope: "workspace",
        type: "directory"
      },
      {
        absolutePath: this.options.userGlobalRoot,
        displayPrefix: "user-memory",
        scope: "user_global",
        type: "directory"
      }
    ];

    if (this.options.includeSessionSummaries ?? true) {
      sources.push({
        absolutePath: this.options.chatSessionRoot,
        displayPrefix: "chat-session-memory",
        scope: "session",
        type: "directory"
      });
    }

    for (const extraPath of extraPaths) {
      const absolutePath = path.resolve(workspaceBase, extraPath);
      const relativeToWorkspace = path.relative(workspaceBase, absolutePath);
      const displayPrefix =
        relativeToWorkspace && !relativeToWorkspace.startsWith("..") && !path.isAbsolute(relativeToWorkspace)
          ? normalizeDisplayPath(relativeToWorkspace)
          : normalizeDisplayPath(path.join("extra", path.basename(absolutePath)));

      if (path.extname(absolutePath).toLowerCase() === ".md") {
        sources.push({
          absolutePath,
          displayPath: displayPrefix,
          scope: "workspace",
          type: "file"
        });
      } else {
        sources.push({
          absolutePath,
          displayPrefix,
          scope: "workspace",
          type: "directory"
        });
      }
    }

    return sources;
  }

  private async listMarkdownFiles(
    root: string,
    displayPrefix: string
  ): Promise<Array<{ absolutePath: string; displayPath: string }>> {
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      const files = await Promise.all(
        entries.map(async (entry) => {
          const filePath = path.join(root, entry.name);
          const displayPath = normalizeDisplayPath(path.join(displayPrefix, entry.name));
          if (entry.isDirectory()) {
            return this.listMarkdownFiles(filePath, displayPath);
          }
          return filePath.endsWith(".md") ? [{ absolutePath: filePath, displayPath }] : [];
        })
      );
      return files.flat();
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async readIndexedDocument(
    filePath: string,
    displayPath: string,
    scope: MemoryEntry["scope"]
  ): Promise<IndexedMemoryDocument | null> {
    try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) {
        return null;
      }
      const content = await fs.readFile(filePath, "utf8");
      return {
        content,
        filePath: normalizeDisplayPath(displayPath),
        mtimeMs: stats.mtimeMs,
        scope,
        uri: pathToFileURL(filePath).toString()
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async resolveMemoryFilePath(relativeFilePath: string): Promise<{
    absolutePath: string;
    displayPath: string;
    missing: boolean;
  }> {
    const normalizedPath = normalizeDisplayPath(relativeFilePath);
    for (const source of this.getMemorySources()) {
      if (source.type === "file") {
        if (normalizedPath !== source.displayPath) {
          continue;
        }
        try {
          const stats = await fs.stat(source.absolutePath);
          if (stats.isFile() && source.absolutePath.endsWith(".md")) {
            return {
              absolutePath: source.absolutePath,
              displayPath: source.displayPath,
              missing: false
            };
          }
        } catch (error) {
          if (isNodeError(error) && error.code === "ENOENT") {
            return {
              absolutePath: source.absolutePath,
              displayPath: source.displayPath,
              missing: true
            };
          }
          throw error;
        }
        continue;
      }

      if (normalizedPath !== source.displayPrefix && !normalizedPath.startsWith(`${source.displayPrefix}/`)) {
        continue;
      }
      const relativeWithinSource = normalizedPath === source.displayPrefix ? "" : normalizedPath.slice(source.displayPrefix.length + 1);
      if (relativeWithinSource.length === 0) {
        throw new Error(`Memory path "${relativeFilePath}" points to a directory. Use a Markdown file path instead.`);
      }
      const resolved = path.resolve(source.absolutePath, relativeWithinSource);
      const relativeCheck = path.relative(source.absolutePath, resolved);
      if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) {
        throw new Error(`Memory path "${relativeFilePath}" is outside the allowed memory roots.`);
      }
      try {
        const stats = await fs.stat(resolved);
        if (stats.isFile() && resolved.endsWith(".md")) {
          return {
            absolutePath: resolved,
            displayPath: normalizedPath,
            missing: false
          };
        }
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") {
          return {
            absolutePath: resolved,
            displayPath: normalizedPath,
            missing: true
          };
        }
        throw error;
      }
    }

    throw new Error(`Memory file "${relativeFilePath}" is outside the allowed memory roots.`);
  }

  private async readLatestCompactionRecord(): Promise<MemorySystemStatus["lastCompaction"]> {
    try {
      const directory = path.join(this.options.stateRoot, "memory", "compactions");
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
      if (files.length === 0) {
        return null;
      }

      let latest: z.infer<typeof memoryCompactionRecordSchema> | null = null;
      for (const file of files) {
        const raw = await fs.readFile(path.join(directory, file.name), "utf8");
        const lines = raw
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0);
        const lastLine = lines.at(-1);
        if (!lastLine) {
          continue;
        }
        const parsed = memoryCompactionRecordSchema.parse(JSON.parse(lastLine) as unknown);
        if (!latest || parsed.updatedAt.localeCompare(latest.updatedAt) > 0) {
          latest = parsed;
        }
      }

      return latest
        ? {
            phase: latest.phase,
            sessionId: latest.sessionId,
            summary: latest.summary,
            trigger: latest.trigger,
            updatedAt: latest.updatedAt
          }
        : null;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }
}

function buildSessionSummary(
  goal: string,
  assistantMessages: SessionSnapshot["messages"],
  toolCalls: SessionSnapshot["toolCalls"]
): string {
  const latestAssistantText = assistantMessages
    .flatMap((message) => message.parts)
    .filter((part): part is Extract<(typeof assistantMessages)[number]["parts"][number], { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .at(-1);

  return [
    `# Session Summary`,
    ``,
    `Goal: ${goal}`,
    ``,
    `Successful tool calls: ${toolCalls.length}`,
    latestAssistantText ? `` : undefined,
    latestAssistantText ? `Latest assistant summary: ${latestAssistantText}` : undefined
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

function estimateTokenCountFromSnapshot(messages: SessionSnapshot["messages"]): number {
  const characters = messages
    .flatMap((message) => message.parts)
    .reduce((total, part) => {
      if (part.kind === "text") {
        return total + part.text.length;
      }
      if (part.kind === "json") {
        return total + JSON.stringify(part.value).length;
      }
      return total;
    }, 0);

  return Math.max(1, Math.round(characters / 4));
}

function renderMemorySummary(title: string, entries: MemoryEntry[]): string {
  const sorted = [...entries].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const lines = [`# ${title}`, ""];

  for (const entry of sorted.slice(0, 20)) {
    lines.push(`## ${entry.summary ?? entry.kind}`);
    lines.push(`- Scope: ${entry.scope}`);
    lines.push(`- Confidence: ${entry.confidence}`);
    lines.push(`- Content: ${entry.content}`);
    lines.push("");
  }

  if (sorted.length === 0) {
    lines.push("No durable memory entries yet.");
    lines.push("");
  }

  return lines.join("\n");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function normalizeDisplayPath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\/+/u, "").replace(/^\/+/u, "");
}

async function safeRealPath(filePath: string): Promise<string | null> {
  try {
    return await fs.realpath(filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
