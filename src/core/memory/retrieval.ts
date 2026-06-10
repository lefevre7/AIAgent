import crypto from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { MemoryEntry, MemoryHit, MemoryQuery } from "@/core/contracts";
import type { ProviderHealthStatus } from "@/core/contracts";
import type { EmbeddingRuntime } from "@/core/memory/embeddings";

// Minimal structural surface of the synchronous SQLite driver we use. Node's
// built-in `node:sqlite` DatabaseSync satisfies this, and so does the
// in-memory fallback store used when a database file cannot be opened.
interface SqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): { lastInsertRowid: number | bigint };
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

const RETRIEVAL_SCHEMA_VERSION = 1;
const EMBEDDING_MODEL_HINTS = [
  /embed/i,
  /embedding/i,
  /nomic/i,
  /mxbai/i,
  /bge/i,
  /e5/i,
  /gte/i,
  /snowflake/i,
  /arctic/i,
  /jina/i,
  /all-minilm/i
];

export type IndexedMemoryDocument = {
  content: string;
  filePath: string;
  mtimeMs: number;
  scope: MemoryEntry["scope"];
  uri: string;
};

type IndexedChunk = {
  chunkKey: string;
  content: string;
  embedding: number[] | null;
  endLine: number;
  filePath: string;
  lastAccessedAt: string | null;
  mtimeMs: number;
  scope: MemoryEntry["scope"];
  startLine: number;
  uri: string;
};

type LexicalCandidate = {
  chunk: IndexedChunk;
  lexicalScore: number;
};

type SemanticCandidate = LexicalCandidate & {
  semanticScore: number;
};

type ScoredCandidate = SemanticCandidate & {
  score: number;
};

export type MemoryRetrievalOptions = {
  candidateLimit: number;
  chunkOverlapChars: number;
  chunkTargetChars: number;
  embeddingModel?: string;
  embeddingProvider: string;
  embeddingsEnabled: boolean;
  ftsEnabled: boolean;
  hardFailOnStartup: boolean;
  loadDocuments: () => Promise<IndexedMemoryDocument[]>;
  mmrLambda: number;
  retrievalLimit: number;
  sqlitePath: string;
};

export type MemoryRetrievalQueryResult = {
  hits: MemoryHit[];
  retrieval: {
    activeMode: "hybrid" | "lexical";
    fallbackUsed: boolean;
    modelId: string | null;
    providerId: string | null;
    semanticAvailable: boolean;
    semanticStatus: ProviderHealthStatus;
    warning: string | null;
  };
};

export type MemoryRetrievalStatus = {
  dirty: boolean;
  embeddings: {
    enabled: boolean;
    hardFailOnStartup: boolean;
    modelId: string | null;
    providerId: string | null;
    status: ProviderHealthStatus;
  };
  index: {
    chunkCount: number;
    configFingerprint: string | null;
    documentCount: number;
    embeddingDimensions: number | null;
    fileCount: number;
    lastIndexedAt: string | null;
    schemaVersion: number;
    sqlitePath: string;
  };
  lexical: {
    enabled: boolean;
    ready: boolean;
  };
  modes: Array<"hybrid" | "lexical" | "semantic">;
};

export class MemoryRetrievalEngine {
  private accessFlushTimer: NodeJS.Timeout | null = null;
  private readonly db: SqliteDatabase;
  private readonly usingFallbackStore: boolean;
  private dirty = true;
  private ftsAvailable = false;
  private initialized = false;
  private readonly pendingAccessUpdates = new Set<string>();
  private resolvedEmbeddingModel: string | null = null;

  constructor(
    private readonly options: MemoryRetrievalOptions,
    private readonly embeddingRuntime?: EmbeddingRuntime
  ) {
    mkdirSync(path.dirname(options.sqlitePath), { recursive: true });
    const store = openSqliteStore(options.sqlitePath);
    this.db = store.db;
    this.usingFallbackStore = store.usingFallbackStore;
    this.initializeSchema();
  }

  markDirty(): void {
    this.dirty = true;
  }

  setEmbeddingProvider(params: { embeddingModel?: string; providerId: string }): void {
    this.options.embeddingProvider = params.providerId;
    if (params.embeddingModel !== undefined) {
      this.options.embeddingModel = params.embeddingModel;
    }
    this.resolvedEmbeddingModel = this.options.embeddingModel ?? null;
    this.markDirty();
  }

