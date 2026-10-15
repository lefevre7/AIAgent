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

/**
 * Providers the caller has decided may not run — currently workspace-declared
 * `exec`/`file` providers in a config the operator has not trusted (H3).
 */
export type SecretResolutionOptions = {
  untrustedProviderNames?: string[];
};

export async function resolveConfigSecrets(
  config: AppConfig,
  environment: Record<string, string | undefined> = process.env,
  options: SecretResolutionOptions = {}
): Promise<AppConfig> {
  return (await resolveUnknownValue(config, config, environment, options)) as AppConfig;
}

export async function resolveSecretInput(
  value: SecretInput,
  config: AppConfig,
  environment: Record<string, string | undefined> = process.env,
  options: SecretResolutionOptions = {}
): Promise<string> {
  const ref = coerceSecretRef(value, config);
  if (!ref) {
    return value as string;
  }
  return resolveSecretReference(ref, config, environment, options);
}

async function resolveUnknownValue(
  value: unknown,
  config: AppConfig,
  environment: Record<string, string | undefined>,
  options: SecretResolutionOptions
): Promise<unknown> {
  const ref = coerceSecretRef(value, config);
  if (ref) {
    return resolveSecretReference(ref, config, environment, options);
  }

  if (Array.isArray(value)) {
    return Promise.all(value.map((entry) => resolveUnknownValue(entry, config, environment, options)));
  }

  if (isPlainObject(value)) {
    const entries = await Promise.all(
      Object.entries(value).map(
        async ([key, entry]) => [key, await resolveUnknownValue(entry, config, environment, options)] as const
      )
    );
    return Object.fromEntries(entries);
  }

  return value;
}

/**
 * Whether a config value would be resolved as a secret: a `{ source, id }`
 * reference or a whole-string `${NAME}` template. Workspace trust withholds
 * such values from an untrusted config, which could otherwise copy any of the
 * operator's environment variables into a header, a URL, or a prompt.
 */
export function isSecretReferenceValue(value: unknown): boolean {
  if (secretRefSchema.safeParse(value).success) {
    return true;
  }
  return typeof value === "string" && ENV_TEMPLATE_PATTERN.test(value.trim());
}

/** A short spelling of a secret reference for the operator: `${NAME}` or `exec:/path`. */
export function describeSecretReference(value: unknown): string {
  const parsed = secretRefSchema.safeParse(value);
  if (parsed.success) {
    return `${parsed.data.source}:${parsed.data.id}${parsed.data.provider ? ` (provider ${parsed.data.provider})` : ""}`;
  }
  return typeof value === "string" ? value.trim() : String(value);
}

/**
 * Config values (headers, env) as plain strings, for a connection being made.
 * Secret references must be resolved already (`loadAIAgentConfig` returns
 * `resolvedConfig` with them resolved); one left over is a wiring bug, so it
 * fails loudly instead of sending the reference object as a value. `owner`
 * and `kind` name the value in the error: 'MCP server "docs"', "header".
 */
export function materializeSecretRecord(
  values: Record<string, SecretInput>,
  owner: string,
  kind: string
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      if (typeof value !== "string") {
        throw new Error(`${owner} has an unresolved secret-backed ${kind} "${key}". Use resolvedConfig.`);
      }
      return [key, value];
    })
  );
}

/**
 * `headers` with `Authorization: Bearer <apiKey>`, unless there is no key or
 * an Authorization header is configured already (that header wins, and the
 * key is not used). The key must be resolved, as for `materializeSecretRecord`.
 */
export function withBearerApiKey(
  headers: Record<string, string>,
  apiKey: SecretInput | undefined,
  owner: string
): Record<string, string> {
  if (
    apiKey === undefined ||
    apiKey === "" ||
    Object.keys(headers).some((name) => name.toLowerCase() === "authorization")
  ) {
    return headers;
  }
  if (typeof apiKey !== "string") {
    throw new Error(`${owner} has an unresolved secret-backed apiKey. Use resolvedConfig.`);
  }
  return { ...headers, Authorization: `Bearer ${apiKey}` };
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
  environment: Record<string, string | undefined>,
  options: SecretResolutionOptions = {}
): Promise<string> {
  // H3: the provider is declared by a workspace config the operator has not
  // trusted, so it was withheld from the merged config. Say so rather than
  // "not configured", which would send the operator looking in the wrong place.
  if (ref.provider && options.untrustedProviderNames?.includes(ref.provider)) {
    throw new SecretResolutionError(
      `Secret provider "${ref.provider}" is declared by an untrusted workspace config, so it was not used for ` +
        `${ref.source}:${ref.id}. Run \`aia trust\` in this workspace to see what it would do, then grant it if you agree.`
    );
  }
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
