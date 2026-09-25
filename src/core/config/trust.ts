import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { writeJsonAtomic } from "@/core/io/files";

/**
 * Workspace-config trust (security review H3).
 *
 * Workspace config is discovered by walking *up* from cwd, and a config file
 * can declare secret providers. The `exec` provider runs an arbitrary command;
 * the `file` provider reads an arbitrary absolute path. Both are rebased
 * against the repo directory, so merely running `aia` inside a cloned repo used
 * to be enough to execute `<repo>/payload.sh` with the operator's environment,
 * or to read `~/.ssh/id_rsa` and exfiltrate it through a provider header.
 *
 * A workspace config must therefore be explicitly trusted before the providers
 * that can execute or read arbitrary files are honoured. Trust is keyed on the
 * file's path *and* the SHA-256 of its exact contents, so a repo that is
 * trusted today cannot silently grow an `exec` provider tomorrow — editing the
 * file revokes trust until the operator grants it again.
 *
 * The trust store deliberately lives under the user's home state directory,
 * never inside the workspace: a record stored in the repo could simply be
 * shipped pre-populated by the attacker.
 */

/**
 * Secret provider sources that can run a command or read an arbitrary path.
 * `env` is excluded: it can only read the environment the process already has.
 */
export const TRUST_GATED_SECRET_SOURCES = new Set(["exec", "file"]);

export const CONFIG_TRUST_FILE_NAME = "trust.json";

const trustedConfigEntrySchema = z
  .object({
    grantedAt: z.string().min(1),
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u)
  })
  .strict();

const configTrustStoreSchema = z
  .object({
    trustedConfigs: z.array(trustedConfigEntrySchema).default([]),
    version: z.literal(1).default(1)
  })
  .strict();

export type ConfigTrustEntry = z.infer<typeof trustedConfigEntrySchema>;
export type ConfigTrustStore = z.infer<typeof configTrustStoreSchema>;

export type ConfigFingerprint = {
  path: string;
  sha256: string;
};

export function configTrustFilePath(userStateDirectory: string): string {
  return path.join(userStateDirectory, CONFIG_TRUST_FILE_NAME);
}

export function fingerprintConfigContents(filePath: string, contents: string): ConfigFingerprint {
  return {
    path: path.resolve(filePath),
    sha256: crypto.createHash("sha256").update(contents, "utf8").digest("hex")
  };
}

/**
 * Canonical key for one config file.
 *
 * Resolves symlinks, because `path.resolve` alone does not: on macOS `/tmp` is
 * a symlink to `/private/tmp`, so the same file reached two ways produced two
 * different keys — a grant made under one spelling could not be revoked under
 * the other, and `aia trust --revoke` reported success while leaving the grant
 * in place. A revoke that silently does nothing is the dangerous direction.
 */
async function canonicalConfigPath(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch {
    // The file may not exist (revoking a stale entry); fall back to a plain
    // absolute path so the caller can still address it.
    return path.resolve(filePath);
  }
}

/**
 * Fingerprints a config file on disk, or returns null when it does not exist.
 * A missing file is not an error: most workspaces have no config at all.
 */
export async function fingerprintConfigFile(filePath: string): Promise<ConfigFingerprint | null> {
  try {
    const contents = await fs.readFile(filePath, "utf8");
    return {
      ...fingerprintConfigContents(filePath, contents),
      path: await canonicalConfigPath(filePath)
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

export class ConfigTrustStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigTrustStoreError";
  }
}

/** Reads the store, throwing when a file exists but cannot be used. */
async function readConfigTrustStoreStrict(userStateDirectory: string): Promise<ConfigTrustStore> {
  const filePath = configTrustFilePath(userStateDirectory);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return { trustedConfigs: [], version: 1 };
    }
    throw new ConfigTrustStoreError(
      `The trust store ${filePath} could not be read (${error instanceof Error ? error.message : String(error)}).`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ConfigTrustStoreError(`The trust store ${filePath} is not valid JSON.`);
  }
  const result = configTrustStoreSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigTrustStoreError(
      `The trust store ${filePath} has an unexpected shape (${result.error.issues[0]?.message ?? "invalid"}).`
    );
  }
  return result.data;
}