  async initialize(): Promise<void> {
    await this.ensureEmbeddingStartupReadiness();
    if (!this.initialized || this.dirty || this.needsRebuild()) {
      await this.sync();
    }
    this.initialized = true;
  }

  async search(query: MemoryQuery): Promise<MemoryRetrievalQueryResult> {
    if (!this.initialized || this.dirty) {
      await this.initialize();
    }

    if (query.includeKinds.length > 0 && !query.includeKinds.includes("summary")) {
      return {
        hits: [],
        retrieval: {
          activeMode: "lexical",
          fallbackUsed: false,
          modelId: this.resolvedEmbeddingModel,
          providerId: this.options.embeddingsEnabled ? this.options.embeddingProvider : null,
          semanticAvailable: false,
          semanticStatus: this.options.embeddingsEnabled ? "healthy" : "unavailable",
          warning: null
        }
      };
    }

    const lexicalRows = this.options.ftsEnabled
      ? this.lexicalSearch(query.text, query.scopes, this.options.candidateLimit)
      : [];
    const allScopedChunks = this.getAllChunks(query.scopes);
    let queryVector: number[] | null = null;
    let semanticAvailable = false;
    let semanticStatus: ProviderHealthStatus = this.options.embeddingsEnabled ? "healthy" : "unavailable";
    let warning: string | null = null;

    if (this.options.embeddingsEnabled && this.embeddingRuntime && this.resolvedEmbeddingModel) {
      try {
        const response = await this.embeddingRuntime.createEmbeddings({
          id: `embedding.query.${crypto.randomUUID()}`,
          inputs: [query.text],
          metadata: {},
          modelId: this.resolvedEmbeddingModel,
          providerId: this.options.embeddingProvider
        });
        queryVector = response.vectors[0] ?? null;
        semanticAvailable = Array.isArray(queryVector) && queryVector.length > 0;
      } catch {
        semanticAvailable = false;
        semanticStatus = "degraded";
        warning = "Semantic retrieval is temporarily unavailable; continuing with lexical retrieval.";
      }
    }

    const semanticRows =
      semanticAvailable && queryVector
        ? this.semanticSearch(
            queryVector,
            lexicalRows.length > 0 ? lexicalRows : allScopedChunks.map((chunk) => ({ chunk, lexicalScore: 0 })),
            this.options.candidateLimit
          )
        : [];

    const hits = combineCandidates({
      lexicalRows,
      mmrLambda: this.options.mmrLambda,
      semanticAvailable,
      semanticRows
    })
      .slice(0, query.limit ?? this.options.retrievalLimit)
      .map((candidate) =>
        buildMemoryHitFromChunk(candidate.chunk, {
          explanation: semanticAvailable
            ? candidate.lexicalScore > 0
              ? "Hybrid lexical + semantic retrieval."
              : "Semantic retrieval fallback."
            : this.options.embeddingsEnabled
              ? "Semantic retrieval unavailable; lexical retrieval only."
              : "Lexical retrieval only.",
          providerId: semanticAvailable ? this.options.embeddingProvider : undefined,
          score: candidate.score
        })
      )
      .filter((hit) => hit.entry.confidence >= query.minConfidence);

    this.queueAccessUpdates(hits.map((hit) => hit.entry.id.replace(/^memory\.chunk\./u, "")));

    return {
      hits,
      retrieval: {
        activeMode: semanticAvailable ? "hybrid" : "lexical",
        fallbackUsed: this.options.embeddingsEnabled && !semanticAvailable,
        modelId: this.resolvedEmbeddingModel,
        providerId: this.options.embeddingsEnabled ? this.options.embeddingProvider : null,
        semanticAvailable,
        semanticStatus,
        warning
      }
    };
  }

