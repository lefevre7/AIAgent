import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ArtifactReference, ImageOutputFormat, JsonValue, StructuredError } from "@/core/contracts";
import { createArtifactReferenceFromFile } from "@/core/io/artifacts";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RIFF_SIGNATURE = Buffer.from("RIFF", "ascii");
const WEBP_SIGNATURE = Buffer.from("WEBP", "ascii");

export type ImageProbeResult = {
  format: ImageOutputFormat;
  height: number;
  mediaType: string;
  width: number;
};

export function buildImageInputPath(params: {
  artifactRoot: string;
  fileName: string;
  requestId: string;
  sessionId?: string;
}): string {
  return path.join(
    params.artifactRoot,
    "inputs",
    sanitizeSegment(params.sessionId ?? "shared"),
    sanitizeSegment(params.requestId),
    sanitizeFileName(params.fileName)
  );
}

export function buildImageOutputPath(params: {
  artifactRoot: string;
  fileName: string;
  providerId: string;
  requestId: string;
  sessionId?: string;
}): string {
  return path.join(
    params.artifactRoot,
    "outputs",
    sanitizeSegment(params.providerId),
    sanitizeSegment(params.sessionId ?? "shared"),
    sanitizeSegment(params.requestId),
    sanitizeFileName(params.fileName)
  );
}

export async function buildImageArtifactFromFile(params: {
  filePath: string;
  metadata?: Record<string, JsonValue>;
  name?: string;
  requestedFormat?: ImageOutputFormat;
}): Promise<ArtifactReference> {
  const probe = await probeImageFile(params.filePath);

  return createArtifactReferenceFromFile(params.filePath, "image", {
    mediaType: probe.mediaType,
    metadata: {
      actualFormat: probe.format,
      height: probe.height,
      requestedFormat: params.requestedFormat ?? probe.format,
      width: probe.width,
      ...(params.metadata ?? {})
    },
    name: params.name
  });
}

export async function copyLocalImageInputToArtifactRoot(params: {
  artifactRoot: string;
  filePath: string;
  metadata?: Record<string, JsonValue>;
  name?: string;
  requestId: string;
  sessionId?: string;
}): Promise<ArtifactReference> {
  const targetPath = buildImageInputPath({
    artifactRoot: params.artifactRoot,
    fileName: params.name ?? path.basename(params.filePath),
    requestId: params.requestId,
    sessionId: params.sessionId
  });

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(params.filePath, targetPath);

  return buildImageArtifactFromFile({
    filePath: targetPath,
    metadata: params.metadata,
    name: params.name ?? path.basename(targetPath)
  });
}

export function createImageError(
  code: string,
  message: string,
  details: Record<string, JsonValue> = {},
  retriable = false
): StructuredError {
  return {
    code,
    details,
    message,
    retriable
  };
}

export function imageArtifactPathFromArtifact(artifact: ArtifactReference): string {
  if (artifact.kind !== "image" && artifact.kind !== "screenshot") {
    throw createImageError(
      "image_input_invalid_artifact_kind",
      `Artifact "${artifact.id}" is not an image-like artifact.`,
      {
        artifactId: artifact.id,
        artifactKind: artifact.kind
      }
    );
  }

  return imageInputPathFromUri(artifact.uri);
}

export function imageInputPathFromUri(uri: string): string {
  if (!/^file:\/\//u.test(uri)) {
    throw createImageError(
      "image_input_uri_unsupported",
      "Image inputs must use local file:// URIs.",
      {
        uri
      }
    );
  }

  return fileURLToPath(uri);
}

export function sanitizeFileName(fileName: string): string {
  const normalized = path.basename(fileName).replace(/[^A-Za-z0-9._-]/gu, "_");
  return normalized.length > 0 ? normalized : "image";
}

export function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_");
}

export async function probeImageFile(filePath: string): Promise<ImageProbeResult> {
  const buffer = await fs.readFile(filePath);
  const extension = path.extname(filePath).toLowerCase();

  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return {
      format: "png",
      height: buffer.readUInt32BE(20),
      mediaType: "image/png",
      width: buffer.readUInt32BE(16)
    };
  }

  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    return {
      format: "jpeg",
      mediaType: "image/jpeg",
      ...probeJpegDimensions(buffer)
    };
  }

  if (buffer.length >= 16 && buffer.subarray(0, 4).equals(RIFF_SIGNATURE) && buffer.subarray(8, 12).equals(WEBP_SIGNATURE)) {
    return {
      format: "webp",
      mediaType: "image/webp",
      ...probeWebpDimensions(buffer)
    };
  }

  throw createImageError(
    "image_probe_unsupported_format",
    `Unsupported image format for "${filePath}".`,
    {
      extension
    }
  );
}

export function probeImageSizeMetadata(artifact: ArtifactReference): { height: number; width: number } | null {
  const height = typeof artifact.metadata.height === "number" ? Math.trunc(artifact.metadata.height) : undefined;
  const width = typeof artifact.metadata.width === "number" ? Math.trunc(artifact.metadata.width) : undefined;

  if (!height || !width || height <= 0 || width <= 0) {
    return null;
  }

  return {
    height,
    width
  };
}

function probeJpegDimensions(buffer: Buffer): { height: number; width: number } {
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    if (marker === undefined) {
      break;
    }

    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }

    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) {
      break;
    }

    if (isJpegSizeMarker(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7)
      };
    }

    offset += 2 + length;
  }

  throw createImageError("image_probe_invalid_jpeg", "Could not determine JPEG dimensions.");
}

function probeWebpDimensions(buffer: Buffer): { height: number; width: number } {
  const chunkType = buffer.toString("ascii", 12, 16);

  if (chunkType === "VP8X") {
    return {
      height: 1 + readUInt24LE(buffer, 27),
      width: 1 + readUInt24LE(buffer, 24)
    };
  }

  if (chunkType === "VP8L") {
    const dataOffset = 20;
    if (buffer[dataOffset] !== 0x2f) {
      throw createImageError("image_probe_invalid_webp", "Invalid VP8L WebP header.");
    }
    const bits = buffer.readUInt32LE(dataOffset + 1);
    return {
      height: 1 + ((bits >> 14) & 0x3fff),
      width: 1 + (bits & 0x3fff)
    };
  }

  if (chunkType === "VP8 ") {
    const dataOffset = 20;
    if (buffer[dataOffset + 3] !== 0x9d || buffer[dataOffset + 4] !== 0x01 || buffer[dataOffset + 5] !== 0x2a) {
      throw createImageError("image_probe_invalid_webp", "Invalid VP8 WebP frame header.");
    }

    return {
      height: buffer.readUInt16LE(dataOffset + 8) & 0x3fff,
      width: buffer.readUInt16LE(dataOffset + 6) & 0x3fff
    };
  }

  throw createImageError("image_probe_invalid_webp", `Unsupported WebP chunk "${chunkType}".`);
}

function isJpegSizeMarker(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function readUInt24LE(buffer: Buffer, offset: number): number {
  return buffer[offset] + (buffer[offset + 1] << 8) + (buffer[offset + 2] << 16);
}
