import { z } from "zod";

import {
  artifactReferenceSchema,
  entityIdSchema,
  isoTimestampSchema,
  metadataSchema,
  structuredErrorSchema
} from "@/core/contracts/common";
import { providerHealthSchema, type ProviderHealth } from "@/core/contracts/providers";

export const voiceProviderKindSchema = z.enum(["apple_native", "custom", "local_system", "whisper_compatible"]);
export const voiceCapabilitySchema = z.enum(["capture", "device_list", "playback", "synthesis", "transcription", "voice_list"]);
export const voiceDeviceKindSchema = z.enum(["input", "output"]);
export const voiceJobStatusSchema = z.enum(["cancelled", "completed", "failed", "pending", "playing", "recording", "running", "transcribing"]);
export const voiceCaptureStopReasonSchema = z.enum(["completed", "error", "manual", "max_duration", "silence"]);

export const voiceDescriptorSchema = z
  .object({
    default: z.boolean().default(false),
    displayName: z.string().min(1).max(256),
    id: z.string().min(1).max(256),
    locale: z.string().min(1).max(32).optional(),
    metadata: metadataSchema.default({}),
    providerId: z.string().min(1).max(128)
  })
  .strict();

export const voiceDeviceDescriptorSchema = z
  .object({
    default: z.boolean().default(false),
    id: z.string().min(1).max(256),
    kind: voiceDeviceKindSchema,
    metadata: metadataSchema.default({}),
    name: z.string().min(1).max(256),
    providerId: z.string().min(1).max(128)
  })
  .strict();

export const transcriptionRequestSchema = z
  .object({
    audio: artifactReferenceSchema,
    id: entityIdSchema,
    locale: z.string().min(1).max(32).optional(),
    metadata: metadataSchema.default({}),
    providerId: z.string().min(1).max(128),
    sessionId: entityIdSchema.optional()
  })
  .strict();

export const transcriptionResultSchema = z
  .object({
    completedAt: isoTimestampSchema,
    durationMs: z.number().int().positive().optional(),
    id: entityIdSchema,
    locale: z.string().min(1).max(32).optional(),
    metadata: metadataSchema.default({}),
    providerId: z.string().min(1).max(128),
    text: z.string().min(1)
  })
  .strict();

export const synthesisRequestSchema = z
  .object({
    id: entityIdSchema,
    locale: z.string().min(1).max(32).optional(),
    metadata: metadataSchema.default({}),
    providerId: z.string().min(1).max(128),
    sessionId: entityIdSchema.optional(),
    text: z.string().min(1),
    voice: z.string().min(1).max(128).optional()
  })
  .strict();

export const synthesisResultSchema = z
  .object({
    audio: artifactReferenceSchema,
    completedAt: isoTimestampSchema,
    durationMs: z.number().int().positive().optional(),
    id: entityIdSchema,
    metadata: metadataSchema.default({}),
    providerId: z.string().min(1).max(128)
  })
  .strict();

export const voiceCaptureRequestSchema = z
  .object({
    id: entityIdSchema,
    inputDevice: z.string().min(1).max(256).optional(),
    locale: z.string().min(1).max(32).optional(),
    maxDurationMs: z.number().int().positive().max(600_000).optional(),
    metadata: metadataSchema.default({}),
    providerId: z.string().min(1).max(128),
    sessionId: entityIdSchema.optional(),
    silenceTimeoutMs: z.number().int().positive().max(120_000).optional()
  })
  .strict();

export const voiceCaptureRecordSchema = z
  .object({
    audio: artifactReferenceSchema.optional(),
    completedAt: isoTimestampSchema.optional(),
    error: structuredErrorSchema.optional(),
    id: entityIdSchema,
    inputDevice: z.string().min(1).max(256).optional(),
    locale: z.string().min(1).max(32).optional(),
    maxDurationMs: z.number().int().positive().max(600_000).optional(),
    metadata: metadataSchema.default({}),
    providerId: z.string().min(1).max(128),
    sessionId: entityIdSchema.optional(),
    silenceTimeoutMs: z.number().int().positive().max(120_000).optional(),
    startedAt: isoTimestampSchema,
    status: voiceJobStatusSchema,
    stopReason: voiceCaptureStopReasonSchema.optional(),
    text: z.string().min(1).optional(),
    transcriptionId: entityIdSchema.optional()
  })
  .strict();

export const voiceTranscriptionRecordSchema = z
  .object({
    audio: artifactReferenceSchema,
    completedAt: isoTimestampSchema.optional(),
    durationMs: z.number().int().positive().optional(),
    error: structuredErrorSchema.optional(),
    id: entityIdSchema,
    locale: z.string().min(1).max(32).optional(),
    metadata: metadataSchema.default({}),
    providerId: z.string().min(1).max(128),
    sessionId: entityIdSchema.optional(),
    startedAt: isoTimestampSchema,
    status: voiceJobStatusSchema,
    text: z.string().min(1).optional()
  })
  .strict();

