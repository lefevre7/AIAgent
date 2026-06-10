import type {
  AppConfig,
  ImageProviderConfig
} from "@/core/config/schema";
import type {
  ImageGenerationAdapter,
  ImageGenerationInput,
  ImageGenerationResult,
  ImageModelDescriptor,
  ImageService,
  ProviderHealth
} from "@/core/contracts";
import { imageGenerationRequestSchema } from "@/core/contracts";
import { ComfyUIImageGenerationAdapter } from "@/core/image/comfyui";
import { createImageError } from "@/core/image/utils";

export type FileImageServiceOptions = {
  adapters: ImageGenerationAdapter[];
  config: AppConfig["image"];
  providerConfigs?: Record<string, ImageProviderConfig>;
};

export class FileImageService implements ImageService {
  readonly artifactRoot: string;

  private readonly adapters = new Map<string, ImageGenerationAdapter>();

  constructor(private readonly options: FileImageServiceOptions) {
    this.artifactRoot = options.config.artifactRoot;

    for (const adapter of options.adapters) {
      this.adapters.set(adapter.providerId, adapter);
    }
  }

  async dispose(): Promise<void> {
    return Promise.resolve();
  }

  async generate(request: ImageGenerationInput): Promise<ImageGenerationResult> {
    const providerId = request.providerId ?? this.options.config.defaultProviderId;
    return this.requireAdapter(providerId).generate(
      imageGenerationRequestSchema.parse({
        ...request,
        providerId
      })
    );
  }

  async listModels(providerId?: string): Promise<ImageModelDescriptor[]> {
    if (providerId) {
      return this.requireAdapter(providerId).listModels?.() ?? [];
    }

    const descriptors = await Promise.all(Array.from(this.adapters.values()).map(async (adapter) => adapter.listModels?.() ?? []));
    return descriptors.flat().sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  async listProviderHealth(providerId?: string): Promise<ProviderHealth[]> {
    if (providerId) {
      return [await this.requireAdapter(providerId).health()];
    }

    return Promise.all(Array.from(this.adapters.values()).map(async (adapter) => adapter.health()));
  }

  private requireAdapter(providerId: string): ImageGenerationAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      throw createImageError(
        "image_provider_not_configured",
        `Image provider "${providerId}" is not configured or not enabled.`,
        {
          providerId
        }
      );
    }
    return adapter;
  }
}

export function createImageServiceFromConfig(
  config: AppConfig,
  options: {
    fetchImpl?: typeof fetch;
  } = {}
): FileImageService {
  const adapters: ImageGenerationAdapter[] = [];

  for (const [providerId, providerConfig] of Object.entries(config.providers.imageProviders)) {
    if (!providerConfig.enabled) {
      continue;
    }

    switch (providerConfig.kind) {
      case "comfyui_compatible":
        adapters.push(
          new ComfyUIImageGenerationAdapter({
            artifactRoot: config.image.artifactRoot,
            baseUrl: providerConfig.baseUrl,
            defaultModel: providerConfig.model,
            fetchImpl: options.fetchImpl,
            headers: materializeHeaders(providerConfig),
            pollIntervalMs: config.image.pollIntervalMs,
            providerId,
            timeoutMs: providerConfig.timeoutMs,
            workflowPath: providerConfig.workflowPath,
            workflowPaths: providerConfig.workflowPaths
          })
        );
        break;
      default:
        throw createImageError(
          "image_provider_kind_unsupported",
          `Image provider kind "${providerConfig.kind}" is not implemented yet.`,
          {
            providerId
          }
        );
    }
  }

  return new FileImageService({
    adapters,
    config: config.image,
    providerConfigs: config.providers.imageProviders
  });
}

function materializeHeaders(providerConfig: ImageProviderConfig): Record<string, string> {
  const headers = Object.fromEntries(
    Object.entries(providerConfig.headers).map(([key, value]) => {
      if (typeof value !== "string") {
        throw new Error(
          `Image provider has unresolved secret-backed header "${key}". Use resolvedConfig when creating the image service.`
        );
      }
      return [key, value] as const;
    })
  );

  if (providerConfig.apiKey) {
    if (typeof providerConfig.apiKey !== "string") {
      throw new Error("Image provider apiKey contains an unresolved secret reference. Use resolvedConfig when creating the image service.");
    }
    const hasAuthorizationHeader = Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
    if (!hasAuthorizationHeader) {
      headers.Authorization = `Bearer ${providerConfig.apiKey}`;
    }
  }

  return headers;
}
