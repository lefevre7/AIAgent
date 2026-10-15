import type {
  EmbeddingAdapter,
  EmbeddingModelDescriptor,
  EmbeddingRequest,
  EmbeddingResponse,
  ProviderHealth
} from "@/core/contracts";
import { fetchFollowingSameOriginRedirects } from "@/core/io/http";
import { fetchJson, providerMaxAttempts } from "@/core/lm/http";
import { BUILT_IN_LANGUAGE_MODEL_PROVIDERS } from "@/core/lm/provider-table";

type EmbeddingRuntimeOptions = {
  defaultProvider: string;
};

export type EmbeddingRuntimeRequest = Omit<EmbeddingRequest, "providerId"> & {
  providerId?: string;
};

export type EmbeddingAdapterRegistration = {
  adapter: EmbeddingAdapter;
  defaultModel?: string;
  makeDefault?: boolean;
};

export class EmbeddingRuntime {
  private readonly adapters = new Map<string, EmbeddingAdapter>();

  constructor(
    adapters: EmbeddingAdapter[],
    private readonly options: EmbeddingRuntimeOptions
  ) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.providerId, adapter);
    }
  }

  async createEmbeddings(request: EmbeddingRuntimeRequest): Promise<EmbeddingResponse> {
    const providerId = request.providerId ?? this.options.defaultProvider;
    const adapter = this.getAdapter(providerId);
    return adapter.createEmbeddings({
      ...request,
      providerId
    });
  }

  async health(providerId?: string): Promise<ProviderHealth> {
    return this.getAdapter(providerId ?? this.options.defaultProvider).health();
  }

  async listModels(providerId?: string): Promise<EmbeddingModelDescriptor[]> {
    const adapter = this.getAdapter(providerId ?? this.options.defaultProvider);
    if (!adapter.listModels) {
      throw new Error(`Provider "${adapter.providerId}" does not support embedding model discovery.`);
    }
    return adapter.listModels();
  }

  registerAdapter(adapter: EmbeddingAdapter): void {
    this.adapters.set(adapter.providerId, adapter);
  }

  setDefaultProvider(providerId: string): void {
    this.getAdapter(providerId);
    this.options.defaultProvider = providerId;
  }

  getAdapter(providerId: string): EmbeddingAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      throw new Error(`No embedding adapter is registered for provider "${providerId}".`);
    }
    return adapter;
  }
}

type OpenAICompatibleEmbeddingsAdapterOptions = {
  baseUrl: string;
  /** How the server is named in errors. */
  displayName: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  /** Retries after the first attempt, as for the provider's chat requests. */
  maxRetries?: number;
  providerId: string;
  timeoutMs: number;
};

/**
 * An embeddings server is called the way the same server's chat requests are
 * (`fetchJson`): retried with backoff and Retry-After, redirected only within
 * its own origin (a custom key header would follow a redirect anywhere), and
 * a llama.cpp server's 503 "Loading model" waited out for up to `timeoutMs`
 * rather than failing at once.
 */
async function postEmbeddings<T>(params: {
  body: unknown;
  fetchImpl: typeof fetch | undefined;
  headers: Record<string, string> | undefined;
  maxRetries: number | undefined;
  timeoutMs: number;
  url: string;
}): Promise<T> {
  const response = await fetchJson<T>({
    body: params.body,
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
    ...(params.headers ? { headers: params.headers } : {}),
    maxAttempts: providerMaxAttempts(params.maxRetries),
    retryUnavailableForMs: params.timeoutMs,
    timeoutMs: params.timeoutMs,
    url: params.url
  });
  return response.data;
}

async function getModelListing<T>(params: {
  fetchImpl: typeof fetch | undefined;
  headers: Record<string, string> | undefined;
  timeoutMs: number;
  url: string;
}): Promise<T> {
  const response = await fetchJson<T>({
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
    ...(params.headers ? { headers: params.headers } : {}),
    maxAttempts: 1,
    timeoutMs: params.timeoutMs,
    url: params.url
  });
  return response.data;
}

async function checkEmbeddingsHealth(params: {
  displayName: string;
  fetchImpl: typeof fetch | undefined;
  headers: Record<string, string> | undefined;
  providerId: string;
  timeoutMs: number;
  url: string;
}): Promise<ProviderHealth> {
  try {
    const response = await fetchFollowingSameOriginRedirects({
      fetchImpl: params.fetchImpl ?? fetch,
      init: {
        ...(params.headers ? { headers: params.headers } : {}),
        method: "GET",
        signal: AbortSignal.timeout(params.timeoutMs)
      },
      label: params.displayName,
      url: params.url
    });
    await response.body?.cancel().catch(() => undefined);
    return {
      checkedAt: new Date().toISOString(),
      details: {
        statusCode: response.status
      },
      providerId: params.providerId,
      status: response.ok ? "healthy" : "degraded"
    };
  } catch (error) {
    return {
      checkedAt: new Date().toISOString(),
      details: {
        error: error instanceof Error ? error.message : String(error)
      },
      providerId: params.providerId,
      status: "unavailable"
    };
  }
}

