import type {
  AppConfig,
  VoiceProviderConfig
} from "@/core/config/schema";
import { sleep } from "@/core/io/files";
import type {
  ProviderHealth,
  SynthesisRequest,
  SynthesisResult,
  TranscriptionRequest,
  TranscriptionResult,
  VoiceAdapter,
  VoiceCapability,
  VoiceCaptureInput,
  VoiceCaptureRecord,
  VoiceCaptureRequest,
  VoiceDeviceDescriptor,
  VoiceDeviceKind,
  VoicePlaybackInput,
  VoicePlaybackRecord,
  VoicePlaybackRequest,
  VoiceService,
  VoiceSynthesisInput,
  VoiceTranscriptionInput,
  VoiceTranscriptionRecord,
  VoiceVoiceListQuery,
  VoiceDeviceListQuery,
  VoiceDescriptor
} from "@/core/contracts";
import {
  synthesisRequestSchema,
  transcriptionRequestSchema,
  voiceCaptureRequestSchema,
  voicePlaybackRecordSchema,
  voicePlaybackRequestSchema,
  voiceTranscriptionRecordSchema
} from "@/core/contracts";
import type { FileSessionStore } from "@/core/sessions";
import { AppleNativeVoiceAdapter } from "@/core/voice/apple-native";
import { LocalSystemVoiceAdapter } from "@/core/voice/local-system";
import {
  createVoiceError,
  isTerminalVoiceStatus,
  normalizeLocale,
  normalizeVoiceError
} from "@/core/voice/utils";

type CaptureTracker = {
  persistedTerminal: boolean;
  promise: Promise<VoiceCaptureRecord>;
  providerId: string;
};

export type FileVoiceServiceOptions = {
  adapters: VoiceAdapter[];
  config: AppConfig["voice"];
  pollIntervalMs?: number;
  providerConfigs?: Record<string, VoiceProviderConfig>;
  sessions?: FileSessionStore;
};

export class FileVoiceService implements VoiceService {
  private readonly adapters = new Map<string, VoiceAdapter>();
  private readonly captureTrackers = new Map<string, CaptureTracker>();
  private readonly pollIntervalMs: number;

  constructor(private readonly options: FileVoiceServiceOptions) {
    for (const adapter of options.adapters) {
      this.adapters.set(adapter.providerId, adapter);
    }
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
  }

  async dispose(): Promise<void> {
    await Promise.all(Array.from(this.adapters.values()).map(async (adapter) => adapter.dispose?.()));
  }

  async getCapture(captureId: string): Promise<VoiceCaptureRecord | null> {
    const located = await this.locateCapture(captureId);
    if (!located) {
      return null;
    }

    return located.adapter.getCapture?.(captureId) ?? located.record;
  }

  async listDevices(query: VoiceDeviceListQuery = {}): Promise<VoiceDeviceDescriptor[]> {
    const adapters = query.providerId
      ? [this.requireCapability(query.providerId, "device_list")]
      : this.listAdaptersWithCapability("device_list", query.kind);

    const results = await Promise.all(
      adapters.map(async (adapter) => ({
        adapter,
        devices: (await adapter.listDevices?.(query.kind) ?? []).filter((device) =>
          query.kind ? device.kind === query.kind : true
        )
      }))
    );

    return results.flatMap((entry) => entry.devices);
  }

  async listProviderHealth(providerId?: string): Promise<ProviderHealth[]> {
    if (providerId) {
      return [await this.requireAdapter(providerId).health()];
    }

    return Promise.all(Array.from(this.adapters.values()).map(async (adapter) => adapter.health()));
  }

