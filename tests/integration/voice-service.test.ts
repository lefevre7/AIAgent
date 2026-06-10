import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  FileSessionStore,
  FileVoiceService,
  createDefaultAppConfig,
  type ProviderHealth,
  type SessionRecord,
  type VoiceAdapter,
  type VoiceCaptureRecord,
  type VoiceCaptureRequest,
  type VoicePlaybackRecord,
  type VoicePlaybackRequest
} from "@/core";
import { createArtifactReferenceFromFile } from "@/core/io/artifacts";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

describe("voice service", () => {
  test("selects providers by capability and persists capture/transcription records", async () => {
    const root = await createTempRoot();
    const stateRoot = path.join(root, ".aia");
    const sessions = new FileSessionStore(stateRoot);
    const session = buildSession(root);
    await sessions.saveSession(session);

    const config = createDefaultAppConfig({
      userStateDirectory: path.join(root, "user")
    });
    config.voice.artifactRoot = path.join(stateRoot, "voice");
    config.voice.defaultProviderId = "apple_native";
    config.voice.defaultSynthesisProviderId = "local_system";
    config.voice.defaultTranscriptionProviderId = "apple_native";

    const recordedInputPath = path.join(root, "input.wav");
    await fs.writeFile(recordedInputPath, "fake audio input", "utf8");
    const recordedInput = await createArtifactReferenceFromFile(recordedInputPath, "audio", {
      mediaType: "audio/wav",
      metadata: {},
      name: "input.wav"
    });

    const captureAdapter = await createFakeCaptureAdapter(root);
    const synthesisAdapter = await createFakeSynthesisAdapter(root);

    const service = new FileVoiceService({
      adapters: [captureAdapter, synthesisAdapter],
      config: config.voice,
      providerConfigs: config.providers.voiceProviders,
      sessions
    });

    const synthesis = await service.synthesize({
      id: "voice.synthesis.integration.1",
      metadata: {},
      sessionId: session.id,
      text: "Speak this"
    });
    expect(synthesis.providerId).toBe("local_system");

    const transcription = await service.transcribe({
      audio: recordedInput,
      id: "voice.transcription.integration.1",
      metadata: {},
      sessionId: session.id
    });
    expect(transcription.providerId).toBe("apple_native");
    expect(transcription.text).toContain("workspace");

    const capture = await service.startCapture({
      id: "voice.capture.integration.1",
      metadata: {},
      sessionId: session.id
    });
    expect(capture.status).toBe("recording");

    const completedCapture = await service.waitForCapture(capture.id);
    expect(completedCapture.status).toBe("completed");
    expect(completedCapture.text).toBe("captured transcript");

    const snapshot = await sessions.getSessionSnapshot(session.id);
    expect(snapshot?.voiceCaptures).toHaveLength(1);
    expect(snapshot?.voiceCaptures[0]?.text).toBe("captured transcript");
    expect(snapshot?.voicePlaybacks).toHaveLength(0);
    expect(snapshot?.voiceTranscriptions).toHaveLength(2);
    expect(snapshot?.voiceTranscriptions.map((record) => record.id)).toEqual(
      expect.arrayContaining(["voice.capture.integration.1.transcription", "voice.transcription.integration.1"])
    );

    await service.dispose();
  });
});

