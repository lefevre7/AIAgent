import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { AppleNativeVoiceAdapter } from "@/core";
import type { ArtifactReference } from "@/core/contracts";

const tempRoots: string[] = [];
const isDarwin = process.platform === "darwin";
const darwinTest = isDarwin ? test : test.skip;

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-voice-apple-"));
  tempRoots.push(root);
  return root;
}

// A node stand-in for the compiled Swift helper. Speaks the JSON protocol the
// adapter expects, driven by subcommand + flags.
const FAKE_HELPER = `#!/usr/bin/env node
import fs from "node:fs";
const argv = process.argv.slice(2);
const sub = argv[0];
const val = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
if (sub === "list-input-devices") {
  process.stdout.write(JSON.stringify({ devices: [{ default: true, id: "mic-1", kind: "input", metadata: {}, name: "Built-in Microphone" }], ok: true }));
  process.exit(0);
}
if (sub === "transcribe") {
  const input = val("--input") ?? "";
  if (input.includes("empty")) { process.exit(0); }
  if (input.includes("badjson")) { process.stdout.write("not json{"); process.exit(0); }
  if (input.includes("fail")) {
    process.stdout.write(JSON.stringify({ error: { code: "voice_transcription_failed", details: {}, message: "could not transcribe" }, ok: false }));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ ok: true, result: { durationMs: 1200, locale: "en_US", text: "hello from helper" } }));
  process.exit(0);
}
if (sub === "capture") {
  const out = val("--output");
  if (out.includes("failcap")) {
    fs.writeFileSync(out, "RIFF-fake-wav");
    process.stdout.write(
      JSON.stringify({ capture: { outputPath: out, stopReason: "error" }, error: { code: "voice_capture_failed", details: {}, message: "mic error" }, ok: false }),
      () => process.exit(1)
    );
  } else if (out.includes("garbagecap")) {
    // Non-zero exit with stdout that is not valid JSON at all.
    fs.writeFileSync(out, "RIFF-fake-wav");
    process.stdout.write("totally not json", () => process.exit(1));
  } else if (out.includes("unexpectedcap")) {
    // Non-zero exit with valid JSON that does not match the failure schema.
    fs.writeFileSync(out, "RIFF-fake-wav");
    process.stdout.write(JSON.stringify({ unexpected: "shape" }), () => process.exit(1));
  } else {
    // Register the stop handler BEFORE signalling readiness so the test only
    // sends SIGINT once the handler is installed.
    process.on("SIGINT", () => {
      process.stdout.write(
        JSON.stringify({ capture: { durationMs: 800, locale: "en_US", outputPath: out, stopReason: "manual", text: "captured words" }, ok: true }),
        () => process.exit(0)
      );
    });
    fs.writeFileSync(out, "RIFF-fake-wav");
    fs.writeFileSync(out + ".ready", "1");
    setInterval(() => {}, 1000);
  }
} else {
  process.exit(0);
}
`;

async function writeExecutable(root: string, name: string, body: string): Promise<string> {
  const scriptPath = path.join(root, name);
  await fs.writeFile(scriptPath, body, "utf8");
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

async function fakeSwiftc(root: string, mode: "ok" | "fail"): Promise<string> {
  if (mode === "fail") {
    return writeExecutable(root, "swiftc-fail.mjs", `#!/usr/bin/env node\nprocess.stderr.write("compile error\\n");\nprocess.exit(1);\n`);
  }
  const body = `#!/usr/bin/env node
import fs from "node:fs";
const HELPER = ${JSON.stringify(FAKE_HELPER)};
const argv = process.argv.slice(2);
const out = argv[argv.indexOf("-o") + 1];
fs.writeFileSync(out, HELPER);
fs.chmodSync(out, 0o755);
process.exit(0);
`;
  return writeExecutable(root, "swiftc-ok.mjs", body);
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(filePath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}.`);
}

async function waitForTerminalCapture(adapter: AppleNativeVoiceAdapter, captureId: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const record = await adapter.getCapture(captureId);
    if (record && record.status !== "recording" && record.status !== "running") {
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for capture ${captureId} to finish.`);
}

