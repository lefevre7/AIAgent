import path from "node:path";

import { z } from "zod";

import type { ToolDefinition, VoiceDescriptor, VoiceService } from "@/core/contracts";
import {
  buildVoiceAudioArtifact,
  createVoiceError,
  normalizeLocale,
  voiceInputPathFromUri
} from "@/core/voice";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

const voiceListVoicesSchema = z
  .object({
    locale: z.string().min(1).max(32).optional(),
    providerId: z.string().min(1).max(128).optional()
  })
  .strict();

const voiceTranscribeAudioSchema = z
  .object({
    locale: z.string().min(1).max(32).optional(),
    mediaType: z.string().min(1).max(256).optional(),
    name: z.string().min(1).max(256).optional(),
    providerId: z.string().min(1).max(128).optional(),
    uri: z.string().min(1).max(4096)
  })
  .strict();

const voiceSynthesizeTextSchema = z
  .object({
    locale: z.string().min(1).max(32).optional(),
    providerId: z.string().min(1).max(128).optional(),
    text: z.string().min(1),
    voice: z.string().min(1).max(128).optional()
  })
  .strict();

export function createVoiceTools(params: { voiceService: VoiceService }): RuntimeTool[] {
  return [
    createVoiceListVoicesTool(params),
    createVoiceTranscribeAudioTool(params),
    createVoiceSynthesizeTextTool(params)
  ];
}

export function createVoiceListVoicesTool(params: { voiceService: VoiceService }): RuntimeTool {
  return {
    definition: voiceListVoicesToolDefinition,
    async execute(call): Promise<RuntimeToolResult> {
      const input = voiceListVoicesSchema.parse(call.arguments as unknown);
      const voices = await params.voiceService.listVoices({
        locale: normalizeLocale(input.locale),
        providerId: input.providerId
      });

      return {
        display: [
          {
            kind: "markdown",
            markdown: renderVoiceListMarkdown(voices)
          }
        ],
        result: {
          voices
        }
      };
    }
  };
}

export function createVoiceTranscribeAudioTool(params: { voiceService: VoiceService }): RuntimeTool {
  return {
    definition: voiceTranscribeAudioToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = voiceTranscribeAudioSchema.parse(call.arguments as unknown);
      const filePath = voiceInputPathFromUri(input.uri);
      const audio = await buildVoiceAudioArtifact({
        filePath,
        locale: normalizeLocale(input.locale),
        mediaType: input.mediaType ?? inferAudioMediaType(filePath),
        name: input.name ?? path.basename(filePath)
      });

      const result = await params.voiceService.transcribe({
        audio,
        id: call.id,
        locale: normalizeLocale(input.locale),
        metadata: call.metadata,
        providerId: input.providerId,
        sessionId: context.session.id
      });

      return {
        display: [
          {
            kind: "status",
            state: "transcribed",
            summary: `Transcribed audio into ${result.text.length} characters.`
          },
          {
            kind: "text",
            text: result.text
          }
        ],
        result
      };
    }
  };
}

export function createVoiceSynthesizeTextTool(params: { voiceService: VoiceService }): RuntimeTool {
  return {
    definition: voiceSynthesizeTextToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = voiceSynthesizeTextSchema.parse(call.arguments as unknown);
      const result = await params.voiceService.synthesize({
        id: call.id,
        locale: normalizeLocale(input.locale),
        metadata: call.metadata,
        providerId: input.providerId,
        sessionId: context.session.id,
        text: input.text,
        voice: input.voice
      });

      if (result.audio.kind !== "audio") {
        throw createVoiceError(
          "voice_synthesis_invalid_artifact",
          "Voice synthesis did not return an audio artifact.",
          {
            artifactKind: result.audio.kind
          }
        );
      }

      return {
        artifacts: [result.audio],
        display: [
          {
            kind: "status",
            state: "synthesized",
            summary: `Synthesized speech to ${result.audio.uri}`
          }
        ],
        result
      };
    }
  };
}

