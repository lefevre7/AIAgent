import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import {
  EmbeddingRuntime,
  FileBackedMemoryService,
  FileSessionStore,
  MemoryRetrievalEngine,
  createDefaultToolRuntime,
  createDefaultAppConfig,
  createMemoryServiceFromConfig,
  type EmbeddingAdapter,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type IndexedMemoryDocument,
  type ProviderHealth,
  type SessionRecord,
  type TurnRecord
} from "@/core";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

describe("memory retrieval", () => {
  test("supports hybrid retrieval and exposes the full memory tool family", async () => {
    const root = await createTempRoot();
    const { chatSessionRoot, memory, session, stateRoot, workspaceBase } = await createRetrievalFixture(root, {
      adapter: createKeywordEmbeddingAdapter()
    });

    await fs.writeFile(
      path.join(workspaceBase, "MEMORY.md"),
      "# Long-Term Memory\nThe operator prefers concise execution updates and direct progress reports.\n",
      "utf8"
    );
    await fs.mkdir(path.join(workspaceBase, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceBase, "memory", "architecture.md"),
      "# Architecture\nThe workspace prefers TypeScript ESM and Node 22.\n",
      "utf8"
    );

    await memory.initializeRetrieval();

    const detailed = await memory.queryDetailed({
      includeKinds: [],
      limit: 5,
      minConfidence: 0,
      scopes: ["workspace", "session", "user_global"],
      text: "What brief progress-update style does the operator prefer?"
    });

    expect(detailed.retrieval.activeMode).toBe("hybrid");
    expect(detailed.retrieval.semanticAvailable).toBe(true);
    expect(detailed.hits[0]?.entry.metadata.filePath).toBe("MEMORY.md");

    const runtime = createDefaultToolRuntime({
      memoryService: memory
    });
    const toolNames = runtime.listDefinitions().map((definition) => definition.invocationName);

    expect(toolNames).toEqual(
      expect.arrayContaining(["memory_get", "memory_index", "memory_search", "memory_status", "memory_write"])
    );

    const result = await runtime.execute(
      {
        arguments: {
          text: "What brief progress-update style does the operator prefer?"
        },
        id: "tool-call.memory-search.1",
        metadata: {},
        sessionId: session.id,
        startedAt: "2026-03-27T18:00:00.000Z",
        status: "pending",
        toolName: "memory_search",
        turnId: "turn.memory.retrieval.1"
      },
      {
        session,
        turn: buildTurn(session.id, "turn.memory.retrieval.1")
      }
    );

    expect(result.toolCall.status).toBe("succeeded");
    expect(result.toolCall.result).toMatchObject({
      fallbackUsed: false,
      hits: [
        expect.objectContaining({
          citation: expect.stringContaining("MEMORY.md#L"),
          path: "MEMORY.md"
        })
      ],
      mode: "hybrid",
      semanticAvailable: true
    });

    const status = await memory.getMemoryStatus();
    expect(status.index.sqlitePath).toBe(path.join(stateRoot, "memory.sqlite"));
    expect(status.sources.chatSessionRoot).toBe(chatSessionRoot);
  });

  test("falls back to lexical retrieval when semantic lookup degrades after startup", async () => {
    const root = await createTempRoot();
    const { memory, workspaceBase } = await createRetrievalFixture(root, {
      adapter: createKeywordEmbeddingAdapter({
        failOnQuery: true
      })
    });

    await fs.writeFile(path.join(workspaceBase, "MEMORY.md"), "# Long-Term Memory\nUse terse updates.\n", "utf8");
    await memory.initializeRetrieval();

    const detailed = await memory.queryDetailed({
      includeKinds: [],
      limit: 5,
      minConfidence: 0,
      scopes: ["workspace"],
      text: "Use terse updates"
    });

    expect(detailed.retrieval.activeMode).toBe("lexical");
    expect(detailed.retrieval.fallbackUsed).toBe(true);
    expect(detailed.retrieval.semanticAvailable).toBe(false);
    expect(detailed.retrieval.semanticStatus).toBe("degraded");
    expect(detailed.retrieval.warning).toContain("Semantic retrieval is temporarily unavailable");
    expect(detailed.hits[0]?.entry.metadata.filePath).toBe("MEMORY.md");
  });

  test("uses real node:sqlite with FTS5 and persists the index to disk", async () => {
    const root = await createTempRoot();
    const sqlitePath = path.join(root, ".aia", "memory.sqlite");
    const mtimeMs = Date.now();
    const documents: IndexedMemoryDocument[] = [
      {
        content: "# Architecture\nThe workspace prefers TypeScript ESM and a Node 22 runtime.\n",
        filePath: "memory/architecture.md",
        mtimeMs,
        scope: "workspace",
        uri: "file:///memory/architecture.md"
      },
      {
        content: "# Long-Term Memory\nThe operator prefers concise progress updates.\n",
        filePath: "MEMORY.md",
        mtimeMs,
        scope: "workspace",
        uri: "file:///MEMORY.md"
      }
    ];

    const engine = new MemoryRetrievalEngine({
      candidateLimit: 12,
      chunkOverlapChars: 64,
      chunkTargetChars: 256,
      embeddingProvider: "lm_studio",
      embeddingsEnabled: false,
      ftsEnabled: true,
      hardFailOnStartup: false,
      loadDocuments: async () => documents,
      mmrLambda: 0.7,
      retrievalLimit: 8,
      sqlitePath
    });

    await engine.initialize();

    // A real node:sqlite database with the FTS5 virtual table reports
    // lexical readiness; the in-memory fallback store reports ready: false.
    const status = await engine.status();
    expect(status.lexical.enabled).toBe(true);
    // FTS5 is not compiled into every Node `node:sqlite` build; the engine
    // falls back to an in-memory lexical scan when it is absent. Either path
    // uses the real SQLite store, which the no-op fallback could never report.
    expect(status.lexical.ready).toBe(fts5IsAvailable());
    expect(status.index.fileCount).toBe(2);
    expect(status.index.chunkCount).toBeGreaterThan(0);

    // The fallback store never opens a file, so an on-disk database with
    // content proves the real driver indexed the documents.
    const sqliteStat = await fs.stat(sqlitePath);
    expect(sqliteStat.size).toBeGreaterThan(0);

    const result = await engine.search({
      includeKinds: [],
      limit: 5,
      minConfidence: 0,
      scopes: ["workspace"],
      text: "TypeScript ESM"
    });

    expect(result.retrieval.activeMode).toBe("lexical");
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]?.entry.metadata.filePath).toBe("memory/architecture.md");
  });

  test("returns empty content instead of throwing when a memory file is missing", async () => {
    const root = await createTempRoot();
    const { memory } = await createRetrievalFixture(root, {
      adapter: createKeywordEmbeddingAdapter()
    });

    const missing = await memory.getMemoryFile({
      path: "memory/today.md"
    });

    expect(missing.missing).toBe(true);
    expect(missing.content).toBe("");
    expect(missing.path).toBe("memory/today.md");

    await expect(
      memory.getMemoryFile({
        path: "../secrets.txt"
      })
    ).rejects.toThrow("outside the allowed memory roots");
  });

  test("auto-discovers an embedding model from config and hard-fails startup when none are available", async () => {
    const root = await createTempRoot();
    const userStateDirectory = path.join(root, "home", ".aia");
    const workspaceBase = path.join(root, "workspace");
    const stateRoot = path.join(workspaceBase, ".aia");
    const sessions = new FileSessionStore(stateRoot);
    await sessions.saveSession(buildSession());

    const config = createDefaultAppConfig({
      userStateDirectory
    });
    config.memory.chatSessionRoot = path.join(workspaceBase, "chat-session-memory");
    config.memory.sqlitePath = path.join(stateRoot, "memory.sqlite");
    config.memory.stateRoot = stateRoot;
    config.memory.userGlobalRoot = path.join(userStateDirectory, "memory");
    config.memory.workspaceRoot = path.join(workspaceBase, "memory");
    config.providers.lmStudio.baseUrl = "http://localhost:1234/v1";
    config.providers.ollama.enabled = false;

    const successFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/models")) {
        return jsonResponse({
          data: [{ id: "mistralai/devstral-small-2-2512" }, { id: "nomic-embed-text" }]
        });
      }
      if (url.endsWith("/embeddings")) {
        return jsonResponse({
          data: [{ embedding: [1, 0, 0] }]
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const service = await createMemoryServiceFromConfig({
      config,
      fetchImpl: successFetch,
      sessions
    });
    const status = await service.getMemoryStatus();

    expect(status.embeddings.modelId).toBe("nomic-embed-text");
    expect(status.embeddings.status).toBe("healthy");

    const failingFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/models")) {
        return jsonResponse({
          data: [{ id: "mistralai/devstral-small-2-2512" }]
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    await expect(
      createMemoryServiceFromConfig({
        config,
        fetchImpl: failingFetch,
        sessions
      })
    ).rejects.toThrow("No embedding model could be auto-discovered");
  });

  test("supports registered custom embedding providers during creation and after service startup", async () => {
    const root = await createTempRoot();
    const userStateDirectory = path.join(root, "home", ".aia");
    const workspaceBase = path.join(root, "workspace");
    const stateRoot = path.join(workspaceBase, ".aia");
    const sessions = new FileSessionStore(stateRoot);
    await sessions.saveSession(buildSession());

    const config = createDefaultAppConfig({
      userStateDirectory
    });
    config.memory.chatSessionRoot = path.join(workspaceBase, "chat-session-memory");
    config.memory.embeddingProvider = "custom_embed";
    config.memory.sqlitePath = path.join(stateRoot, "memory.sqlite");
    config.memory.stateRoot = stateRoot;
    config.memory.userGlobalRoot = path.join(userStateDirectory, "memory");
    config.memory.workspaceRoot = path.join(workspaceBase, "memory");
    config.providers.lmStudio.enabled = false;
    config.providers.ollama.enabled = false;

    const service = await createMemoryServiceFromConfig({
      config,
      embeddingAdapters: [createKeywordEmbeddingAdapter({ providerId: "custom_embed" })],
      sessions
    });

    const initialStatus = await service.getMemoryStatus();
    expect(initialStatus.embeddings.providerId).toBe("custom_embed");

    service.registerEmbeddingAdapter(createKeywordEmbeddingAdapter({ providerId: "late_embed" }));
    service.setDefaultEmbeddingProvider({
      providerId: "late_embed"
    });
    const updatedStatus = await service.getMemoryStatus();

    expect(updatedStatus.embeddings.providerId).toBe("late_embed");
  });
});

async function createRetrievalFixture(
  root: string,
  params: {
    adapter: EmbeddingAdapter;
  }
): Promise<{
  chatSessionRoot: string;
  memory: FileBackedMemoryService;
  session: SessionRecord;
  stateRoot: string;
  workspaceBase: string;
}> {
  const workspaceBase = path.join(root, "workspace");
  const workspaceRoot = path.join(workspaceBase, "memory");
  const userGlobalRoot = path.join(root, "home", ".aia", "memory");
  const chatSessionRoot = path.join(workspaceBase, "chat-session-memory");
  const stateRoot = path.join(workspaceBase, ".aia");
  const sessions = new FileSessionStore(stateRoot);
  const session = buildSession();
  await sessions.saveSession(session);

  const memory = new FileBackedMemoryService({
    chatSessionRoot,
    embeddingRuntime: new EmbeddingRuntime([params.adapter], {
      defaultProvider: "lm_studio"
    }),
    retrieval: {
      candidateLimit: 12,
      chunkOverlapChars: 64,
      chunkTargetChars: 256,
      embeddingProvider: "lm_studio",
      embeddingsEnabled: true,
      ftsEnabled: true,
      hardFailOnStartup: true,
      mmrLambda: 0.7,
      retrievalLimit: 8,
      sqlitePath: path.join(stateRoot, "memory.sqlite")
    },
    sessions,
    stateRoot,
    userGlobalRoot,
    workspaceRoot
  });

  return {
    chatSessionRoot,
    memory,
    session,
    stateRoot,
    workspaceBase
  };
}

function buildSession(): SessionRecord {
  const now = "2026-03-27T18:00:00.000Z";
  return {
    createdAt: now,
    cwd: "/workspace",
    goal: "Exercise retrieval behavior.",
    id: "session.memory.retrieval.1",
    lastActiveAt: now,
    metadata: {},
    status: "running_model",
    tags: [],
    title: "Retrieval Session",
    updatedAt: now
  };
}

function buildTurn(sessionId: string, turnId: string): TurnRecord {
  return {
    approvalRequestIds: [],
    executedToolCallIds: [],
    id: turnId,
    inputMessageIds: [],
    metadata: {},
    outputMessageIds: [],
    requestedToolCallIds: [],
    sequence: 0,
    sessionId,
    startedAt: "2026-03-27T18:00:00.000Z",
    status: "running",
    trigger: "user" as const
  };
}

function createKeywordEmbeddingAdapter(params: { failOnQuery?: boolean; providerId?: string } = {}): EmbeddingAdapter {
  const providerId = params.providerId ?? "lm_studio";
  return {
    async createEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
      if (params.failOnQuery && request.id.startsWith("embedding.query.")) {
        throw new Error("query embeddings unavailable");
      }
      return {
        dimensions: 3,
        id: request.id,
        metadata: request.metadata,
        providerId,
        vectors: request.inputs.map((input) => keywordVector(input))
      };
    },
    async health(): Promise<ProviderHealth> {
      return {
        checkedAt: new Date().toISOString(),
        details: {
          modelCount: 1
        },
        providerId,
        status: "healthy"
      };
    },
    async listModels() {
      return [
        {
          displayName: "nomic-embed-text",
          modelId: "nomic-embed-text",
          providerId
        }
      ];
    },
    providerId
  };
}

function fts5IsAvailable(): boolean {
  const probe = new DatabaseSync(":memory:");
  try {
    probe.exec("CREATE VIRTUAL TABLE fts_probe USING fts5(content);");
    return true;
  } catch {
    return false;
  } finally {
    probe.close();
  }
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: {
      "content-type": "application/json"
    },
    status: 200
  });
}

function keywordVector(input: string): number[] {
  const text = input.toLowerCase();
  const progressScore = /(brief|concise|progress|status|operator)/.test(text) ? 1 : 0;
  const runtimeScore = /(typescript|node|esm|runtime)/.test(text) ? 1 : 0;
  const planningScore = /(plan|todo|task)/.test(text) ? 1 : 0;
  return [progressScore, runtimeScore, planningScore];
}

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-memory-retrieval-"));
  tempRoots.push(root);
  return root;
}