export const voicePlaybackRequestSchema = z
  .object({
    audio: artifactReferenceSchema.optional(),
    id: entityIdSchema,
    metadata: metadataSchema.default({}),
    outputDevice: z.string().min(1).max(256).optional(),
    providerId: z.string().min(1).max(128),
    sessionId: entityIdSchema.optional(),
    text: z.string().min(1).optional(),
    voice: z.string().min(1).max(128).optional()
  })
  .strict()
  .superRefine((value, context) => {
    const hasAudio = value.audio !== undefined;
    const hasText = typeof value.text === "string";
    if (hasAudio !== hasText) {
      return;
    }

    context.addIssue({
      code: "custom",
      message: "Provide exactly one playback source: audio or text."
    });
  });

export const voicePlaybackRecordSchema = z
  .object({
    audio: artifactReferenceSchema.optional(),
    completedAt: isoTimestampSchema.optional(),
    error: structuredErrorSchema.optional(),
    id: entityIdSchema,
    metadata: metadataSchema.default({}),
    outputDevice: z.string().min(1).max(256).optional(),
    providerId: z.string().min(1).max(128),
    sessionId: entityIdSchema.optional(),
    startedAt: isoTimestampSchema,
    status: voiceJobStatusSchema,
    text: z.string().min(1).optional(),
    voice: z.string().min(1).max(128).optional()
  })
  .strict();

export type VoiceCaptureInput = Omit<VoiceCaptureRequest, "providerId"> & {
  providerId?: string;
};

export type VoiceDeviceListQuery = {
  kind?: VoiceDeviceKind;
  providerId?: string;
};

export type VoicePlaybackInput = Omit<VoicePlaybackRequest, "providerId"> & {
  providerId?: string;
};

export type VoiceSynthesisInput = Omit<SynthesisRequest, "providerId"> & {
  providerId?: string;
};

export type VoiceTranscriptionInput = Omit<TranscriptionRequest, "providerId"> & {
  providerId?: string;
};

export type VoiceVoiceListQuery = {
  locale?: string;
  providerId?: string;
};

export interface VoiceAdapter {
  readonly capabilities: VoiceCapability[];
  readonly kind: VoiceProviderKind;
  readonly providerId: string;

  dispose?(): Promise<void>;
  getCapture?(captureId: string): Promise<VoiceCaptureRecord | null>;
  health(): Promise<ProviderHealth>;
  listDevices?(kind?: VoiceDeviceKind): Promise<VoiceDeviceDescriptor[]>;
  listVoices?(): Promise<VoiceDescriptor[]>;
  playback?(request: VoicePlaybackRequest): Promise<VoicePlaybackRecord>;
  startCapture?(request: VoiceCaptureRequest): Promise<VoiceCaptureRecord>;
  stopCapture?(captureId: string): Promise<VoiceCaptureRecord>;
  synthesize?(request: SynthesisRequest): Promise<SynthesisResult>;
  transcribe?(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

export interface VoiceService {
  dispose(): Promise<void>;
  getCapture(captureId: string): Promise<VoiceCaptureRecord | null>;
  listDevices(query?: VoiceDeviceListQuery): Promise<VoiceDeviceDescriptor[]>;
  listProviderHealth(providerId?: string): Promise<ProviderHealth[]>;
  listVoices(query?: VoiceVoiceListQuery): Promise<VoiceDescriptor[]>;
  playback(request: VoicePlaybackInput): Promise<VoicePlaybackRecord>;
  startCapture(request: VoiceCaptureInput): Promise<VoiceCaptureRecord>;
  stopCapture(captureId: string): Promise<VoiceCaptureRecord>;
  synthesize(request: VoiceSynthesisInput): Promise<SynthesisResult>;
  transcribe(request: VoiceTranscriptionInput): Promise<TranscriptionResult>;
  waitForCapture(captureId: string): Promise<VoiceCaptureRecord>;
}

export type SynthesisRequest = z.infer<typeof synthesisRequestSchema>;
export type SynthesisResult = z.infer<typeof synthesisResultSchema>;
export type TranscriptionRequest = z.infer<typeof transcriptionRequestSchema>;
export type TranscriptionResult = z.infer<typeof transcriptionResultSchema>;
export type VoiceCapability = z.infer<typeof voiceCapabilitySchema>;
export type VoiceCaptureRecord = z.infer<typeof voiceCaptureRecordSchema>;
export type VoiceCaptureRequest = z.infer<typeof voiceCaptureRequestSchema>;
export type VoiceCaptureStopReason = z.infer<typeof voiceCaptureStopReasonSchema>;
export type VoiceDescriptor = z.infer<typeof voiceDescriptorSchema>;
export type VoiceDeviceDescriptor = z.infer<typeof voiceDeviceDescriptorSchema>;
export type VoiceDeviceKind = z.infer<typeof voiceDeviceKindSchema>;
export type VoiceJobStatus = z.infer<typeof voiceJobStatusSchema>;
export type VoicePlaybackRecord = z.infer<typeof voicePlaybackRecordSchema>;
export type VoicePlaybackRequest = z.infer<typeof voicePlaybackRequestSchema>;
export type VoiceProviderKind = z.infer<typeof voiceProviderKindSchema>;
export type VoiceTranscriptionRecord = z.infer<typeof voiceTranscriptionRecordSchema>;

export { providerHealthSchema };
