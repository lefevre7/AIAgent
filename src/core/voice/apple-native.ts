import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type {
  ProviderHealth,
  TranscriptionRequest,
  TranscriptionResult,
  VoiceAdapter,
  VoiceCapability,
  VoiceCaptureRecord,
  VoiceCaptureRequest,
  VoiceDeviceDescriptor,
  VoiceDeviceKind
} from "@/core/contracts";
import {
  transcriptionResultSchema,
  voiceCaptureRecordSchema,
  voiceDeviceDescriptorSchema
} from "@/core/contracts";

import { APPLE_NATIVE_VOICE_HELPER_SOURCE } from "@/core/voice/apple-helper-source";
import {
  buildVoiceArtifactPath,
  buildVoiceAudioArtifact,
  createVoiceError,
  normalizeLocale,
  runProcess,
  stableArtifactId,
  voiceInputPathFromUri,
  writeIfChanged
} from "@/core/voice/utils";

const helperErrorSchema = z
  .object({
    code: z.string().min(1),
    details: z.record(z.string(), z.string()).default({}),
    message: z.string().min(1)
  })
  .strict();

const helperInputDeviceSchema = z
  .object({
    default: z.boolean().default(false),
    id: z.string().min(1),
    kind: z.literal("input"),
    metadata: z.record(z.string(), z.string()).default({}),
    name: z.string().min(1)
  })
  .strict();

const helperInputDeviceListSchema = z
  .object({
    devices: z.array(helperInputDeviceSchema).default([]),
    ok: z.literal(true)
  })
  .strict();

const helperTranscriptionSuccessSchema = z
  .object({
    ok: z.literal(true),
    result: z
      .object({
        durationMs: z.number().int().positive().optional(),
        locale: z.string().min(1).optional(),
        text: z.string().min(1)
      })
      .strict()
  })
  .strict();

const helperFailureSchema = z
  .object({
    error: helperErrorSchema,
    ok: z.literal(false)
  })
  .strict();

const helperCaptureSuccessSchema = z
  .object({
    capture: z
      .object({
        durationMs: z.number().int().positive().optional(),
        locale: z.string().min(1).optional(),
        outputPath: z.string().min(1),
        stopReason: z.enum(["completed", "error", "manual", "max_duration", "silence"]),
        text: z.string().min(1).optional()
      })
      .strict(),
    ok: z.literal(true)
  })
  .strict();

const helperCaptureFailureSchema = z
  .object({
    capture: z
      .object({
        durationMs: z.number().int().positive().optional(),
        locale: z.string().min(1).optional(),
        outputPath: z.string().min(1),
        stopReason: z.enum(["completed", "error", "manual", "max_duration", "silence"]),
        text: z.string().min(1).optional()
      })
      .strict()
      .optional(),
    error: helperErrorSchema,
    ok: z.literal(false)
  })
  .strict();

type ActiveCapture = {
  child: ChildProcess;
  promise: Promise<VoiceCaptureRecord>;
  record: VoiceCaptureRecord;
};

export type AppleNativeVoiceAdapterOptions = {
  artifactRoot: string;
  defaultLocale?: string;
  providerId: string;
  requireOnDeviceRecognition: boolean;
  swiftCompilerPath?: string;
};

export class AppleNativeVoiceAdapter implements VoiceAdapter {
  readonly capabilities: VoiceCapability[] = ["capture", "device_list", "transcription"];
  readonly kind = "apple_native" as const;
  readonly providerId: string;

  private readonly activeCaptures = new Map<string, ActiveCapture>();
  private readonly artifactRoot: string;
  private readonly defaultLocale?: string;
  private readonly helperRoot: string;
  private helperPromise: Promise<string> | null = null;
  private readonly requireOnDeviceRecognition: boolean;
  private readonly swiftCompilerPath: string;

  constructor(options: AppleNativeVoiceAdapterOptions) {
    this.artifactRoot = options.artifactRoot;
    this.defaultLocale = options.defaultLocale;
    this.helperRoot = path.join(options.artifactRoot, "bin");
    this.providerId = options.providerId;
    this.requireOnDeviceRecognition = options.requireOnDeviceRecognition;
    this.swiftCompilerPath = options.swiftCompilerPath ?? "/usr/bin/swiftc";
  }

  async dispose(): Promise<void> {
    await Promise.all(
      Array.from(this.activeCaptures.values()).map(async (capture) => {
        if (capture.record.status === "recording" || capture.record.status === "running") {
          capture.child.kill("SIGTERM");
          await capture.promise.catch(() => undefined);
        }
      })
    );
  }

