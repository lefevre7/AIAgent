import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import {
  ToolRuntime,
  buildImageArtifactFromFile,
  createDefaultToolRegistry,
  createDefaultToolRuntime,
  imageGenerationResultSchema,
  sessionRecordSchema,
  toolCallRecordSchema,
  turnRecordSchema,
  type ImageGenerationInput,
  type ImageService
} from "@/core";

import { writeFakePng } from "../helpers/images";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

describe("image tools", () => {
  test("registers the built-in image tool when an image service is present", async () => {
    const root = await createTempRoot();
    const imageService = createFakeImageService(path.join(root, ".aia", "images"));
    const registry = createDefaultToolRegistry({
      imageService
    });
    expect(registry.getDefinition("image_generate")).toMatchObject({
      invocationName: "image_generate",
      kind: "image"
    });
  });

  test("copies file inputs into the image artifact root and surfaces image parts", async () => {
    const root = await createTempRoot();
    const artifactRoot = path.join(root, ".aia", "images");
    const received: ImageGenerationInput[] = [];
    const imageService = createFakeImageService(artifactRoot, {
      onGenerate: (request) => {
        received.push(request);
      }
    });
    const runtime = new ToolRuntime({
      approvalDecider: async () => ({
        mode: "execute"
      }),
      registry: createDefaultToolRegistry({
        imageService
      })
    });

    const sourcePath = path.join(root, "source.png");
    const maskPath = path.join(root, "mask.png");
    const referencePath = path.join(root, "reference.png");
    await writeFakePng(sourcePath, 96, 96);
    await writeFakePng(maskPath, 96, 96);
    await writeFakePng(referencePath, 64, 64);

    const result = await runtime.execute(
      createCall({
        arguments: {
          format: "png",
          maskImage: pathToFileURL(maskPath).toString(),
          mode: "inpaint",
          model: "test-model.safetensors",
          prompt: "Fill the masked area with a subtle icon treatment",
          references: [pathToFileURL(referencePath).toString()],
          sourceImage: pathToFileURL(sourcePath).toString(),
          strength: 0.45
        },
        id: "tool-call.image.tools.generate",
        toolName: "image_generate"
      }),
      {
        session: buildSession(root),
        turn: buildTurn()
      }
    );

    expect(result.toolCall.status).toBe("succeeded");
    expect(result.resultMessage?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "status",
          state: "generated"
        }),
        expect.objectContaining({
          kind: "image"
        })
      ])
    );
    expect(received).toHaveLength(1);

    const request = received[0]!;
    expect(request.parameters.sourceImage).toBeDefined();
    expect(request.parameters.maskImage).toBeDefined();
    expect(request.parameters.references?.[0]).toBeDefined();

    const copiedSourcePath = fileURLToPath(request.parameters.sourceImage!.uri);
    const copiedMaskPath = fileURLToPath(request.parameters.maskImage!.uri);
    const firstReference = request.parameters.references?.[0];
    const copiedReferencePath = fileURLToPath(firstReference!.uri);

    expect(copiedSourcePath).toContain(path.join(artifactRoot, "inputs"));
    expect(copiedMaskPath).toContain(path.join(artifactRoot, "inputs"));
    expect(copiedReferencePath).toContain(path.join(artifactRoot, "inputs"));
    expect(copiedSourcePath).not.toBe(sourcePath);
    expect(firstReference?.metadata?.originalUri).toBe(pathToFileURL(referencePath).toString());
    await expect(fs.stat(copiedSourcePath)).resolves.toMatchObject({
      isFile: expect.any(Function)
    });
  });

  test("keeps image generation approval on the generic tool target", async () => {
    const root = await createTempRoot();
    const runtime = createDefaultToolRuntime({
      imageService: createFakeImageService(path.join(root, ".aia", "images"))
    });

    const result = await runtime.execute(
      createCall({
        arguments: {
          model: "test-model.safetensors",
          prompt: "Needs approval"
        },
        id: "tool-call.image.tools.approval",
        toolName: "image_generate"
      }),
      {
        session: buildSession(root),
        turn: buildTurn()
      }
    );

    expect(result.toolCall.status).toBe("awaiting_approval");
    expect(result.approvalRequest?.target.kind).toBe("tool");
  });
});

function buildSession(cwd = "/workspace") {
  return sessionRecordSchema.parse({
    createdAt: "2026-03-31T12:00:00.000Z",
    cwd,
    goal: "Exercise image tools",
    id: "session.image.tools.1",
    lastActiveAt: "2026-03-31T12:00:00.000Z",
    metadata: {},
    status: "running_model",
    tags: [],
    title: "Image Tool Session",
    updatedAt: "2026-03-31T12:00:00.000Z"
  });
}

function buildTurn() {
  return turnRecordSchema.parse({
    approvalRequestIds: [],
    executedToolCallIds: [],
    id: "turn.image.tools.1",
    inputMessageIds: [],
    metadata: {},
    outputMessageIds: [],
    requestedToolCallIds: [],
    sequence: 0,
    sessionId: "session.image.tools.1",
    startedAt: "2026-03-31T12:00:00.000Z",
    status: "running",
    trigger: "user"
  });
}

function createCall(overrides: Partial<Parameters<typeof toolCallRecordSchema.parse>[0]> = {}) {
  return toolCallRecordSchema.parse({
    arguments: {},
    id: "tool-call.image.tools.default",
    metadata: {},
    sessionId: "session.image.tools.1",
    startedAt: "2026-03-31T12:00:00.000Z",
    status: "pending",
    toolName: "image_generate",
    turnId: "turn.image.tools.1",
    ...overrides
  });
}

function createFakeImageService(
  artifactRoot: string,
  options: {
    onGenerate?: (request: ImageGenerationInput) => void;
  } = {}
): ImageService {
  return {
    artifactRoot,
    dispose: async () => undefined,
    generate: async (request) => {
      options.onGenerate?.(request);

      const outputPath = path.join(artifactRoot, "outputs", "mock_image", request.sessionId ?? "shared", request.id, "generated.png");
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await writeFakePng(outputPath, 128, 128);
      const outputImage = await buildImageArtifactFromFile({
        filePath: outputPath,
        requestedFormat: request.parameters.format
      });

      return imageGenerationResultSchema.parse({
        completedAt: "2026-03-31T12:00:00.000Z",
        id: request.id,
        images: [outputImage],
        metadata: {
          progress: [
            {
              state: "completed",
              summary: "Generated test image."
            }
          ]
        },
        parameters: request.parameters,
        primaryImageIndex: 0,
        providerId: request.providerId ?? "mock_image"
      });
    },
    listModels: async () => [
      {
        displayName: "Test Model",
        metadata: {},
        modelId: "test-model.safetensors",
        providerId: "mock_image"
      }
    ],
    listProviderHealth: async () => [
      {
        checkedAt: "2026-03-31T12:00:00.000Z",
        details: {},
        providerId: "mock_image",
        status: "healthy"
      }
    ]
  };
}

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-image-tools-"));
  tempRoots.push(root);
  return root;
}
