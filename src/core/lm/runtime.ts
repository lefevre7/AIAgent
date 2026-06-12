import type {
  LanguageModelAdapter,
  LanguageModelDescriptor,
  LanguageModelProvider,
  LanguageModelRequest,
  LanguageModelResponse,
  ProviderHealth
} from "@/core/contracts";
import type { AppConfig } from "@/core/config";
import {
  FileLanguageModelQueue,
  type LanguageModelExecutionQueue,
  type LanguageModelStreamSink
} from "@/core/lm/queue";
import { LMStudioLanguageModelAdapter } from "@/core/lm/lm-studio";
import { OllamaLanguageModelAdapter } from "@/core/lm/ollama";

export type LanguageModelInvocation = Omit<
  LanguageModelRequest,
  "modelId" | "provider"
> & {
  modelId?: string;
  provider?: LanguageModelProvider;
};

export type LanguageModelAdapterRegistration = {
  adapter: LanguageModelAdapter;
  defaultModel?: string;
  enabled?: boolean;
};

type LanguageModelRuntimeOptions = {
  adapters?: LanguageModelAdapterRegistration[];
  config: AppConfig;
  fetchImpl?: typeof fetch;
  queue?: LanguageModelExecutionQueue;
};

export class LanguageModelRuntime {
  private readonly adapters: Map<LanguageModelProvider, LanguageModelAdapter>;
  private readonly adapterSettings = new Map<
    LanguageModelProvider,
    { defaultModel?: string; enabled: boolean }
  >();
  private readonly queue: LanguageModelExecutionQueue;

  constructor(private readonly options: LanguageModelRuntimeOptions) {
    this.adapters = new Map<LanguageModelProvider, LanguageModelAdapter>();
    this.registerAdapter({
      adapter: new LMStudioLanguageModelAdapter({
        baseUrl: options.config.providers.lmStudio.baseUrl,
        fetchImpl: options.fetchImpl,
        headers: materializeHeaders(
          options.config.providers.lmStudio.headers,
          "lmStudio"
        ),
        providerId: "lm_studio",
        streamIdleTimeoutMs:
          options.config.providers.lmStudio.streamIdleTimeoutMs,
        timeoutMs: options.config.providers.lmStudio.timeoutMs
      }),
      defaultModel: options.config.providers.lmStudio.model,
      enabled: options.config.providers.lmStudio.enabled
    });
    this.registerAdapter({
      adapter: new OllamaLanguageModelAdapter({
        baseUrl: options.config.providers.ollama.baseUrl,
        contextLength:
          options.config.providers.ollama.contextLength ??
          options.config.runtime.modelSettings.contextWindowTokens,
        fetchImpl: options.fetchImpl,
        headers: materializeHeaders(
          options.config.providers.ollama.headers,
          "ollama"
        ),
        keepAlive: options.config.providers.ollama.keepAlive,
        providerId: "ollama",
        streamIdleTimeoutMs:
          options.config.providers.ollama.streamIdleTimeoutMs,
        timeoutMs: options.config.providers.ollama.timeoutMs
      }),
      defaultModel: options.config.providers.ollama.model,
      enabled: options.config.providers.ollama.enabled
    });
    for (const registration of options.adapters ?? []) {
      this.registerAdapter(registration);
    }

    this.queue =
      options.queue ??
      new FileLanguageModelQueue({
        resolveAdapter: (provider) => this.getAdapter(provider),
        stateRoot: options.config.memory.stateRoot
      });
  }

  async generate(
    request: LanguageModelInvocation
  ): Promise<LanguageModelResponse> {
    return this.queue.execute(this.resolveRequest(request));
  }

  async stream(
    request: LanguageModelInvocation,
    onEvent: LanguageModelStreamSink
  ): Promise<LanguageModelResponse> {
    const resolved = this.resolveRequest(request);
    return this.queue.stream
      ? this.queue.stream(resolved, onEvent)
      : this.queue.execute(resolved);
  }

  async close(): Promise<void> {
    await this.queue.close?.();
  }

  async health(
    provider: LanguageModelProvider = this.options.config.runtime
      .defaultProvider
  ): Promise<ProviderHealth> {
    return this.getAdapter(provider).health();
  }

  async listJobs() {
    return this.queue.listJobs();
  }

  async listModels(
    provider?: LanguageModelProvider
  ): Promise<LanguageModelDescriptor[]> {
    if (provider) {
      return this.getAdapter(provider).listModels();
    }

    const enabledProviders = Array.from(this.adapters.entries())
      .filter(
        ([providerId]) =>
          this.adapterSettings.get(providerId)?.enabled !== false
      )
      .map(([, adapter]) => adapter);
    const descriptors = await Promise.all(
      enabledProviders.map(async (adapter) => adapter.listModels())
    );
    return descriptors.flat();
  }

  registerAdapter(registration: LanguageModelAdapterRegistration): void {
    const providerId = registration.adapter.providerId as LanguageModelProvider;
    this.adapters.set(providerId, registration.adapter);
    this.adapterSettings.set(providerId, {
      defaultModel: registration.defaultModel,
      enabled: registration.enabled ?? true
    });
  }

  setProviderEnabled(provider: LanguageModelProvider, enabled: boolean): void {
    this.getAdapter(provider);
    const existing = this.adapterSettings.get(provider) ?? {
      enabled: true
    };
    this.adapterSettings.set(provider, {
      ...existing,
      enabled
    });
  }

  getAdapter(provider: LanguageModelProvider): LanguageModelAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(
        `No language-model adapter is registered for provider "${provider}".`
      );
    }
    return adapter;
  }

  resolveRequest(request: LanguageModelInvocation): LanguageModelRequest {
    const provider =
      request.provider ?? this.options.config.runtime.defaultProvider;
    const registration = this.adapterSettings.get(provider);
    if (!registration) {
      throw new Error(
        `No language-model adapter is registered for provider "${provider}".`
      );
    }
    if (!registration.enabled) {
      throw new Error(
        `Language-model provider "${provider}" is disabled in the current configuration.`
      );
    }

    const builtInDefaultModel =
      provider === "lm_studio"
        ? this.options.config.providers.lmStudio.model
        : provider === "ollama"
          ? this.options.config.providers.ollama.model
          : undefined;
    const configuredDefaultModel =
      provider === this.options.config.runtime.defaultProvider
        ? this.options.config.runtime.defaultModel
        : undefined;
    const modelId =
      request.modelId ??
      registration.defaultModel ??
      builtInDefaultModel ??
      configuredDefaultModel;
    if (!modelId) {
      throw new Error(
        `No default model is configured for provider "${provider}". Pass modelId explicitly or register a default model.`
      );
    }

    return {
      ...request,
      modelId,
      provider
    };
  }
}

function materializeHeaders(
  headers: Record<
    string,
    string | { id: string; provider?: string; source: string }
  >,
  label: string
) {
  const resolvedEntries = Object.entries(headers).map(([key, value]) => {
    if (typeof value !== "string") {
      throw new Error(
        `Provider "${label}" has unresolved secret-backed header "${key}". Use resolvedConfig when creating the runtime.`
      );
    }

    return [key, value] as const;
  });

  return Object.fromEntries(resolvedEntries);
}
