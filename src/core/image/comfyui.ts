import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import imageToImageTemplateJson from "@/core/image/workflows/image-to-image.json";
import inpaintTemplateJson from "@/core/image/workflows/inpaint.json";
import textToImageTemplateJson from "@/core/image/workflows/text-to-image.json";

import { z } from "zod";

import type {
  ImageGenerationAdapter,
  ImageGenerationMode,
  ImageGenerationParameters,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageModelDescriptor,
  JsonValue,
  ProviderHealth
} from "@/core/contracts";
import {
  imageGenerationRequestSchema,
  imageGenerationResultSchema,
  imageModelDescriptorSchema
} from "@/core/contracts";
import { fetchJson, normalizeUnknownProviderError } from "@/core/lm/http";
import { sleep } from "@/core/io/files";
import {
  buildImageArtifactFromFile,
  buildImageOutputPath,
  createImageError,
  imageArtifactPathFromArtifact,
  probeImageFile,
  probeImageSizeMetadata,
  sanitizeFileName,
  sanitizeSegment
} from "@/core/image/utils";

const DEFAULT_GUIDANCE_SCALE = 8;
const DEFAULT_IMAGE_SIZE = {
  height: 1024,
  width: 1024
} as const;
const DEFAULT_SAMPLER = "euler";
const DEFAULT_SCHEDULER = "normal";
const DEFAULT_STEPS = 20;
const DEFAULT_STRENGTH = 0.75;

const workflowBindingTargetSchema = z
  .object({
    input: z.string().min(1),
    nodeId: z.string().min(1)
  })
  .strict();

const workflowBindingSchema = z.union([workflowBindingTargetSchema, z.array(workflowBindingTargetSchema).min(1)]);

const workflowTemplateSchema = z
  .object({
    bindings: z.record(z.string().min(1), workflowBindingSchema),
    prompt: z.record(
      z.string().min(1),
      z
        .object({
          class_type: z.string().min(1),
          inputs: z.record(z.string(), z.any())
        })
        .passthrough()
    )
  })
  .strict();

type WorkflowTemplate = z.infer<typeof workflowTemplateSchema>;
type WorkflowTarget = z.infer<typeof workflowBindingTargetSchema>;

export type ComfyUIImageGenerationAdapterOptions = {
  artifactRoot: string;
  baseUrl: string;
  defaultModel?: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  pollIntervalMs: number;
  providerId: string;
  timeoutMs: number;
  workflowPath?: string;
  workflowPaths?: {
    imageToImage?: string;
    inpaint?: string;
    textToImage?: string;
  };
};

const builtInTemplates: Record<ImageGenerationMode, WorkflowTemplate> = {
  image_to_image: workflowTemplateSchema.parse(imageToImageTemplateJson),
  inpaint: workflowTemplateSchema.parse(inpaintTemplateJson),
  text_to_image: workflowTemplateSchema.parse(textToImageTemplateJson)
};

export class ComfyUIImageGenerationAdapter implements ImageGenerationAdapter {
  readonly kind = "comfyui_compatible" as const;
  readonly providerId: string;

  private readonly baseUrl: string;
  private capabilityProbe: Promise<void> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(private readonly options: ComfyUIImageGenerationAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = options.headers ?? {};
    this.providerId = options.providerId;
  }