function audioArtifact(uri: string): ArtifactReference {
  return {
    byteLength: 8,
    id: "artifact.audio.in",
    kind: "audio",
    mediaType: "audio/wav",
    metadata: {},
    name: "in.wav",
    sha256: "a".repeat(64),
    uri
  };
}

describe("AppleNativeVoiceAdapter", () => {
  darwinTest("reports healthy status once the helper compiles and lists input devices", async () => {
    const root = await tempRoot();
    const adapter = new AppleNativeVoiceAdapter({
      artifactRoot: root,
      providerId: "apple_native",
      requireOnDeviceRecognition: false,
      swiftCompilerPath: await fakeSwiftc(root, "ok")
    });

    await expect(adapter.health()).resolves.toMatchObject({ providerId: "apple_native", status: "healthy" });

    const devices = await adapter.listDevices("input");
    expect(devices).toEqual([expect.objectContaining({ kind: "input", name: "Built-in Microphone" })]);
    await expect(adapter.listDevices("output")).resolves.toEqual([]);
  });

  darwinTest("reports unavailable health when the helper fails to compile", async () => {
    const root = await tempRoot();
    const adapter = new AppleNativeVoiceAdapter({
      artifactRoot: root,
      providerId: "apple_native",
      requireOnDeviceRecognition: true,
      swiftCompilerPath: await fakeSwiftc(root, "fail")
    });
    await expect(adapter.health()).resolves.toMatchObject({ status: "unavailable" });
  });

  darwinTest("transcribes audio and surfaces helper failures and malformed output", async () => {
    const root = await tempRoot();
    const adapter = new AppleNativeVoiceAdapter({
      artifactRoot: root,
      providerId: "apple_native",
      requireOnDeviceRecognition: false,
      swiftCompilerPath: await fakeSwiftc(root, "ok")
    });

    const ok = await adapter.transcribe({
      audio: audioArtifact("file:///tmp/in.wav"),
      id: "transcription.1",
      metadata: {},
      providerId: "apple_native"
    });
    expect(ok.text).toBe("hello from helper");
    expect(ok.locale).toBe("en-US");

    await expect(
      adapter.transcribe({ audio: audioArtifact("file:///tmp/fail.wav"), id: "transcription.2", metadata: {}, providerId: "apple_native" })
    ).rejects.toMatchObject({ code: "voice_transcription_failed" });

    await expect(
      adapter.transcribe({ audio: audioArtifact("file:///tmp/empty.wav"), id: "transcription.3", metadata: {}, providerId: "apple_native" })
    ).rejects.toMatchObject({ code: "voice_helper_empty_output" });

    await expect(
      adapter.transcribe({ audio: audioArtifact("file:///tmp/badjson.wav"), id: "transcription.4", metadata: {}, providerId: "apple_native" })
    ).rejects.toMatchObject({ code: "voice_helper_invalid_json" });
  });

  darwinTest("captures audio, exposes the active record, and finalizes on stop", async () => {
    const root = await tempRoot();
    const adapter = new AppleNativeVoiceAdapter({
      artifactRoot: root,
      providerId: "apple_native",
      requireOnDeviceRecognition: false,
      swiftCompilerPath: await fakeSwiftc(root, "ok")
    });

    const started = await adapter.startCapture({
      id: "capture.ok.1",
      inputDevice: "mic-1",
      locale: "en-US",
      maxDurationMs: 30_000,
      metadata: {},
      providerId: "apple_native",
      sessionId: "session.v",
      silenceTimeoutMs: 4_000
    });
    expect(started.status).toBe("recording");
    const active = await adapter.getCapture("capture.ok.1");
    expect(active).toMatchObject({ id: "capture.ok.1" });

    // Wait until the helper has installed its stop handler before signalling.
    const outputPath = active?.metadata.outputPath as string;
    await waitForFile(`${outputPath}.ready`);

    const finished = await adapter.stopCapture("capture.ok.1");
    expect(finished.status).toBe("completed");
    expect(finished.stopReason).toBe("manual");
    expect(finished.text).toBe("captured words");
    expect(finished.audio?.kind).toBe("audio");

    await adapter.dispose();
  });

  darwinTest("finalizes a failed capture when the helper exits with an error", async () => {
    const root = await tempRoot();
    const adapter = new AppleNativeVoiceAdapter({
      artifactRoot: root,
      providerId: "apple_native",
      requireOnDeviceRecognition: false,
      swiftCompilerPath: await fakeSwiftc(root, "ok")
    });

    const started = await adapter.startCapture({ id: "capture.failcap.1", metadata: {}, providerId: "apple_native" });
    expect(started.status).toBe("recording");
    // The helper self-terminates with a failure payload; poll for the result.
    const finished = await waitForTerminalCapture(adapter, "capture.failcap.1");
    expect(finished.status).toBe("failed");
    expect(finished.error?.code).toBe("voice_capture_failed");
  });

  darwinTest("finalizes captures with invalid and unexpected helper output", async () => {
    const root = await tempRoot();
    const adapter = new AppleNativeVoiceAdapter({
      artifactRoot: root,
      providerId: "apple_native",
      requireOnDeviceRecognition: false,
      swiftCompilerPath: await fakeSwiftc(root, "ok")
    });

    // Invalid JSON → the finalize step throws and is reported as finalize-failed.
    await adapter.startCapture({ id: "capture.garbagecap.1", metadata: {}, providerId: "apple_native" });
    const garbage = await waitForTerminalCapture(adapter, "capture.garbagecap.1");
    expect(garbage.status).toBe("failed");
    expect(garbage.error?.code).toBe("voice_capture_finalize_failed");

    // Valid JSON that is not a structured failure payload → generic capture failure.
    await adapter.startCapture({ id: "capture.unexpectedcap.1", metadata: {}, providerId: "apple_native" });
    const unexpected = await waitForTerminalCapture(adapter, "capture.unexpectedcap.1");
    expect(unexpected.status).toBe("failed");
    expect(unexpected.error?.code).toBe("voice_capture_failed");
  });

  darwinTest("rejects stopping an unknown capture", async () => {
    const root = await tempRoot();
    const adapter = new AppleNativeVoiceAdapter({
      artifactRoot: root,
      providerId: "apple_native",
      requireOnDeviceRecognition: false,
      swiftCompilerPath: await fakeSwiftc(root, "ok")
    });
    await expect(adapter.stopCapture("capture.missing")).rejects.toMatchObject({ code: "voice_capture_not_found" });
    await expect(adapter.getCapture("capture.missing")).resolves.toBeNull();
  });

  test("reports unavailable on non-macOS platforms", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    try {
      const adapter = new AppleNativeVoiceAdapter({
        artifactRoot: "/tmp/none",
        providerId: "apple_native",
        requireOnDeviceRecognition: false
      });
      await expect(adapter.health()).resolves.toMatchObject({ status: "unavailable" });
    } finally {
      if (original) {
        Object.defineProperty(process, "platform", original);
      }
    }
  });
});

describe("AppleNativeVoiceAdapter helper caching", () => {
  darwinTest("reuses a previously compiled helper binary across adapter instances", async () => {
    const root = await tempRoot();
    const swiftc = await fakeSwiftc(root, "ok");

    const first = new AppleNativeVoiceAdapter({ artifactRoot: root, providerId: "apple_native", requireOnDeviceRecognition: false, swiftCompilerPath: swiftc });
    await expect(first.health()).resolves.toMatchObject({ status: "healthy" });

    // A fresh adapter pointing at the same artifact root should hit the on-disk
    // hash cache and skip recompilation.
    const second = new AppleNativeVoiceAdapter({
      artifactRoot: root,
      providerId: "apple_native",
      requireOnDeviceRecognition: false,
      swiftCompilerPath: "/nonexistent/swiftc-should-not-run"
    });
    await expect(second.health()).resolves.toMatchObject({ status: "healthy" });
    const devices = await second.listDevices("input");
    expect(devices.length).toBeGreaterThanOrEqual(1);
  });
});
