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

  async function writeImage(name: string, data: Buffer): Promise<string> {
    const root = await tempRoot();
    const filePath = path.join(root, name);
    await fs.writeFile(filePath, data);
    return filePath;
  }

  function webpHeader(chunkType: string): Buffer {
    const buffer = Buffer.alloc(64);
    buffer.write("RIFF", 0, "ascii");
    buffer.writeUInt32LE(buffer.length - 8, 4);
    buffer.write("WEBP", 8, "ascii");
    buffer.write(chunkType, 12, "ascii");
    return buffer;
  }

  test("probes JPEG dimensions by scanning to the SOF marker", async () => {
    // SOI, an APP0 segment that is skipped, a stray fill byte, then SOF0
    // (declared length 17, so the buffer must extend past offset 9 + 2 + 17).
    const buffer = Buffer.alloc(32);
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x01, 0x02, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08]).copy(buffer, 0);
    buffer.writeUInt16BE(100, 14); // height
    buffer.writeUInt16BE(200, 16); // width
    const filePath = await writeImage("dims.jpg", buffer);
    await expect(probeImageFile(filePath)).resolves.toEqual({
      format: "jpeg",
      height: 100,
      mediaType: "image/jpeg",
      width: 200
    });
  });

  test("throws when a JPEG carries no size marker", async () => {
    const filePath = await writeImage("eoi.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    await expect(probeImageFile(filePath)).rejects.toMatchObject({ code: "image_probe_invalid_jpeg" });
  });

  test("breaks out of the JPEG scan on an implausible segment length", async () => {
    const filePath = await writeImage("bad.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]));
    await expect(probeImageFile(filePath)).rejects.toMatchObject({ code: "image_probe_invalid_jpeg" });
  });

  test("probes WebP VP8X dimensions", async () => {
    const buffer = webpHeader("VP8X");
    buffer.writeUIntLE(640 - 1, 24, 3);
    buffer.writeUIntLE(480 - 1, 27, 3);
    await expect(probeImageFile(await writeImage("x.webp", buffer))).resolves.toMatchObject({
      format: "webp",
      height: 480,
      width: 640
    });
  });

  test("probes WebP lossless VP8L dimensions", async () => {
    const buffer = webpHeader("VP8L");
    buffer[20] = 0x2f;
    buffer.writeUInt32LE((100 - 1) | ((50 - 1) << 14), 21);
    await expect(probeImageFile(await writeImage("l.webp", buffer))).resolves.toMatchObject({
      format: "webp",
      height: 50,
      width: 100
    });
  });

  test("probes WebP lossy VP8 dimensions", async () => {
    const buffer = webpHeader("VP8 ");
    buffer[23] = 0x9d;
    buffer[24] = 0x01;
    buffer[25] = 0x2a;
    buffer.writeUInt16LE(100, 26);
    buffer.writeUInt16LE(50, 28);
    await expect(probeImageFile(await writeImage("v.webp", buffer))).resolves.toMatchObject({
      format: "webp",
      height: 50,
      width: 100
    });
  });

  test("rejects malformed VP8L, VP8, and unknown WebP chunks", async () => {
    const vp8l = webpHeader("VP8L");
    vp8l[20] = 0x00;
    await expect(probeImageFile(await writeImage("bad-l.webp", vp8l))).rejects.toMatchObject({
      code: "image_probe_invalid_webp"
    });

    await expect(probeImageFile(await writeImage("bad-v.webp", webpHeader("VP8 ")))).rejects.toMatchObject({
      code: "image_probe_invalid_webp"
    });

    await expect(probeImageFile(await writeImage("bad-c.webp", webpHeader("ABCD")))).rejects.toMatchObject({
      code: "image_probe_invalid_webp"
    });
  });
});
