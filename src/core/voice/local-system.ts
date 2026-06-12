import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type {
  ProviderHealth,
  SynthesisRequest,
  SynthesisResult,
  VoiceAdapter,
  VoiceCapability,
  VoiceDescriptor,
  VoiceDeviceDescriptor,
  VoiceDeviceKind,
  VoicePlaybackRecord,
  VoicePlaybackRequest
} from "@/core/contracts";
import { synthesisResultSchema, voiceDescriptorSchema, voiceDeviceDescriptorSchema, voicePlaybackRecordSchema } from "@/core/contracts";

import {
  buildVoiceArtifactPath,
  buildVoiceAudioArtifact,
  createVoiceError,
  normalizeLocale,
  probeAudioDurationMs,
  runProcess,
  voiceInputPathFromUri
} from "@/core/voice/utils";

const sayVoiceLineSchema = z
  .object({
    displayName: z.string().min(1),
    locale: z.string().min(1).optional()
  })
  .strict();

export type LocalSystemVoiceAdapterOptions = {
  artifactRoot: string;
  defaultOutputDevice?: string;
  defaultVoice?: string;
  providerId: string;
  sayPath?: string;
};

export class LocalSystemVoiceAdapter implements VoiceAdapter {
  readonly capabilities: VoiceCapability[] = ["device_list", "playback", "synthesis", "voice_list"];
  readonly kind = "local_system" as const;
  readonly providerId: string;

  private readonly artifactRoot: string;
  private readonly defaultOutputDevice?: string;
  private readonly defaultVoice?: string;
  private readonly sayPath: string;

  constructor(options: LocalSystemVoiceAdapterOptions) {
    this.artifactRoot = options.artifactRoot;
    this.defaultOutputDevice = options.defaultOutputDevice;
    this.defaultVoice = options.defaultVoice;
    this.providerId = options.providerId;
    this.sayPath = options.sayPath ?? "/usr/bin/say";
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    if (process.platform !== "darwin") {
      return {
        checkedAt,
        details: {
          reason: "local_system voice is available on macOS only."
        },
        providerId: this.providerId,
        status: "unavailable"
      };
    }

    try {
      const result = await runProcess(this.sayPath, ["-v", "?"]);
      return {
        checkedAt,
        details: {
          command: this.sayPath,
          voicesDetected: result.stdout
            .split(/\r?\n/gu)
            .map((line) => line.trim())
            .filter(Boolean).length
        },
        providerId: this.providerId,
        status: result.exitCode === 0 ? "healthy" : "degraded"
      };
    } catch (error) {
      return {
        checkedAt,
        details: {
          message: error instanceof Error ? error.message : String(error)
        },
        providerId: this.providerId,
        status: "unavailable"
      };
    }
  }

  async listDevices(kind?: VoiceDeviceKind): Promise<VoiceDeviceDescriptor[]> {
    if (kind && kind !== "output") {
      return [];
    }

    if (process.platform !== "darwin") {
      return [];
    }

    const result = await runProcess(this.sayPath, ["-a", "?"]);
    if (result.exitCode !== 0) {
      throw createVoiceError(
        "voice_output_device_list_failed",
        result.stderr.trim() || "Failed to enumerate macOS output devices."
      );
    }

    const lines = result.stdout
      .split(/\r?\n/gu)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0 && this.defaultOutputDevice) {
      return [
        voiceDeviceDescriptorSchema.parse({
          default: true,
          id: this.defaultOutputDevice,
          kind: "output",
          metadata: {},
          name: this.defaultOutputDevice,
          providerId: this.providerId
        })
      ];
    }