  async status(): Promise<MemoryRetrievalStatus> {
    const counts = (this.db
      .prepare("SELECT COUNT(DISTINCT file_path) AS fileCount, COUNT(*) AS chunkCount FROM chunks")
      .get() ?? { chunkCount: 0, fileCount: 0 }) as { chunkCount?: number; fileCount?: number };

    let embeddingStatus: ProviderHealthStatus = "unavailable";
    if (this.options.embeddingsEnabled && this.embeddingRuntime) {
      embeddingStatus = (await this.embeddingRuntime.health(this.options.embeddingProvider)).status;
    }

    return {
      dirty: this.dirty,
      embeddings: {
        enabled: this.options.embeddingsEnabled,
        hardFailOnStartup: this.options.hardFailOnStartup,
        modelId: this.resolvedEmbeddingModel,
        providerId: this.options.embeddingsEnabled ? this.options.embeddingProvider : null,
        status: this.options.embeddingsEnabled ? embeddingStatus : "unavailable"
      },
      index: {
        chunkCount: counts.chunkCount ?? 0,
        configFingerprint: this.readMeta("config_fingerprint"),
        documentCount: Number(this.readMeta("document_count") ?? 0),
        embeddingDimensions: this.readOptionalNumberMeta("embedding_dimensions"),
        fileCount: counts.fileCount ?? 0,
        lastIndexedAt: this.readMeta("last_indexed_at"),
        schemaVersion: Number(this.readMeta("schema_version") ?? RETRIEVAL_SCHEMA_VERSION),
        sqlitePath: this.options.sqlitePath
      },
      lexical: {
        enabled: this.options.ftsEnabled,
        ready: this.ftsAvailable
      },
      modes: this.options.embeddingsEnabled ? ["lexical", "semantic", "hybrid"] : ["lexical"]
    };
  }

  async sync(): Promise<void> {
    await this.ensureEmbeddingStartupReadiness();

    const documents = await this.options.loadDocuments();
    const chunks = chunkDocuments(documents, this.options.chunkTargetChars, this.options.chunkOverlapChars);
    let embeddings: number[][] = [];

    if (this.options.embeddingsEnabled && chunks.length > 0) {
      if (!this.embeddingRuntime || !this.resolvedEmbeddingModel) {
        throw new Error("Embeddings are enabled but the embedding runtime is not ready.");
      }

      const response = await this.embeddingRuntime.createEmbeddings({
        id: `embedding.sync.${crypto.randomUUID()}`,
        inputs: chunks.map((chunk) => chunk.content),
        metadata: {},
        modelId: this.resolvedEmbeddingModel,
        providerId: this.options.embeddingProvider
      });
      embeddings = response.vectors;
      if (embeddings.length !== chunks.length) {
        throw new Error("Embedding sync returned a mismatched vector count.");
      }
    }

    const insertChunk = this.db.prepare(
      "INSERT INTO chunks (chunk_key, file_path, scope, start_line, end_line, content, mtime_ms, uri, embedding_json, last_accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    const insertFts = this.ftsAvailable
      ? this.db.prepare("INSERT INTO chunk_fts (rowid, file_path, content) VALUES (?, ?, ?)")
      : null;

    this.flushPendingAccessUpdates();
    this.db.exec("BEGIN IMMEDIATE TRANSACTION");
    try {
      if (this.ftsAvailable) {
        this.db.exec("DELETE FROM chunk_fts;");
      }
      this.db.exec("DELETE FROM chunks;");
      for (const [index, chunk] of chunks.entries()) {
        const result = insertChunk.run(
          chunk.chunkKey,
          chunk.filePath,
          chunk.scope,
          chunk.startLine,
          chunk.endLine,
          chunk.content,
          chunk.mtimeMs,
          chunk.uri,
          embeddings[index] ? JSON.stringify(embeddings[index]) : null,
          null
        );
        insertFts?.run(Number(result.lastInsertRowid), chunk.filePath, chunk.content);
      }
      this.persistMeta({
        config_fingerprint: this.buildConfigFingerprint(),
        document_count: documents.length,
        embedding_dimensions: embeddings[0]?.length ?? null,
        embedding_model: this.resolvedEmbeddingModel,
        embedding_provider: this.options.embeddingsEnabled ? this.options.embeddingProvider : null,
        last_indexed_at: new Date().toISOString(),
        schema_version: RETRIEVAL_SCHEMA_VERSION
      });
      this.db.exec("COMMIT");
      this.dirty = false;
      this.initialized = true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private async ensureEmbeddingStartupReadiness(): Promise<void> {
    if (!this.options.embeddingsEnabled) {
      return;
    }

    if (!this.embeddingRuntime) {
      throw new Error("Embeddings are enabled but no embedding runtime is configured.");
    }

    this.resolvedEmbeddingModel ??= await this.resolveEmbeddingModel();
    const health = await this.embeddingRuntime.health(this.options.embeddingProvider);
    if (health.status !== "healthy" && this.options.hardFailOnStartup) {
      throw new Error(
        `Embedding provider "${this.options.embeddingProvider}" is not healthy: ${JSON.stringify(health.details)}`
      );
    }
  }

  private buildConfigFingerprint(): string {
    return crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          chunkOverlapChars: this.options.chunkOverlapChars,
          chunkTargetChars: this.options.chunkTargetChars,
          embeddingModel: this.resolvedEmbeddingModel ?? this.options.embeddingModel ?? "auto",
          embeddingProvider: this.options.embeddingProvider,
          embeddingsEnabled: this.options.embeddingsEnabled,
          ftsEnabled: this.options.ftsEnabled,
          mmrLambda: this.options.mmrLambda,
          retrievalLimit: this.options.retrievalLimit
        })
      )
      .digest("hex");
  }

