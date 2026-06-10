import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import type { ArtifactReference } from "@/core/contracts";
import {
  buildImageArtifactFromFile,
  buildImageInputPath,
  buildImageOutputPath,
  copyLocalImageInputToArtifactRoot,
  createImageError,
  imageArtifactPathFromArtifact,
  imageInputPathFromUri,
  probeImageFile,
  probeImageSizeMetadata,
  sanitizeFileName,
  sanitizeSegment
} from "@/core/image/utils";

const tempRoots: string[] = [];
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-image-utils-"));
  tempRoots.push(root);
  return root;
}

function artifact(overrides: Partial<ArtifactReference>): ArtifactReference {
  return {
    id: "artifact.image.1",
    kind: "image",
    metadata: {},
    uri: "file:///tmp/x.png",
    ...overrides
  } as ArtifactReference;
}

describe("image utils paths and sanitizers", () => {
  test("builds input and output paths with sanitized segments", () => {
    expect(buildImageInputPath({ artifactRoot: "/root", fileName: "a b.png", requestId: "req/1" })).toBe(
      path.join("/root", "inputs", "shared", "req_1", "a_b.png")
    );
    expect(
      buildImageOutputPath({ artifactRoot: "/root", fileName: "out.png", providerId: "comfy", requestId: "r1", sessionId: "s 1" })
    ).toBe(path.join("/root", "outputs", "comfy", "s_1", "r1", "out.png"));
  });

  test("sanitizeFileName and sanitizeSegment strip unsafe characters", () => {
    expect(sanitizeFileName("../../etc/pa$$wd")).toBe("pa__wd");
    expect(sanitizeFileName("!!!" )).toBe("___");
    expect(sanitizeSegment("a/b c")).toBe("a_b_c");
  });

  test("createImageError builds a structured error", () => {
    expect(createImageError("code", "msg", { a: 1 }, true)).toEqual({
      code: "code",
      details: { a: 1 },
      message: "msg",
      retriable: true
    });
  });

  test("imageInputPathFromUri requires file URIs", () => {
    const local = path.join(os.tmpdir(), "pic.png");
    expect(imageInputPathFromUri(pathToFileURL(local).href)).toBe(local);
    expect(() => imageInputPathFromUri("https://example.com/x.png")).toThrow(/local file/u);
  });

  test("imageArtifactPathFromArtifact rejects non-image kinds", () => {
    const local = path.join(os.tmpdir(), "pic.png");
    expect(imageArtifactPathFromArtifact(artifact({ uri: pathToFileURL(local).href }))).toBe(local);
    expect(() => imageArtifactPathFromArtifact(artifact({ kind: "audio" }))).toThrow(/not an image-like artifact/u);
  });

  test("probeImageSizeMetadata reads valid dimensions only", () => {
    expect(probeImageSizeMetadata(artifact({ metadata: { height: 10, width: 20 } }))).toEqual({ height: 10, width: 20 });
    expect(probeImageSizeMetadata(artifact({ metadata: {} }))).toBeNull();
    expect(probeImageSizeMetadata(artifact({ metadata: { height: 0, width: 5 } }))).toBeNull();
  });
});

describe("image probing", () => {
  test("probes a PNG file for format and dimensions", async () => {
    const root = await tempRoot();
    const filePath = path.join(root, "one.png");
    await fs.writeFile(filePath, Buffer.from(PNG_1X1, "base64"));

    const probe = await probeImageFile(filePath);
    expect(probe).toMatchObject({ format: "png", height: 1, mediaType: "image/png", width: 1 });
  });

  test("throws for unsupported formats", async () => {
    const root = await tempRoot();
    const filePath = path.join(root, "not-image.bin");
    await fs.writeFile(filePath, Buffer.from("just text, not an image"));
    await expect(probeImageFile(filePath)).rejects.toMatchObject({ code: "image_probe_unsupported_format" });
  });

  test("builds an artifact reference from a PNG with probe metadata", async () => {
    const root = await tempRoot();
    const filePath = path.join(root, "two.png");
    await fs.writeFile(filePath, Buffer.from(PNG_1X1, "base64"));

    const reference = await buildImageArtifactFromFile({ filePath, name: "two.png" });
    expect(reference.kind).toBe("image");
    expect(reference.mediaType).toBe("image/png");
    expect(reference.metadata).toMatchObject({ actualFormat: "png", height: 1, width: 1 });
  });

  test("copies a local image into the artifact root", async () => {
    const root = await tempRoot();
    const source = path.join(root, "src.png");
    await fs.writeFile(source, Buffer.from(PNG_1X1, "base64"));
    const artifactRoot = path.join(root, "artifacts");

    const reference = await copyLocalImageInputToArtifactRoot({
      artifactRoot,
      filePath: source,
      requestId: "req-1",
      sessionId: "sess-1"
    });

    expect(reference.kind).toBe("image");
    const copiedPath = imageInputPathFromUri(reference.uri);
    await expect(fs.stat(copiedPath)).resolves.toBeTruthy();
    expect(copiedPath).toContain(path.join("artifacts", "inputs", "sess-1", "req-1"));
  });
});
