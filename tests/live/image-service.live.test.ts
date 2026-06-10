import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect } from "vitest";

import { createDefaultAppConfig, createImageServiceFromConfig } from "@/core";
import { createLiveTestHarness, envFlag } from "./helpers";

const { createTempRoot: createLiveTempRoot, liveTest } = createLiveTestHarness({
  enabled: envFlag("AIA_RUN_LIVE_IMAGE_TESTS"),
  prefix: "aiagent-live-image-"
});

describe("image service live", () => {
  liveTest("lists models and generates an image through a ComfyUI-compatible backend", async () => {
    const root = await createLiveTempRoot();
    const config = createDefaultAppConfig({
      userStateDirectory: path.join(root, "user")
    });
    const providerId = process.env.AIA_LIVE_IMAGE_PROVIDER_ID ?? process.env.AIA_IMAGE_LIVE_PROVIDER_ID ?? "comfyui_local";
    const baseUrl = process.env.AIA_LIVE_IMAGE_BASE_URL ?? process.env.AIA_IMAGE_LIVE_BASE_URL ?? "http://localhost:8188";
    const requestedModel = process.env.AIA_LIVE_IMAGE_MODEL ?? process.env.AIA_IMAGE_LIVE_MODEL;

    config.image.artifactRoot = path.join(root, ".aia", "images");
    config.image.defaultProviderId = providerId;
    config.providers.imageProviders = {
      [providerId]: {
        baseUrl,
        enabled: true,
        headers: {},
        kind: "comfyui_compatible",
        model: requestedModel ?? config.providers.imageProviders[providerId]?.model,
        timeoutMs: 300_000
      }
    };

    const service = createImageServiceFromConfig(config);
    try {
      const health = await service.listProviderHealth(providerId);
      expect(health[0]?.status).not.toBe("unavailable");

      const models = await service.listModels(providerId);
      expect(models.length).toBeGreaterThan(0);

      const modelId = config.providers.imageProviders[providerId]?.model ?? models[0]?.modelId;
      expect(modelId).toBeTruthy();

      const result = await service.generate({
        id: "image.live.generate.1",
        metadata: {},
        parameters: {
          count: 1,
          format: "png",
          model: modelId,
          prompt: "A compact local-first control-plane status icon with clean geometry",
          references: [],
          size: {
            height: 512,
            width: 512
          },
          styleTags: ["clean", "icon"]
        },
        providerId,
        sessionId: "session.image.live.1"
      });

      expect(result.providerId).toBe(providerId);
      expect(result.images.length).toBeGreaterThan(0);
      await expect(fs.stat(fileURLToPath(result.images[0]!.uri))).resolves.toMatchObject({
        isFile: expect.any(Function)
      });
    } finally {
      await service.dispose();
    }
  });
});