async function createFakeCaptureAdapter(root: string): Promise<VoiceAdapter> {
  const captureOutputPath = path.join(root, "capture.wav");
  await fs.writeFile(captureOutputPath, "fake captured audio", "utf8");
  const captureAudio = await createArtifactReferenceFromFile(captureOutputPath, "audio", {
    mediaType: "audio/wav",
    metadata: {
      durationMs: 900
    },
    name: "capture.wav"
  });
  const captures = new Map<string, VoiceCaptureRecord>();
  const health = providerHealth("apple_native");

  return {
    capabilities: ["capture", "device_list", "transcription"],
    getCapture: async (captureId) => captures.get(captureId) ?? null,
    health: async () => health,
    kind: "apple_native",
    listDevices: async () => [
      {
        default: true,
        id: "default-mic",
        kind: "input",
        metadata: {},
        name: "Default Microphone",
        providerId: "apple_native"
      }
    ],
    providerId: "apple_native",
    startCapture: async (request: VoiceCaptureRequest) => {
      const startedAt = new Date().toISOString();
      const initial = {
        id: request.id,
        inputDevice: request.inputDevice,
        locale: request.locale,
        maxDurationMs: request.maxDurationMs,
        metadata: request.metadata,
        providerId: request.providerId,
        sessionId: request.sessionId,
        silenceTimeoutMs: request.silenceTimeoutMs,
        startedAt,
        status: "recording" as const
      };
      captures.set(request.id, initial);
      setTimeout(() => {
        captures.set(request.id, {
          ...initial,
          audio: captureAudio,
          completedAt: new Date().toISOString(),
          status: "completed",
          stopReason: "silence",
          text: "captured transcript",
          transcriptionId: `${request.id}.transcription`
        });
      }, 10);
      return initial;
    },
    stopCapture: async (captureId) => {
      const current = captures.get(captureId);
      if (!current) {
        throw new Error(`Unknown capture ${captureId}`);
      }
      const finalRecord = {
        ...current,
        audio: captureAudio,
        completedAt: new Date().toISOString(),
        status: "completed" as const,
        stopReason: "manual" as const,
        text: "captured transcript",
        transcriptionId: `${captureId}.transcription`
      };
      captures.set(captureId, finalRecord);
      return finalRecord;
    },
    transcribe: async (request) => ({
      completedAt: new Date().toISOString(),
      durationMs: 700,
      id: request.id,
      locale: request.locale,
      metadata: request.metadata,
      providerId: request.providerId,
      text: "workspace transcription"
    })
  };
}

async function createFakeSynthesisAdapter(root: string): Promise<VoiceAdapter> {
  const synthesisOutputPath = path.join(root, "synth.aiff");
  await fs.writeFile(synthesisOutputPath, "fake synthesized audio", "utf8");
  const synthesisAudio = await createArtifactReferenceFromFile(synthesisOutputPath, "audio", {
    mediaType: "audio/aiff",
    metadata: {
      durationMs: 1100,
      transcript: "Speak this",
      voice: "Allison"
    },
    name: "synth.aiff"
  });

  return {
    capabilities: ["playback", "synthesis", "voice_list"],
    health: async () => providerHealth("local_system"),
    kind: "local_system",
    listVoices: async () => [
      {
        default: true,
        displayName: "Allison",
        id: "Allison",
        locale: "en-US",
        metadata: {},
        providerId: "local_system"
      }
    ],
    playback: async (request: VoicePlaybackRequest): Promise<VoicePlaybackRecord> => ({
      completedAt: new Date().toISOString(),
      id: request.id,
      metadata: request.metadata,
      outputDevice: request.outputDevice,
      providerId: request.providerId,
      sessionId: request.sessionId,
      startedAt: new Date().toISOString(),
      status: "completed",
      text: request.text,
      voice: request.voice
    }),
    providerId: "local_system",
    synthesize: async (request) => ({
      audio: {
        ...synthesisAudio,
        metadata: {
          ...synthesisAudio.metadata,
          transcript: request.text,
          voice: request.voice ?? "Allison"
        }
      },
      completedAt: new Date().toISOString(),
      durationMs: 1100,
      id: request.id,
      metadata: request.metadata,
      providerId: request.providerId
    })
  };
}

function buildSession(cwd: string): SessionRecord {
  return {
    createdAt: "2026-03-31T12:00:00.000Z",
    cwd,
    goal: "Exercise the voice service",
    id: "session.voice.service.1",
    lastActiveAt: "2026-03-31T12:00:00.000Z",
    metadata: { source: "test" },
    status: "awaiting_user",
    tags: [],
    title: "Voice Service Session",
    updatedAt: "2026-03-31T12:00:00.000Z"
  };
}

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-voice-service-"));
  tempRoots.push(root);
  return root;
}

function providerHealth(providerId: string): ProviderHealth {
  return {
    checkedAt: "2026-03-31T12:00:00.000Z",
    details: {},
    providerId,
    status: "healthy"
  };
}
