import type { EmbeddingAdapter } from "@/core/contracts";
import type { AppConfig } from "@/core/config";
import { EmbeddingRuntime, LMStudioEmbeddingAdapter, OllamaEmbeddingAdapter } from "@/core/memory/embeddings";
import { FileBackedMemoryService } from "@/core/memory/service";
import type { FileSessionStore } from "@/core/sessions";

type MemoryServiceFactoryOptions = {
  config: AppConfig;
  embeddingAdapters?: EmbeddingAdapter[];
  fetchImpl?: typeof fetch;
  initialize?: boolean;
  sessions: FileSessionStore;
};

export async function createMemoryServiceFromConfig(
  options: MemoryServiceFactoryOptions
): Promise<FileBackedMemoryService> {
  const memoryConfig = options.config.memory;
  const embeddingRuntime = createEmbeddingRuntimeFromConfig({
    adapters: options.embeddingAdapters,
    config: options.config,
    fetchImpl: options.fetchImpl
  });

  const service = new FileBackedMemoryService({
    chatSessionRoot: memoryConfig.chatSessionRoot,
    embeddingRuntime,
    extraPaths: memoryConfig.extraPaths,
    includeSessionSummaries: memoryConfig.includeSessionSummaries,
    retrieval: {
      candidateLimit: memoryConfig.candidateLimit,
      chunkOverlapChars: memoryConfig.chunkOverlapChars,
      chunkTargetChars: memoryConfig.chunkTargetChars,
      embeddingModel: memoryConfig.embeddingModel,
      embeddingProvider: memoryConfig.embeddingProvider,
      embeddingsEnabled: memoryConfig.embeddingsEnabled,
      ftsEnabled: memoryConfig.ftsEnabled,
      hardFailOnStartup: memoryConfig.hardFailOnStartup,
      mmrLambda: memoryConfig.mmrLambda,
      retrievalLimit: memoryConfig.retrievalLimit,
      sqlitePath: memoryConfig.sqlitePath
    },
    sessions: options.sessions,
    stateRoot: memoryConfig.stateRoot,
    userGlobalRoot: memoryConfig.userGlobalRoot,
    workspaceRoot: memoryConfig.workspaceRoot
  });

  if (options.initialize ?? true) {
    await service.initializeRetrieval();
  }

  return service;
}

export function createEmbeddingRuntimeFromConfig(params: {
  adapters?: EmbeddingAdapter[];
  config: AppConfig;
  fetchImpl?: typeof fetch;
}): EmbeddingRuntime | undefined {
  if (!params.config.memory.embeddingsEnabled) {
    return undefined;
  }

  const adapters: EmbeddingAdapter[] = [];
  if (params.config.providers.lmStudio.enabled) {
    adapters.push(
      new LMStudioEmbeddingAdapter({
        baseUrl: params.config.providers.lmStudio.baseUrl,
        fetchImpl: params.fetchImpl,
        headers: materializeHeaders(params.config.providers.lmStudio.headers, "lmStudio"),
        providerId: "lm_studio",
        timeoutMs: params.config.providers.lmStudio.timeoutMs
      })
    );
  }
  if (params.config.providers.ollama.enabled) {
    adapters.push(
      new OllamaEmbeddingAdapter({
        baseUrl: params.config.providers.ollama.baseUrl,
        fetchImpl: params.fetchImpl,
        headers: materializeHeaders(params.config.providers.ollama.headers, "ollama"),
        providerId: "ollama",
        timeoutMs: params.config.providers.ollama.timeoutMs
      })
    );
  }

  for (const adapter of params.adapters ?? []) {
    adapters.push(adapter);
  }

  if (adapters.length === 0) {
    throw new Error("Memory embeddings are enabled, but no embedding-capable providers are enabled.");
  }

  return new EmbeddingRuntime(adapters, {
    defaultProvider: params.config.memory.embeddingProvider
  });
}

function materializeHeaders(
  headers: Record<string, string | { id: string; provider?: string; source: string }>,
  label: string
) {
  const resolvedEntries = Object.entries(headers).map(([key, value]) => {
    if (typeof value !== "string") {
      throw new Error(
        `Provider "${label}" has unresolved secret-backed header "${key}". Use resolvedConfig when creating the memory service.`
      );
    }

    return [key, value] as const;
  });

  return Object.fromEntries(resolvedEntries);
}
