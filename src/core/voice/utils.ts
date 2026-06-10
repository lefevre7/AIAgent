import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ArtifactReference, JsonValue, StructuredError, VoiceJobStatus } from "@/core/contracts";
import { createArtifactReferenceFromFile } from "@/core/io/artifacts";

export type RunProcessOptions = {
  cwd?: string;
  stdinText?: string;
  timeoutMs?: number;
};

export type RunProcessResult = {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
};

export function buildVoiceArtifactPath(params: {
  artifactRoot: string;
  extension: string;
  id: string;
  kind: "captures" | "synthesis";
  providerId: string;
  sessionId?: string;
}): string {
  return path.join(
    params.artifactRoot,
    params.kind,
    params.providerId,
    params.sessionId ?? "shared",
    `${params.id}.${params.extension.replace(/^\./u, "")}`
  );
}

export async function buildVoiceAudioArtifact(params: {
  filePath: string;
  locale?: string;
  mediaType: string;
  name?: string;
  transcript?: string;
  voice?: string;
}): Promise<ArtifactReference> {
  const durationMs = await probeAudioDurationMs(params.filePath);
  const metadata: Record<string, JsonValue> = {};

  if (durationMs !== undefined) {
    metadata.durationMs = durationMs;
  }
  if (params.locale) {
    metadata.locale = params.locale;
  }
  if (params.transcript) {
    metadata.transcript = params.transcript;
  }
  if (params.voice) {
    metadata.voice = params.voice;
  }

  return createArtifactReferenceFromFile(params.filePath, "audio", {
    mediaType: params.mediaType,
    metadata,
    name: params.name
  });
}

export function createVoiceError(
  code: string,
  message: string,
  details: Record<string, JsonValue> = {},
  retriable = false
): StructuredError {
  return {
    code,
    details,
    message,
    retriable
  };
}

export function isTerminalVoiceStatus(status: VoiceJobStatus): boolean {
  return status === "cancelled" || status === "completed" || status === "failed";
}

export function normalizeLocale(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return value.replace(/_/gu, "-");
}

export function normalizeVoiceError(error: unknown, fallbackCode = "voice_operation_failed"): StructuredError {
  if (isStructuredError(error)) {
    return error;
  }

  if (error instanceof Error) {
    return createVoiceError(fallbackCode, error.message);
  }

  return createVoiceError(fallbackCode, String(error));
}

export async function probeAudioDurationMs(filePath: string): Promise<number | undefined> {
  if (process.platform !== "darwin") {
    return undefined;
  }

  try {
    const result = await runProcess("/usr/bin/afinfo", [filePath]);
    if (result.exitCode !== 0) {
      return undefined;
    }

    const match = result.stdout.match(/estimated duration:\s+([0-9.]+)/u);
    if (!match) {
      return undefined;
    }

    const seconds = Number.parseFloat(match[1] ?? "");
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return undefined;
    }

    return Math.trunc(seconds * 1_000);
  } catch {
    return undefined;
  }
}

export async function runProcess(command: string, args: string[], options: RunProcessOptions = {}): Promise<RunProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: "pipe"
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer =
      typeof options.timeoutMs === "number"
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
          }, options.timeoutMs)
        : null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    });
    child.once("exit", (exitCode, signal) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve({
        exitCode: exitCode ?? 1,
        signal,
        stderr,
        stdout,
        timedOut
      });
    });

    if (options.stdinText !== undefined) {
      child.stdin?.end(options.stdinText);
    } else {
      child.stdin?.end();
    }
  });
}

export function stableArtifactId(prefix: string, value: string): string {
  return `${prefix}.${crypto.createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

export async function writeIfChanged(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  try {
    const existing = await fs.readFile(filePath, "utf8");
    if (existing === content) {
      return;
    }
  } catch {
    // Ignore missing files and overwrite below.
  }

  await fs.writeFile(filePath, content, "utf8");
}

export function voiceInputPathFromUri(uri: string): string {
  if (/^file:\/\//u.test(uri)) {
    return fileURLToPath(uri);
  }

  if (path.isAbsolute(uri)) {
    return uri;
  }

  throw createVoiceError(
    "voice_input_uri_unsupported",
    "Voice input artifacts must use a local file URI or an absolute file path.",
    {
      uri
    }
  );
}

function isStructuredError(error: unknown): error is StructuredError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    "retriable" in error &&
    "details" in error
  );
}