/**
 * Embeddings over the OpenAI `/embeddings` endpoint, shared by every server
 * that speaks it (LM Studio, llama.cpp started with --embeddings).
 */
export class OpenAICompatibleEmbeddingAdapter implements EmbeddingAdapter {
  readonly providerId: string;

  constructor(private readonly options: OpenAICompatibleEmbeddingsAdapterOptions) {
    this.providerId = options.providerId;
  }

  async createEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const payload = await postEmbeddings<{ data?: Array<{ embedding?: number[] }> } | null>({
      body: {
        input: request.inputs.length === 1 ? request.inputs[0] : request.inputs,
        model: request.modelId
      },
      fetchImpl: this.options.fetchImpl,
      headers: this.options.headers,
      maxRetries: this.options.maxRetries,
      timeoutMs: this.options.timeoutMs,
      url: this.url("embeddings")
    });
    const vectors = (payload?.data ?? []).map((item) => item.embedding ?? []);
    const dimensions = vectors[0]?.length ?? 0;

    if (vectors.length === 0 || dimensions === 0) {
      throw new Error(`${this.options.displayName} returned no embeddings.`);
    }

    return {
      dimensions,
      id: request.id,
      metadata: request.metadata,
      providerId: this.providerId,
      vectors
    };
  }

  async health(): Promise<ProviderHealth> {
    return checkEmbeddingsHealth({
      displayName: this.options.displayName,
      fetchImpl: this.options.fetchImpl,
      headers: this.options.headers,
      providerId: this.providerId,
      timeoutMs: this.options.timeoutMs,
      url: this.url("models")
    });
  }

  async listModels(): Promise<EmbeddingModelDescriptor[]> {
    const payload = await getModelListing<{ data?: Array<{ id?: string }> } | null>({
      fetchImpl: this.options.fetchImpl,
      headers: this.options.headers,
      timeoutMs: this.options.timeoutMs,
      url: this.url("models")
    });

    return (payload?.data ?? [])
      .map((entry) => entry.id?.trim())
      .filter((modelId): modelId is string => Boolean(modelId))
      .map((modelId) => ({
        displayName: modelId,
        modelId,
        providerId: this.providerId
      }));
  }

  private url(endpoint: string): string {
    return `${this.options.baseUrl.replace(/\/$/, "")}/${endpoint}`;
  }
}

/** LM Studio's embeddings; the shared adapter under its own provider id. */
export class LMStudioEmbeddingAdapter extends OpenAICompatibleEmbeddingAdapter {
  constructor(
    options: Omit<OpenAICompatibleEmbeddingsAdapterOptions, "displayName" | "providerId"> & { providerId?: "lm_studio" }
  ) {
    super({
      ...options,
      displayName: BUILT_IN_LANGUAGE_MODEL_PROVIDERS.lm_studio.displayName,
      providerId: "lm_studio"
    });
  }
}

type OllamaEmbeddingAdapterOptions = {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  /** Retries after the first attempt, as for the provider's chat requests. */
  maxRetries?: number;
  providerId: "ollama";
  timeoutMs: number;
};

export class OllamaEmbeddingAdapter implements EmbeddingAdapter {
  readonly providerId = "ollama" as const;

  constructor(private readonly options: OllamaEmbeddingAdapterOptions) {}

  async createEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const payload = await postEmbeddings<{ embeddings?: number[][] } | null>({
      body: {
        input: request.inputs,
        model: request.modelId
      },
      fetchImpl: this.options.fetchImpl,
      headers: this.options.headers,
      maxRetries: this.options.maxRetries,
      timeoutMs: this.options.timeoutMs,
      url: this.url("api/embed")
    });
    const vectors = payload?.embeddings ?? [];
    const dimensions = vectors[0]?.length ?? 0;

    if (vectors.length === 0 || dimensions === 0) {
      throw new Error("Ollama returned no embeddings.");
    }

    return {
      dimensions,
      id: request.id,
      metadata: request.metadata,
      providerId: this.providerId,
      vectors
    };
  }

  async health(): Promise<ProviderHealth> {
    return checkEmbeddingsHealth({
      displayName: BUILT_IN_LANGUAGE_MODEL_PROVIDERS.ollama.displayName,
      fetchImpl: this.options.fetchImpl,
      headers: this.options.headers,
      providerId: this.providerId,
      timeoutMs: this.options.timeoutMs,
      url: this.url("api/tags")
    });
  }

  async listModels(): Promise<EmbeddingModelDescriptor[]> {
    const payload = await getModelListing<{ models?: Array<{ model?: string; name?: string }> } | null>({
      fetchImpl: this.options.fetchImpl,
      headers: this.options.headers,
      timeoutMs: this.options.timeoutMs,
      url: this.url("api/tags")
    });

    return (payload?.models ?? [])
      .map((entry) => entry.model?.trim() || entry.name?.trim())
      .filter((modelId): modelId is string => Boolean(modelId))
      .map((modelId) => ({
        displayName: modelId,
        modelId,
        providerId: this.providerId
      }));
  }

  private url(endpoint: string): string {
    return `${this.options.baseUrl.replace(/\/$/, "")}/${endpoint}`;
  }
}
