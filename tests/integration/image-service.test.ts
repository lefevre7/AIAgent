import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  ToolRuntime,
  createDefaultAppConfig,
  createDefaultToolRegistry,
  createImageServiceFromConfig,
  createToolApprovalDecider,
  sessionRecordSchema,
  toolCallRecordSchema,
  turnRecordSchema,
  type ApprovalSettings
} from "@/core";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

describe("image service", () => {
  test("reports provider health, lists models, and generates an image through the runtime tool path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-image-service-"));
    tempRoots.push(root);

    const fakeFetch = createFakeComfyUiFetch();
    const config = createDefaultAppConfig({
      userStateDirectory: path.join(root, "home", ".aia")
    });
    config.image.artifactRoot = path.join(root, ".aia", "images");
    config.providers.imageProviders.comfyui_local.baseUrl = "http://127.0.0.1:43111";
    config.providers.imageProviders.comfyui_local.enabled = true;
    config.providers.imageProviders.comfyui_local.model = "flux-dev.safetensors";

    const imageService = createImageServiceFromConfig(config, {
      fetchImpl: fakeFetch
    });
    const settings: ApprovalSettings = {
      configVersion: 1,
      defaultMode: "ask",
      rules: [
        {
          id: "rule.image.allow",
          mode: "allow",
          pattern: "^image_",
          targetKind: "tool"
        }
      ]
    };
    const runtime = new ToolRuntime({
      approvalDecider: createToolApprovalDecider({
        settings
      }),
      registry: createDefaultToolRegistry({
        imageService
      })
    });

    const health = await imageService.listProviderHealth("comfyui_local");
    expect(health[0]?.status).toBe("healthy");

    const models = await imageService.listModels("comfyui_local");
    expect(models).toEqual([
      expect.objectContaining({
        modelId: "flux-dev.safetensors"
      })
    ]);

    const result = await runtime.execute(
      toolCallRecordSchema.parse({
        arguments: {
          prompt: "Render a clean status badge for the control plane."
        },
        id: "tool-call.image.integration.1",
        metadata: {},
        sessionId: "session.image.integration.1",
        startedAt: "2026-03-31T12:00:00.000Z",
        status: "pending",
        toolName: "image_generate",
        turnId: "turn.image.integration.1"
      }),
      {
        session: sessionRecordSchema.parse({
          createdAt: "2026-03-31T12:00:00.000Z",
          cwd: root,
          goal: "Exercise image generation",
          id: "session.image.integration.1",
          lastActiveAt: "2026-03-31T12:00:00.000Z",
          metadata: {},
          status: "running_model",
          tags: [],
          title: "Image Integration Session",
          updatedAt: "2026-03-31T12:00:00.000Z"
        }),
        turn: turnRecordSchema.parse({
          approvalRequestIds: [],
          executedToolCallIds: [],
          id: "turn.image.integration.1",
          inputMessageIds: [],
          metadata: {},
          outputMessageIds: [],
          requestedToolCallIds: [],
          sequence: 0,
          sessionId: "session.image.integration.1",
          startedAt: "2026-03-31T12:00:00.000Z",
          status: "running",
          trigger: "user"
        })
      }
    );

    expect(result.toolCall.status).toBe("succeeded");
    expect(fakeFetch.requests.some((entry) => entry.pathname === "/prompt")).toBe(true);
    expect(fakeFetch.requests.some((entry) => entry.pathname === "/history/prompt-1")).toBe(true);
    expect(result.toolCall.result).toMatchObject({
      images: [
        {
          kind: "image",
          uri: expect.stringContaining("file://")
        }
      ],
      providerId: "comfyui_local"
    });

    const imageUri = (
      result.toolCall.result as {
        images: Array<{ uri: string }>;
      }
    ).images[0]?.uri;
    expect(imageUri).toBeTruthy();
    if (!imageUri) {
      throw new Error("Expected generated image artifact URI.");
    }

    await expect(fs.stat(new URL(imageUri))).resolves.toMatchObject({
      isFile: expect.any(Function)
    });
    expect(fakeFetch.lastPromptBody?.prompt).toBeTruthy();
  });
});

function createFakeComfyUiFetch() {
  const requests: Array<{ method: string; pathname: string }> = [];
  let lastPromptBody: Record<string, unknown> | null = null;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    requests.push({
      method: init?.method ?? "GET",
      pathname: `${url.pathname}${url.search}`
    });

    if (url.pathname === "/system_stats") {
      return jsonResponse({
        devices: ["cpu"]
      });
    }

    if (url.pathname === "/models/checkpoints") {
      return jsonResponse(["flux-dev.safetensors"]);
    }

    if (url.pathname === "/prompt") {
      lastPromptBody = parseJsonBody(init?.body);
      return jsonResponse({
        number: 7,
        prompt_id: "prompt-1"
      });
    }

    if (url.pathname === "/history/prompt-1") {
      return jsonResponse({
        "prompt-1": {
          outputs: {
            "save-image": {
              images: [
                {
                  filename: "generated.png",
                  type: "output"
                }
              ]
            }
          }
        }
      });
    }

    if (url.pathname === "/view") {
      return new Response(Buffer.from(TINY_PNG_BASE64, "base64"), {
        headers: {
          "content-type": "image/png"
        },
        status: 200
      });
    }

    return new Response(`No fake ComfyUI handler for ${url.pathname}`, {
      status: 404
    });
  };

  Object.defineProperties(fetchImpl, {
    lastPromptBody: {
      get() {
        return lastPromptBody;
      }
    },
    requests: {
      value: requests
    }
  });

  return fetchImpl as typeof fetch & {
    readonly lastPromptBody: Record<string, unknown> | null;
    readonly requests: Array<{ method: string; pathname: string }>;
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: {
      "content-type": "application/json"
    },
    status: 200
  });
}

function parseJsonBody(body: BodyInit | null | undefined): Record<string, unknown> | null {
  if (typeof body !== "string") {
    return null;
  }
  return JSON.parse(body) as Record<string, unknown>;
}

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9pQhR7QAAAAASUVORK5CYII=";
