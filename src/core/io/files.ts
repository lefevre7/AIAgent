import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { checkProcessLiveness } from "@/core/process/liveness";

/**
 * `mode` applies to the file as it is created, so a secret-bearing record is
 * never readable by others, not even between the write and the rename.
 */
export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options: { mode?: number } = {}
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempFilePath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempFilePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    ...(options.mode === undefined ? {} : { mode: options.mode })
  });
  await fs.rename(tempFilePath, filePath);
}

/**
 * Runs `operation` holding `lockPath`, a file created exclusively, so a
 * read-modify-write of a shared file (the MCP credentials, which every session
 * and `aia mcp login` write) never loses another process's change. A lock left
 * by a process that died, or older than `staleMs`, is taken over.
 */
export async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: { staleMs?: number; waitMs?: number } = {}
): Promise<T> {
  const startedAt = Date.now();
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  for (;;) {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      if (await isLockAbandoned(lockPath, options.staleMs ?? 30_000)) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() - startedAt > (options.waitMs ?? 10_000)) {
        throw new Error(`Timed out waiting for the lock ${lockPath}; if no aia process is running, delete it.`);
      }
      await sleep(20);
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, timestamp: new Date().toISOString() }));
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      await fs.rm(lockPath, { force: true }).catch(() => undefined);
    }
  }
}

async function isLockAbandoned(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const [stats, text] = await Promise.all([fs.stat(lockPath), fs.readFile(lockPath, "utf8")]);
    if (Date.now() - stats.mtimeMs > staleMs) {
      return true;
    }
    const pid = (JSON.parse(text) as { pid?: unknown }).pid;
    return typeof pid === "number" && checkProcessLiveness(pid) === "dead";
  } catch {
    // Gone already, or written but not yet filled in: not abandoned.
    return false;
  }
}

export async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

// Appends still in flight, per path, so appendJsonlWithRotation can queue a
// writer behind the previous one.
const pendingAppends = new Map<string, Promise<void>>();

/**
 * Appends `record` as one JSON line, first moving the file aside to `<file>.1`
 * once it has reached `maxBytes`. One retained generation bounds disk use at
 * about twice the limit.
 *
 * Rotation is best-effort: failing to rotate must never cost the record, so a
 * rotation error is reported as a `warningCode` warning and the append goes
 * ahead. Appends to one path are serialized within this process. Two writers
 * that both saw a full file would otherwise both rotate, and the second rename
 * would replace the generation the first had just kept with a near-empty file.
 */
export async function appendJsonlWithRotation(
  filePath: string,
  record: unknown,
  options: { maxBytes: number; warningCode: string }
): Promise<void> {
  const append = (pendingAppends.get(filePath) ?? Promise.resolve()).then(() =>
    appendRotating(filePath, record, options)
  );
  const settled = append.catch(() => undefined);
  pendingAppends.set(filePath, settled);
  try {
    await append;
  } finally {
    if (pendingAppends.get(filePath) === settled) {
      pendingAppends.delete(filePath);
    }
  }
}

async function appendRotating(
  filePath: string,
  record: unknown,
  options: { maxBytes: number; warningCode: string }
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await rotateWhenFull(filePath, options.maxBytes).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`${options.warningCode}: could not rotate ${filePath} (${reason}); it will keep growing.`);
  });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

async function rotateWhenFull(filePath: string, maxBytes: number): Promise<void> {
  try {
    if ((await fs.stat(filePath)).size < maxBytes) {
      return;
    }
    // `rename` is atomic within a filesystem, so a reader holding the path
    // sees either the rotated file or the fresh one, never a partial state.
    await fs.rename(filePath, `${filePath}.1`);
  } catch (error) {
    // No file yet, or another process rotated it first: nothing to move.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
