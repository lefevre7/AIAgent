import type { EmbeddingAdapter } from "@/core/contracts";
import type { AppConfig } from "@/core/config";
import {
  BUILT_IN_LANGUAGE_MODEL_PROVIDERS,
  buildProviderHeaders,
  type BuiltInLanguageModelProviderId
} from "@/core/lm/providers";
import {
  EmbeddingRuntime,
  LMStudioEmbeddingAdapter,
  OllamaEmbeddingAdapter,
  OpenAICompatibleEmbeddingAdapter
} from "@/core/memory/embeddings";
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

/** What every built-in embeddings adapter takes from its provider's config section. */
function sharedEmbeddingOptions(
  config: AppConfig,
  providerId: BuiltInLanguageModelProviderId,
  fetchImpl?: typeof fetch
) {
  const section = config.providers[BUILT_IN_LANGUAGE_MODEL_PROVIDERS[providerId].configKey];
  return {
    baseUrl: section.baseUrl,
    fetchImpl,
    headers: buildProviderHeaders(config, providerId),
    ...(section.maxRetries !== undefined ? { maxRetries: section.maxRetries } : {}),
    timeoutMs: section.timeoutMs
  };
}

// Each built-in provider's embeddings adapter, built from the same section
// (and headers) as its chat adapter.
const EMBEDDING_ADAPTER_FACTORIES: Array<
  [BuiltInLanguageModelProviderId, (config: AppConfig, fetchImpl?: typeof fetch) => EmbeddingAdapter]
> = [
  [
    "lm_studio",
    (config, fetchImpl) =>
      new LMStudioEmbeddingAdapter({
        ...sharedEmbeddingOptions(config, "lm_studio", fetchImpl),
        providerId: "lm_studio"
      })
  ],
  [
    "llama_cpp",
    (config, fetchImpl) =>
      new OpenAICompatibleEmbeddingAdapter({
        ...sharedEmbeddingOptions(config, "llama_cpp", fetchImpl),
        // `/v1/embeddings` needs a server started with --embeddings and an
        // embedding model, usually not the chat server.
        baseUrl: config.providers.llamaCpp.embeddingsBaseUrl ?? config.providers.llamaCpp.baseUrl,
        displayName: BUILT_IN_LANGUAGE_MODEL_PROVIDERS.llama_cpp.displayName,
        providerId: "llama_cpp"
      })
  ],
  [
    "ollama",
    (config, fetchImpl) =>
      new OllamaEmbeddingAdapter({ ...sharedEmbeddingOptions(config, "ollama", fetchImpl), providerId: "ollama" })
  ]
];

export function createEmbeddingRuntimeFromConfig(params: {
  adapters?: EmbeddingAdapter[];
  config: AppConfig;
  fetchImpl?: typeof fetch;
}): EmbeddingRuntime | undefined {
  if (!params.config.memory.embeddingsEnabled) {
    return undefined;
  }

  const adapters: EmbeddingAdapter[] = EMBEDDING_ADAPTER_FACTORIES.flatMap(([providerId, create]) =>
    params.config.providers[BUILT_IN_LANGUAGE_MODEL_PROVIDERS[providerId].configKey].enabled
      ? [create(params.config, params.fetchImpl)]
      : []
  );
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
