import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { LocalSystemVoiceAdapter } from "@/core";

const tempRoots: string[] = [];
const isDarwin = process.platform === "darwin";
const darwinTest = isDarwin ? test : test.skip;

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-voice-local-"));
  tempRoots.push(root);
  return root;
}

async function writeScript(root: string, name: string, body: string): Promise<string> {
  const scriptPath = path.join(root, name);
  await fs.writeFile(scriptPath, `#!/usr/bin/env node\n${body}`, "utf8");
  await fs.chmod(scriptPath, 0o755);
  return scriptPath;
}

const OK_SCRIPT = `
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "-v" && args[1] === "?") {
  process.stdout.write("Alex                en_US    # Hello.\\nDaniel              en_GB    # Hi.\\nNoLocaleLine here\\n");
  process.exit(0);
}
if (args[0] === "-a" && args[1] === "?") {
  process.stdout.write("0  Built-in Output\\n1  External Headphones\\n");
  process.exit(0);
}
const oIndex = args.indexOf("-o");
if (oIndex >= 0) { fs.writeFileSync(args[oIndex + 1], "FORM-fake-aiff"); process.exit(0); }
process.exit(0);
`;

const FAIL_SCRIPT = `
process.stderr.write("say: boom\\n");
process.exit(1);
`;

const EMPTY_DEVICES_SCRIPT = `
const args = process.argv.slice(2);
if (args[0] === "-a" && args[1] === "?") { process.exit(0); }
process.exit(0);
`;

describe("LocalSystemVoiceAdapter", () => {
  darwinTest("reports healthy status and parses say voice/device output", async () => {
    const root = await tempRoot();
    const sayPath = await writeScript(root, "say-ok.mjs", OK_SCRIPT);
    const adapter = new LocalSystemVoiceAdapter({
      artifactRoot: path.join(root, "artifacts"),
      defaultOutputDevice: "Built-in Output",
      defaultVoice: "Alex",
      providerId: "local_system",
      sayPath
    });

    await expect(adapter.health()).resolves.toMatchObject({ providerId: "local_system", status: "healthy" });

    const voices = await adapter.listVoices();
    expect(voices.map((voice) => voice.displayName)).toEqual(["Alex", "Daniel"]);
    expect(voices.find((voice) => voice.displayName === "Alex")?.default).toBe(true);

    const devices = await adapter.listDevices("output");
    expect(devices.map((device) => device.name)).toEqual(["Built-in Output", "External Headphones"]);
    expect(devices[0]?.default).toBe(true);

    // Non-output device kinds short-circuit.
    await expect(adapter.listDevices("input")).resolves.toEqual([]);
  });

  darwinTest("synthesizes speech to an audio artifact and plays text", async () => {
    const root = await tempRoot();
    const sayPath = await writeScript(root, "say-synth.mjs", OK_SCRIPT);
    const adapter = new LocalSystemVoiceAdapter({
      artifactRoot: path.join(root, "artifacts"),
      defaultVoice: "Alex",
      providerId: "local_system",
      sayPath
    });

    const result = await adapter.synthesize({ id: "synthesis.1", metadata: {}, providerId: "local_system", text: "hello" });
    expect(result.audio.kind).toBe("audio");
    expect(result.audio.mediaType).toBe("audio/aiff");

    const playback = await adapter.playback({
      id: "playback.1",
      metadata: {},
      providerId: "local_system",
      sessionId: "session.v",
      text: "speak this",
      voice: "Daniel"
    });
    expect(playback.status).toBe("completed");
  });

  darwinTest("rejects audio playback to a specific output device", async () => {
    const root = await tempRoot();
    const sayPath = await writeScript(root, "say-dev.mjs", OK_SCRIPT);
    const adapter = new LocalSystemVoiceAdapter({ artifactRoot: path.join(root, "artifacts"), providerId: "local_system", sayPath });

    await expect(
      adapter.playback({
        audio: {
          byteLength: 4,
          id: "artifact.audio.1",
          kind: "audio",
          mediaType: "audio/aiff",
          metadata: {},
          name: "clip.aiff",
          sha256: "a".repeat(64),
          uri: "file:///tmp/clip.aiff"
        },
        id: "playback.2",
        metadata: {},
        outputDevice: "External Headphones",
        providerId: "local_system"
      })
    ).rejects.toMatchObject({ code: "voice_playback_output_device_unsupported" });
  });

  darwinTest("falls back to the default output device when say reports none", async () => {
    const root = await tempRoot();
    const sayPath = await writeScript(root, "say-empty.mjs", EMPTY_DEVICES_SCRIPT);
    const adapter = new LocalSystemVoiceAdapter({
      artifactRoot: path.join(root, "artifacts"),
      defaultOutputDevice: "Configured Speaker",
      providerId: "local_system",
      sayPath
    });

    const devices = await adapter.listDevices();
    expect(devices).toEqual([
      expect.objectContaining({ default: true, name: "Configured Speaker" })
    ]);
  });

  darwinTest("surfaces failures from the say binary", async () => {
    const root = await tempRoot();
    const sayPath = await writeScript(root, "say-fail.mjs", FAIL_SCRIPT);
    const adapter = new LocalSystemVoiceAdapter({ artifactRoot: path.join(root, "artifacts"), providerId: "local_system", sayPath });

    await expect(adapter.health()).resolves.toMatchObject({ status: "degraded" });
    await expect(adapter.listVoices()).rejects.toMatchObject({ code: "voice_list_voices_failed" });
    await expect(adapter.listDevices()).rejects.toMatchObject({ code: "voice_output_device_list_failed" });
    await expect(
      adapter.synthesize({ id: "synthesis.2", metadata: {}, providerId: "local_system", text: "x" })
    ).rejects.toMatchObject({ code: "voice_synthesis_failed" });
    await expect(
      adapter.playback({ id: "playback.3", metadata: {}, providerId: "local_system", text: "x" })
    ).rejects.toMatchObject({ code: "voice_playback_failed" });
  });

  darwinTest("reports unavailable health when the say binary is missing", async () => {
    const adapter = new LocalSystemVoiceAdapter({
      artifactRoot: "/tmp/none",
      providerId: "local_system",
      sayPath: "/nonexistent/aiagent-say"
    });
    await expect(adapter.health()).resolves.toMatchObject({ status: "unavailable" });
  });

  test("returns unavailable health and no devices on non-macOS platforms", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    try {
      const adapter = new LocalSystemVoiceAdapter({ artifactRoot: "/tmp/none", providerId: "local_system" });
      await expect(adapter.health()).resolves.toMatchObject({ status: "unavailable" });
      await expect(adapter.listDevices()).resolves.toEqual([]);
    } finally {
      if (original) {
        Object.defineProperty(process, "platform", original);
      }
    }
  });
});
