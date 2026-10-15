import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { parseJsoncText } from "@/core/config/jsonc";
import { readImportedMcpFile } from "@/core/config/mcp-imports";
import { resolveAbsolutePath } from "@/core/config/paths";
import type { ApprovalSettings, ApprovalSettingsFragment } from "@/core/config/schema";
import { describeSecretReference, isSecretReferenceValue } from "@/core/config/secrets";
import type { ApprovalPolicyMode } from "@/core/contracts";
import { writeJsonAtomic } from "@/core/io/files";

/**
 * Workspace-config trust (security review H3, M11).
 *
 * Workspace config is discovered by walking *up* from cwd, so a cloned
 * repository chooses what it contains. Anything in it that can run a program,
 * send the operator's data or credentials somewhere, or read outside the
 * project therefore waits until the operator trusts that exact file:
 *
 * - Secret providers: an `exec` provider runs a command and a `file` provider
 *   reads an arbitrary path (both rebased against the repo directory). And
 *   `${NAME}` or `{ source, id }` references anywhere in the file would copy
 *   the operator's environment or secrets into it, so those wait too.
 * - `mcp.servers`, `imports`, `templates`, `passEnv`: a stdio server's command
 *   runs as soon as aia starts, and any of them can rewrite a server the
 *   operator configured user-globally. The files `mcp.imports` names are part
 *   of the grant, so editing one revokes it like editing the config.
 * - Model provider endpoints, headers, keys and request extras; image and
 *   voice providers: where the conversation and credentials are sent.
 * - `externalAgents`, `gateway`, `tunnel`, `channels`: what runs, who can
 *   connect, and who may issue commands.
 * - `skills.extraRoots`, `memory.extraPaths`: folders read into the model's
 *   context from outside the project.
 *
 * An untrusted layer is merged without them (`withoutTrustGatedEntries`).
 * Trust is keyed on the file's path *and* the SHA-256 of its exact contents, so
 * a repo that is trusted today cannot silently grow a server tomorrow: editing
 * the file revokes trust until the operator grants it again.
 *
 * A workspace `aia.approvals.jsonc` is trusted the same way, but an untrusted
 * one still applies what only tightens approval (its deny and ask rules, and a
 * stricter `defaultMode`); see `mergeWorkspaceApprovals`.
 *
 * The trust store deliberately lives under the user's home state directory,
 * never inside the workspace: a record stored in the repo could simply be
 * shipped pre-populated by the attacker.
 */

/**
 * Secret provider sources that can run a command or read an arbitrary path.
 * `env` is excluded: it can only read the environment the process already
 * has, and an untrusted file's own references to it are withheld anyway.
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
    sha256: sha256(contents)
  };
}

/**
 * Canonical key for one config file: its directory with symlinks resolved,
 * plus the file's own name.
 *
 * The directory is resolved because `path.resolve` does not resolve symlinks:
 * on macOS `/tmp` is `/private/tmp`, so the same file reached two ways produced
 * two keys, a grant made under one spelling could not be revoked under the
 * other, and `aia trust --revoke` reported success while leaving the grant.
 *
 * The file itself is deliberately *not* resolved. A config's relative paths
 * (an exec provider's command, an import, a server's cwd) resolve against the
 * directory it was found in, so a repo whose `aia.config.jsonc` is a symlink to
 * a trusted file elsewhere would otherwise inherit that grant while running
 * its own `./scripts/token.sh`. A symlinked config needs its own grant.
 */
export async function canonicalConfigPath(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
  try {
    return path.join(await fs.realpath(path.dirname(resolved)), path.basename(resolved));
  } catch {
    // The directory may be gone (revoking a stale entry); keep the plain
    // absolute path so the caller can still address it.
    return resolved;
  }
}

/**
 * Fingerprints a config file on disk, or returns null when it does not exist.
 * A missing file is not an error: most workspaces have no config at all.
 */
