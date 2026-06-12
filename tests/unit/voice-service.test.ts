import { describe, expect, test, vi } from "vitest";

import {
  FileVoiceService,
  createDefaultAppConfig,
  createVoiceServiceFromConfig,
  type AppConfig,
  type ArtifactReference,
  type VoiceAdapter
} from "@/core";

const ISO = "2026-06-10T00:00:00.000Z";

function audioArtifact(): ArtifactReference {
  return {
    byteLength: 8,
    id: "artifact.audio.1",
    kind: "audio",
    mediaType: "audio/wav",
    metadata: { durationMs: 1000 },
    name: "clip.wav",
    sha256: "a".repeat(64),
    uri: "file:///tmp/clip.wav"
  };
}

function baseVoiceConfig(): AppConfig["voice"] {
  const config = createDefaultAppConfig({ userStateDirectory: "/tmp/aiagent-voice-home" });
  return {
    ...config.voice,
    defaultProviderId: "fake",
    defaultSynthesisProviderId: "fake",
    defaultTranscriptionProviderId: "fake"
  };
}

function fakeAdapter(overrides: Partial<VoiceAdapter> & Pick<VoiceAdapter, "capabilities" | "providerId">): VoiceAdapter {
  return {
    health: async () => ({ checkedAt: ISO, details: {}, providerId: overrides.providerId, status: "healthy" }),
    ...overrides
  } as VoiceAdapter;
}

function buildSessions() {
  return {
    appendVoiceCapture: vi.fn(async () => undefined),
    appendVoicePlayback: vi.fn(async () => undefined),
    appendVoiceTranscription: vi.fn(async () => undefined)
  };
}

function buildService(adapters: VoiceAdapter[], sessions = buildSessions()) {
  const service = new FileVoiceService({
    adapters,
    config: baseVoiceConfig(),
    pollIntervalMs: 1,
    providerConfigs: {},
    sessions: sessions as never
  });
  return { service, sessions };
}

describe("FileVoiceService routing and discovery", () => {
  test("lists provider health for one and all providers", async () => {
    const { service } = buildService([
      fakeAdapter({ capabilities: ["synthesis"], providerId: "fake" }),
      fakeAdapter({ capabilities: ["transcription"], providerId: "other" })
    ]);
    await expect(service.listProviderHealth("fake")).resolves.toHaveLength(1);
    await expect(service.listProviderHealth()).resolves.toHaveLength(2);
  });

  test("requireAdapter throws for unknown providers", async () => {
    const { service } = buildService([fakeAdapter({ capabilities: ["synthesis"], providerId: "fake" })]);
    await expect(service.listProviderHealth("missing")).rejects.toMatchObject({ code: "voice_provider_not_found" });
  });

  test("listVoices filters by locale and sorts by display name", async () => {
    const { service } = buildService([
      fakeAdapter({
        capabilities: ["voice_list"],
        listVoices: async () => [
          { default: false, displayName: "Zara", id: "z", locale: "en-US", metadata: {}, providerId: "fake" },
          { default: true, displayName: "Allison", id: "a", locale: "en-GB", metadata: {}, providerId: "fake" },
          { default: false, displayName: "Klaus", id: "k", locale: "de-DE", metadata: {}, providerId: "fake" }
        ],
        providerId: "fake"
      })
    ]);

    const all = await service.listVoices();
    expect(all.map((voice) => voice.displayName)).toEqual(["Allison", "Klaus", "Zara"]);

    const enOnly = await service.listVoices({ locale: "en" });
    expect(enOnly.map((voice) => voice.displayName)).toEqual(["Allison", "Zara"]);
  });

  test("requireCapability rejects providers missing the capability", async () => {
    const { service } = buildService([fakeAdapter({ capabilities: ["synthesis"], providerId: "fake" })]);
    await expect(service.listVoices({ providerId: "fake" })).rejects.toMatchObject({
      code: "voice_provider_capability_missing"
    });
  });

  test("listDevices filters by kind across capable adapters", async () => {
    const { service } = buildService([
      fakeAdapter({
        capabilities: ["device_list"],
        listDevices: async () => [
          { default: true, id: "mic", kind: "input", metadata: {}, name: "Mic", providerId: "fake" },
          { default: false, id: "spk", kind: "output", metadata: {}, name: "Speaker", providerId: "fake" }
        ],
        providerId: "fake"
      })
    ]);
    const inputs = await service.listDevices({ kind: "input" });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.kind).toBe("input");
  });
});

