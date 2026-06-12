import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  buildVoiceArtifactPath,
  buildVoiceAudioArtifact,
  createVoiceError,
  isTerminalVoiceStatus,
  normalizeLocale,
  normalizeVoiceError,
  probeAudioDurationMs,
  runProcess,
  stableArtifactId,
  voiceInputPathFromUri,
  writeIfChanged
} from "@/core/voice/utils";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-voice-utils-"));
  tempRoots.push(root);
  return root;
}

function buildWavBuffer(seconds: number, sampleRate = 8000): Buffer {
  const numSamples = seconds * sampleRate;
  const dataLength = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataLength);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataLength, 40);
  return buffer;
}

describe("voice utils", () => {
  test("buildVoiceArtifactPath composes provider/session/extension segments", () => {
    expect(
      buildVoiceArtifactPath({
        artifactRoot: "/voice",
        extension: ".wav",
        id: "job.1",
        kind: "captures",
        providerId: "apple_native",
        sessionId: "session.7"
      })
    ).toBe(path.join("/voice", "captures", "apple_native", "session.7", "job.1.wav"));
  });

  test("buildVoiceArtifactPath falls back to a shared bucket without a session", () => {
    expect(
      buildVoiceArtifactPath({
        artifactRoot: "/voice",
        extension: "mp3",
        id: "job.2",
        kind: "synthesis",
        providerId: "local_system"
      })
    ).toBe(path.join("/voice", "synthesis", "local_system", "shared", "job.2.mp3"));
  });

  test("buildVoiceAudioArtifact builds an audio reference with optional metadata", async () => {
    const root = await createTempRoot();
    const filePath = path.join(root, "clip.wav");
    await fs.writeFile(filePath, buildWavBuffer(1));

    const artifact = await buildVoiceAudioArtifact({
      filePath,
      locale: "en_US",
      mediaType: "audio/wav",
      name: "clip.wav",
      transcript: "hello",
      voice: "Samantha"
    });

    expect(artifact.kind).toBe("audio");
    expect(artifact.mediaType).toBe("audio/wav");
    expect(artifact.metadata.transcript).toBe("hello");
    expect(artifact.metadata.voice).toBe("Samantha");
    expect(artifact.metadata.locale).toBe("en_US");
  });

  test("createVoiceError defaults to non-retriable with empty details", () => {
    expect(createVoiceError("voice_x", "boom")).toEqual({
      code: "voice_x",
      details: {},
      message: "boom",
      retriable: false
    });
  });

  test("isTerminalVoiceStatus recognizes terminal states", () => {
    expect(isTerminalVoiceStatus("completed")).toBe(true);
    expect(isTerminalVoiceStatus("cancelled")).toBe(true);
    expect(isTerminalVoiceStatus("failed")).toBe(true);
    expect(isTerminalVoiceStatus("running")).toBe(false);
  });

  test("normalizeLocale converts underscores and passes through empties", () => {
    expect(normalizeLocale("en_US")).toBe("en-US");
    expect(normalizeLocale("en-GB")).toBe("en-GB");
    expect(normalizeLocale(undefined)).toBeUndefined();
  });

  test("normalizeVoiceError handles structured errors, Errors, and primitives", () => {
    const structured = createVoiceError("voice_existing", "already structured");
    expect(normalizeVoiceError(structured)).toBe(structured);
    expect(normalizeVoiceError(new Error("native crash"))).toMatchObject({
      code: "voice_operation_failed",
      message: "native crash"
    });
    expect(normalizeVoiceError("string failure", "voice_custom")).toMatchObject({
      code: "voice_custom",
      message: "string failure"
    });
  });

  test("stableArtifactId is deterministic and prefixed", () => {
    const first = stableArtifactId("voice", "same-seed");
    expect(first).toBe(stableArtifactId("voice", "same-seed"));
    expect(first.startsWith("voice.")).toBe(true);
    expect(first).not.toBe(stableArtifactId("voice", "other-seed"));
  });

  test("voiceInputPathFromUri accepts file URIs and absolute paths, rejects relative", () => {
    const absolute = path.resolve("/tmp/clip.wav");
    expect(voiceInputPathFromUri(`file://${absolute}`)).toBe(absolute);
    expect(voiceInputPathFromUri(absolute)).toBe(absolute);
    expect(() => voiceInputPathFromUri("relative/clip.wav")).toThrowError(/local file URI/u);
  });

  test("writeIfChanged writes new content, skips identical writes, and overwrites changes", async () => {
    const root = await createTempRoot();
    const filePath = path.join(root, "nested", "out.txt");

    await writeIfChanged(filePath, "alpha");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("alpha");

    // Identical content takes the early-return branch (mtime unchanged).
    const before = (await fs.stat(filePath)).mtimeMs;
    await writeIfChanged(filePath, "alpha");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("alpha");
    expect((await fs.stat(filePath)).mtimeMs).toBe(before);

    await writeIfChanged(filePath, "beta");
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("beta");
  });

  test("runProcess captures stdout and stdin and reports exit codes", async () => {
    const success = await runProcess(process.execPath, ["-e", "process.stdout.write('captured')"]);
    expect(success.exitCode).toBe(0);
    expect(success.stdout).toBe("captured");
    expect(success.timedOut).toBe(false);

    const echoed = await runProcess(
      process.execPath,
      ["-e", "process.stdin.on('data', (c) => process.stdout.write(c))"],
      { stdinText: "piped-input" }
    );
    expect(echoed.stdout).toBe("piped-input");

    const failure = await runProcess(process.execPath, ["-e", "process.exit(3)"]);
    expect(failure.exitCode).toBe(3);
  });

  test("runProcess enforces a timeout by killing the child", async () => {
    const result = await runProcess(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      timeoutMs: 50
    });
    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGTERM");
  });

  test("runProcess rejects when the command cannot be spawned", async () => {
    await expect(
      runProcess(path.join(os.tmpdir(), "definitely-not-a-real-binary-xyz"), [])
    ).rejects.toBeInstanceOf(Error);
  });

  test("probeAudioDurationMs returns undefined for unreadable inputs", async () => {
    const root = await createTempRoot();
    const bogus = path.join(root, "not-audio.bin");
    await fs.writeFile(bogus, "not really audio");
    // On darwin afinfo exits non-zero (undefined); on other platforms the
    // platform guard returns undefined immediately.
    await expect(probeAudioDurationMs(bogus)).resolves.toBeUndefined();
  });
});