export async function fingerprintConfigFile(filePath: string): Promise<ConfigFingerprint | null> {
  try {
    return await fingerprintConfigText(filePath, await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Fingerprints text a caller has already read. The loader hashes the exact
 * bytes it parsed: reading the file a second time to hash it let a file that
 * changed in between be trusted for contents that were never parsed.
 */
export async function fingerprintConfigText(filePath: string, contents: string): Promise<ConfigFingerprint> {
  return {
    ...fingerprintConfigContents(filePath, contents),
    path: await canonicalConfigPath(filePath)
  };
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

/**
 * Checks that a grant could be recorded, without recording it. A caller about
 * to edit a file and then re-grant it calls this first, so an unusable store
 * fails before the edit rather than after it.
 */
export async function assertConfigTrustStoreWritable(userStateDirectory: string): Promise<void> {
  await readConfigTrustStoreForUpdate(userStateDirectory);
}

export function isConfigTrusted(store: ConfigTrustStore, fingerprint: ConfigFingerprint): boolean {
  return store.trustedConfigs.some((entry) => entry.path === fingerprint.path && entry.sha256 === fingerprint.sha256);
}

/**
 * Records trust for exact config files + contents, replacing any earlier
 * grant for the same paths (an older hash must not stay valid). Several
 * fingerprints are recorded in one write, so a workspace's config and
 * approvals files are trusted together or not at all.
 */
export async function grantConfigTrust(
  userStateDirectory: string,
  ...fingerprints: ConfigFingerprint[]
): Promise<ConfigTrustStore> {
  const store = await readConfigTrustStoreForUpdate(userStateDirectory);
  const paths = new Set(fingerprints.map((fingerprint) => fingerprint.path));
  const grantedAt = new Date().toISOString();
  const next: ConfigTrustStore = {
    trustedConfigs: [
      ...store.trustedConfigs.filter((entry) => !paths.has(entry.path)),
      ...fingerprints.map((fingerprint) => ({ grantedAt, path: fingerprint.path, sha256: fingerprint.sha256 }))
    ].sort((left, right) => left.path.localeCompare(right.path)),
    version: 1
  };

  await fs.mkdir(userStateDirectory, { recursive: true });
  await writeJsonAtomic(configTrustFilePath(userStateDirectory), next);
  return next;
}

export async function revokeConfigTrust(userStateDirectory: string, ...filePaths: string[]): Promise<ConfigTrustStore> {
  const store = await readConfigTrustStoreForUpdate(userStateDirectory);
  // Match both spellings: entries granted before path canonicalization, and
  // callers that hand us an un-resolved path.
  const candidates = new Set<string>();
  for (const filePath of filePaths) {
    candidates.add(await canonicalConfigPath(filePath));
    candidates.add(path.resolve(filePath));
  }
  const next: ConfigTrustStore = {
    trustedConfigs: store.trustedConfigs.filter((entry) => !candidates.has(entry.path)),
    version: 1
  };

  await fs.mkdir(userStateDirectory, { recursive: true });
  await writeJsonAtomic(configTrustFilePath(userStateDirectory), next);
  return next;
}

/** A secret provider an untrusted workspace config declared, held back. */
export type TrustGatedSecretProvider = {
  args?: string[];
  command?: string;
  name: string;
  path?: string;
  source: string;
};

/**
 * One MCP entry an untrusted workspace config declared and that was held back,
 * described by what it would run or reach so the operator can decide. Values
 * come from the config as written: print them through `sanitizeForTerminal`.
 */
export type TrustGatedMcpEntry = {
  args?: string[];
  command?: string;
  cwd?: string;
  /** The server's `env`, with secret references spelled out (`env:NAME`). */
  env?: Record<string, string>;
  headerNames?: string[];
  /** `pass_env`: `mcp.passEnv`, the variables every stdio server would get. */
  kind: "import" | "pass_env" | "server" | "template";
  /** An import whose file does not exist (yet). */
  missing?: boolean;
  name: string;
  /** The server's own `passEnv`. */
  passEnv?: string[];
  /** The import's source file. */
  path?: string;
  /** The servers an import's file declares, when it could be read. */
  servers?: TrustGatedMcpEntry[];
  /** The server's declared `type`, when it declared one. */
  transport?: string;
  /** `trust: "trusted"`: every tool of the server would run without asking. */
  trustsTools?: boolean;
  /** An import whose file exists but could not be read or parsed. */
  unreadable?: string;
  url?: string;
};

/** Any other setting an untrusted workspace config may not use. */
export type TrustGatedSetting = {
  /** Dotted config path, such as `providers.llamaCpp.baseUrl`. */
  path: string;
  /** What it would do. Contains config text: print through `sanitizeForTerminal`. */
  summary: string;
};

export type ConfigTrustGates = {
  mcpEntries: TrustGatedMcpEntry[];
  providers: TrustGatedSecretProvider[];
  settings: TrustGatedSetting[];
};

/**
 * The `mcp` keys a workspace config may contribute only once it is trusted.
 *
 * Each one can make aia start a process or reach a server on the operator's
 * behalf: `servers` declares a server (a stdio server runs its command the
 * moment aia starts) or overrides one from the user-global config, `imports`
 * pulls servers in from another file, `templates` puts installable servers in
 * front of the model, and `passEnv` hands variables to every stdio server
 * (an empty list included: arrays replace on merge, so `[]` would take the
 * operator's own list away). `watch` and the timeouts only decide when and how
 * long, so a workspace may still set them.
 */
export const TRUST_GATED_MCP_KEYS = ["imports", "passEnv", "servers", "templates"] as const;

type SettingGate = {
  describe(value: unknown): string;
  path: readonly string[];
};

const MODEL_PROVIDER_GATES: SettingGate[] = [
  ...(["lmStudio", "llamaCpp", "ollama"] as const).flatMap((provider): SettingGate[] => [
    {
      describe: (value) => `sends model requests, with your conversation, to ${String(value)}`,
      path: ["providers", provider, "baseUrl"]
    },
    {
      describe: (value) => `adds headers to every model request: ${listKeys(value)}`,
      path: ["providers", provider, "headers"]
    }
  ]),
  {
    describe: (value) => `adds fields to every LM Studio request: ${listKeys(value)}`,
    path: ["providers", "lmStudio", "requestExtras"]
  },
  {
    describe: (value) => `adds fields to every llama.cpp request: ${listKeys(value)}`,
    path: ["providers", "llamaCpp", "requestExtras"]
  },
  {
    describe: () => "sets the API key sent with every llama.cpp request",
    path: ["providers", "llamaCpp", "apiKey"]
  },
  {
    describe: (value) => `sends memory text to ${String(value)} for embedding`,
    path: ["providers", "llamaCpp", "embeddingsBaseUrl"]
  }
];

/**
 * Settings outside `mcp` and `secrets` that wait for trust: where requests and
 * credentials go, what runs, who can connect, and what is read from outside
 * the project. One table drives the description, the collection, and the
 * stripping, so a new entry cannot be listed without being withheld.
 */
const TRUST_GATED_SETTINGS: readonly SettingGate[] = [
  ...MODEL_PROVIDER_GATES,
  {
    describe: (value) => `configures image providers (${listKeys(value)}): where images and prompts are sent`,
    path: ["providers", "imageProviders"]
  },
  {
    describe: (value) => `configures voice providers (${listKeys(value)}): where audio is sent`,
    path: ["providers", "voiceProviders"]
  },
  {
    describe: () => "configures external coding agents: the commands they run, their arguments and environment",
    path: ["externalAgents"]
  },
  { describe: () => "changes the gateway's address, port, or access token", path: ["gateway"] },
  { describe: () => "changes remote access (the tunnel)", path: ["tunnel"] },
  {
    describe: () => "configures messaging channels, including who may run commands through them",
    path: ["channels"]
  },
  { describe: (value) => `loads Agent Skills from ${listValues(value)}`, path: ["skills", "extraRoots"] },
  { describe: (value) => `reads ${listValues(value)} into memory`, path: ["memory", "extraPaths"] }
];

/**
 * Names the `exec`/`file` secret providers a config fragment declares. Works on
 * the raw fragment (pre-merge) so a provider is only attributed to the layer
 * that actually declared it.
 */
export function collectTrustGatedProviderNames(fragment: unknown): string[] {
  return collectTrustGatedSecretProviders(fragment).map((provider) => provider.name);
}

/** The `exec`/`file` secret providers a config fragment declares, with what each would run or read. */
export function collectTrustGatedSecretProviders(fragment: unknown): TrustGatedSecretProvider[] {
  if (!isPlainObject(fragment) || !isPlainObject(fragment.secrets)) {
    return [];
  }
  return plainObjectEntries(fragment.secrets.providers)
    .filter(([, provider]) => typeof provider.source === "string" && TRUST_GATED_SECRET_SOURCES.has(provider.source))
    .map(([name, provider]) => ({
      name,
      source: typeof provider.source === "string" ? provider.source : "unknown",
      ...(typeof provider.command === "string"
        ? { args: stringEntries(provider.args), command: provider.command }
        : {}),
      ...(typeof provider.path === "string" ? { path: provider.path } : {})
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Lists the MCP entries a config fragment declares that need trust. Works on
 * the raw fragment, like `collectTrustGatedProviderNames`, so an entry is only
 * attributed to the layer that declared it.
 */
export function collectTrustGatedMcpEntries(fragment: unknown): TrustGatedMcpEntry[] {
  if (!isPlainObject(fragment) || !isPlainObject(fragment.mcp)) {
    return [];
  }
  const mcp = fragment.mcp;
  const entries: TrustGatedMcpEntry[] = [];

  for (const [name, server] of plainObjectEntries(mcp.servers)) {
    entries.push(describeMcpServerForTrust(name, server));
  }
  for (const [name, entry] of plainObjectEntries(mcp.imports)) {
    entries.push({ kind: "import", name, ...(typeof entry.path === "string" ? { path: entry.path } : {}) });
  }
  for (const [name] of plainObjectEntries(mcp.templates)) {
    entries.push({ kind: "template", name });
  }
  // Hands the named variables of the operator's environment to every stdio
  // server, the user-global ones included. Present at all, it is gated: an
  // empty list would replace the operator's own.
  if (Array.isArray(mcp.passEnv)) {
    entries.push({ kind: "pass_env", name: stringEntries(mcp.passEnv).join(", ") });
  }

  return entries;
}

/**
 * The other settings a config fragment declares that need trust, and every
 * secret reference (`${NAME}`, `{ source, id }`) it uses elsewhere.
 */
export function collectTrustGatedSettings(fragment: unknown): TrustGatedSetting[] {
  if (!isPlainObject(fragment)) {
    return [];
  }
  const settings: TrustGatedSetting[] = [];
  for (const gate of TRUST_GATED_SETTINGS) {
    const value = getAt(fragment, gate.path);
    if (value !== undefined) {
      settings.push({ path: gate.path.join("."), summary: gate.describe(value) });
    }
  }
  const outsideGates = withoutGatedKeys(fragment);
  for (const reference of findSecretReferences(outsideGates, [])) {
    settings.push({
      path: reference.path.join("."),
      summary: `uses the secret ${describeSecretReference(reference.value)}`
    });
  }
  return settings;
}

export function collectTrustGates(fragment: unknown): ConfigTrustGates {
  return {
    mcpEntries: collectTrustGatedMcpEntries(fragment),
    providers: collectTrustGatedSecretProviders(fragment),
    settings: collectTrustGatedSettings(fragment)
  };
}

export function hasTrustGates(gates: ConfigTrustGates): boolean {
  return gates.mcpEntries.length > 0 || gates.providers.length > 0 || gates.settings.length > 0;
}

/**
 * Returns the fragment without anything that waits for trust: the gated `mcp`
 * keys, all of `secrets`, the settings in `TRUST_GATED_SETTINGS`, and any
 * value holding a secret reference. An untrusted workspace layer is merged in
 * this form, so it can neither add a server, nor change one the operator
 * configured, nor point a request (or a credential) somewhere new.
 */
export function withoutTrustGatedEntries<T>(fragment: T): T {
  if (!isPlainObject(fragment)) {
    return fragment;
  }
  const next = withoutGatedKeys(fragment);
  stripSecretReferences(next);
  return next as T;
}

/** The trust decision for one workspace config's text. */
export type ConfigTrustEvaluation = {
  /** Null when the file declares nothing that needs trust. */
  fingerprint: ConfigFingerprint | null;
  gates: ConfigTrustGates;
  required: boolean;
  trusted: boolean;
};

/**
 * The one trust decision for a workspace config: what it declares that needs
 * trust, the fingerprint a grant would record (its text plus every file its
 * `mcp.imports` names, read once here), and whether that grant exists. The
 * loader and `aia mcp add --workspace` both ask this, so they cannot disagree.
 */
export async function evaluateConfigTextTrust(params: {
  filePath: string;
  /** The parsed text; parsed here when omitted. */
  fragment?: unknown;
  store?: ConfigTrustStore;
  text: string | null;
  userStateDirectory: string;
}): Promise<ConfigTrustEvaluation> {
  const empty: ConfigTrustGates = { mcpEntries: [], providers: [], settings: [] };
  if (params.text === null) {
    return { fingerprint: null, gates: empty, required: false, trusted: true };
  }
  const fragment = params.fragment === undefined ? parseJsoncText(params.text, params.filePath) : params.fragment;
  const gates = collectTrustGates(fragment);
  if (!hasTrustGates(gates)) {
    return { fingerprint: null, gates, required: false, trusted: true };
  }

  const { fingerprint, imports } = await fingerprintWorkspaceConfigText(params.filePath, params.text, fragment);
  if (imports.length > 0) {
    for (const entry of gates.mcpEntries) {
      const file = entry.kind === "import" ? imports.find((candidate) => candidate.name === entry.name) : undefined;
      if (file) {
        entry.path = file.path;
        if (file.error) {
          entry.unreadable = file.error;
        } else if (file.text === null) {
          entry.missing = true;
        } else {
          entry.servers = Object.entries(file.servers).map(([name, server]) =>
            describeMcpServerForTrust(name, server as unknown as Record<string, unknown>)
          );
        }
      }
    }
  }

  const store = params.store ?? (await readConfigTrustStore(params.userStateDirectory));
  return { fingerprint, gates, required: true, trusted: isConfigTrusted(store, fingerprint) };
}

/**
 * The fingerprint a grant for a workspace config records: its text, plus the
 * contents of every file its `mcp.imports` names (read once, here). The
 * imported files are part of what is trusted: a model or a `git pull` that
 * changes one must revoke the grant, not gain a server. Without imports it is
 * the plain text fingerprint, so existing grants stay valid.
 */
export async function fingerprintWorkspaceConfigText(
  filePath: string,
  text: string,
  fragment: unknown = parseJsoncText(text, filePath)
): Promise<{ fingerprint: ConfigFingerprint; imports: DeclaredImport[] }> {
  const imports = await readDeclaredImports(fragment, filePath);
  const fingerprint = await fingerprintConfigText(filePath, text);
  if (imports.length > 0) {
    fingerprint.sha256 = sha256(
      [
        text,
        ...imports.map(
          (entry) =>
            `\u0000mcp.imports\u0000${entry.name}\u0000${entry.path}\u0000${
              entry.error ? `<unreadable: ${entry.error}>` : entry.text === null ? "<missing>" : sha256(entry.text)
            }`
        )
      ].join("")
    );
  }
  return { fingerprint, imports };
}

/** `fingerprintWorkspaceConfigText` for a file on disk; null when it does not exist. */
export async function fingerprintWorkspaceConfigFile(filePath: string): Promise<ConfigFingerprint | null> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }
  return (await fingerprintWorkspaceConfigText(filePath, text)).fingerprint;
}

/**
 * Whether a config file's current contents are the operator's own as far as
 * trust goes: absent, declaring nothing trust-gated, or trusted exactly as
 * they are. When aia edits a workspace config on the operator's behalf (adding
 * a server they asked for), it re-grants trust for the result only then.
 * Re-granting a file that was untrusted would bless everything else in it.
 */
export async function isConfigTextOperatorOwned(params: {
  filePath: string;
  text: string | null;
  userStateDirectory: string;
}): Promise<boolean> {
  try {
    const evaluation = await evaluateConfigTextTrust(params);
    return !evaluation.required || evaluation.trusted;
  } catch {
    // A file that cannot be parsed or whose imports cannot be read is nobody's
    // to bless.
    return false;
  }
}

const MODE_STRICTNESS: Record<ApprovalPolicyMode, number> = { allow: 0, ask: 1, deny: 2 };

/** The trust decision for a workspace `aia.approvals.jsonc`. */
export type ApprovalsTrustEvaluation = {
  /** Null when the file asks for nothing that needs trust. */
  fingerprint: ConfigFingerprint | null;
  path: string;
  required: boolean;
  trusted: boolean;
  /** What the file asks for that applies only once it is trusted. */
  withheld: {
    allowRules: Array<{ id?: string; pattern?: string; targetKind?: string }>;
    defaultMode?: { current: ApprovalPolicyMode; requested: ApprovalPolicyMode };
  };
};

/**
 * Decides what a workspace approvals file may do. Deny and ask rules, and a
 * `defaultMode` at least as strict as the operator's, only ever add a
 * question or a refusal, so they apply untrusted; allow rules and a looser
 * `defaultMode` wait for a grant. Returns null when there is no file.
 */
export async function evaluateApprovalsTextTrust(params: {
  /** The approval settings before the workspace file: defaults plus user-global. */
  base: ApprovalSettings;
  filePath: string;
  fragment: ApprovalSettingsFragment | null;
  store?: ConfigTrustStore;
  text: string | null;
  userStateDirectory: string;
}): Promise<ApprovalsTrustEvaluation | null> {
  if (params.text === null || params.fragment === null) {
    return null;
  }
  const allowRules = (params.fragment.rules ?? [])
    .filter((rule): rule is NonNullable<typeof rule> => rule?.mode === "allow")
    .map((rule) => ({
      ...(rule.id ? { id: rule.id } : {}),
      ...(rule.pattern ? { pattern: rule.pattern } : {}),
      ...(rule.targetKind ? { targetKind: rule.targetKind } : {})
    }));
  const requested = params.fragment.defaultMode;
  const looser =
    requested !== undefined && MODE_STRICTNESS[requested] < MODE_STRICTNESS[params.base.defaultMode]
      ? { current: params.base.defaultMode, requested }
      : undefined;
  const withheld = { allowRules, ...(looser ? { defaultMode: looser } : {}) };
  const filePath = path.resolve(params.filePath);
  if (allowRules.length === 0 && !looser) {
    return { fingerprint: null, path: filePath, required: false, trusted: true, withheld };
  }
  const fingerprint = await fingerprintConfigText(params.filePath, params.text);
  const store = params.store ?? (await readConfigTrustStore(params.userStateDirectory));
  return { fingerprint, path: filePath, required: true, trusted: isConfigTrusted(store, fingerprint), withheld };
}

/**
 * Adds a workspace approvals file to the operator's settings. Its rules are
 * appended after the operator's, never replacing them: a deny rule wins
 * wherever it sits, and the first allow/ask match decides otherwise, so a
 * workspace rule can add a question or a refusal but cannot override one of
 * the operator's. Untrusted, only deny and ask rules and a `defaultMode` at
 * least as strict as the operator's apply; trusted, all of it does.
 *
 * The result is unvalidated (a fragment's rules may be incomplete); the loader
 * parses it with the full schema.
 */
export function mergeWorkspaceApprovals(
  base: ApprovalSettings,
  fragment: ApprovalSettingsFragment | null,
  trusted: boolean
): unknown {
  if (!fragment) {
    return base;
  }
  const rules = (fragment.rules ?? []).filter((rule) => trusted || rule?.mode !== "allow");
  const requested = fragment.defaultMode;
  const defaultMode =
    requested !== undefined && (trusted || MODE_STRICTNESS[requested] >= MODE_STRICTNESS[base.defaultMode])
      ? requested
      : base.defaultMode;
  return { ...base, defaultMode, rules: [...base.rules, ...rules] };
}

export type DeclaredImport = {
  /** Why the file could not be read, when it exists but could not be. */
  error?: string;
  name: string;
  path: string;
  servers: Record<string, unknown>;
  text: string | null;
};

async function readDeclaredImports(fragment: unknown, configPath: string): Promise<DeclaredImport[]> {
  if (!isPlainObject(fragment) || !isPlainObject(fragment.mcp)) {
    return [];
  }
  const baseDirectory = path.dirname(path.resolve(configPath));
  const declared = plainObjectEntries(fragment.mcp.imports)
    .filter(([, entry]) => typeof entry.path === "string" && entry.path.trim().length > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  const imports: DeclaredImport[] = [];
  for (const [name, entry] of declared) {
    const resolvedPath = resolveAbsolutePath(String(entry.path), baseDirectory);
    try {
      const file = await readImportedMcpFile({
        format: isImportFormat(entry.format) ? entry.format : "generic_mcp_servers_json",
        path: resolvedPath
      });
      imports.push({ name, path: resolvedPath, servers: file.servers, text: file.text });
    } catch (error) {
      // Still part of the fingerprint (it changes when the file is fixed), and
      // the MCP manager reports the parse error if the import is ever used.
      imports.push({
        error: error instanceof Error ? error.message : String(error),
        name,
        path: resolvedPath,
        servers: {},
        text: null
      });
    }
  }
  return imports;
}

function isImportFormat(value: unknown): value is "claude_desktop" | "generic_mcp_servers_json" | "roo_project" {
  return value === "claude_desktop" || value === "generic_mcp_servers_json" || value === "roo_project";
}

function describeMcpServerForTrust(name: string, server: Record<string, unknown>): TrustGatedMcpEntry {
  const env = isPlainObject(server.env)
    ? Object.fromEntries(
        Object.entries(server.env).map(([key, value]) => [
          key,
          typeof value === "string" && !isSecretReferenceValue(value) ? value : describeSecretReference(value)
        ])
      )
    : undefined;
  const headerNames = isPlainObject(server.headers) ? Object.keys(server.headers).sort() : undefined;
  const passEnv = Array.isArray(server.passEnv) ? stringEntries(server.passEnv) : undefined;
  return {
    kind: "server",
    name,
    ...(typeof server.command === "string" ? { args: stringEntries(server.args), command: server.command } : {}),
    ...(typeof server.cwd === "string" ? { cwd: server.cwd } : {}),
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
    ...(headerNames && headerNames.length > 0 ? { headerNames } : {}),
    ...(passEnv && passEnv.length > 0 ? { passEnv } : {}),
    ...(typeof server.type === "string" ? { transport: server.type } : {}),
    ...(server.trust === "trusted" ? { trustsTools: true } : {}),
    ...(typeof server.url === "string" ? { url: server.url } : {})
  };
}

/** A deep copy of a fragment without the gated `mcp` keys, `exec`/`file` providers, and gated settings. */
function withoutGatedKeys(fragment: Record<string, unknown>): Record<string, unknown> {
  const next = structuredClone(fragment);
  if (isPlainObject(next.mcp)) {
    for (const key of TRUST_GATED_MCP_KEYS) {
      delete next.mcp[key];
    }
  }
  if (isPlainObject(next.secrets) && isPlainObject(next.secrets.providers)) {
    for (const name of collectTrustGatedProviderNames(next)) {
      delete next.secrets.providers[name];
    }
  }
  for (const gate of TRUST_GATED_SETTINGS) {
    deleteAt(next, gate.path);
  }
  return next;
}

function findSecretReferences(value: unknown, at: string[]): Array<{ path: string[]; value: unknown }> {
  if (isSecretReferenceValue(value)) {
    return [{ path: at, value }];
  }
  if (Array.isArray(value)) {
    // An array is withheld whole (arrays replace on merge), so report it once.
    const inner = value.flatMap((entry, index) => findSecretReferences(entry, [...at, String(index)]));
    return inner.length > 0 ? [{ path: at, value: inner[0]!.value }] : [];
  }
  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([key, entry]) => findSecretReferences(entry, [...at, key]));
  }
  return [];
}

function stripSecretReferences(value: Record<string, unknown>): void {
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretReferenceValue(entry) || (Array.isArray(entry) && findSecretReferences(entry, []).length > 0)) {
      delete value[key];
    } else if (isPlainObject(entry)) {
      stripSecretReferences(entry);
    }
  }
}

function getAt(value: unknown, at: readonly string[]): unknown {
  let current = value;
  for (const segment of at) {
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function deleteAt(value: Record<string, unknown>, at: readonly string[]): void {
  let current: unknown = value;
  for (const segment of at.slice(0, -1)) {
    if (!isPlainObject(current)) {
      return;
    }
    current = current[segment];
  }
  if (isPlainObject(current)) {
    delete current[at[at.length - 1]!];
  }
}

function listKeys(value: unknown): string {
  return isPlainObject(value) && Object.keys(value).length > 0 ? Object.keys(value).sort().join(", ") : "(none)";
}

function listValues(value: unknown): string {
  return Array.isArray(value) && value.length > 0 ? value.map((entry) => String(entry)).join(", ") : "(none)";
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function plainObjectEntries(value: unknown): Array<[string, Record<string, unknown>]> {
  if (!isPlainObject(value)) {
    return [];
  }
  return Object.entries(value).flatMap(
    ([key, entry]): Array<[string, Record<string, unknown>]> => (isPlainObject(entry) ? [[key, entry]] : [[key, {}]])
  );
}

function stringEntries(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}
