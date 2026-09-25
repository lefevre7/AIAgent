import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, "..", "..");
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-sqlite-warning-"));
  tempRoots.push(root);
  return root;
}

/** Runs a TypeScript entry point in a fresh Node, where no warning has fired yet. */
async function runTs(args: string[], home: string): Promise<{ stderr: string; stdout: string }> {
  return execFileAsync(process.execPath, ["--import", "tsx", ...args], {
    cwd: repoRoot,
    env: { ...process.env, HOME: home, TSX_TSCONFIG_PATH: path.join(repoRoot, "tsconfig.json") }
  });
}

// Loading node:sqlite prints Node's "SQLite is an experimental feature"
// ExperimentalWarning. It was required at module scope, so every `aia`
// command printed it, `--version` included, and it was never actionable.
describe("the node:sqlite ExperimentalWarning", () => {
  test("is not printed by commands that never open the memory index", async () => {
    const home = await tempRoot();

    const { stderr, stdout } = await runTs(["src/cli.ts", "--version"], home);

    expect(stdout).toMatch(/^aia \d+\.\d+\.\d+/u);
    expect(stderr).not.toContain("ExperimentalWarning");
  });

  test("is not printed when the memory index opens, while other warnings still are", async () => {
    const root = await tempRoot();
    const sqlitePath = path.join(root, "memory.sqlite");
    const script = path.join(root, "open-index.mts");
    await fs.writeFile(
      script,
      [
        `import { MemoryRetrievalEngine } from ${JSON.stringify(path.join(repoRoot, "src/core/memory/retrieval.ts"))};`,
        "new MemoryRetrievalEngine({",
        "  candidateLimit: 4, chunkOverlapChars: 16, chunkTargetChars: 128, embeddingProvider: 'lm_studio',",
        "  embeddingsEnabled: false, ftsEnabled: true, hardFailOnStartup: false, loadDocuments: async () => [],",
        `  mmrLambda: 0.7, retrievalLimit: 4, sqlitePath: ${JSON.stringify(sqlitePath)}`,
        "});",
        "process.emitWarning('Some other feature is an experimental feature', 'ExperimentalWarning');"
      ].join("\n"),
      "utf8"
    );

    const { stderr } = await runTs([script], root);

    expect(stderr).not.toContain("SQLite is an experimental feature");
    // The real store opened, not the no-op fallback that needs no SQLite at all.
    expect(stderr).not.toContain("AIA_SQLITE_FALLBACK");
    await expect(fs.stat(sqlitePath)).resolves.toBeTruthy();
    // Only SQLite's own notice is dropped.
    expect(stderr).toContain("ExperimentalWarning: Some other feature is an experimental feature");
  });
});