describe("FileVoiceService synthesis, transcription, playback", () => {
  test("synthesize routes to a capable adapter and returns its result", async () => {
    const synthesize = vi.fn(async (request: { id: string; providerId: string; voice?: string }) => ({
      audio: audioArtifact(),
      completedAt: ISO,
      durationMs: 1000,
      id: request.id,
      metadata: {},
      providerId: request.providerId
    }));
    const { service } = buildService([fakeAdapter({ capabilities: ["synthesis"], providerId: "fake", synthesize })]);

    const result = await service.synthesize({ id: "synthesis.1", metadata: {}, text: "hello there", voice: "Allison" });
    expect(result.audio.kind).toBe("audio");
    expect(synthesize).toHaveBeenCalledOnce();
  });

  test("resolveProviderId throws when nothing supports the capability", async () => {
    const { service } = buildService([fakeAdapter({ capabilities: ["transcription"], providerId: "fake" })]);
    await expect(service.synthesize({ id: "synthesis.2", metadata: {}, text: "hi" })).rejects.toMatchObject({
      code: "voice_provider_unavailable"
    });
  });

  test("synthesize honors an explicitly requested providerId", async () => {
    const synthesize = vi.fn(async (request: { id: string; providerId: string }) => ({
      audio: audioArtifact(),
      completedAt: ISO,
      durationMs: 500,
      id: request.id,
      metadata: {},
      providerId: request.providerId
    }));
    const { service } = buildService([
      fakeAdapter({ capabilities: ["synthesis"], providerId: "fake", synthesize }),
      fakeAdapter({ capabilities: ["synthesis"], providerId: "other" })
    ]);

    const result = await service.synthesize({ id: "synthesis.explicit", metadata: {}, providerId: "fake", text: "explicit route" });
    expect(result.providerId).toBe("fake");
    expect(synthesize).toHaveBeenCalledOnce();
  });

  test("waitForCapture rejects when the capture id is unknown", async () => {
    const { service } = buildService([fakeAdapter({ capabilities: ["capture"], providerId: "fake" })]);
    await expect(service.waitForCapture("capture.does-not-exist")).rejects.toMatchObject({
      code: "voice_capture_not_found"
    });
  });

  test("transcribe persists in-flight and completed records", async () => {
    const { service, sessions } = buildService([
      fakeAdapter({
        capabilities: ["transcription"],
        providerId: "fake",
        transcribe: async (request) => ({
          completedAt: ISO,
          durationMs: 900,
          id: request.id,
          locale: "en-US",
          metadata: {},
          providerId: request.providerId,
          text: "transcribed text"
        })
      })
    ]);

    const result = await service.transcribe({
      audio: audioArtifact(),
      id: "transcription.1",
      metadata: {},
      sessionId: "session.v"
    });
    expect(result.text).toBe("transcribed text");
    expect(sessions.appendVoiceTranscription).toHaveBeenCalledTimes(2);
  });

  test("transcribe records a failure and rethrows a structured error", async () => {
    const { service, sessions } = buildService([
      fakeAdapter({
        capabilities: ["transcription"],
        providerId: "fake",
        transcribe: async () => {
          throw new Error("decoder failed");
        }
      })
    ]);

    await expect(
      service.transcribe({ audio: audioArtifact(), id: "transcription.2", metadata: {}, sessionId: "session.v" })
    ).rejects.toMatchObject({ code: "voice_transcription_failed" });
    expect(sessions.appendVoiceTranscription).toHaveBeenCalledTimes(2);
  });

  test("playback persists the initial and final records on success", async () => {
    const { service, sessions } = buildService([
      fakeAdapter({
        capabilities: ["playback"],
        playback: async (request) => ({
          completedAt: ISO,
          id: request.id,
          metadata: {},
          providerId: request.providerId,
          sessionId: request.sessionId,
          startedAt: ISO,
          status: "completed",
          text: request.text
        }),
        providerId: "fake"
      })
    ]);

    const record = await service.playback({ id: "playback.1", metadata: {}, sessionId: "session.v", text: "say this" });
    expect(record.status).toBe("completed");
    expect(sessions.appendVoicePlayback).toHaveBeenCalledTimes(2);
  });

  test("playback records a failure and rethrows", async () => {
    const { service, sessions } = buildService([
      fakeAdapter({
        capabilities: ["playback"],
        playback: async () => {
          throw new Error("device busy");
        },
        providerId: "fake"
      })
    ]);

    await expect(
      service.playback({ id: "playback.2", metadata: {}, sessionId: "session.v", text: "say this" })
    ).rejects.toMatchObject({ code: "voice_playback_failed" });
    expect(sessions.appendVoicePlayback).toHaveBeenCalledTimes(2);
  });
});

