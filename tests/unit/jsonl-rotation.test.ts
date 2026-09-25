import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { appendJsonlWithRotation } from "@/core/io/files";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function ledgerPath(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-jsonl-rotation-"));
  tempRoots.push(root);
  return path.join(root, "logs", "ledger.jsonl");
}

const options = { maxBytes: 100, warningCode: "TEST_ROTATE_FAILED" };

async function readRecords(filePath: string): Promise<unknown[]> {
  const text = await fs.readFile(filePath, "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}

describe("appendJsonlWithRotation", () => {
  test("creates the file and its directory on first append", async () => {
    const filePath = await ledgerPath();

    await appendJsonlWithRotation(filePath, { n: 1 }, options);

    await expect(readRecords(filePath)).resolves.toEqual([{ n: 1 }]);
    await expect(fs.access(`${filePath}.1`)).rejects.toThrow();
  });

  test("moves a full file aside to .1 and starts a fresh one", async () => {
    const filePath = await ledgerPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const full = `${"x".repeat(150)}\n`;
    await fs.writeFile(filePath, full, "utf8");

    await appendJsonlWithRotation(filePath, { n: 1 }, options);

    await expect(fs.readFile(`${filePath}.1`, "utf8")).resolves.toBe(full);
    await expect(readRecords(filePath)).resolves.toEqual([{ n: 1 }]);
  });

  // The two ledgers each carried their own copy of this, and neither queued
  // writers: two appends that both saw a full file both renamed it, and the
  // second rename replaced the generation the first had kept with the
  // near-empty file just started. The slowed rename forces that interleaving.
  test("concurrent appends to a full file rotate it once and keep the retained generation", async () => {
    const filePath = await ledgerPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const full = `${"x".repeat(150)}\n`;
    await fs.writeFile(filePath, full, "utf8");
    const realRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await realRename(from, to);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await Promise.all([0, 1, 2, 3, 4].map((n) => appendJsonlWithRotation(filePath, { n }, options)));

    expect(rename).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    await expect(fs.readFile(`${filePath}.1`, "utf8")).resolves.toBe(full);
    await expect(readRecords(filePath)).resolves.toEqual([{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
  });

  test("treats a file another process already rotated as nothing to do", async () => {
    const filePath = await ledgerPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${"x".repeat(150)}\n`, "utf8");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ENOENT" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await appendJsonlWithRotation(filePath, { n: 1 }, options);

    expect(warn).not.toHaveBeenCalled();
  });

  test("still appends the record when rotation fails, and says so", async () => {
    const filePath = await ledgerPath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${"x".repeat(150)}\n`, "utf8");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(Object.assign(new Error("read-only"), { code: "EROFS" }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await appendJsonlWithRotation(filePath, { n: 1 }, options);

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^TEST_ROTATE_FAILED: could not rotate .*read-only/u));
    expect((await fs.readFile(filePath, "utf8")).endsWith('{"n":1}\n')).toBe(true);
  });

  test("a failed append does not stall the appends queued behind it", async () => {
    const filePath = await ledgerPath();
    vi.spyOn(fs, "appendFile").mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));

    const results = await Promise.allSettled([
      appendJsonlWithRotation(filePath, { n: 1 }, options),
      appendJsonlWithRotation(filePath, { n: 2 }, options)
    ]);

    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    await expect(readRecords(filePath)).resolves.toEqual([{ n: 2 }]);
  });
});
