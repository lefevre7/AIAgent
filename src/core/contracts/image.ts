import { z } from "zod";

import {
  artifactReferenceSchema,
  entityIdSchema,
  isoTimestampSchema,
  metadataSchema,
  tagsSchema
} from "@/core/contracts/common";
import { providerHealthSchema, providerIdSchema, type ProviderHealth } from "@/core/contracts/providers";

export const imageProviderKindSchema = z.enum(["comfyui_compatible", "custom", "lm_studio", "mcp", "sd_webui"]);
export const imageGenerationModeSchema = z.enum(["image_to_image", "inpaint", "text_to_image"]);
export const imageOutputFormatSchema = z.enum(["jpeg", "png", "webp"]);

export const imageModelDescriptorSchema = z
  .object({
    displayName: z.string().min(1).max(256),
    metadata: metadataSchema.default({}),
    modelId: z.string().min(1).max(256),
    providerId: providerIdSchema
  })
  .strict();

export const imageSizeSchema = z
  .object({
    height: z.number().int().positive(),
    width: z.number().int().positive()
  })
  .strict();

const imageArtifactInputSchema = artifactReferenceSchema.superRefine((artifact, context) => {
  if (artifact.kind !== "image" && artifact.kind !== "screenshot") {
    context.addIssue({
      code: "custom",
      message: 'Image generation inputs must be image-like artifacts with kind "image" or "screenshot".'
    });
  }
});

export const imageGenerationParametersSchema = z
  .object({
    count: z.number().int().positive().default(1),
    format: imageOutputFormatSchema.default("png"),
    guidanceScale: z.number().positive().optional(),
    maskImage: imageArtifactInputSchema.optional(),
    mode: imageGenerationModeSchema.default("text_to_image"),
    model: z.string().min(1).max(256).optional(),
    negativePrompt: z.string().min(1).optional(),
    prompt: z.string().min(1),
    references: z.array(imageArtifactInputSchema).default([]),
    sampler: z.string().min(1).max(128).optional(),
    scheduler: z.string().min(1).max(128).optional(),
    seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    size: imageSizeSchema.optional(),
    sourceImage: imageArtifactInputSchema.optional(),
    steps: z.number().int().positive().optional(),
    strength: z.number().min(0).max(1).optional(),
    styleTags: tagsSchema.default([])
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "text_to_image") {
      if (value.sourceImage) {
        context.addIssue({
          code: "custom",
          message: 'sourceImage is only valid for "image_to_image" and "inpaint" modes.',
          path: ["sourceImage"]
        });
      }
      if (value.maskImage) {
        context.addIssue({
          code: "custom",
          message: 'maskImage is only valid for "inpaint" mode.',
          path: ["maskImage"]
        });
      }
      if (value.strength !== undefined) {
        context.addIssue({
          code: "custom",
          message: 'strength is only valid for "image_to_image" and "inpaint" modes.',
          path: ["strength"]
        });
      }
      return;
    }

    if (!value.sourceImage) {
      context.addIssue({
        code: "custom",
        message: `sourceImage is required for "${value.mode}" mode.`,
        path: ["sourceImage"]
      });
    }

    if (value.mode === "image_to_image" && value.maskImage) {
      context.addIssue({
        code: "custom",
        message: 'maskImage is only valid for "inpaint" mode.',
        path: ["maskImage"]
      });
    }

    if (value.mode === "inpaint" && !value.maskImage) {
      context.addIssue({
        code: "custom",
        message: 'maskImage is required for "inpaint" mode.',
        path: ["maskImage"]
      });
    }
  });

export const imageGenerationRequestSchema = z
  .object({
    id: entityIdSchema,
    metadata: metadataSchema.default({}),
    parameters: imageGenerationParametersSchema,
    providerId: providerIdSchema,
    sessionId: entityIdSchema.optional(),
  })
  .strict();

export const imageGenerationResultSchema = z
  .object({
    completedAt: isoTimestampSchema,
    id: entityIdSchema,
    images: z.array(imageArtifactInputSchema).min(1),
    metadata: metadataSchema.default({}),
    parameters: imageGenerationParametersSchema,
    primaryImageIndex: z.number().int().nonnegative(),
    providerId: providerIdSchema
  })
  .strict()
  .superRefine((value, context) => {
    if (value.primaryImageIndex >= value.images.length) {
      context.addIssue({
        code: "custom",
        message: "primaryImageIndex must point at one of the returned images.",
        path: ["primaryImageIndex"]
      });
    }
  });

export type ImageGenerationInput = Omit<z.input<typeof imageGenerationRequestSchema>, "providerId"> & {
  providerId?: string;
};

export interface ImageGenerationAdapter {
  readonly kind: ImageProviderKind;
  readonly providerId: z.infer<typeof providerIdSchema>;

  generate(request: ImageGenerationRequest): Promise<ImageGenerationResult>;
  health(): Promise<ProviderHealth>;
  listModels?(): Promise<ImageModelDescriptor[]>;
}

export interface ImageService {
  readonly artifactRoot: string;

  dispose(): Promise<void>;
  generate(request: ImageGenerationInput): Promise<ImageGenerationResult>;
  listModels(providerId?: string): Promise<ImageModelDescriptor[]>;
  listProviderHealth(providerId?: string): Promise<ProviderHealth[]>;
}

export type ImageGenerationMode = z.infer<typeof imageGenerationModeSchema>;
export type ImageGenerationParameters = z.infer<typeof imageGenerationParametersSchema>;
export type ImageGenerationRequest = z.infer<typeof imageGenerationRequestSchema>;
export type ImageGenerationResult = z.infer<typeof imageGenerationResultSchema>;
export type ImageModelDescriptor = z.infer<typeof imageModelDescriptorSchema>;
export type ImageOutputFormat = z.infer<typeof imageOutputFormatSchema>;
export type ImageProviderKind = z.infer<typeof imageProviderKindSchema>;

export { providerHealthSchema };