  async generate(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const parsed = imageGenerationRequestSchema.parse(request);
    await this.ensureCapabilities();
    const resolved = await this.resolveParameters(parsed);
    const outputRoot = path.join(
      this.options.artifactRoot,
      "outputs",
      sanitizeSegment(this.providerId),
      sanitizeSegment(parsed.sessionId ?? "shared"),
      sanitizeSegment(parsed.id)
    );
    await fs.mkdir(outputRoot, { recursive: true });

    const template = await this.loadTemplate(resolved.mode);
    const uploadedInputs = await this.uploadInputs(resolved);
    const outputPrefix = `AIAgent-${sanitizeSegment(parsed.id)}`;
    const prompt = applyBindings({
      model: resolved.model,
      outputPrefix,
      parameters: resolved,
      template,
      uploadedInputs
    });

    const requestLogPath = path.join(outputRoot, "request.json");
    await fs.writeFile(
      requestLogPath,
      `${JSON.stringify(
        {
          parameters: resolved,
          prompt
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const progress = [
      {
        state: "submitted",
        summary: `Submitted ${resolved.mode} request to ${this.providerId}.`
      }
    ];

    const submission = await fetchJson<{
      number?: number;
      prompt_id?: string;
      promptId?: string;
    }>({
      body: {
        client_id: crypto.randomUUID(),
        prompt
      },
      fetchImpl: this.fetchImpl,
      headers: this.headers,
      timeoutMs: this.options.timeoutMs,
      url: `${this.baseUrl}/prompt`
    });

    const promptId = submission.data.prompt_id ?? submission.data.promptId;
    if (!promptId) {
      throw createImageError("image_prompt_submission_failed", "ComfyUI did not return a prompt id.", {
        response: submission.data
      });
    }

    progress.push({
      state: "running",
      summary:
        typeof submission.data.number === "number"
          ? `ComfyUI accepted prompt ${promptId} with queue number ${submission.data.number}.`
          : `ComfyUI accepted prompt ${promptId}.`
    });

    const history = await this.waitForHistory(promptId);
    const historyPath = path.join(outputRoot, "history.json");
    await fs.writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`, "utf8");

    const generatedImages = extractGeneratedImages(history);
    if (generatedImages.length === 0) {
      throw createImageError("image_generation_no_outputs", "ComfyUI completed the request but did not report any images.", {
        promptId
      });
    }

    const images = await Promise.all(
      generatedImages.map(async (image, index) => {
        const fileName = buildOutputFileName(index, image.filename);
        const targetPath = buildImageOutputPath({
          artifactRoot: this.options.artifactRoot,
          fileName,
          providerId: this.providerId,
          requestId: parsed.id,
          sessionId: parsed.sessionId
        });

        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        const response = await this.fetchImpl(this.buildViewUrl(image), {
          headers: this.headers,
          signal: AbortSignal.timeout(this.options.timeoutMs)
        });
        if (!response.ok) {
          throw createImageError(
            "image_generation_download_failed",
            `Failed to download generated image "${image.filename}" from ComfyUI.`,
            {
              filename: image.filename,
              promptId,
              status: response.status
            },
            response.status >= 500
          );
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        await fs.writeFile(targetPath, buffer);

        return buildImageArtifactFromFile({
          filePath: targetPath,
          metadata: {
            backendType: image.type ?? "output",
            backendFilename: image.filename,
            backendNodeId: image.nodeId,
            promptId
          },
          name: path.basename(targetPath),
          requestedFormat: resolved.format
        });
      })
    );

    progress.push({
      state: "completed",
      summary: `Downloaded ${images.length} generated image(s) from ${this.providerId}.`
    });

    const result = imageGenerationResultSchema.parse({
      completedAt: new Date().toISOString(),
      id: parsed.id,
      images,
      metadata: {
        logPaths: {
          history: historyPath,
          request: requestLogPath
        },
        progress,
        promptId,
        queueNumber: submission.data.number ?? null,
        referencesUsedByBuiltInWorkflow: false,
        uploadedInputs
      },
      parameters: resolved,
      primaryImageIndex: 0,
      providerId: this.providerId
    });

    await fs.writeFile(path.join(outputRoot, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
    return result;
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    try {
      const response = await fetchJson<Record<string, JsonValue>>({
        fetchImpl: this.fetchImpl,
        headers: this.headers,
        timeoutMs: Math.min(this.options.timeoutMs, 15_000),
        url: `${this.baseUrl}/system_stats`
      });

      const details: Record<string, JsonValue> = {
        baseUrl: this.baseUrl,
        systemStats: response.data
      };

      return {
        checkedAt,
        details,
        providerId: this.providerId,
        status: "healthy"
      };
    } catch (error) {
      const normalized = normalizeUnknownProviderError(error, {
        code: "image_provider_health_failed"
      });
      const details: Record<string, JsonValue> = {
        baseUrl: this.baseUrl,
        error: normalized.message
      };
      return {
        checkedAt,
        details,
        providerId: this.providerId,
        status: normalized.retriable ? "degraded" : "unavailable"
      };
    }
  }

  async listModels(): Promise<ImageModelDescriptor[]> {
    const response = await fetchJson<unknown>({
      fetchImpl: this.fetchImpl,
      headers: this.headers,
      timeoutMs: this.options.timeoutMs,
      url: `${this.baseUrl}/models/checkpoints`
    });

    return normalizeModelList(response.data, this.providerId);
  }

  private buildViewUrl(image: GeneratedImageDescriptor): string {
    const params = new URLSearchParams({
      filename: image.filename
    });
    if (image.subfolder) {
      params.set("subfolder", image.subfolder);
    }
    if (image.type) {
      params.set("type", image.type);
    }
    return `${this.baseUrl}/view?${params.toString()}`;
  }

  private async loadTemplate(mode: ImageGenerationMode): Promise<WorkflowTemplate> {
    const customPath =
      (mode === "text_to_image"
        ? this.options.workflowPaths?.textToImage
        : mode === "image_to_image"
          ? this.options.workflowPaths?.imageToImage
          : this.options.workflowPaths?.inpaint) ?? this.options.workflowPath;

    if (!customPath) {
      return structuredClone(builtInTemplates[mode]);
    }

    const raw = await fs.readFile(customPath, "utf8");
    return workflowTemplateSchema.parse(JSON.parse(raw));
  }

  private async resolveParameters(request: ImageGenerationRequest): Promise<ResolvedImageGenerationParameters> {
    const parameters = structuredClone(request.parameters);
    const sourceSize =
      parameters.sourceImage !== undefined
        ? probeImageSizeMetadata(parameters.sourceImage) ??
          (await probeImageFile(imageArtifactPathFromArtifact(parameters.sourceImage)))
        : null;
    const maskSize =
      parameters.maskImage !== undefined
        ? probeImageSizeMetadata(parameters.maskImage) ??
          (await probeImageFile(imageArtifactPathFromArtifact(parameters.maskImage)))
        : null;

    if (sourceSize && maskSize && (sourceSize.width !== maskSize.width || sourceSize.height !== maskSize.height)) {
      throw createImageError("image_mask_dimension_mismatch", "maskImage must match sourceImage dimensions.", {
        maskHeight: maskSize.height,
        maskWidth: maskSize.width,
        sourceHeight: sourceSize.height,
        sourceWidth: sourceSize.width
      });
    }

    const resolvedModel = parameters.model ?? this.options.defaultModel;
    if (!resolvedModel) {
      throw createImageError(
        "image_model_required",
        `No image model is configured for provider "${this.providerId}". Set providers.imageProviders.${this.providerId}.model or pass model explicitly.`
      );
    }

    return {
      ...parameters,
      count: parameters.count,
      format: parameters.format,
      guidanceScale: parameters.guidanceScale ?? DEFAULT_GUIDANCE_SCALE,
      model: resolvedModel,
      negativePrompt: parameters.negativePrompt,
      sampler: parameters.sampler ?? DEFAULT_SAMPLER,
      scheduler: parameters.scheduler ?? DEFAULT_SCHEDULER,
      seed: parameters.seed ?? Math.floor(Math.random() * Number.MAX_SAFE_INTEGER),
      size:
        parameters.size ??
        sourceSize ?? {
          ...DEFAULT_IMAGE_SIZE
        },
      steps: parameters.steps ?? DEFAULT_STEPS,
      strength:
        parameters.mode === "text_to_image" ? undefined : parameters.strength ?? DEFAULT_STRENGTH
    };
  }

  private async ensureCapabilities(): Promise<void> {
    if (!this.capabilityProbe) {
      this.capabilityProbe = this.probeCapabilities();
    }

    return this.capabilityProbe;
  }

  private async probeCapabilities(): Promise<void> {
    await probeComfyUiCapabilities({
      baseUrl: this.baseUrl,
      fetchImpl: this.fetchImpl,
      headers: this.headers,
      timeoutMs: this.options.timeoutMs
    });
  }

  private async uploadInputs(parameters: ImageGenerationParameters): Promise<Record<string, JsonValue>> {
    const uploads: Record<string, JsonValue> = {};

    if (parameters.sourceImage) {
      uploads.sourceImage = await this.uploadSingleImage(imageArtifactPathFromArtifact(parameters.sourceImage));
    }
    if (parameters.maskImage) {
      uploads.maskImage = await this.uploadSingleImage(imageArtifactPathFromArtifact(parameters.maskImage));
    }

    return uploads;
  }

  private async uploadSingleImage(filePath: string): Promise<string> {
    const body = new FormData();
    const probe = await probeImageFile(filePath);
    const content = await fs.readFile(filePath);
    body.append("image", new Blob([content], { type: probe.mediaType }), path.basename(filePath));

    const response = await this.fetchImpl(`${this.baseUrl}/upload/image`, {
      body,
      headers: this.headers,
      method: "POST",
      signal: AbortSignal.timeout(this.options.timeoutMs)
    });

    if (!response.ok) {
      const rawText = await response.text();
      throw createImageError(
        "image_input_upload_failed",
        `Failed to upload "${path.basename(filePath)}" to ComfyUI.`,
        {
          filePath,
          response: rawText,
          status: response.status
        },
        response.status >= 500
      );
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const name = typeof payload.name === "string" ? payload.name : path.basename(filePath);
    const subfolder = typeof payload.subfolder === "string" && payload.subfolder.length > 0 ? payload.subfolder : null;
    return subfolder ? `${subfolder}/${name}` : name;
  }

  private async waitForHistory(promptId: string): Promise<Record<string, JsonValue>> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < this.options.timeoutMs) {
      const response = await fetchJson<unknown>({
        fetchImpl: this.fetchImpl,
        headers: this.headers,
        timeoutMs: this.options.timeoutMs,
        url: `${this.baseUrl}/history/${promptId}`
      });
      const entry = normalizeHistoryEntry(response.data, promptId);
      if (entry) {
        return entry;
      }

      await sleep(this.options.pollIntervalMs);
    }

    throw createImageError(
      "image_generation_timeout",
      `Timed out waiting for ComfyUI prompt "${promptId}" to finish.`,
      {
        promptId,
        timeoutMs: this.options.timeoutMs
      },
      true
    );
  }
}

type ResolvedImageGenerationParameters = ImageGenerationParameters & {
  count: number;
  format: "jpeg" | "png" | "webp";
  guidanceScale: number;
  model: string;
  negativePrompt?: string;
  sampler: string;
  scheduler: string;
  seed: number;
  size: {
    height: number;
    width: number;
  };
  steps: number;
};

type ApplyBindingsInput = {
  model: string;
  outputPrefix: string;
  parameters: ResolvedImageGenerationParameters;
  template: WorkflowTemplate;
  uploadedInputs: Record<string, JsonValue>;
};

type GeneratedImageDescriptor = {
  filename: string;
  nodeId: string;
  subfolder?: string;
  type?: string;
};

function applyBindings(input: ApplyBindingsInput): WorkflowTemplate["prompt"] {
  const prompt = structuredClone(input.template.prompt);
  const setValue = (bindingName: string, value: JsonValue) => {
    const binding = input.template.bindings[bindingName];
    if (!binding) {
      throw createImageError(
        "image_workflow_binding_missing",
        `The workflow template is missing the required "${bindingName}" binding.`
      );
    }

    const targets = Array.isArray(binding) ? binding : [binding];
    for (const target of targets) {
      applyBindingValue(prompt, target, value);
    }
  };

  setValue("model", input.model);
  setValue("positivePrompt", input.parameters.prompt);
  setValue("negativePrompt", input.parameters.negativePrompt ?? "");
  setValue("seed", input.parameters.seed ?? 0);
  setValue("steps", input.parameters.steps ?? DEFAULT_STEPS);
  setValue("guidanceScale", input.parameters.guidanceScale ?? DEFAULT_GUIDANCE_SCALE);
  setValue("sampler", input.parameters.sampler ?? DEFAULT_SAMPLER);
  setValue("scheduler", input.parameters.scheduler ?? DEFAULT_SCHEDULER);
  setValue("width", input.parameters.size?.width ?? DEFAULT_IMAGE_SIZE.width);
  setValue("height", input.parameters.size?.height ?? DEFAULT_IMAGE_SIZE.height);
  setValue("count", input.parameters.count);
  setValue("outputPrefix", input.outputPrefix);

  if (input.parameters.mode !== "text_to_image") {
    setValue("strength", input.parameters.strength ?? DEFAULT_STRENGTH);
  }
  if (input.parameters.sourceImage) {
    setValue("sourceImage", input.uploadedInputs.sourceImage ?? "");
  }
  if (input.parameters.maskImage) {
    setValue("maskImage", input.uploadedInputs.maskImage ?? "");
  }

  return prompt;
}

function applyBindingValue(prompt: WorkflowTemplate["prompt"], target: WorkflowTarget, value: JsonValue): void {
  const node = prompt[target.nodeId];
  if (!node) {
    throw createImageError(
      "image_workflow_node_missing",
      `The workflow template references missing node "${target.nodeId}".`,
      {
        input: target.input,
        nodeId: target.nodeId
      }
    );
  }

  node.inputs[target.input] = value;
}

function buildOutputFileName(index: number, backendFileName: string): string {
  const extension = path.extname(backendFileName);
  return `${String(index + 1).padStart(2, "0")}-${sanitizeFileName(path.basename(backendFileName, extension))}${extension || ".png"}`;
}

function extractGeneratedImages(history: Record<string, JsonValue>): GeneratedImageDescriptor[] {
  const outputs: Record<string, unknown> =
    typeof history.outputs === "object" && history.outputs !== null
      ? (history.outputs as Record<string, unknown>)
      : {};
  const images: GeneratedImageDescriptor[] = [];

  for (const [nodeId, nodeOutput] of Object.entries(outputs)) {
    if (typeof nodeOutput !== "object" || nodeOutput === null) {
      continue;
    }

    const candidateImages = (nodeOutput as Record<string, unknown>).images;
    if (!Array.isArray(candidateImages)) {
      continue;
    }

    for (const candidate of candidateImages) {
      if (typeof candidate !== "object" || candidate === null) {
        continue;
      }

      const candidateRecord = candidate as Record<string, unknown>;
      const filenameValue = candidateRecord.filename;
      if (typeof filenameValue !== "string") {
        continue;
      }

      const descriptor: GeneratedImageDescriptor = {
        filename: filenameValue,
        nodeId,
        subfolder:
          typeof candidateRecord.subfolder === "string"
            ? candidateRecord.subfolder
            : undefined,
        type:
          typeof candidateRecord.type === "string"
            ? candidateRecord.type
            : undefined
      };
      images.push(descriptor);
    }
  }

  return images;
}

async function probeComfyUiCapabilities(params: {
  baseUrl: string;
  fetchImpl: typeof fetch;
  headers: Record<string, string>;
  timeoutMs: number;
}): Promise<void> {
  try {
    await fetchJson<Record<string, JsonValue>>({
      fetchImpl: params.fetchImpl,
      headers: params.headers,
      timeoutMs: Math.min(params.timeoutMs, 15_000),
      url: `${params.baseUrl}/system_stats`
    });
  } catch (error) {
    const normalized = normalizeUnknownProviderError(error, {
      code: "image_provider_probe_failed",
      message: `Failed to reach the ComfyUI-compatible image backend at ${params.baseUrl}.`
    });
    throw createImageError(
      normalized.code,
      normalized.message,
      {
        baseUrl: params.baseUrl,
        cause: normalized.message
      },
      normalized.retriable
    );
  }
}

function normalizeHistoryEntry(payload: unknown, promptId: string): Record<string, JsonValue> | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  if (promptId in (payload as Record<string, unknown>)) {
    const nested = (payload as Record<string, unknown>)[promptId];
    if (typeof nested === "object" && nested !== null) {
      return nested as Record<string, JsonValue>;
    }
  }

  const keys = Object.keys(payload as Record<string, unknown>);
  if (keys.length === 0) {
    return null;
  }

  if ("outputs" in (payload as Record<string, unknown>)) {
    return payload as Record<string, JsonValue>;
  }

  return null;
}

function normalizeModelList(payload: unknown, providerId: string): ImageModelDescriptor[] {
  const values = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload !== null && Array.isArray((payload as Record<string, unknown>).models)
      ? ((payload as Record<string, unknown>).models as unknown[])
      : [];

  return values
    .map((entry) => {
      if (typeof entry === "string") {
        return imageModelDescriptorSchema.parse({
          displayName: entry,
          metadata: {},
          modelId: entry,
          providerId
        });
      }

      if (typeof entry === "object" && entry !== null) {
        const record = entry as Record<string, unknown>;
        const modelId =
          typeof record.name === "string"
            ? record.name
            : typeof record.model === "string"
              ? record.model
              : typeof record.filename === "string"
                ? record.filename
                : null;
        if (!modelId) {
          return null;
        }

        return imageModelDescriptorSchema.parse({
          displayName: typeof record.display_name === "string" ? record.display_name : modelId,
          metadata: {},
          modelId,
          providerId
        });
      }

      return null;
    })
    .filter((entry): entry is ImageModelDescriptor => entry !== null);
}
