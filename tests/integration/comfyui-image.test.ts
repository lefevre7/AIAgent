import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createDefaultAppConfig, createImageServiceFromConfig } from "@/core";

const tempRoots: string[] = [];
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9pQhR7QAAAAASUVORK5CYII=";

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status });
}

function fakeComfy(
  options: {
    historyOutputs?: unknown;
    modelsPayload?: unknown;
    promptId?: string | null;
    systemStatsStatus?: number;
    uploadStatus?: number;
    viewStatus?: number;
  } = {}
) {
  const promptId = options.promptId === undefined ? "prompt-1" : options.promptId;
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (url.pathname === "/system_stats") {
      return jsonResponse({ devices: ["cpu"] }, options.systemStatsStatus ?? 200);
    }
    if (url.pathname === "/models/checkpoints") {
      return jsonResponse(options.modelsPayload ?? ["flux-dev.safetensors"]);
    }
    if (url.pathname === "/prompt") {
      return promptId ? jsonResponse({ number: 1, prompt_id: promptId }) : jsonResponse({});
    }
    if (url.pathname.startsWith("/history/")) {
      return jsonResponse(
        options.historyOutputs ?? {
          "prompt-1": { outputs: { "save-image": { images: [{ filename: "out.png", type: "output" }] } } }
        }
      );
    }
    if (url.pathname === "/upload/image") {
      return jsonResponse({ name: "uploaded-source.png", subfolder: "" }, options.uploadStatus ?? 200);
    }
    if (url.pathname === "/view") {
      return new Response(Buffer.from(TINY_PNG, "base64"), { headers: { "content-type": "image/png" }, status: options.viewStatus ?? 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

let comfyRoot = "";

async function buildService(fetchImpl: typeof fetch) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-comfy-"));
  tempRoots.push(root);
  comfyRoot = root;
  const config = createDefaultAppConfig({ userStateDirectory: path.join(root, "home", ".aia") });
  config.image.artifactRoot = path.join(root, ".aia", "images");
  config.providers.imageProviders.comfyui_local.baseUrl = "http://127.0.0.1:43117";
  config.providers.imageProviders.comfyui_local.enabled = true;
  config.providers.imageProviders.comfyui_local.model = "flux-dev.safetensors";
  config.providers.imageProviders.comfyui_local.timeoutMs = 300;
  return createImageServiceFromConfig(config, { fetchImpl });
}

function request() {
  return { id: "image.req.1", metadata: {}, parameters: { prompt: "render a clean badge" }, providerId: "comfyui_local" };
}

describe("ComfyUI image generation", () => {
  test("generates a text-to-image result and persists an artifact", async () => {
    const service = await buildService(fakeComfy() as unknown as typeof fetch);
    const result = await service.generate(request() as never);
    expect(result.images[0]?.kind).toBe("image");
    expect(result.images[0]?.uri).toContain("file://");
    expect(result.providerId).toBe("comfyui_local");
  });

  test("reports provider health and lists checkpoint models", async () => {
    const healthy = await buildService(fakeComfy() as unknown as typeof fetch);
    await expect(healthy.listProviderHealth("comfyui_local")).resolves.toMatchObject([{ status: "healthy" }]);
    await expect(healthy.listModels("comfyui_local")).resolves.toEqual([
      expect.objectContaining({ modelId: "flux-dev.safetensors" })
    ]);

    const degraded = await buildService(fakeComfy({ systemStatsStatus: 500 }) as unknown as typeof fetch);
    await expect(degraded.listProviderHealth("comfyui_local")).resolves.toMatchObject([{ status: expect.stringMatching(/degraded|unavailable/u) }]);
  });

  test("fails when ComfyUI returns no prompt id", async () => {
    const service = await buildService(fakeComfy({ promptId: null }) as unknown as typeof fetch);
    await expect(service.generate(request() as never)).rejects.toMatchObject({ code: "image_prompt_submission_failed" });
  });

  test("times out when ComfyUI never returns a completed prompt", async () => {
    const service = await buildService(fakeComfy({ historyOutputs: {} }) as unknown as typeof fetch);
    await expect(service.generate(request() as never)).rejects.toMatchObject({ code: "image_generation_timeout" });
  });

  test("extracts valid images from mixed/garbage history outputs", async () => {
    const service = await buildService(
      fakeComfy({
        historyOutputs: {
          "prompt-1": {
            outputs: {
              badNode: "not-an-object",
              garbageCandidates: { images: ["a string", null, { missingFilename: 1 }] },
              good: { images: [{ filename: "out.png", subfolder: "sub", type: "output" }, { filename: "bare.png" }] },
              noImages: { foo: "bar" },
              nonArrayImages: { images: "nope" }
            }
          }
        }
      }) as unknown as typeof fetch
    );
    const result = await service.generate(request() as never);
    expect(result.images.length).toBe(2);
  });

  test("fails generation when the capability probe cannot reach the backend", async () => {
    const service = await buildService(fakeComfy({ systemStatsStatus: 503 }) as unknown as typeof fetch);
    await expect(service.generate(request() as never)).rejects.toMatchObject({
      code: expect.stringMatching(/image_provider_probe_failed|provider_http_error/u)
    });
  });

  test("normalizes string, object, and wrapped model-list shapes and drops invalid entries", async () => {
    const objectModels = await buildService(
      fakeComfy({
        modelsPayload: [
          "plain.safetensors",
          { display_name: "Named Model", name: "named.safetensors" },
          { model: "by-model.ckpt" },
          { filename: "by-filename.pt" },
          42,
          { irrelevant: true }
        ]
      }) as unknown as typeof fetch
    );
    const models = await objectModels.listModels("comfyui_local");
    expect(models.map((entry) => entry.modelId)).toEqual([
      "plain.safetensors",
      "named.safetensors",
      "by-model.ckpt",
      "by-filename.pt"
    ]);
    expect(models.find((entry) => entry.modelId === "named.safetensors")?.displayName).toBe("Named Model");

    const wrapped = await buildService(
      fakeComfy({ modelsPayload: { models: ["wrapped.safetensors"] } }) as unknown as typeof fetch
    );
    await expect(wrapped.listModels("comfyui_local")).resolves.toEqual([
      expect.objectContaining({ modelId: "wrapped.safetensors" })
    ]);
  });
});

describe("ComfyUI image-to-image", () => {
  async function sourceArtifact() {
    const filePath = path.join(comfyRoot, "source.png");
    await fs.writeFile(filePath, Buffer.from(TINY_PNG, "base64"));
    return {
      byteLength: 70,
      id: "artifact.source.1",
      kind: "image" as const,
      mediaType: "image/png",
      metadata: { height: 1, width: 1 },
      name: "source.png",
      sha256: "a".repeat(64),
      uri: `file://${filePath}`
    };
  }

  test("uploads a source image and generates an image-to-image result", async () => {
    const service = await buildService(fakeComfy() as unknown as typeof fetch);
    const sourceImage = await sourceArtifact();
    const result = await service.generate({
      id: "image.img2img.1",
      metadata: {},
      parameters: { mode: "image_to_image", prompt: "make it pop", sourceImage, strength: 0.6 },
      providerId: "comfyui_local"
    } as never);
    expect(result.images[0]?.kind).toBe("image");
  });

  test("rejects an image-to-image request when the mask dimensions differ from the source", async () => {
    const service = await buildService(fakeComfy() as unknown as typeof fetch);
    const sourceImage = await sourceArtifact();
    const maskImage = { ...sourceImage, id: "artifact.mask.1", metadata: { height: 2, width: 2 }, name: "mask.png" };
    await expect(
      service.generate({
        id: "image.img2img.mask",
        metadata: {},
        parameters: { maskImage, mode: "inpaint", prompt: "inpaint please", sourceImage, strength: 0.5 },
        providerId: "comfyui_local"
      } as never)
    ).rejects.toMatchObject({ code: "image_mask_dimension_mismatch" });
  });

  test("fails when the source-image upload is rejected", async () => {
    const service = await buildService(fakeComfy({ uploadStatus: 500 }) as unknown as typeof fetch);
    const sourceImage = await sourceArtifact();
    await expect(
      service.generate({
        id: "image.img2img.2",
        metadata: {},
        parameters: { mode: "image_to_image", prompt: "x", sourceImage },
        providerId: "comfyui_local"
      } as never)
    ).rejects.toMatchObject({ code: "image_input_upload_failed" });
  });
});

describe("ComfyUI generation error branches", () => {
  test("fails when ComfyUI reports no output images", async () => {
    const service = await buildService(fakeComfy({ historyOutputs: { "prompt-1": { outputs: {} } } }) as unknown as typeof fetch);
    await expect(service.generate(request() as never)).rejects.toMatchObject({ code: "image_generation_no_outputs" });
  });

  test("fails when a generated image cannot be downloaded", async () => {
    const service = await buildService(fakeComfy({ viewStatus: 500 }) as unknown as typeof fetch);
    await expect(service.generate(request() as never)).rejects.toMatchObject({ code: "image_generation_download_failed" });
  });
});
