import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { AppConfig, SecretInput, SecretRef } from "@/core/config/schema";
import { secretRefSchema } from "@/core/config/schema";

const execFileAsync = promisify(execFile);
const ENV_TEMPLATE_PATTERN = /^\$\{([A-Z][A-Z0-9_]{0,127})\}$/;

export class SecretResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretResolutionError";
  }
}

export async function resolveConfigSecrets(
  config: AppConfig,
  environment: Record<string, string | undefined> = process.env
): Promise<AppConfig> {
  return (await resolveUnknownValue(config, config, environment)) as AppConfig;
}

export async function resolveSecretInput(
  value: SecretInput,
  config: AppConfig,
  environment: Record<string, string | undefined> = process.env
): Promise<string> {
  const ref = coerceSecretRef(value, config);
  if (!ref) {
    return value as string;
  }
  return resolveSecretReference(ref, config, environment);
}

async function resolveUnknownValue(
  value: unknown,
  config: AppConfig,
  environment: Record<string, string | undefined>
): Promise<unknown> {
  const ref = coerceSecretRef(value, config);
  if (ref) {
    return resolveSecretReference(ref, config, environment);
  }

  if (Array.isArray(value)) {
    return Promise.all(value.map((entry) => resolveUnknownValue(entry, config, environment)));
  }

  if (isPlainObject(value)) {
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, entry]) => [key, await resolveUnknownValue(entry, config, environment)] as const)
    );
    return Object.fromEntries(entries);
  }

  return value;
}

function coerceSecretRef(value: unknown, config: AppConfig): SecretRef | null {
  const parsed = secretRefSchema.safeParse(value);
  if (parsed.success) {
    return fillDefaultProvider(parsed.data, config);
  }

  if (typeof value !== "string") {
    return null;
  }
  const match = ENV_TEMPLATE_PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }
  return {
    id: match[1],
    provider: config.secrets.defaults.env,
    source: "env"
  };
}

function fillDefaultProvider(ref: SecretRef, config: AppConfig): SecretRef {
  if (ref.provider) {
    return ref;
  }

  return {
    ...ref,
    provider:
      ref.source === "env"
        ? config.secrets.defaults.env
        : ref.source === "file"
          ? config.secrets.defaults.file
          : config.secrets.defaults.exec
  };
}

async function resolveSecretReference(
  ref: SecretRef,
  config: AppConfig,
  environment: Record<string, string | undefined>
): Promise<string> {
  const provider = config.secrets.providers[ref.provider ?? ""];
  if (!provider) {
    throw new SecretResolutionError(`Secret provider "${ref.provider}" is not configured for ${ref.source}:${ref.id}.`);
  }
  if (provider.source !== ref.source) {
    throw new SecretResolutionError(
      `Secret provider "${ref.provider}" has source "${provider.source}" but "${ref.source}" was requested.`
    );
  }

  if (provider.source === "env") {
    if (provider.allowlist && !provider.allowlist.includes(ref.id)) {
      throw new SecretResolutionError(`Env secret "${ref.id}" is not allowlisted for provider "${ref.provider}".`);
    }
    const resolved = environment[ref.id];
    if (!resolved) {
      throw new SecretResolutionError(`Required env secret "${ref.id}" is not set.`);
    }
    return resolved;
  }

  if (provider.source === "file") {
    const text = await fs.readFile(provider.path, "utf8");
    if (provider.maxBytes && Buffer.byteLength(text) > provider.maxBytes) {
      throw new SecretResolutionError(`Secret file "${provider.path}" exceeded maxBytes (${provider.maxBytes}).`);
    }
    if (provider.mode === "singleValue") {
      return text.trim();
    }
    const document = JSON.parse(text) as unknown;
    return extractSecretValue(document, ref.id, `file provider "${ref.provider}"`);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...provider.env
  };
  for (const name of provider.passEnv ?? []) {
    const value = environment[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  const result = await execFileAsync(provider.command, provider.args ?? [], {
    env,
    maxBuffer: provider.maxOutputBytes ?? 16_384,
    timeout: provider.timeoutMs ?? 10_000
  });
  const stdout = result.stdout.trim();
  if (!stdout) {
    throw new SecretResolutionError(`Exec secret provider "${ref.provider}" returned empty stdout.`);
  }
  if (!provider.jsonOnly) {
    if (ref.id !== "value") {
      throw new SecretResolutionError(
        `Exec secret provider "${ref.provider}" uses raw stdout, so the secret id must be "value".`
      );
    }
    return stdout;
  }
  const document = JSON.parse(stdout) as unknown;
  return extractSecretValue(document, ref.id, `exec provider "${ref.provider}"`);
}

function extractSecretValue(document: unknown, pointer: string, label: string): string {
  const selected = pointer === "value" ? document : resolveJsonPointer(document, pointer);

  if (typeof selected === "string") {
    return selected;
  }
  if (typeof selected === "number" || typeof selected === "boolean") {
    return String(selected);
  }
  throw new SecretResolutionError(`${label} resolved ${pointer} to a non-scalar value.`);
}

function resolveJsonPointer(document: unknown, pointer: string): unknown {
  const segments = pointer
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));

  let current: unknown = document;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      current = current[index];
      continue;
    }
    if (!isPlainObject(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
