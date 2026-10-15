import { materializeSecretRecord, withBearerApiKey, type AppConfig, type SecretInput } from "@/core/config";
import type { LanguageModelAdapter } from "@/core/contracts";
import { LlamaCppLanguageModelAdapter } from "@/core/lm/llama-cpp";
import { LMStudioLanguageModelAdapter } from "@/core/lm/lm-studio";
import { OllamaLanguageModelAdapter } from "@/core/lm/ollama";
import {
  BUILT_IN_LANGUAGE_MODEL_PROVIDERS,
  isBuiltInLanguageModelProvider,
  type BuiltInLanguageModelProviderId
} from "@/core/lm/provider-table";

export * from "@/core/lm/provider-table";

/** The settings every built-in provider section has in common. */
export type BuiltInLanguageModelProviderConfig = {
  baseUrl: string;
  enabled: boolean;
  model?: string;
};

/** A built-in provider's config section, or undefined for a custom (SDK-registered) provider id. */
export function getBuiltInProviderConfig(
  config: AppConfig,
  providerId: string
): BuiltInLanguageModelProviderConfig | undefined {
  return isBuiltInLanguageModelProvider(providerId)
    ? config.providers[BUILT_IN_LANGUAGE_MODEL_PROVIDERS[providerId].configKey]
    : undefined;
}

/**
 * The model a turn asks a provider for when the session names none: a
 * registered adapter's own default (a built-in provider's `model`), else
 * `runtime.defaultModel` when this is the default provider. The runtime, the
 * CLI's provenance line, and the context-window lookup all use this, so they
 * cannot disagree about which model a turn will get.
 */
export function resolveConfiguredModelId(
  config: AppConfig,
  providerId: string,
  registeredDefaultModel?: string
): string | undefined {
  return (
    registeredDefaultModel ??
    getBuiltInProviderConfig(config, providerId)?.model ??
    (providerId === config.runtime.defaultProvider ? config.runtime.defaultModel : undefined)
  );
}

/** One adapter registration, as `LanguageModelRuntime` takes it. */
export type BuiltInLanguageModelAdapterRegistration = {
  adapter: LanguageModelAdapter;
  defaultModel?: string;
  enabled: boolean;
};

// Where a provider's settings live, so its errors can name the one to change.
function settingsPathOf(providerId: BuiltInLanguageModelProviderId): string {
  return `providers.${BUILT_IN_LANGUAGE_MODEL_PROVIDERS[providerId].configKey}`;
}

/**
 * The options every built-in chat adapter takes from its config section, in
 * one place: each provider's factory below adds only what is its own.
 */
function sharedAdapterOptions(config: AppConfig, providerId: BuiltInLanguageModelProviderId, fetchImpl?: typeof fetch) {
  const section = config.providers[BUILT_IN_LANGUAGE_MODEL_PROVIDERS[providerId].configKey];
  return {
    baseUrl: section.baseUrl,
    contextWindowRemedy: BUILT_IN_LANGUAGE_MODEL_PROVIDERS[providerId].contextWindowRemedy,
    fetchImpl,
    headers: buildProviderHeaders(config, providerId),
    maxRetries: section.maxRetries,
    providerId,
    settingsPath: settingsPathOf(providerId),
    streamFirstTokenTimeoutMs: section.streamFirstTokenTimeoutMs,
    streamIdleTimeoutMs: section.streamIdleTimeoutMs,
    timeoutMs: section.timeoutMs
  };
}

// Each built-in provider's chat adapter, in the order they are registered.
const CHAT_ADAPTER_FACTORIES: Array<
  [BuiltInLanguageModelProviderId, (config: AppConfig, fetchImpl?: typeof fetch) => LanguageModelAdapter]
> = [
  [
    "lm_studio",
    (config, fetchImpl) =>
      new LMStudioLanguageModelAdapter({
        ...sharedAdapterOptions(config, "lm_studio", fetchImpl),
        providerId: "lm_studio",
        requestExtras: config.providers.lmStudio.requestExtras
      })
  ],
  [
    "llama_cpp",
    (config, fetchImpl) =>
      new LlamaCppLanguageModelAdapter({
        ...sharedAdapterOptions(config, "llama_cpp", fetchImpl),
        providerId: "llama_cpp",
        requestExtras: config.providers.llamaCpp.requestExtras
      })
  ],
  [
    "ollama",
    (config, fetchImpl) =>
      new OllamaLanguageModelAdapter({
        ...sharedAdapterOptions(config, "ollama", fetchImpl),
        contextLength: config.providers.ollama.contextLength ?? config.runtime.modelSettings.contextWindowTokens,
        keepAlive: config.providers.ollama.keepAlive,
        providerId: "ollama"
      })
  ]
];

export function createBuiltInLanguageModelAdapters(
  config: AppConfig,
  fetchImpl?: typeof fetch
): BuiltInLanguageModelAdapterRegistration[] {
  return CHAT_ADAPTER_FACTORIES.map(([providerId, create]) => {
    const section = config.providers[BUILT_IN_LANGUAGE_MODEL_PROVIDERS[providerId].configKey];
    return { adapter: create(config, fetchImpl), defaultModel: section.model, enabled: section.enabled };
  });
}

/**
 * A built-in provider's headers, for its chat and embedding requests alike:
 * the configured ones, plus `Authorization: Bearer` for an `apiKey` (a
 * llama.cpp server started with --api-key) unless an Authorization header was
 * configured by hand, which wins.
 */
export function buildProviderHeaders(
  config: AppConfig,
  providerId: BuiltInLanguageModelProviderId
): Record<string, string> {
  const { configKey } = BUILT_IN_LANGUAGE_MODEL_PROVIDERS[providerId];
  const section: { apiKey?: SecretInput; headers: Record<string, SecretInput> } = config.providers[configKey];
  return withBearerApiKey(
    materializeSecretRecord(section.headers, `Provider "${configKey}"`, "header"),
    section.apiKey,
    `Provider "${configKey}"`
  );
}
