import type {
  LanguageModelCallOptions,
  LanguageModelAdapter,
  LanguageModelDescriptor,
  LanguageModelProvider,
  LanguageModelRequest,
  LanguageModelResponse,
  ProviderHealth
} from "@/core/contracts";
import type { AppConfig } from "@/core/config";
import { createBuiltInLanguageModelAdapters, resolveConfiguredModelId } from "@/core/lm/providers";
import {
  FileLanguageModelQueue,
  type LanguageModelExecutionQueue,
  type LanguageModelStreamSink
} from "@/core/lm/queue";

export type LanguageModelInvocation = Omit<LanguageModelRequest, "modelId" | "provider"> & {
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
  private readonly adapterSettings = new Map<LanguageModelProvider, { defaultModel?: string; enabled: boolean }>();
  private readonly queue: LanguageModelExecutionQueue;

  constructor(private readonly options: LanguageModelRuntimeOptions) {
    this.adapters = new Map<LanguageModelProvider, LanguageModelAdapter>();
    for (const registration of createBuiltInLanguageModelAdapters(options.config, options.fetchImpl)) {
      this.registerAdapter(registration);
    }
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
    request: LanguageModelInvocation,
    options: LanguageModelCallOptions = {}
  ): Promise<LanguageModelResponse> {
    return this.queue.execute(this.resolveRequest(request), options);
  }

  async stream(
    request: LanguageModelInvocation,
    onEvent: LanguageModelStreamSink,
    options: LanguageModelCallOptions = {}
  ): Promise<LanguageModelResponse> {
    const resolved = this.resolveRequest(request);
    return this.queue.stream ? this.queue.stream(resolved, onEvent, options) : this.queue.execute(resolved, options);
  }

  async close(): Promise<void> {
    await this.queue.close?.();
  }

  async health(provider: LanguageModelProvider = this.options.config.runtime.defaultProvider): Promise<ProviderHealth> {
    return this.getAdapter(provider).health();
  }

  async listJobs() {
    return this.queue.listJobs();
  }

  async listModels(provider?: LanguageModelProvider): Promise<LanguageModelDescriptor[]> {
    if (provider) {
      return this.getAdapter(provider).listModels();
    }

    const enabledProviders = Array.from(this.adapters.entries())
      .filter(([providerId]) => this.adapterSettings.get(providerId)?.enabled !== false)
      .map(([, adapter]) => adapter);
    // Every built-in provider is enabled by default and most machines run one
    // or two of them, so one that is not running must not hide the others'
    // models. Asking for a specific provider still reports its failure.
    const settled = await Promise.allSettled(enabledProviders.map(async (adapter) => adapter.listModels()));
    return settled.flatMap((outcome) => (outcome.status === "fulfilled" ? outcome.value : []));
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
      throw new Error(`No language-model adapter is registered for provider "${provider}".`);
    }
    return adapter;
  }

  /**
   * The model a turn asks `provider` for when the session names none. The
   * gateway's context-window lookup asks here too, so the window it reports is
   * the window of the model the turn actually gets.
   */
  resolveModelId(provider: LanguageModelProvider = this.options.config.runtime.defaultProvider): string | undefined {
    return resolveConfiguredModelId(this.options.config, provider, this.adapterSettings.get(provider)?.defaultModel);
  }

  resolveRequest(request: LanguageModelInvocation): LanguageModelRequest {
    const provider = request.provider ?? this.options.config.runtime.defaultProvider;
    const registration = this.adapterSettings.get(provider);
    if (!registration) {
      throw new Error(`No language-model adapter is registered for provider "${provider}".`);
    }
    if (!registration.enabled) {
      throw new Error(`Language-model provider "${provider}" is disabled in the current configuration.`);
    }

    const modelId = request.modelId ?? this.resolveModelId(provider);
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
