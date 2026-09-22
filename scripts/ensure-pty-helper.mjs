#!/usr/bin/env node
/**
 * Restores the execute bit on node-pty's `spawn-helper`.
 *
 * node-pty ships prebuilt binaries, and some npm/tarball extraction paths drop
 * the executable permission on them. The failure is silent and badly
 * misleading: `pty.spawn` throws `posix_spawnp failed` for *every* command, so
 * AIAgent falls back to pipes and every interactive external-agent session
 * loses its TUI without any obvious cause.
 *
 * Runs on postinstall. Missing prebuilds are not an error — a platform that
 * compiles node-pty from source has no prebuilds directory at all.
 */
import { chmod, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXECUTABLE_MODE = 0o755;
const HELPER_NAME = "spawn-helper";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prebuildsRoot = path.join(repoRoot, "node_modules", "node-pty", "prebuilds");

async function listDirectories(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function ensureExecutable(helperPath) {
  let info;
  try {
    info = await stat(helperPath);
  } catch {
    return false;
  }

  if ((info.mode & 0o111) !== 0) {
    return false;
  }

  await chmod(helperPath, EXECUTABLE_MODE);
  return true;
}

const platforms = await listDirectories(prebuildsRoot);
const repaired = [];
for (const platform of platforms) {
  const helperPath = path.join(prebuildsRoot, platform, HELPER_NAME);
  if (await ensureExecutable(helperPath)) {
    repaired.push(platform);
  }
}

if (repaired.length > 0) {
  console.log(`node-pty: restored execute permission on spawn-helper for ${repaired.join(", ")}`);
}