describe("FileVoiceService capture lifecycle", () => {
  function captureAdapter() {
    const started = { id: "capture.1", metadata: {}, providerId: "fake", sessionId: "session.v", startedAt: ISO, status: "capturing" };
    const terminal = {
      audio: audioArtifact(),
      completedAt: ISO,
      id: "capture.1",
      locale: "en-US",
      metadata: {},
      providerId: "fake",
      sessionId: "session.v",
      startedAt: ISO,
      status: "completed",
      text: "captured words",
      transcriptionId: "transcription.cap.1"
    };
    return fakeAdapter({
      capabilities: ["capture", "transcription"],
      getCapture: async () => terminal as never,
      providerId: "fake",
      startCapture: async () => started as never,
      stopCapture: async () => terminal as never
    });
  }

  test("startCapture tracks the job and waitForCapture resolves to the terminal record", async () => {
    const { service, sessions } = buildService([captureAdapter()]);
    const started = await service.startCapture({ id: "capture.1", metadata: {}, sessionId: "session.v" });
    expect(started.status).toBe("capturing");

    const finished = await service.waitForCapture("capture.1");
    expect(finished.status).toBe("completed");
    // terminal capture persists both the capture and a derived transcription record.
    expect(sessions.appendVoiceCapture).toHaveBeenCalled();
    expect(sessions.appendVoiceTranscription).toHaveBeenCalled();
  });

  test("getCapture locates a record by scanning capable adapters", async () => {
    const { service } = buildService([captureAdapter()]);
    await expect(service.getCapture("capture.1")).resolves.toMatchObject({ id: "capture.1", status: "completed" });
  });

  test("stopCapture returns immediately when the adapter reports a terminal status", async () => {
    const { service } = buildService([captureAdapter()]);
    await expect(service.stopCapture("capture.1")).resolves.toMatchObject({ status: "completed" });
  });

  test("stopCapture throws when the capture cannot be located", async () => {
    const { service } = buildService([
      fakeAdapter({ capabilities: ["capture"], getCapture: async () => null, providerId: "fake", stopCapture: async () => null as never })
    ]);
    await expect(service.stopCapture("missing")).rejects.toMatchObject({ code: "voice_capture_not_found" });
  });

  test("getCapture returns null when no adapter knows the capture", async () => {
    const { service } = buildService([fakeAdapter({ capabilities: ["capture"], getCapture: async () => null, providerId: "fake" })]);
    await expect(service.getCapture("unknown")).resolves.toBeNull();
  });
});

describe("createVoiceServiceFromConfig", () => {
  test("builds a service from enabled providers", () => {
    const config = createDefaultAppConfig({ userStateDirectory: "/tmp/aiagent-voice-home" });
    const service = createVoiceServiceFromConfig(config);
    expect(service).toBeInstanceOf(FileVoiceService);
  });

  test("skips disabled providers", async () => {
    const config = createDefaultAppConfig({ userStateDirectory: "/tmp/aiagent-voice-home" });
    config.providers.voiceProviders.apple_native.enabled = false;
    config.providers.voiceProviders.local_system.enabled = false;
    const service = createVoiceServiceFromConfig(config);
    await expect(service.listProviderHealth()).resolves.toEqual([]);
  });

  test("throws for an unsupported provider kind", () => {
    const config = createDefaultAppConfig({ userStateDirectory: "/tmp/aiagent-voice-home" });
    const broken = {
      ...config,
      providers: {
        ...config.providers,
        voiceProviders: {
          mystery: { enabled: true, kind: "mystery_engine" }
        }
      }
    } as unknown as AppConfig;
    expect(() => createVoiceServiceFromConfig(broken)).toThrow(/not implemented yet/u);
  });
});

describe("FileVoiceService capture scan fallback", () => {
  test("waitForCapture locates an untracked capture by scanning capable adapters", async () => {
    const terminal = {
      audio: audioArtifact(),
      id: "capture.scan.1",
      metadata: {},
      providerId: "fake",
      startedAt: ISO,
      status: "completed",
      text: "captured words",
      transcriptionId: "transcription.scan"
    };
    const adapter = fakeAdapter({
      capabilities: ["capture", "transcription"],
      getCapture: async () => terminal as never,
      providerId: "fake"
    });
    const { service } = buildService([adapter]);

    // No startCapture on this service instance → exercises locateCapture's scan.
    const record = await service.waitForCapture("capture.scan.1");
    expect(record.status).toBe("completed");
    await expect(service.getCapture("capture.scan.1")).resolves.toMatchObject({ id: "capture.scan.1" });
  });
});
