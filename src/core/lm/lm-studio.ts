import { fetchJson } from "@/core/lm/http";
import { BUILT_IN_LANGUAGE_MODEL_PROVIDERS } from "@/core/lm/provider-table";
import { OpenAICompatibleChatAdapter, type OpenAICompatibleAdapterOptions } from "@/core/lm/openai-compatible";

export type LMStudioAdapterOptions = OpenAICompatibleAdapterOptions;

/**
 * LM Studio speaks the OpenAI Chat Completions protocol (shared with
 * llama.cpp in `OpenAICompatibleChatAdapter`); what it adds is a native REST
 * API that reports the context window a model is actually loaded with.
 */
export class LMStudioLanguageModelAdapter extends OpenAICompatibleChatAdapter {
  readonly provider = "lm_studio" as const;
  protected readonly displayName = BUILT_IN_LANGUAGE_MODEL_PROVIDERS.lm_studio.displayName;

  constructor(options: LMStudioAdapterOptions) {
    super(options, "lm_studio");
  }

  // The OpenAI-compatible /v1/models endpoint does not report context length, but
  // LM Studio's native REST API (/api/v0/models) exposes `loaded_context_length`
  // (the actual window the model is loaded with) and `max_context_length`.
  //
  // Only the requested model's own loaded window counts. Until it is loaded (LM
  // Studio loads it on the first request) the window it will get is unknown, so
  // this returns undefined and the caller's defaults apply until it asks again.
  // Another model's window is used only when the configured id matches nothing
  // listed (an alias), and then only a loaded chat model's: falling back to any
  // loaded model once picked the embedding model's 2048 tokens, so the session
  // compacted after every turn and lost the operator's request. Best effort:
  // undefined on any failure.
  async getModelContextWindow(modelId: string): Promise<number | undefined> {
    try {
      const response = await fetchJson<{ data?: LMStudioModelEntry[] }>({
        fetchImpl: this.options.fetchImpl,
        headers: this.options.headers,
        maxAttempts: 1,
        timeoutMs: Math.min(this.options.timeoutMs, 5_000),
        url: `${this.origin}/api/v0/models`
      });
      const entries = response.data?.data ?? [];
      const requested = entries.find((entry) => entry.id === modelId);
      if (requested) {
        return loadedContextWindow(requested);
      }
      return entries.map((entry) => (isChatModel(entry) ? loadedContextWindow(entry) : undefined)).find(Boolean);
    } catch {
      return undefined;
    }
  }
}

type LMStudioModelEntry = {
  id?: string;
  loaded_context_length?: number;
  max_context_length?: number;
  state?: string;
  type?: string;
};

// A server too old to report `loaded_context_length` still says which models are
// loaded; for those, the model's own maximum is the best figure there is.
function loadedContextWindow(entry: LMStudioModelEntry): number | undefined {
  return entry.loaded_context_length ?? (entry.state === "loaded" ? entry.max_context_length : undefined);
}

// LM Studio lists embedding models beside chat models ("llm", or "vlm" for one
// that also takes images).
function isChatModel(entry: LMStudioModelEntry): boolean {
  return entry.type === undefined || entry.type === "llm" || entry.type === "vlm";
}