export async function readConfigTrustStore(userStateDirectory: string): Promise<ConfigTrustStore> {
  try {
    return await readConfigTrustStoreStrict(userStateDirectory);
  } catch (error) {
    // A damaged or unparsable trust store must fail closed: treating it as
    // "everything is trusted" would turn corruption into a bypass. Not
    // silently, though, or every trusted workspace just stops working behind
    // a warning that blames the workspace instead.
    process.emitWarning(
      `${error instanceof Error ? error.message : String(error)} Every workspace config is treated as untrusted until it is fixed or removed.`,
      { code: "AIA_TRUST_STORE_UNREADABLE" }
    );
    return { trustedConfigs: [], version: 1 };
  }
}

/**
 * Rewriting a store that could not be read would replace every grant it holds
 * with just the one being changed, so an update refuses instead.
 */
async function readConfigTrustStoreForUpdate(userStateDirectory: string): Promise<ConfigTrustStore> {
  try {
    return await readConfigTrustStoreStrict(userStateDirectory);
  } catch (error) {
    throw new ConfigTrustStoreError(
      `${error instanceof Error ? error.message : String(error)} Nothing was changed: rewriting it would drop every grant it holds. Fix or remove the file, then try again.`
    );
  }
}

export function isConfigTrusted(store: ConfigTrustStore, fingerprint: ConfigFingerprint): boolean {
  return store.trustedConfigs.some((entry) => entry.path === fingerprint.path && entry.sha256 === fingerprint.sha256);
}

/**
 * Records trust for one exact config file + contents, replacing any earlier
 * grant for the same path (an older hash must not stay valid).
 */
export async function grantConfigTrust(
  userStateDirectory: string,
  fingerprint: ConfigFingerprint
): Promise<ConfigTrustStore> {
  const store = await readConfigTrustStoreForUpdate(userStateDirectory);
  const next: ConfigTrustStore = {
    trustedConfigs: [
      ...store.trustedConfigs.filter((entry) => entry.path !== fingerprint.path),
      {
        grantedAt: new Date().toISOString(),
        path: fingerprint.path,
        sha256: fingerprint.sha256
      }
    ].sort((left, right) => left.path.localeCompare(right.path)),
    version: 1
  };

  await fs.mkdir(userStateDirectory, { recursive: true });
  await writeJsonAtomic(configTrustFilePath(userStateDirectory), next);
  return next;
}

export async function revokeConfigTrust(userStateDirectory: string, filePath: string): Promise<ConfigTrustStore> {
  const store = await readConfigTrustStoreForUpdate(userStateDirectory);
  // Match both spellings: entries granted before path canonicalization, and
  // callers that hand us an un-resolved path.
  const candidates = new Set([await canonicalConfigPath(filePath), path.resolve(filePath)]);
  const next: ConfigTrustStore = {
    trustedConfigs: store.trustedConfigs.filter((entry) => !candidates.has(entry.path)),
    version: 1
  };

  await fs.mkdir(userStateDirectory, { recursive: true });
  await writeJsonAtomic(configTrustFilePath(userStateDirectory), next);
  return next;
}

/**
 * Names the secret providers a config fragment declares that need trust before
 * they may run. Works on the raw fragment (pre-merge) so a provider is only
 * attributed to the layer that actually declared it.
 */
export function collectTrustGatedProviderNames(fragment: unknown): string[] {
  if (!isPlainObject(fragment)) {
    return [];
  }
  const secrets = fragment.secrets;
  if (!isPlainObject(secrets)) {
    return [];
  }
  const providers = secrets.providers;
  if (!isPlainObject(providers)) {
    return [];
  }

  return Object.entries(providers)
    .filter(([, provider]) => {
      if (!isPlainObject(provider)) {
        return false;
      }
      return typeof provider.source === "string" && TRUST_GATED_SECRET_SOURCES.has(provider.source);
    })
    .map(([name]) => name)
    .sort();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}