  async listVoices(query: VoiceVoiceListQuery = {}): Promise<VoiceDescriptor[]> {
    const adapters = query.providerId
      ? [this.requireCapability(query.providerId, "voice_list")]
      : this.listAdaptersWithCapability("voice_list");

    const locale = normalizeLocale(query.locale);
    const results = await Promise.all(adapters.map(async (adapter) => adapter.listVoices?.() ?? []));
    return results
      .flat()
      .filter((voice) => {
        if (!locale) {
          return true;
        }

        const voiceLocale = normalizeLocale(voice.locale)?.toLowerCase();
        const requested = locale.toLowerCase();
        return voiceLocale === requested || voiceLocale?.startsWith(`${requested}-`) === true;
      })
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  async playback(request: VoicePlaybackInput): Promise<VoicePlaybackRecord> {
    const providerId = this.resolveProviderId("playback", request.providerId);
    const adapter = this.requireCapability(providerId, "playback");
    const startedAt = new Date().toISOString();
    const parsed = voicePlaybackRequestSchema.parse({
      ...request,
      outputDevice: request.outputDevice ?? this.providerConfig(providerId)?.outputDevice ?? this.options.config.outputDevice,
      providerId,
      sessionId: request.sessionId,
      voice: request.voice ?? this.providerConfig(providerId)?.voice ?? this.options.config.defaultVoice
    } satisfies VoicePlaybackRequest);

    const initialRecord = voicePlaybackRecordSchema.parse({
      audio: parsed.audio,
      id: parsed.id,
      metadata: parsed.metadata,
      outputDevice: parsed.outputDevice,
      providerId,
      sessionId: parsed.sessionId,
      startedAt,
      status: "playing",
      text: parsed.text,
      voice: parsed.voice
    });

    await this.persistVoicePlayback(initialRecord);

    try {
      const record = await adapter.playback!(parsed);
      await this.persistVoicePlayback(record);
      return record;
    } catch (error) {
      const failed = voicePlaybackRecordSchema.parse({
        ...initialRecord,
        completedAt: new Date().toISOString(),
        error: normalizeVoiceError(error, "voice_playback_failed"),
        status: "failed"
      });
      await this.persistVoicePlayback(failed);
      throw failed.error;
    }
  }

  async startCapture(request: VoiceCaptureInput): Promise<VoiceCaptureRecord> {
    const providerId = this.resolveProviderId("capture", request.providerId);
    const adapter = this.requireCapability(providerId, "capture");
    const parsed = voiceCaptureRequestSchema.parse({
      ...request,
      inputDevice: request.inputDevice ?? this.providerConfig(providerId)?.inputDevice ?? this.options.config.inputDevice,
      locale: normalizeLocale(request.locale ?? this.providerConfig(providerId)?.locale ?? this.options.config.defaultLocale),
      maxDurationMs: request.maxDurationMs ?? this.options.config.maxCaptureMs,
      providerId,
      sessionId: request.sessionId,
      silenceTimeoutMs: request.silenceTimeoutMs ?? this.options.config.silenceTimeoutMs
    } satisfies VoiceCaptureRequest);
    const record = await adapter.startCapture!(parsed);
    await this.persistVoiceCapture(record);

    this.captureTrackers.set(record.id, {
      persistedTerminal: isTerminalVoiceStatus(record.status),
      promise: this.trackCapture(record.id, providerId),
      providerId
    });

    if (isTerminalVoiceStatus(record.status)) {
      return record;
    }

    return record;
  }

  async stopCapture(captureId: string): Promise<VoiceCaptureRecord> {
    const located = await this.locateCapture(captureId);
    if (!located) {
      throw createVoiceError("voice_capture_not_found", `Voice capture "${captureId}" was not found.`, {
        captureId
      });
    }

    const record = await located.adapter.stopCapture!(captureId);
    if (isTerminalVoiceStatus(record.status)) {
      await this.persistTerminalCapture(record);
      return record;
    }

    return this.waitForCapture(captureId);
  }

  async synthesize(request: VoiceSynthesisInput): Promise<SynthesisResult> {
    const providerId = this.resolveProviderId("synthesis", request.providerId);
    const adapter = this.requireCapability(providerId, "synthesis");
    const parsed = synthesisRequestSchema.parse({
      ...request,
      locale: normalizeLocale(request.locale ?? this.providerConfig(providerId)?.locale ?? this.options.config.defaultLocale),
      providerId,
      sessionId: request.sessionId,
      voice: request.voice ?? this.providerConfig(providerId)?.voice ?? this.options.config.defaultVoice
    } satisfies SynthesisRequest);

    return adapter.synthesize!(parsed);
  }

  async transcribe(request: VoiceTranscriptionInput): Promise<TranscriptionResult> {
    const providerId = this.resolveProviderId("transcription", request.providerId);
    const adapter = this.requireCapability(providerId, "transcription");
    const parsed = transcriptionRequestSchema.parse({
      ...request,
      locale: normalizeLocale(request.locale ?? this.providerConfig(providerId)?.locale ?? this.options.config.defaultLocale),
      providerId,
      sessionId: request.sessionId
    } satisfies TranscriptionRequest);
    const startedAt = new Date().toISOString();

    const initialRecord = voiceTranscriptionRecordSchema.parse({
      audio: parsed.audio,
      id: parsed.id,
      locale: parsed.locale,
      metadata: parsed.metadata,
      providerId,
      sessionId: parsed.sessionId,
      startedAt,
      status: "transcribing"
    });
    await this.persistVoiceTranscription(initialRecord);

    try {
      const result = await adapter.transcribe!(parsed);
      const completedRecord = voiceTranscriptionRecordSchema.parse({
        audio: parsed.audio,
        completedAt: result.completedAt,
        durationMs: result.durationMs,
        id: result.id,
        locale: result.locale ?? parsed.locale,
        metadata: parsed.metadata,
        providerId,
        sessionId: parsed.sessionId,
        startedAt,
        status: "completed",
        text: result.text
      });
      await this.persistVoiceTranscription(completedRecord);
      return result;
    } catch (error) {
      const failedRecord = voiceTranscriptionRecordSchema.parse({
        audio: parsed.audio,
        completedAt: new Date().toISOString(),
        error: normalizeVoiceError(error, "voice_transcription_failed"),
        id: parsed.id,
        locale: parsed.locale,
        metadata: parsed.metadata,
        providerId,
        sessionId: parsed.sessionId,
        startedAt,
        status: "failed"
      });
      await this.persistVoiceTranscription(failedRecord);
      throw failedRecord.error;
    }
  }

  async waitForCapture(captureId: string): Promise<VoiceCaptureRecord> {
    const tracker = this.captureTrackers.get(captureId);
    if (tracker) {
      return tracker.promise;
    }

    const located = await this.locateCapture(captureId);
    if (!located) {
      throw createVoiceError("voice_capture_not_found", `Voice capture "${captureId}" was not found.`, {
        captureId
      });
    }

    const promise = this.trackCapture(captureId, located.adapter.providerId);
    this.captureTrackers.set(captureId, {
      persistedTerminal: false,
      promise,
      providerId: located.adapter.providerId
    });
    return promise;
  }

  private listAdaptersWithCapability(capability: VoiceCapability, kind?: VoiceDeviceKind): VoiceAdapter[] {
    const preferred = capability === "transcription" || capability === "capture"
      ? [this.options.config.defaultTranscriptionProviderId, this.options.config.defaultProviderId]
      : capability === "device_list" && kind === "input"
        ? [this.options.config.defaultTranscriptionProviderId, this.options.config.defaultProviderId]
        : [this.options.config.defaultSynthesisProviderId, this.options.config.defaultProviderId];
    const ordered = new Map<string, VoiceAdapter>();

    for (const providerId of preferred) {
      const adapter = this.adapters.get(providerId);
      if (adapter && adapter.capabilities.includes(capability)) {
        ordered.set(providerId, adapter);
      }
    }

    for (const adapter of this.adapters.values()) {
      if (adapter.capabilities.includes(capability)) {
        ordered.set(adapter.providerId, adapter);
      }
    }

    return Array.from(ordered.values());
  }

  private providerConfig(providerId: string): VoiceProviderConfig | undefined {
    return this.options.providerConfigs?.[providerId];
  }

  private requireAdapter(providerId: string): VoiceAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      throw createVoiceError("voice_provider_not_found", `Voice provider "${providerId}" is not configured.`, {
        providerId
      });
    }
    return adapter;
  }

  private requireCapability(providerId: string, capability: VoiceCapability): VoiceAdapter {
    const adapter = this.requireAdapter(providerId);
    if (!adapter.capabilities.includes(capability)) {
      throw createVoiceError(
        "voice_provider_capability_missing",
        `Voice provider "${providerId}" does not support ${capability}.`,
        {
          capability,
          providerId
        }
      );
    }
    return adapter;
  }

  private resolveProviderId(capability: VoiceCapability, explicitProviderId?: string): string {
    if (explicitProviderId) {
      this.requireCapability(explicitProviderId, capability);
      return explicitProviderId;
    }

    const preferredProviderIds =
      capability === "capture" || capability === "transcription"
        ? [this.options.config.defaultTranscriptionProviderId, this.options.config.defaultProviderId]
        : [this.options.config.defaultSynthesisProviderId, this.options.config.defaultProviderId];

    for (const providerId of preferredProviderIds) {
      const adapter = this.adapters.get(providerId);
      if (adapter && adapter.capabilities.includes(capability)) {
        return providerId;
      }
    }

    const fallback = Array.from(this.adapters.values()).find((adapter) => adapter.capabilities.includes(capability));
    if (!fallback) {
      throw createVoiceError(
        "voice_provider_unavailable",
        `No configured voice provider supports ${capability}.`,
        {
          capability
        }
      );
    }

    return fallback.providerId;
  }

  private async locateCapture(captureId: string): Promise<{ adapter: VoiceAdapter; record: VoiceCaptureRecord } | null> {
    const tracker = this.captureTrackers.get(captureId);
    if (tracker) {
      const adapter = this.requireCapability(tracker.providerId, "capture");
      const record = await adapter.getCapture?.(captureId);
      if (record) {
        return {
          adapter,
          record
        };
      }
    }

    for (const adapter of this.listAdaptersWithCapability("capture")) {
      const record = await adapter.getCapture?.(captureId);
      if (record) {
        return {
          adapter,
          record
        };
      }
    }

    return null;
  }

  private async persistTerminalCapture(record: VoiceCaptureRecord): Promise<void> {
    await this.persistVoiceCapture(record);
    if (record.audio && record.transcriptionId) {
      const transcriptionRecord: VoiceTranscriptionRecord = voiceTranscriptionRecordSchema.parse({
        audio: record.audio,
        completedAt: record.completedAt,
        durationMs:
          typeof record.audio.metadata.durationMs === "number" ? Math.trunc(record.audio.metadata.durationMs) : undefined,
        error: record.error,
        id: record.transcriptionId,
        locale: record.locale,
        metadata: record.metadata,
        providerId: record.providerId,
        sessionId: record.sessionId,
        startedAt: record.startedAt,
        status: record.text ? "completed" : record.error ? "failed" : "completed",
        text: record.text
      });
      await this.persistVoiceTranscription(transcriptionRecord);
    }
  }

  private async persistVoiceCapture(record: VoiceCaptureRecord): Promise<void> {
    if (!record.sessionId) {
      return;
    }

    await this.options.sessions?.appendVoiceCapture(record);
  }

  private async persistVoicePlayback(record: VoicePlaybackRecord): Promise<void> {
    if (!record.sessionId) {
      return;
    }

    await this.options.sessions?.appendVoicePlayback(record);
  }

  private async persistVoiceTranscription(record: VoiceTranscriptionRecord): Promise<void> {
    if (!record.sessionId) {
      return;
    }

    await this.options.sessions?.appendVoiceTranscription(record);
  }

  private async trackCapture(captureId: string, providerId: string): Promise<VoiceCaptureRecord> {
    const adapter = this.requireCapability(providerId, "capture");
    const tracker = this.captureTrackers.get(captureId);

    while (true) {
      const record = await adapter.getCapture?.(captureId);
      if (record && isTerminalVoiceStatus(record.status)) {
        if (!tracker?.persistedTerminal) {
          await this.persistTerminalCapture(record);
          const currentTracker = this.captureTrackers.get(captureId);
          if (currentTracker) {
            currentTracker.persistedTerminal = true;
          }
        }
        return record;
      }

      await sleep(this.pollIntervalMs);
    }
  }
}

