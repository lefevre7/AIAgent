import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect } from "vitest";

import { createDefaultAppConfig, createMemoryServiceFromConfig, FileSessionStore } from "@/core";
import { createLiveTestHarness, envFlag } from "./helpers";

const liveProvider = process.env.AIA_LIVE_MEMORY_PROVIDER as "lm_studio" | "ollama" | undefined;
const liveBaseUrl = process.env.AIA_LIVE_MEMORY_BASE_URL;
const liveModel = process.env.AIA_LIVE_MEMORY_MODEL;

const { createTempRoot, liveTest } = createLiveTestHarness({
  enabled: envFlag("AIA_RUN_LIVE_MEMORY_TESTS") && Boolean(liveProvider && liveBaseUrl),
  prefix: "aiagent-live-memory-"
});

describe("live memory embeddings", () => {
  liveTest("indexes MEMORY.md and returns a searchable hit", async () => {
    const root = await createTempRoot();

    const userStateDirectory = path.join(root, "home", ".aia");
    const workspaceRoot = path.join(root, "workspace");
    const stateRoot = path.join(workspaceRoot, ".aia");
    const config = createDefaultAppConfig({
      userStateDirectory
    });
    config.memory.chatSessionRoot = path.join(workspaceRoot, "chat-session-memory");
    config.memory.sqlitePath = path.join(stateRoot, "memory.sqlite");
    config.memory.stateRoot = stateRoot;
    config.memory.userGlobalRoot = path.join(userStateDirectory, "memory");
    config.memory.workspaceRoot = path.join(workspaceRoot, "memory");
    config.memory.embeddingProvider = liveProvider!;
    config.memory.embeddingModel = liveModel;
    config.providers.lmStudio.enabled = liveProvider === "lm_studio";
    config.providers.ollama.enabled = liveProvider === "ollama";
    if (liveProvider === "lm_studio") {
      config.providers.lmStudio.baseUrl = liveBaseUrl!;
    } else {
      config.providers.ollama.baseUrl = liveBaseUrl!;
    }

    const sessions = new FileSessionStore(stateRoot);
    await fs.mkdir(workspaceRoot, { recursive: true });
    await fs.writeFile(
      path.join(workspaceRoot, "MEMORY.md"),
      "# Durable Memory\nThe live embedding test expects semantic retrieval to find this sentence.\n",
      "utf8"
    );

    const memory = await createMemoryServiceFromConfig({
      config,
      sessions
    });
    await memory.reindexMemory();

    const result = await memory.queryDetailed({
      includeKinds: [],
      limit: 5,
      minConfidence: 0,
      scopes: ["workspace", "session", "user_global"],
      text: "What sentence should semantic retrieval find in the live embedding test?"
    });

    expect(result.hits[0]?.entry.metadata.filePath).toBe("MEMORY.md");
    expect(result.hits[0]?.entry.content).toContain("live embedding test");
  });
});