  async getCapture(captureId: string): Promise<VoiceCaptureRecord | null> {
    return this.activeCaptures.get(captureId)?.record ?? null;
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = new Date().toISOString();
    if (process.platform !== "darwin") {
      return {
        checkedAt,
        details: {
          reason: "apple_native voice is available on macOS only."
        },
        providerId: this.providerId,
        status: "unavailable"
      };
    }

    try {
      const helperPath = await this.ensureHelperBinary();
      return {
        checkedAt,
        details: {
          helperPath,
          onDeviceRequired: this.requireOnDeviceRecognition
        },
        providerId: this.providerId,
        status: "healthy"
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
    if (kind && kind !== "input") {
      return [];
    }

    const response = helperInputDeviceListSchema.parse(await this.runHelperJson(["list-input-devices"]));
    return response.devices.map((device) =>
      voiceDeviceDescriptorSchema.parse({
        default: device.default,
        id: device.id,
        kind: "input",
        metadata: device.metadata,
        name: device.name,
        providerId: this.providerId
      })
    );
  }

  async startCapture(request: VoiceCaptureRequest): Promise<VoiceCaptureRecord> {
    const helperPath = await this.ensureHelperBinary();
    const outputPath = buildVoiceArtifactPath({
      artifactRoot: this.artifactRoot,
      extension: "wav",
      id: request.id,
      kind: "captures",
      providerId: this.providerId,
      sessionId: request.sessionId
    });

    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    const args = [
      "capture",
      "--output",
      outputPath,
      "--require-on-device",
      String(this.shouldRequireOnDevice(request.metadata.localOnly))
    ];

    if (request.inputDevice) {
      args.push("--input-device", request.inputDevice);
    }
    if (request.locale) {
      args.push("--locale", request.locale);
    }
    if (request.maxDurationMs) {
      args.push("--max-duration-ms", String(request.maxDurationMs));
    }
    if (request.silenceTimeoutMs) {
      args.push("--silence-timeout-ms", String(request.silenceTimeoutMs));
    }

    const startedAt = new Date().toISOString();
    const child = spawn(helperPath, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    const initialRecord = voiceCaptureRecordSchema.parse({
      id: request.id,
      inputDevice: request.inputDevice,
      locale: request.locale,
      maxDurationMs: request.maxDurationMs,
      metadata: {
        ...request.metadata,
        outputPath,
        pid: child.pid ?? null
      },
      providerId: this.providerId,
      sessionId: request.sessionId,
      silenceTimeoutMs: request.silenceTimeoutMs,
      startedAt,
      status: "recording"
    });

    const state: ActiveCapture = {
      child,
      promise: Promise.resolve(initialRecord),
      record: initialRecord
    };

    state.promise = new Promise((resolve) => {
      let stdout = "";
      let stderr = "";

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });

      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.once("error", (error) => {
        const failedRecord = voiceCaptureRecordSchema.parse({
          ...initialRecord,
          completedAt: new Date().toISOString(),
          error: createVoiceError("voice_capture_spawn_failed", error.message),
          status: "failed",
          stopReason: "error",
          transcriptionId: stableArtifactId("voice.transcription", request.id)
        });
        state.record = failedRecord;
        resolve(failedRecord);
      });

      child.once("exit", (exitCode, signal) => {
        void (async () => {
          const finalRecord = await this.buildFinalCaptureRecord({
            exitCode: exitCode ?? 1,
            initialRecord,
            outputPath,
            signal,
            stderr,
            stdout
          });
          state.record = finalRecord;
          resolve(finalRecord);
        })().catch((error) => {
          const failedRecord = voiceCaptureRecordSchema.parse({
            ...initialRecord,
            completedAt: new Date().toISOString(),
            error: createVoiceError(
              "voice_capture_finalize_failed",
              error instanceof Error ? error.message : String(error)
            ),
            status: "failed",
            stopReason: "error",
            transcriptionId: stableArtifactId("voice.transcription", request.id)
          });
          state.record = failedRecord;
          resolve(failedRecord);
        });
      });
    });

    this.activeCaptures.set(request.id, state);
    return initialRecord;
  }

  async stopCapture(captureId: string): Promise<VoiceCaptureRecord> {
    const capture = this.activeCaptures.get(captureId);
    if (!capture) {
      throw createVoiceError("voice_capture_not_found", `Voice capture "${captureId}" was not found.`, {
        captureId
      });
    }

    if (capture.record.status === "recording" || capture.record.status === "running") {
      capture.child.kill("SIGINT");
    }

    return capture.promise;
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const filePath = voiceInputPathFromUri(request.audio.uri);
    const response = await this.runHelperJson([
      "transcribe",
      "--input",
      filePath,
      "--require-on-device",
      String(this.shouldRequireOnDevice(request.metadata.localOnly)),
      ...(request.locale ? ["--locale", request.locale] : [])
    ]);

    if (helperFailureSchema.safeParse(response).success) {
      const failure = helperFailureSchema.parse(response);
      throw createVoiceError(failure.error.code, failure.error.message, failure.error.details);
    }

    const success = helperTranscriptionSuccessSchema.parse(response);
    return transcriptionResultSchema.parse({
      completedAt: new Date().toISOString(),
      durationMs: success.result.durationMs,
      id: request.id,
      locale: normalizeLocale(success.result.locale) ?? request.locale ?? this.defaultLocale,
      metadata: request.metadata,
      providerId: this.providerId,
      text: success.result.text
    });
  }

  private async buildFinalCaptureRecord(params: {
    exitCode: number;
    initialRecord: VoiceCaptureRecord;
    outputPath: string;
    signal: NodeJS.Signals | null;
    stderr: string;
    stdout: string;
  }): Promise<VoiceCaptureRecord> {
    const transcriptionId = stableArtifactId("voice.transcription", params.initialRecord.id);
    const audioExists = await fileExists(params.outputPath);
    const completedAt = new Date().toISOString();

    let audio = undefined;
    if (audioExists) {
      audio = await buildVoiceAudioArtifact({
        filePath: params.outputPath,
        locale: params.initialRecord.locale,
        mediaType: "audio/wav",
        name: `${params.initialRecord.id}.wav`
      });
    }

    const parsed = safeParseJson(params.stdout);
    if (params.exitCode === 0) {
      const success = helperCaptureSuccessSchema.parse(parsed);
      return voiceCaptureRecordSchema.parse({
        ...params.initialRecord,
        audio,
        completedAt,
        locale: normalizeLocale(success.capture.locale) ?? params.initialRecord.locale,
        metadata: {
          ...params.initialRecord.metadata,
          outputPath: success.capture.outputPath
        },
        status: "completed",
        stopReason: success.capture.stopReason,
        text: success.capture.text,
        transcriptionId
      });
    }

    if (helperCaptureFailureSchema.safeParse(parsed).success) {
      const failure = helperCaptureFailureSchema.parse(parsed);
      return voiceCaptureRecordSchema.parse({
        ...params.initialRecord,
        audio,
        completedAt,
        error: createVoiceError(failure.error.code, failure.error.message, failure.error.details),
        locale: normalizeLocale(failure.capture?.locale) ?? params.initialRecord.locale,
        metadata: {
          ...params.initialRecord.metadata,
          outputPath: failure.capture?.outputPath ?? params.outputPath,
          signal: params.signal ?? null,
          stderr: params.stderr.trim() || null
        },
        status: "failed",
        stopReason: failure.capture?.stopReason ?? "error",
        transcriptionId
      });
    }

    return voiceCaptureRecordSchema.parse({
      ...params.initialRecord,
      audio,
      completedAt,
      error: createVoiceError(
        "voice_capture_failed",
        params.stderr.trim() || "The Apple voice helper exited without a structured error payload.",
        {
          exitCode: params.exitCode,
          signal: params.signal ?? null
        }
      ),
      metadata: {
        ...params.initialRecord.metadata,
        outputPath: params.outputPath
      },
      status: "failed",
      stopReason: "error",
      transcriptionId
    });
  }

  private async ensureHelperBinary(): Promise<string> {
    if (!this.helperPromise) {
      this.helperPromise = this.buildHelperBinary();
    }

    return this.helperPromise;
  }

  private async buildHelperBinary(): Promise<string> {
    if (process.platform !== "darwin") {
      throw createVoiceError("voice_helper_platform_unsupported", "The Apple voice helper requires macOS.");
    }

    const helperSourcePath = path.join(this.helperRoot, "apple-native-voice-helper.swift");
    const helperBinaryPath = path.join(this.helperRoot, "apple-native-voice-helper");
    const helperHashPath = path.join(this.helperRoot, "apple-native-voice-helper.sha256");
    const sourceHash = crypto.createHash("sha256").update(APPLE_NATIVE_VOICE_HELPER_SOURCE).digest("hex");

    await fs.mkdir(this.helperRoot, { recursive: true });
    await writeIfChanged(helperSourcePath, APPLE_NATIVE_VOICE_HELPER_SOURCE);

    const existingHash = await fs.readFile(helperHashPath, "utf8").catch(() => "");
    if (existingHash.trim() === sourceHash && (await fileExists(helperBinaryPath))) {
      return helperBinaryPath;
    }

    const compileResult = await runProcess(this.swiftCompilerPath, [
      helperSourcePath,
      "-framework",
      "AVFoundation",
      "-framework",
      "Speech",
      "-o",
      helperBinaryPath
    ]);
    if (compileResult.exitCode !== 0) {
      throw createVoiceError(
        "voice_helper_compile_failed",
        compileResult.stderr.trim() || "Failed to compile the Apple voice helper.",
        {
          stdout: compileResult.stdout.trim()
        }
      );
    }

    await fs.writeFile(helperHashPath, `${sourceHash}\n`, "utf8");
    return helperBinaryPath;
  }

  private async runHelperJson(args: string[]): Promise<unknown> {
    const helperPath = await this.ensureHelperBinary();
    const result = await runProcess(helperPath, args);
    const stdout = result.stdout.trim();

    if (!stdout) {
      throw createVoiceError(
        "voice_helper_empty_output",
        result.stderr.trim() || "The Apple voice helper produced no JSON output."
      );
    }

    return safeParseJson(stdout);
  }

  private shouldRequireOnDevice(localOnly: unknown): boolean {
    return localOnly === true || this.requireOnDeviceRecognition;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw createVoiceError(
      "voice_helper_invalid_json",
      error instanceof Error ? error.message : "The Apple voice helper returned invalid JSON.",
      {
        output: text
      }
    );
  }
}