    return lines.map((line, index) => {
      const match = line.match(/^(\d+)\s+(.+)$/u);
      const id = match?.[1] ?? line;
      const name = match?.[2] ?? line;
      return voiceDeviceDescriptorSchema.parse({
        default: this.defaultOutputDevice ? name.startsWith(this.defaultOutputDevice) : index === 0,
        id,
        kind: "output",
        metadata: {},
        name,
        providerId: this.providerId
      });
    });
  }

  async listVoices(): Promise<VoiceDescriptor[]> {
    const result = await runProcess(this.sayPath, ["-v", "?"]);
    if (result.exitCode !== 0) {
      throw createVoiceError("voice_list_voices_failed", result.stderr.trim() || "Failed to list macOS voices.");
    }

    return result.stdout
      .split(/\r?\n/gu)
      .map((line) => parseSayVoiceLine(line))
      .filter((entry): entry is z.infer<typeof sayVoiceLineSchema> => entry !== null)
      .map((entry) =>
        voiceDescriptorSchema.parse({
          default: entry.displayName === this.defaultVoice,
          displayName: entry.displayName,
          id: entry.displayName,
          locale: normalizeLocale(entry.locale),
          metadata: {},
          providerId: this.providerId
        })
      );
  }

  async playback(request: VoicePlaybackRequest): Promise<VoicePlaybackRecord> {
    const startedAt = new Date().toISOString();

    if (request.text) {
      const voiceName = request.voice ?? this.defaultVoice;
      const outputDevice = request.outputDevice ?? this.defaultOutputDevice;
      const args = buildSayArgs({
        outputDevice,
        text: request.text,
        voice: voiceName
      });
      const result = await runProcess(this.sayPath, args);
      if (result.exitCode !== 0) {
        throw createVoiceError(
          "voice_playback_failed",
          result.stderr.trim() || "macOS speech playback failed."
        );
      }

      return voicePlaybackRecordSchema.parse({
        completedAt: new Date().toISOString(),
        id: request.id,
        metadata: request.metadata,
        outputDevice,
        providerId: this.providerId,
        sessionId: request.sessionId,
        startedAt,
        status: "completed",
        text: request.text,
        voice: voiceName
      });
    }

    if (request.outputDevice) {
      throw createVoiceError(
        "voice_playback_output_device_unsupported",
        "Audio artifact playback currently supports the system default output device only.",
        {
          outputDevice: request.outputDevice
        }
      );
    }

    const filePath = voiceInputPathFromUri(request.audio?.uri ?? "");
    const result = await runProcess("/usr/bin/afplay", [filePath]);
    if (result.exitCode !== 0) {
      throw createVoiceError(
        "voice_audio_playback_failed",
        result.stderr.trim() || "Audio artifact playback failed."
      );
    }

    return voicePlaybackRecordSchema.parse({
      audio: request.audio,
      completedAt: new Date().toISOString(),
      id: request.id,
      metadata: request.metadata,
      providerId: this.providerId,
      sessionId: request.sessionId,
      startedAt,
      status: "completed"
    });
  }

  async synthesize(request: SynthesisRequest): Promise<SynthesisResult> {
    const voiceName = request.voice ?? this.defaultVoice;
    const outputPath = buildVoiceArtifactPath({
      artifactRoot: this.artifactRoot,
      extension: "aiff",
      id: request.id,
      kind: "synthesis",
      providerId: this.providerId,
      sessionId: request.sessionId
    });
    const args = buildSayArgs({
      outputPath,
      text: request.text,
      voice: voiceName
    });
    // `say -o` does not create parent directories; ensure the artifact path exists.
    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    const result = await runProcess(this.sayPath, args);
    if (result.exitCode !== 0) {
      throw createVoiceError("voice_synthesis_failed", result.stderr.trim() || "macOS speech synthesis failed.");
    }

    const audio = await buildVoiceAudioArtifact({
      filePath: outputPath,
      locale: request.locale,
      mediaType: "audio/aiff",
      name: `${request.id}.aiff`,
      transcript: request.text,
      voice: voiceName
    });
    const durationMs = await probeAudioDurationMs(outputPath);

    return synthesisResultSchema.parse({
      audio,
      completedAt: new Date().toISOString(),
      durationMs,
      id: request.id,
      metadata: request.metadata,
      providerId: this.providerId
    });
  }
}

function buildSayArgs(params: {
  outputDevice?: string;
  outputPath?: string;
  text: string;
  voice?: string;
}): string[] {
  const args: string[] = [];
  if (params.voice) {
    args.push("-v", params.voice);
  }
  if (params.outputDevice) {
    args.push("-a", params.outputDevice);
  }
  if (params.outputPath) {
    args.push("-o", params.outputPath);
  }
  args.push(params.text);
  return args;
}

function parseSayVoiceLine(line: string): z.infer<typeof sayVoiceLineSchema> | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const match = trimmed.match(/^(.+?)\s{2,}([A-Za-z_]+)\s+#/u);
  if (!match) {
    return null;
  }

  return sayVoiceLineSchema.parse({
    displayName: match[1]?.trim(),
    locale: match[2]?.trim()
  });
}
