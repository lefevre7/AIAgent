import type {
  EmbeddingAdapter,
  EmbeddingModelDescriptor,
  EmbeddingRequest,
  EmbeddingResponse,
  ProviderHealth
} from "@/core/contracts";

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
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  providerId: "lm_studio";
  timeoutMs: number;
};

export class LMStudioEmbeddingAdapter implements EmbeddingAdapter {
  readonly providerId = "lm_studio" as const;

  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAICompatibleEmbeddingsAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async createEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/embeddings`, {
      body: JSON.stringify({
        input: request.inputs.length === 1 ? request.inputs[0] : request.inputs,
        model: request.modelId
      }),
      headers: {
        "content-type": "application/json",
        ...this.options.headers
      },
      method: "POST",
      signal: AbortSignal.timeout(this.options.timeoutMs)
    });

    if (!response.ok) {
      throw new Error(`LM Studio embeddings request failed with ${response.status}.`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const vectors = (payload.data ?? []).map((item) => item.embedding ?? []);
    const dimensions = vectors[0]?.length ?? 0;

    if (vectors.length === 0 || dimensions === 0) {
      throw new Error("LM Studio returned no embeddings.");
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
    try {
      const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/models`, {
        headers: this.options.headers,
        method: "GET",
        signal: AbortSignal.timeout(this.options.timeoutMs)
      });
      return {
        checkedAt: new Date().toISOString(),
        details: {
          statusCode: response.status
        },
        providerId: this.providerId,
        status: response.ok ? "healthy" : "degraded"
      };
    } catch (error) {
      return {
        checkedAt: new Date().toISOString(),
        details: {
          error: error instanceof Error ? error.message : String(error)
        },
        providerId: this.providerId,
        status: "unavailable"
      };
    }
  }

  async listModels(): Promise<EmbeddingModelDescriptor[]> {
    const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/models`, {
      headers: this.options.headers,
      method: "GET",
      signal: AbortSignal.timeout(this.options.timeoutMs)
    });

    if (!response.ok) {
      throw new Error(`LM Studio model listing failed with ${response.status}.`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ id?: string }>;
    };

    return (payload.data ?? [])
      .map((entry) => entry.id?.trim())
      .filter((modelId): modelId is string => Boolean(modelId))
      .map((modelId) => ({
        displayName: modelId,
        modelId,
        providerId: this.providerId
      }));
  }
}

type OllamaEmbeddingAdapterOptions = {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  providerId: "ollama";
  timeoutMs: number;
};

export class OllamaEmbeddingAdapter implements EmbeddingAdapter {
  readonly providerId = "ollama" as const;

  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OllamaEmbeddingAdapterOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async createEmbeddings(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/api/embed`, {
      body: JSON.stringify({
        input: request.inputs,
        model: request.modelId
      }),
      headers: {
        "content-type": "application/json",
        ...this.options.headers
      },
      method: "POST",
      signal: AbortSignal.timeout(this.options.timeoutMs)
    });

    if (!response.ok) {
      throw new Error(`Ollama embeddings request failed with ${response.status}.`);
    }

    const payload = (await response.json()) as {
      embeddings?: number[][];
    };
    const vectors = payload.embeddings ?? [];
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
    try {
      const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/api/tags`, {
        headers: this.options.headers,
        method: "GET",
        signal: AbortSignal.timeout(this.options.timeoutMs)
      });
      return {
        checkedAt: new Date().toISOString(),
        details: {
          statusCode: response.status
        },
        providerId: this.providerId,
        status: response.ok ? "healthy" : "degraded"
      };
    } catch (error) {
      return {
        checkedAt: new Date().toISOString(),
        details: {
          error: error instanceof Error ? error.message : String(error)
        },
        providerId: this.providerId,
        status: "unavailable"
      };
    }
  }

  async listModels(): Promise<EmbeddingModelDescriptor[]> {
    const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/api/tags`, {
      headers: this.options.headers,
      method: "GET",
      signal: AbortSignal.timeout(this.options.timeoutMs)
    });

    if (!response.ok) {
      throw new Error(`Ollama model listing failed with ${response.status}.`);
    }

    const payload = (await response.json()) as {
      models?: Array<{
        model?: string;
        name?: string;
      }>;
    };

    return (payload.models ?? [])
      .map((entry) => entry.model?.trim() || entry.name?.trim())
      .filter((modelId): modelId is string => Boolean(modelId))
      .map((modelId) => ({
        displayName: modelId,
        modelId,
        providerId: this.providerId
      }));
  }
}
