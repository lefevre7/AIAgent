import { describe, expect, test } from "vitest";

import {
  FileImageService,
  createDefaultAppConfig,
  createImageServiceFromConfig,
  type AppConfig,
  type ImageGenerationAdapter
} from "@/core";

const ISO = "2026-06-10T00:00:00.000Z";

function imageConfig(): AppConfig["image"] {
  const config = createDefaultAppConfig({ userStateDirectory: "/tmp/aiagent-image-home" });
  return { ...config.image, defaultProviderId: "comfyui_local" };
}

function fakeAdapter(overrides: Partial<ImageGenerationAdapter> & Pick<ImageGenerationAdapter, "providerId">): ImageGenerationAdapter {
  return {
    generate: async () => {
      throw new Error("not used");
    },
    health: async () => ({ checkedAt: ISO, details: {}, providerId: overrides.providerId, status: "healthy" }),
    listModels: async () => [{ displayName: "Model", metadata: {}, modelId: "m", providerId: overrides.providerId }],
    ...overrides
  } as ImageGenerationAdapter;
}

describe("FileImageService", () => {
  test("dispose resolves and exposes the artifact root", async () => {
    const service = new FileImageService({ adapters: [], config: imageConfig() });
    expect(service.artifactRoot).toContain("images");
    await expect(service.dispose()).resolves.toBeUndefined();
  });

  test("aggregates and sorts models across adapters", async () => {
    const service = new FileImageService({
      adapters: [
        fakeAdapter({ listModels: async () => [{ displayName: "Zeta", metadata: {}, modelId: "z", providerId: "comfyui_local" }], providerId: "comfyui_local" }),
        fakeAdapter({ listModels: async () => [{ displayName: "Alpha", metadata: {}, modelId: "a", providerId: "other" }], providerId: "other" })
      ],
      config: imageConfig()
    });
    const models = await service.listModels();
    expect(models.map((model) => model.displayName)).toEqual(["Alpha", "Zeta"]);
  });

  test("returns an empty model list for an adapter without discovery", async () => {
    const adapter = fakeAdapter({ providerId: "comfyui_local" });
    delete (adapter as { listModels?: unknown }).listModels;
    const service = new FileImageService({ adapters: [adapter], config: imageConfig() });
    await expect(service.listModels("comfyui_local")).resolves.toEqual([]);
  });

  test("reports health for all adapters and rejects unknown providers", async () => {
    const service = new FileImageService({ adapters: [fakeAdapter({ providerId: "comfyui_local" })], config: imageConfig() });
    await expect(service.listProviderHealth()).resolves.toHaveLength(1);
    await expect(service.listProviderHealth("missing")).rejects.toMatchObject({ code: "image_provider_not_configured" });
  });
});

describe("createImageServiceFromConfig", () => {
  test("builds an adapter for enabled comfyui providers", () => {
    const config = createDefaultAppConfig({ userStateDirectory: "/tmp/aiagent-image-home" });
    config.providers.imageProviders.comfyui_local.enabled = true;
    const service = createImageServiceFromConfig(config);
    expect(service).toBeInstanceOf(FileImageService);
  });

  test("skips disabled providers", async () => {
    const config = createDefaultAppConfig({ userStateDirectory: "/tmp/aiagent-image-home" });
    config.providers.imageProviders.comfyui_local.enabled = false;
    const service = createImageServiceFromConfig(config);
    await expect(service.listProviderHealth()).resolves.toEqual([]);
  });

  test("materializes string headers and an apiKey into an Authorization header", () => {
    const config = createDefaultAppConfig({ userStateDirectory: "/tmp/aiagent-image-home" });
    config.providers.imageProviders.comfyui_local.enabled = true;
    config.providers.imageProviders.comfyui_local.headers = { "X-Trace": "abc" };
    config.providers.imageProviders.comfyui_local.apiKey = "secret-token";
    expect(() => createImageServiceFromConfig(config)).not.toThrow();
  });

  test("throws when a header is an unresolved secret reference", () => {
    const config = createDefaultAppConfig({ userStateDirectory: "/tmp/aiagent-image-home" });
    config.providers.imageProviders.comfyui_local.enabled = true;
    (config.providers.imageProviders.comfyui_local.headers as Record<string, unknown>)["X-Secret"] = {
      key: "FOO",
      source: "env"
    };
    expect(() => createImageServiceFromConfig(config)).toThrow(/unresolved secret-backed header/u);
  });

  test("throws when the apiKey is an unresolved secret reference", () => {
    const config = createDefaultAppConfig({ userStateDirectory: "/tmp/aiagent-image-home" });
    config.providers.imageProviders.comfyui_local.enabled = true;
    (config.providers.imageProviders.comfyui_local as { apiKey?: unknown }).apiKey = { key: "FOO", source: "env" };
    expect(() => createImageServiceFromConfig(config)).toThrow(/unresolved secret reference/u);
  });

  test("throws for an unsupported provider kind", () => {
    const config = createDefaultAppConfig({ userStateDirectory: "/tmp/aiagent-image-home" });
    const broken = {
      ...config,
      providers: {
        ...config.providers,
        imageProviders: { weird: { enabled: true, headers: {}, kind: "sd_webui" } }
      }
    } as unknown as AppConfig;
    expect(() => createImageServiceFromConfig(broken)).toThrow(/not implemented yet/u);
  });
});
