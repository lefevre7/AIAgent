import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { APP_CONFIG_VERSION } from "@/core/config/constants";
import { applyJsoncEdit, parseJsoncText } from "@/core/config/jsonc";
import type { ResolvedConfigPaths } from "@/core/config/paths";
import { fingerprintWorkspaceConfigText, grantConfigTrust, isConfigTextOperatorOwned } from "@/core/config/trust";

/** One change: the value at `path` (a JSON path into the config), or removal with `undefined`. */
export type ConfigFileEdit = { path: (number | string)[]; value: unknown };

/**
 * What an edit did: whether the file was written (no edits, no write), and
 * whether the file is the operator's afterwards: always for a file outside
 * the workspace, and for the workspace config when its trust carried over
 * (see `editConfigFile`). An untrusted workspace config is not trusted by an
 * edit.
 */
export type ConfigFileEditResult = { trusted: boolean; written: boolean };

/**
 * Changes values in a config file and keeps the rest of it, comments and
 * layout included, as it was. Every command that edits config (`aia mcp
 * add|remove`, `aia skills enable|disable`, a template install) goes through
 * here, so they cannot drift apart again.
 *
 * - The file is written atomically (a temporary file renamed over it), so a
 *   crash, or a session reloading the file mid-write, never sees half of it.
 * - A new file is created readable by its owner only (0600): config holds
 *   headers and tokens. An existing file keeps its mode.
 * - Editing a workspace config revokes its trust (trust is keyed on the exact
 *   contents). The operator asked for this change, so when the file was theirs
 *   before the edit (absent, declaring nothing trust-gated, or trusted as it
 *   was), trust carries over to the result. It is granted before the file is
 *   written: a running session that reloaded in between would otherwise find
 *   the file untrusted and stop its servers. A file that was untrusted stays
 *   untrusted: re-granting it would bless whatever else it declares.
 */
export async function editConfigFile(params: {
  configPath: string;
  /** Resolved paths, so an edit to the workspace config is recognized as one. */
  configPaths?: ResolvedConfigPaths;
  /**
   * The changes, or a function that works them out from the file as it is
   * now (parsed, `{}` when it does not exist) and may throw to refuse, so
   * the file is read once.
   */
  edits: ConfigFileEdit[] | ((current: Record<string, unknown>) => ConfigFileEdit[]);
}): Promise<ConfigFileEditResult> {
  const existing = await readConfigFileText(params.configPath);
  const workspaceUserStateDirectory =
    params.configPaths && path.resolve(params.configPath) === path.resolve(params.configPaths.workspaceConfigPath)
      ? params.configPaths.userStateDirectory
      : null;
  const keepTrust =
    workspaceUserStateDirectory !== null &&
    (await isConfigTextOperatorOwned({
      filePath: params.configPath,
      text: existing?.text ?? null,
      userStateDirectory: workspaceUserStateDirectory
    }));

  const baseText = existing?.text ?? `${JSON.stringify({ configVersion: APP_CONFIG_VERSION }, null, 2)}\n`;
  const parsed = parseJsoncText(baseText, params.configPath);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Config file at ${params.configPath} must contain an object.`);
  }
  const edits = typeof params.edits === "function" ? params.edits(parsed as Record<string, unknown>) : params.edits;
  const trusted = workspaceUserStateDirectory === null || keepTrust;
  if (edits.length === 0) {
    return { trusted, written: false };
  }
  let nextText = "configVersion" in parsed ? baseText : applyJsoncEdit(baseText, ["configVersion"], APP_CONFIG_VERSION);
  for (const edit of edits) {
    nextText = applyJsoncEdit(nextText, edit.path, edit.value);
  }
  const writtenText = `${nextText.trimEnd()}\n`;

  if (keepTrust && workspaceUserStateDirectory !== null) {
    await grantConfigTrust(
      workspaceUserStateDirectory,
      (await fingerprintWorkspaceConfigText(params.configPath, writtenText)).fingerprint
    );
  }
  // A config kept elsewhere and linked in (a dotfiles repo) stays linked: the
  // rename replaces the file the link points at, not the link.
  const target = existing ? await fs.realpath(params.configPath) : params.configPath;
  await writeTextAtomic(target, writtenText, existing?.mode ?? 0o600);
  return { trusted, written: true };
}

/** A config file's text and mode, or null when it does not exist. */
export async function readConfigFileText(filePath: string): Promise<{ mode: number; text: string } | null> {
  try {
    const [text, stat] = await Promise.all([fs.readFile(filePath, "utf8"), fs.stat(filePath)]);
    return { mode: stat.mode & 0o777, text };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeTextAtomic(filePath: string, text: string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempFilePath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempFilePath, text, { encoding: "utf8", mode });
    // The mode given at creation is masked by the umask; set it exactly.
    await fs.chmod(tempFilePath, mode);
    await fs.rename(tempFilePath, filePath);
  } catch (error) {
    await fs.rm(tempFilePath, { force: true }).catch(() => undefined);
    throw error;
  }
}
