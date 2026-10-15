import type { JsonValue, LanguageModelDescriptor, ProviderHealth } from "@/core/contracts";
import { fetchJson, normalizeUnknownProviderError } from "@/core/lm/http";
import { BUILT_IN_LANGUAGE_MODEL_PROVIDERS } from "@/core/lm/provider-table";
import { OpenAICompatibleChatAdapter, type OpenAICompatibleAdapterOptions } from "@/core/lm/openai-compatible";

export type LlamaCppAdapterOptions = OpenAICompatibleAdapterOptions;

// One entry of llama-server's /v1/models. `meta` describes a model that is
// running; in router mode `status.value` says whether it is (loaded,
// loading, unloaded, sleeping, downloading…) and `meta` is present only
// while it runs.
type LlamaCppModelEntry = {
  aliases?: string[];
  id: string;
  meta?: {
    n_ctx?: number;
    n_ctx_train?: number;
  };
  status?: {
    value?: string;
  };
};

/**
 * llama.cpp's `llama-server`, single-model or router mode.
 *
 * It speaks the OpenAI Chat Completions protocol (the shared adapter does all
 * of that), and differs in three places: `/health` says "Loading model" with a
 * 503 while a model loads, the loaded context window is read from `/v1/models`
 * (or `/props`) because `--fit` can shrink it below the model's training
 * context, and in router mode `/v1/models` lists every model the router knows,
 * loaded or not.
 */
export class LlamaCppLanguageModelAdapter extends OpenAICompatibleChatAdapter {
  readonly provider = "llama_cpp" as const;
  protected readonly displayName = BUILT_IN_LANGUAGE_MODEL_PROVIDERS.llama_cpp.displayName;

  constructor(options: LlamaCppAdapterOptions) {
    super(options, "llama_cpp");
  }

  /**
   * `/health` needs no API key, so it answers even when the key is wrong, and
   * it is the only endpoint that distinguishes "still loading" from "down".
   * Loading is `degraded`: the server is up and a request will be waited on.
   */
  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      await fetchJson<{ status?: string }>({
        fetchImpl: this.options.fetchImpl,
        headers: this.options.headers,
        maxAttempts: 1,
        timeoutMs: Math.min(this.options.timeoutMs, 5_000),
        url: `${this.origin}/health`
      });
      return {
        checkedAt,
        details: { baseUrl: this.options.baseUrl },
        providerId: this.providerId,
        status: "healthy"
      };
    } catch (error) {
      const normalized = normalizeUnknownProviderError(error);
      if (normalized.details.status === 503) {
        return {
          checkedAt,
          details: {
            baseUrl: this.options.baseUrl,
            error: normalized.message,
            loading: true
          },
          providerId: this.providerId,
          status: "degraded"
        };
      }
      return {
        checkedAt,
        details: { baseUrl: this.options.baseUrl, error: normalized.message },
        providerId: this.providerId,
        status: "unavailable"
      };
    }
  }

  async listModels(): Promise<LanguageModelDescriptor[]> {
    const entries = await this.fetchModelEntries(2);
    return entries.map((entry) => {
      const contextWindow = positive(entry.meta?.n_ctx);
      const status = entry.status?.value;
      return {
        ...(contextWindow ? { contextWindow } : {}),
        // Router mode knows models it has not loaded; say which is which.
        displayName: status && status !== "loaded" ? `${entry.id} (${status})` : entry.id,
        modelId: entry.id,
        provider: this.provider,
        toolCalling: true
      };
    });
  }

  /**
   * The window a request actually gets: the per-slot `n_ctx`, which is what
   * `--ctx-size`, `--parallel`, and `--fit` left of the training context. Read
   * from `/v1/models` first because it has no side effects in router mode
   * (`/props?model=…` would load the model), then `/props` for a single-model
   * server that reports no `meta`. Best effort, like the other adapters.
   */
  async getModelContextWindow(modelId: string): Promise<number | undefined> {
    try {
      const entries = await this.fetchModelEntries(1);
      const running = entries.filter((entry) => positive(entry.meta?.n_ctx));
      const match =
        entries.find((entry) => entry.id === modelId || entry.aliases?.includes(modelId)) ??
        // A single-model server answers whatever `model` a request names.
        (running.length === 1 ? running[0] : undefined);
      const fromModels = positive(match?.meta?.n_ctx);
      if (fromModels) {
        return fromModels;
      }

      const props = await fetchJson<{ default_generation_settings?: { n_ctx?: number } }>({
        fetchImpl: this.options.fetchImpl,
        headers: this.options.headers,
        maxAttempts: 1,
        timeoutMs: Math.min(this.options.timeoutMs, 5_000),
        url: `${this.origin}/props`
      });
      // A router answers /props for itself with n_ctx 0.
      return positive(props.data?.default_generation_settings?.n_ctx);
    } catch {
      return undefined;
    }
  }

  /**
   * Prompt caching reuses the longest prefix of the previous prompt in the
   * slot, which is what keeps a long agent conversation from being
   * re-evaluated from scratch every turn. It is the server's default too;
   * sending it keeps it on when a server was started with it off, and
   * `requestExtras` can still turn it off.
   */
  protected payloadDefaults(): Record<string, JsonValue> {
    return { cache_prompt: true };
  }

  private async fetchModelEntries(maxAttempts: number): Promise<LlamaCppModelEntry[]> {
    const response = await fetchJson<{ data?: LlamaCppModelEntry[] }>({
      fetchImpl: this.options.fetchImpl,
      headers: this.options.headers,
      maxAttempts,
      timeoutMs: Math.min(this.options.timeoutMs, maxAttempts === 1 ? 5_000 : this.options.timeoutMs),
      url: this.buildUrl("models")
    });
    return (response.data?.data ?? []).filter((entry) => typeof entry?.id === "string" && entry.id.length > 0);
  }
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}
