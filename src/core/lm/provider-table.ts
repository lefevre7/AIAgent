import type { AppConfig } from "@/core/config";

/**
 * The language-model providers that ship with aia, in one table.
 *
 * Code that needs a provider's settings, its name, or the model it defaults
 * to reads them here instead of branching on provider ids. Those branches used
 * to be spread over five files (`provider === "lm_studio" ? … : provider ===
 * "ollama" ? …`), and one of them handed every non-Ollama provider LM Studio's
 * model. Adding a provider is an entry here, its adapters, and their factories
 * in `providers.ts`. This module imports no adapter, so the adapters can read
 * their own names from it.
 */
export const BUILT_IN_LANGUAGE_MODEL_PROVIDERS = {
  llama_cpp: {
    configKey: "llamaCpp",
    // How to give the model a larger context window, for the message shown
    // when a prompt does not fit even after compacting.
    contextWindowRemedy: "Start llama-server with a larger context (-c)",
    displayName: "llama.cpp"
  },
  lm_studio: {
    configKey: "lmStudio",
    contextWindowRemedy: "Load the model in LM Studio with a larger context length",
    displayName: "LM Studio"
  },
  ollama: {
    configKey: "ollama",
    contextWindowRemedy: "Raise providers.ollama.contextLength (Ollama's num_ctx)",
    displayName: "Ollama"
  }
} as const satisfies Record<
  string,
  { configKey: keyof AppConfig["providers"]; contextWindowRemedy: string; displayName: string }
>;

export type BuiltInLanguageModelProviderId = keyof typeof BUILT_IN_LANGUAGE_MODEL_PROVIDERS;

export function isBuiltInLanguageModelProvider(providerId: string): providerId is BuiltInLanguageModelProviderId {
  return Object.hasOwn(BUILT_IN_LANGUAGE_MODEL_PROVIDERS, providerId);
}