  private flushPendingAccessUpdates(): void {
    if (this.pendingAccessUpdates.size === 0) {
      return;
    }

    const chunkKeys = Array.from(this.pendingAccessUpdates);
    this.pendingAccessUpdates.clear();
    if (this.accessFlushTimer) {
      clearTimeout(this.accessFlushTimer);
      this.accessFlushTimer = null;
    }

    const placeholders = chunkKeys.map(() => "?").join(", ");
    try {
      this.db
        .prepare(`UPDATE chunks SET last_accessed_at = ? WHERE chunk_key IN (${placeholders})`)
        .run(new Date().toISOString(), ...chunkKeys);
    } catch {
      // Access timestamps are best-effort metadata and must never break retrieval.
    }
  }

  private getAllChunks(scopes: MemoryQuery["scopes"]): IndexedChunk[] {
    const scoped = new Set(scopes);
    return (this.db.prepare("SELECT * FROM chunks").all() as Array<Record<string, unknown>>)
      .map((row) => mapRowToChunk(row))
      .filter((chunk) => scoped.has(chunk.scope));
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        chunk_key TEXT NOT NULL UNIQUE,
        file_path TEXT NOT NULL,
        scope TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        content TEXT NOT NULL,
        mtime_ms INTEGER NOT NULL,
        uri TEXT NOT NULL,
        embedding_json TEXT,
        last_accessed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS retrieval_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    if (this.usingFallbackStore) {
      this.ftsAvailable = false;
      return;
    }
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(file_path, content);");
      this.ftsAvailable = true;
    } catch {
      this.ftsAvailable = false;
    }
  }

  private lexicalSearch(queryText: string, scopes: MemoryQuery["scopes"], limit: number): LexicalCandidate[] {
    if (!this.ftsAvailable) {
      const normalized = queryText.toLowerCase();
      return this.getAllChunks(scopes)
        .filter((chunk) => chunk.content.toLowerCase().includes(normalized) || chunk.filePath.toLowerCase().includes(normalized))
        .slice(0, limit)
        .map((chunk) => ({
          chunk,
          lexicalScore: 0.5
        }));
    }

    try {
      const rows = this.db
        .prepare(
          "SELECT c.*, bm25(chunk_fts) AS lexical_score FROM chunk_fts JOIN chunks c ON c.rowid = chunk_fts.rowid WHERE chunk_fts MATCH ? LIMIT ?"
        )
        .all(queryText, limit * 3) as Array<Record<string, unknown>>;

      const scopeSet = new Set(scopes);
      return rows
        .map((row) => ({
          chunk: mapRowToChunk(row),
          lexicalScore: 1 / (1 + Math.max(0, Number(row.lexical_score ?? 0)))
        }))
        .filter((row) => scopeSet.has(row.chunk.scope))
        .slice(0, limit);
    } catch {
      const normalized = queryText.toLowerCase();
      return this.getAllChunks(scopes)
        .filter((chunk) => chunk.content.toLowerCase().includes(normalized) || chunk.filePath.toLowerCase().includes(normalized))
        .slice(0, limit)
        .map((chunk) => ({
          chunk,
          lexicalScore: 0.5
        }));
    }
  }

  private needsRebuild(): boolean {
    const schemaVersion = Number(this.readMeta("schema_version") ?? 0);
    const fingerprint = this.readMeta("config_fingerprint");
    return schemaVersion !== RETRIEVAL_SCHEMA_VERSION || fingerprint !== this.buildConfigFingerprint();
  }

  private persistMeta(meta: Record<string, unknown>): void {
    const statement = this.db.prepare(
      "INSERT INTO retrieval_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    );
    for (const [key, value] of Object.entries(meta)) {
      statement.run(key, JSON.stringify(value ?? null));
    }
  }

  private queueAccessUpdates(chunkKeys: string[]): void {
    for (const chunkKey of chunkKeys) {
      if (chunkKey.trim().length > 0) {
        this.pendingAccessUpdates.add(chunkKey);
      }
    }
    if (this.pendingAccessUpdates.size === 0 || this.accessFlushTimer) {
      return;
    }
    this.accessFlushTimer = setTimeout(() => {
      this.flushPendingAccessUpdates();
    }, 50);
    this.accessFlushTimer.unref?.();
  }

  private readMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM retrieval_meta WHERE key = ?").get(key) as { value?: string } | undefined;
    if (!row?.value) {
      return null;
    }
    return JSON.parse(row.value) as string | null;
  }

  private readOptionalNumberMeta(key: string): number | null {
    const value = this.readMeta(key);
    if (value === null || value === "") {
      return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private async resolveEmbeddingModel(): Promise<string> {
    if (this.options.embeddingModel) {
      return this.options.embeddingModel;
    }

    if (!this.embeddingRuntime) {
      throw new Error(`No embedding runtime is configured for provider "${this.options.embeddingProvider}".`);
    }

    const models = await this.embeddingRuntime.listModels(this.options.embeddingProvider);
    const ranked = models
      .map((model) => ({
        modelId: model.modelId,
        score: scoreEmbeddingModel(model.modelId)
      }))
      .sort((left, right) => right.score - left.score);

    const best = ranked.find((model) => model.score > 0);
    if (!best) {
      throw new Error(
        `No embedding model could be auto-discovered for provider "${this.options.embeddingProvider}". Configure memory.embeddingModel explicitly.`
      );
    }

    return best.modelId;
  }

  private semanticSearch(queryVector: number[], candidates: LexicalCandidate[], limit: number): SemanticCandidate[] {
    return candidates
      .map((candidate) => ({
        ...candidate,
        semanticScore: cosineSimilarity(queryVector, candidate.chunk.embedding ?? [])
      }))
      .filter((candidate) => candidate.semanticScore > 0)
      .sort((left, right) => right.semanticScore - left.semanticScore)
      .slice(0, limit);
  }
}

function openSqliteStore(sqlitePath: string): { db: SqliteDatabase; usingFallbackStore: boolean } {
  try {
    return { db: new DatabaseSync(sqlitePath), usingFallbackStore: false };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.emitWarning(
      `node:sqlite could not open "${sqlitePath}" (${reason}); memory retrieval will use a ` +
        "non-persistent in-memory store and lexical/semantic search will be disabled.",
      { code: "AIA_SQLITE_FALLBACK" }
    );
    return { db: createInMemorySqliteStore(), usingFallbackStore: true };
  }
}

// Minimal no-op store used only when a SQLite database cannot be opened. Reads
// return empty, writes are dropped, so the runtime stays usable without
// persisting memory. `usingFallbackStore` keeps FTS disabled for this path.
function createInMemorySqliteStore(): SqliteDatabase {
  const statement: SqliteStatement = {
    all: () => [],
    get: () => undefined,
    run: () => ({ lastInsertRowid: 0 })
  };
  return {
    exec: () => undefined,
    prepare: () => statement
  };
}

function buildMemoryHitFromChunk(
  chunk: IndexedChunk,
  params: {
    explanation: string;
    providerId?: string;
    score: number;
  }
): MemoryHit {
  const citation = formatCitation(chunk.filePath, chunk.startLine, chunk.endLine);
  return {
    entry: {
      confidence: Math.min(1, Math.max(0.25, params.score)),
      content: chunk.content,
      createdAt: new Date(chunk.mtimeMs).toISOString(),
      id: `memory.chunk.${chunk.chunkKey}`,
      kind: "summary",
      lastAccessedAt: chunk.lastAccessedAt ?? undefined,
      metadata: {
        citation,
        endLine: chunk.endLine,
        filePath: chunk.filePath,
        providerId: params.providerId ?? null,
        startLine: chunk.startLine
      },
      provenance: {
        messageIds: [],
        sourceLabel: "memory_search",
        toolCallIds: [],
        uri: chunk.uri
      },
      recencyScore: recencyFromMtime(chunk.mtimeMs),
      scope: chunk.scope,
      summary: `${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`,
      tags: ["retrieval"],
      updatedAt: new Date(chunk.mtimeMs).toISOString()
    },
    explanation: params.explanation,
    score: params.score
  };
}

function chunkDocuments(documents: IndexedMemoryDocument[], targetChars: number, overlapChars: number): IndexedChunk[] {
  const chunks: IndexedChunk[] = [];

  for (const document of documents) {
    const lines = document.content.split("\n");
    let start = 0;

    while (start < lines.length) {
      let end = start;
      let charCount = 0;
      while (end < lines.length && charCount < targetChars) {
        charCount += lines[end]?.length ?? 0;
        end += 1;
      }

      const chunkLines = lines.slice(start, end);
      const chunkContent = chunkLines.join("\n").trim();
      if (chunkContent.length > 0) {
        chunks.push({
          chunkKey: crypto
            .createHash("sha256")
            .update(`${document.filePath}:${start + 1}:${end}:${chunkContent}`)
            .digest("hex"),
          content: chunkContent,
          embedding: null,
          endLine: end,
          filePath: document.filePath,
          lastAccessedAt: null,
          mtimeMs: document.mtimeMs,
          scope: document.scope,
          startLine: start + 1,
          uri: document.uri
        });
      }

      if (end >= lines.length) {
        break;
      }

      let overlapLineCount = 0;
      let overlapCount = 0;
      while (end - overlapLineCount - 1 > start && overlapCount < overlapChars) {
        overlapLineCount += 1;
        overlapCount += lines[end - overlapLineCount]?.length ?? 0;
      }
      start = Math.max(start + 1, end - overlapLineCount);
    }
  }

  return chunks;
}

function combineCandidates(params: {
  lexicalRows: LexicalCandidate[];
  mmrLambda: number;
  semanticAvailable: boolean;
  semanticRows: SemanticCandidate[];
}): ScoredCandidate[] {
  const combined = new Map<string, SemanticCandidate>();

  for (const lexical of params.lexicalRows) {
    combined.set(lexical.chunk.chunkKey, {
      ...lexical,
      semanticScore: 0
    });
  }
  for (const semantic of params.semanticRows) {
    const existing = combined.get(semantic.chunk.chunkKey);
    combined.set(semantic.chunk.chunkKey, {
      chunk: semantic.chunk,
      lexicalScore: existing?.lexicalScore ?? semantic.lexicalScore,
      semanticScore: semantic.semanticScore
    });
  }

  const scored = Array.from(combined.values()).map((candidate) => ({
    ...candidate,
    score:
      candidate.lexicalScore * 0.45 +
      candidate.semanticScore * (params.semanticAvailable ? 0.45 : 0) +
      recencyFromMtime(candidate.chunk.mtimeMs) * 0.1
  }));

  if (!params.semanticAvailable) {
    return scored.sort((left, right) => right.score - left.score);
  }

  const selected: ScoredCandidate[] = [];
  const remaining = [...scored];
  while (remaining.length > 0 && selected.length < scored.length) {
    remaining.sort((left, right) => mmrScore(right, selected, params.mmrLambda) - mmrScore(left, selected, params.mmrLambda));
    const next = remaining.shift();
    if (!next) {
      break;
    }
    selected.push(next);
  }
  return selected;
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return 0;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function formatCitation(filePath: string, startLine: number, endLine: number): string {
  return startLine === endLine ? `${filePath}#L${startLine}` : `${filePath}#L${startLine}-L${endLine}`;
}

function mapRowToChunk(row: Record<string, unknown>): IndexedChunk {
  return {
    chunkKey: String(row.chunk_key),
    content: String(row.content),
    embedding: typeof row.embedding_json === "string" ? (JSON.parse(row.embedding_json) as number[]) : null,
    endLine: Number(row.end_line),
    filePath: String(row.file_path),
    lastAccessedAt: typeof row.last_accessed_at === "string" ? row.last_accessed_at : null,
    mtimeMs: Number(row.mtime_ms),
    scope: row.scope as MemoryEntry["scope"],
    startLine: Number(row.start_line),
    uri: String(row.uri)
  };
}

function mmrScore(candidate: ScoredCandidate, selected: ScoredCandidate[], lambda: number): number {
  if (selected.length === 0) {
    return candidate.score;
  }
  const diversityPenalty = Math.max(
    ...selected.map((entry) => cosineSimilarity(candidate.chunk.embedding ?? [], entry.chunk.embedding ?? []))
  );
  return lambda * candidate.score - (1 - lambda) * diversityPenalty;
}

function recencyFromMtime(mtimeMs: number): number {
  const ageHours = Math.max(1, (Date.now() - mtimeMs) / (1000 * 60 * 60));
  return Math.max(0, Math.min(1, 1 / Math.log10(ageHours + 10)));
}

function scoreEmbeddingModel(modelId: string): number {
  return EMBEDDING_MODEL_HINTS.reduce((score, pattern) => score + (pattern.test(modelId) ? 1 : 0), 0);
}
