import path from "node:path";

import { z } from "zod";

import type {
  ArtifactReference,
  ImageService,
  JsonValue,
  ToolDefinition
} from "@/core/contracts";
import {
  artifactReferenceSchema,
  imageGenerationParametersSchema,
  imageGenerationModeSchema,
  imageOutputFormatSchema,
  providerIdSchema,
  tagsSchema
} from "@/core/contracts";
import { copyLocalImageInputToArtifactRoot, imageInputPathFromUri } from "@/core/image";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

const imageArtifactSourceSchema = artifactReferenceSchema.superRefine((artifact, context) => {
  if (artifact.kind !== "image" && artifact.kind !== "screenshot") {
    context.addIssue({
      code: "custom",
      message: 'Image inputs must be image-like artifacts with kind "image" or "screenshot".'
    });
  }
});

const imageFileUriSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith("file://"), "Image inputs must be local file:// URIs.");

const imageToolSourceSchema = z.union([imageArtifactSourceSchema, imageFileUriSchema]);

const imageToolSourceJsonSchema: JsonValue = {
  anyOf: [
    {
      additionalProperties: false,
      properties: {
        byteLength: { type: "integer" },
        id: { type: "string" },
        kind: {
          enum: ["image", "screenshot"],
          type: "string"
        },
        mediaType: { type: "string" },
        metadata: { type: "object" },
        name: { type: "string" },
        sha256: { type: "string" },
        uri: { type: "string" }
      },
      required: ["id", "kind", "uri"],
      type: "object"
    },
    {
      description: "Local file:// URI for an input image.",
      type: "string"
    }
  ]
};

const imageGenerateToolInputSchema = z
  .object({
    count: z.number().int().positive().optional(),
    format: imageOutputFormatSchema.optional(),
    guidanceScale: z.number().positive().optional(),
    maskImage: imageToolSourceSchema.optional(),
    mode: imageGenerationModeSchema.optional(),
    model: z.string().min(1).max(256).optional(),
    negativePrompt: z.string().min(1).optional(),
    prompt: z.string().min(1),
    providerId: providerIdSchema.optional(),
    references: z.array(imageToolSourceSchema).default([]),
    sampler: z.string().min(1).max(128).optional(),
    scheduler: z.string().min(1).max(128).optional(),
    seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    size: z
      .object({
        height: z.number().int().positive(),
        width: z.number().int().positive()
      })
      .strict()
      .optional(),
    sourceImage: imageToolSourceSchema.optional(),
    steps: z.number().int().positive().optional(),
    strength: z.number().min(0).max(1).optional(),
    styleTags: tagsSchema.default([])
  })
  .strict();

type ImageToolSource = z.infer<typeof imageToolSourceSchema>;

export function createImageGenerateTool(params: { imageService: ImageService }): RuntimeTool {
  return {
    definition: imageGenerateToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = imageGenerateToolInputSchema.parse(call.arguments as unknown);

      const sourceImage = await materializeImageSource(input.sourceImage, {
        artifactRoot: params.imageService.artifactRoot,
        label: "source",
        requestId: call.id,
        sessionId: context.session.id
      });
      const maskImage = await materializeImageSource(input.maskImage, {
        artifactRoot: params.imageService.artifactRoot,
        label: "mask",
        requestId: call.id,
        sessionId: context.session.id
      });
      const references = await Promise.all(
        input.references.map(async (reference, index) =>
          materializeImageSource(reference, {
            artifactRoot: params.imageService.artifactRoot,
            label: `reference-${String(index + 1).padStart(2, "0")}`,
            requestId: call.id,
            sessionId: context.session.id
          })
        )
      );
      const parameters = imageGenerationParametersSchema.parse({
        count: input.count,
        format: input.format,
        guidanceScale: input.guidanceScale,
        maskImage,
        mode: input.mode,
        model: input.model,
        negativePrompt: input.negativePrompt,
        prompt: input.prompt,
        references: references.filter((reference): reference is ArtifactReference => reference !== undefined),
        sampler: input.sampler,
        scheduler: input.scheduler,
        seed: input.seed,
        size: input.size,
        sourceImage,
        steps: input.steps,
        strength: input.strength,
        styleTags: input.styleTags
      });

      const result = await params.imageService.generate({
        id: call.id,
        metadata: call.metadata,
        parameters,
        providerId: input.providerId,
        sessionId: context.session.id
      });

      return {
        artifacts: result.images,
        display: [
          {
            kind: "status",
            state: "generated",
            summary: `Generated ${result.images.length} image(s) with ${result.providerId} using ${result.parameters.mode}.`
          }
        ],
        metadata: {
          mode: result.parameters.mode,
          primaryImageIndex: result.primaryImageIndex,
          providerId: result.providerId
        },
        progress: normalizeProgress(result.metadata.progress),
        result
      };
    }
  };
}