export function createVoiceServiceFromConfig(
  config: AppConfig,
  options: {
    pollIntervalMs?: number;
    sessions?: FileSessionStore;
  } = {}
): FileVoiceService {
  const adapters: VoiceAdapter[] = [];

  for (const [providerId, providerConfig] of Object.entries(config.providers.voiceProviders)) {
    if (!providerConfig.enabled) {
      continue;
    }

    switch (providerConfig.kind) {
      case "apple_native":
        adapters.push(
          new AppleNativeVoiceAdapter({
            artifactRoot: config.voice.artifactRoot,
            defaultLocale: normalizeLocale(providerConfig.locale ?? config.voice.defaultLocale),
            providerId,
            requireOnDeviceRecognition: config.voice.requireOnDeviceRecognition
          })
        );
        break;
      case "local_system":
        adapters.push(
          new LocalSystemVoiceAdapter({
            artifactRoot: config.voice.artifactRoot,
            defaultOutputDevice: providerConfig.outputDevice ?? config.voice.outputDevice,
            defaultVoice: providerConfig.voice ?? config.voice.defaultVoice,
            providerId
          })
        );
        break;
      default:
        throw createVoiceError(
          "voice_provider_kind_unsupported",
          `Voice provider kind "${providerConfig.kind}" is not implemented yet.`,
          {
            providerId
          }
        );
    }
  }

  return new FileVoiceService({
    adapters,
    config: config.voice,
    pollIntervalMs: options.pollIntervalMs,
    providerConfigs: config.providers.voiceProviders,
    sessions: options.sessions
  });
}
