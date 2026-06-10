import crypto from "node:crypto";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import type { ArtifactReference, JsonSchemaDocument, ToolDefinition } from "@/core/contracts";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";
import { displayLocalPath, inferMediaType, resolveLocalPath } from "@/core/tools/builtins/local-paths";

const viewImageInputSchema = z
  .object({
    alt: z.string().max(512).optional(),
    path: z.string().min(1).max(4096)
  })
  .strict();

export function createViewImageTool(): RuntimeTool {
  return {
    definition: viewImageToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = viewImageInputSchema.parse(call.arguments as unknown);
      const absolutePath = resolveLocalPath(input.path, context.session.cwd);
      const bytes = await fs.readFile(absolutePath);
      const mediaType = inferMediaType(absolutePath, true);
      if (!mediaType.startsWith("image/")) {
        throw new Error(`"${input.path}" is not a recognized image type (resolved media type: ${mediaType}).`);
      }

      const displayPath = displayLocalPath(context.session.cwd, absolutePath);
      const name = input.path.split(/[\\/]/u).pop() || "image";
      const artifact: ArtifactReference = {
        byteLength: bytes.byteLength,
        id: `artifact.image.${crypto.randomUUID()}`,
        kind: "image",
        mediaType,
        metadata: input.alt ? { alt: input.alt } : {},
        name: input.alt ?? name,
        uri: pathToFileURL(absolutePath).href
      };

      return {
        artifacts: [artifact],
        display: [
          {
            kind: "status",
            state: "read",
            summary: `Loaded image ${displayPath} (${bytes.byteLength} bytes, ${mediaType}).`
          }
        ],
        result: {
          byteLength: bytes.byteLength,
          mediaType,
          path: displayPath
        }
      };
    }
  };
}

const viewImageOutputSchema: JsonSchemaDocument = {
  additionalProperties: false,
  properties: {
    byteLength: { type: "integer" },
    mediaType: { type: "string" },
    path: { type: "string" }
  },
  required: ["byteLength", "mediaType", "path"],
  type: "object"
};

export const viewImageToolDefinition: ToolDefinition = {
  aliases: ["read_image", "look_at_image"],
  annotations: {
    idempotentHint: true,
    meta: {
      family: "workspace"
    },
    openWorldHint: false,
    readOnlyHint: true,
    title: "View Image"
  },
  approvalMode: "never",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only reads a local image file.",
    examples: [
      "Look at a screenshot the operator referenced before reasoning about it.",
      "Inspect a generated diagram or chart saved in the workspace."
    ],
    purpose: "Load a local image file into the conversation so a vision-capable model can see it.",
    sideEffectSummary: "Reads a local image file. Does not change anything.",
    whenNotToUse: [
      "Do not use it on non-image files; use read_file for text or other binary inspection.",
      "Do not use it to generate images; use image_generate for that."
    ],
    whenToUse: [
      "Use when you need to actually see an image to answer the task.",
      "Use after a tool or the operator produced an image you must inspect."
    ]
  },
  description:
    "Load a local image file (png, jpg, gif, webp, …) as an image attachment so a vision-capable model can see it. Returns the image as a message artifact plus basic metadata. It does not work on non-image files.",
  displayName: "View Image",
  execution: {
    inputMode: "json",
    resumable: false,
    taskSupport: "forbidden"
  },
  idempotent: true,
  inputSchema: {
    additionalProperties: false,
    properties: {
      alt: {
        description: "Optional caption/description used as the image's alt text.",
        type: "string"
      },
      path: {
        description: "Path to a local image file.",
        type: "string"
      }
    },
    required: ["path"],
    type: "object"
  },
  invocationName: "view_image",
  kind: "built_in",
  metadata: {},
  name: "view_image",
  outputKind: "json",
  outputSchema: viewImageOutputSchema,
  retryable: true,
  searchTags: ["image", "look", "photo", "screenshot", "view", "vision"],
  sideEffects: ["workspace_read"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.builtin.view_image",
  usageGuidance:
    "Use this to bring a local image into the conversation for a vision-capable model. It only reads image files and never modifies anything. If the active model has no vision support, prefer describing the image another way.",
  version: "1.0.0"
};
