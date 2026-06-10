import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect } from "vitest";

import { createDefaultAppConfig, createVoiceServiceFromConfig } from "@/core";
import { createLiveTestHarness, envFlag } from "./helpers";

const { createTempRoot: createLiveTempRoot, liveTest } = createLiveTestHarness({
  enabled: envFlag("AIA_RUN_LIVE_VOICE_TESTS") && process.platform === "darwin",
  prefix: "aiagent-live-voice-"
});

describe("voice service live", () => {
  liveTest("lists voices and synthesizes speech with local macOS providers", async () => {
    const root = await createTempRoot();
    const config = createDefaultAppConfig({
      userStateDirectory: path.join(root, "user")
    });
    config.voice.artifactRoot = path.join(root, ".aia", "voice");
    config.voice.defaultLocale = "en-US";

    const service = createVoiceServiceFromConfig(config);
    try {
      const providerHealth = await service.listProviderHealth();
      expect(providerHealth.some((entry) => entry.providerId === "local_system" && entry.status === "healthy")).toBe(true);

      const voices = await service.listVoices({
        providerId: "local_system"
      });
      expect(voices.length).toBeGreaterThan(0);

      const synthesis = await service.synthesize({
        id: "voice.live.synthesis.1",
        locale: "en-US",
        metadata: {},
        providerId: "local_system",
        text: "AIAgent live voice synthesis check",
        voice: voices[0]?.id
      });

      const synthesisPath = fileURLToPath(synthesis.audio.uri);
      expect(synthesis.providerId).toBe("local_system");
      await expect(fs.stat(synthesisPath)).resolves.toMatchObject({
        isFile: expect.any(Function)
      });
    } finally {
      await service.dispose();
    }
  });

  liveTest("transcribes synthesized speech through the Apple native STT adapter", async () => {
    const root = await createTempRoot();
    const config = createDefaultAppConfig({
      userStateDirectory: path.join(root, "user")
    });
    config.voice.artifactRoot = path.join(root, ".aia", "voice");
    config.voice.defaultLocale = "en-US";

    const service = createVoiceServiceFromConfig(config);
    try {
      const synthesis = await service.synthesize({
        id: "voice.live.synthesis.2",
        locale: "en-US",
        metadata: {},
        providerId: "local_system",
        text: "AIAgent live transcription check",
        voice: "Allison"
      });

      const transcription = await service.transcribe({
        audio: synthesis.audio,
        id: "voice.live.transcription.1",
        locale: "en-US",
        metadata: {},
        providerId: "apple_native"
      });

      expect(transcription.providerId).toBe("apple_native");
      expect(transcription.text.trim().length).toBeGreaterThan(0);
    } finally {
      await service.dispose();
    }
  });
});

async function createTempRoot(): Promise<string> {
  return createLiveTempRoot();
}