export const imageGenerateToolDefinition: ToolDefinition = {
  aliases: ["generate_image", "image-generate"],
  annotations: {
    meta: {
      family: "image"
    },
    title: "Generate Image"
  },
  approvalMode: "ask",
  descriptor: {
    approvalNotes:
      "Generates images through the configured image backend, uploads local source or mask files when needed, and writes artifacts under .aia/images.",
    examples: [
      "Generate a control-plane concept image with a short text prompt.",
      "Run image-to-image or inpaint against a local file:// source image and optional mask."
    ],
    purpose:
      "Create, transform, or inpaint raster images through the configured provider while persisting artifacts for later turns and tools.",
    sideEffectSummary:
      "Reads local image files, writes copied inputs and generated outputs under .aia/images, and submits generation jobs to the configured image backend.",
    whenNotToUse: [
      "Do not use with remote http(s) image URLs.",
      "Do not use when you need vector editing or direct file editing instead of generated raster output.",
      "Do not use if no image provider is enabled in configuration."
    ],
    whenToUse: [
      "Use for text-to-image generation when a prompt should produce one or more raster images.",
      "Use for image-to-image or inpaint workflows when you already have a local source image or mask."
    ]
  },
  description: "Generate, transform, or inpaint raster images through the configured image provider.",
  displayName: "Generate Image",
  execution: {
    inputMode: "json",
    resumable: false,
    taskSupport: "optional"
  },
  idempotent: false,
  inputSchema: {
    additionalProperties: false,
    properties: {
      count: { type: "integer" },
      format: {
        enum: ["png", "jpeg", "webp"],
        type: "string"
      },
      guidanceScale: { type: "number" },
      maskImage: imageToolSourceJsonSchema,
      mode: {
        enum: ["text_to_image", "image_to_image", "inpaint"],
        type: "string"
      },
      model: { type: "string" },
      negativePrompt: { type: "string" },
      prompt: { type: "string" },
      providerId: { type: "string" },
      references: {
        items: imageToolSourceJsonSchema,
        type: "array"
      },
      sampler: { type: "string" },
      scheduler: { type: "string" },
      seed: { type: "integer" },
      size: {
        additionalProperties: false,
        properties: {
          height: { type: "integer" },
          width: { type: "integer" }
        },
        required: ["width", "height"],
        type: "object"
      },
      sourceImage: imageToolSourceJsonSchema,
      steps: { type: "integer" },
      strength: { type: "number" },
      styleTags: {
        items: {
          type: "string"
        },
        type: "array"
      }
    },
    required: ["prompt"],
    type: "object"
  },
  invocationName: "image_generate",
  kind: "image",
  metadata: {},
  name: "image_generate",
  outputKind: "mixed",
  outputSchema: {
    type: "object"
  },
  retryable: true,
  searchTags: ["artifact", "comfyui", "generate", "image", "img2img", "inpaint", "raster"],
  sideEffects: ["workspace_read", "workspace_write", "network_write"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.image.generate",
  usageGuidance:
    "Prefer explicit prompts, pass a model when you need a specific checkpoint, and use local file:// URIs or prior image artifacts for sourceImage, maskImage, and references.",
  version: "1.0.0"
};

async function materializeImageSource(
  source: ImageToolSource | undefined,
  params: {
    artifactRoot: string;
    label: string;
    requestId: string;
    sessionId: string;
  }
): Promise<ArtifactReference | undefined> {
  if (!source) {
    return undefined;
  }

  if (typeof source !== "string") {
    return source;
  }

  const filePath = imageInputPathFromUri(source);
  return copyLocalImageInputToArtifactRoot({
    artifactRoot: params.artifactRoot,
    filePath,
    metadata: {
      originalUri: source,
      sourceRole: params.label
    },
    name: buildCopiedInputName(params.label, filePath),
    requestId: params.requestId,
    sessionId: params.sessionId
  });
}

function buildCopiedInputName(label: string, filePath: string): string {
  const extension = path.extname(filePath);
  const baseName = path.basename(filePath, extension);
  return `${label}-${baseName}${extension}`;
}

function normalizeProgress(value: JsonValue | undefined): Array<{ state: string; summary: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return [];
      }

      const state = "state" in entry && typeof entry.state === "string" ? entry.state : null;
      const summary = "summary" in entry && typeof entry.summary === "string" ? entry.summary : null;
      return state && summary ? [{ state, summary }] : [];
    })
    .slice(0, 32);
}