export const voiceListVoicesToolDefinition: ToolDefinition = {
  aliases: ["voice-list", "voice_list"],
  annotations: {
    meta: {
      family: "voice"
    },
    readOnlyHint: true,
    title: "List Voices"
  },
  approvalMode: "never",
  descriptor: {
    approvalNotes: "Lists configured local voice descriptors without recording or playing audio.",
    examples: [
      "List voices before choosing a voice for speech synthesis.",
      "Filter voices for a specific locale such as en-US."
    ],
    purpose: "Inspect available TTS voices exposed by the configured local voice providers.",
    sideEffectSummary: "Queries local voice providers and returns descriptors only.",
    whenNotToUse: [
      "Do not use to record audio or synthesize speech.",
      "Do not use when you already know the exact voice id to pass to voice_synthesize_text."
    ],
    whenToUse: [
      "Use when you need to discover available voice names or locales before synthesizing speech."
    ]
  },
  description: "List available local voice descriptors for speech synthesis.",
  displayName: "List Voices",
  execution: {
    inputMode: "json",
    resumable: false,
    taskSupport: "optional"
  },
  idempotent: true,
  inputSchema: {
    additionalProperties: false,
    properties: {
      locale: { type: "string" },
      providerId: { type: "string" }
    },
    type: "object"
  },
  invocationName: "voice_list_voices",
  kind: "voice",
  metadata: {},
  name: "voice_list_voices",
  outputKind: "mixed",
  outputSchema: {
    type: "object"
  },
  retryable: true,
  searchTags: ["audio", "list", "speech", "tts", "voice"],
  sideEffects: ["local_process"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.voice.list_voices",
  usageGuidance: "Use this before synthesis when you need an exact voice id or locale match.",
  version: "1.0.0"
};

export const voiceTranscribeAudioToolDefinition: ToolDefinition = {
  aliases: ["stt", "voice_transcribe_artifact"],
  annotations: {
    meta: {
      family: "voice"
    },
    readOnlyHint: true,
    title: "Transcribe Audio"
  },
  approvalMode: "never",
  descriptor: {
    approvalNotes: "Transcribes a local audio artifact without opening the microphone.",
    examples: [
      "Transcribe a local WAV recording into text.",
      "Convert a saved voice memo into a text transcript for the current task."
    ],
    purpose: "Convert a local audio artifact into plain text through the configured STT provider.",
    sideEffectSummary: "Reads a local audio artifact and runs a local speech-to-text process.",
    whenNotToUse: [
      "Do not use to start live recording.",
      "Do not use for remote audio URLs or non-local files."
    ],
    whenToUse: [
      "Use when you have a local audio file and need a transcript inside the current session."
    ]
  },
  description: "Transcribe a local audio artifact into text.",
  displayName: "Transcribe Audio",
  execution: {
    inputMode: "json",
    resumable: false,
    taskSupport: "optional"
  },
  idempotent: true,
  inputSchema: {
    additionalProperties: false,
    properties: {
      locale: { type: "string" },
      mediaType: { type: "string" },
      name: { type: "string" },
      providerId: { type: "string" },
      uri: { type: "string" }
    },
    required: ["uri"],
    type: "object"
  },
  invocationName: "voice_transcribe_audio",
  kind: "voice",
  metadata: {},
  name: "voice_transcribe_audio",
  outputKind: "mixed",
  outputSchema: {
    type: "object"
  },
  retryable: true,
  searchTags: ["audio", "speech", "stt", "transcript", "voice"],
  sideEffects: ["local_process", "workspace_read"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.voice.transcribe_audio",
  usageGuidance: "Pass a local file URI or absolute path for the audio artifact you want to transcribe.",
  version: "1.0.0"
};

export const voiceSynthesizeTextToolDefinition: ToolDefinition = {
  aliases: ["tts", "voice_synthesize"],
  annotations: {
    meta: {
      family: "voice"
    },
    title: "Synthesize Speech"
  },
  approvalMode: "ask",
  descriptor: {
    approvalNotes: "Synthesis writes a local audio artifact under the configured voice artifact root.",
    examples: [
      "Generate an audio attachment for an assistant reply.",
      "Synthesize a short spoken summary using a specific installed voice."
    ],
    purpose: "Convert text into a local audio artifact through the configured TTS provider.",
    sideEffectSummary: "Runs a local speech synthesis process and writes an audio artifact under .aia/voice.",
    whenNotToUse: [
      "Do not use to play audio live through the microphone or speakers.",
      "Do not use when plain text output is sufficient."
    ],
    whenToUse: [
      "Use when a surface requested spoken output or an audio attachment for the assistant response."
    ]
  },
  description: "Synthesize text into a local audio artifact.",
  displayName: "Synthesize Speech",
  execution: {
    inputMode: "json",
    resumable: false,
    taskSupport: "optional"
  },
  idempotent: false,
  inputSchema: {
    additionalProperties: false,
    properties: {
      locale: { type: "string" },
      providerId: { type: "string" },
      text: { type: "string" },
      voice: { type: "string" }
    },
    required: ["text"],
    type: "object"
  },
  invocationName: "voice_synthesize_text",
  kind: "voice",
  metadata: {},
  name: "voice_synthesize_text",
  outputKind: "artifact",
  outputSchema: {
    type: "object"
  },
  retryable: true,
  searchTags: ["audio", "speech", "tts", "voice"],
  sideEffects: ["local_process", "workspace_write"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.voice.synthesize_text",
  usageGuidance: "Use for short spoken responses or audio attachments. Pick a voice first if you need a specific locale or timbre.",
  version: "1.0.0"
};

function inferAudioMediaType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".aif":
    case ".aiff":
      return "audio/aiff";
    case ".m4a":
      return "audio/mp4";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
    default:
      return "audio/wav";
  }
}

function renderVoiceListMarkdown(voices: VoiceDescriptor[]): string {
  if (voices.length === 0) {
    return "No configured voice providers exposed any voices.";
  }

  return [
    "Available voices:",
    ...voices.map((voice) => {
      const locale = voice.locale ? ` (${voice.locale})` : "";
      const provider = ` [${voice.providerId}]`;
      const defaultMarker = voice.default ? " default" : "";
      return `- ${voice.id}${locale}${provider}${defaultMarker}`;
    })
  ].join("\n");
}
