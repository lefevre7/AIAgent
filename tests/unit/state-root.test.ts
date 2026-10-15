import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ensureStateRootWritable, loadAIAgentConfig, StateRootUnavailableError } from "@/core";

const roots: string[] = [];
// chmod does not stop root, so the unwritable cases cannot fail for it.
const unwritableTest = process.getuid?.() === 0 ? test.skip : test;

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.chmod(root, 0o755).catch(() => undefined);
    await fs.rm(root, { force: true, recursive: true });
  }
});

async function makeRoot(): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-state-root-")));
  roots.push(root);
  return root;
}

async function lockDirectory(directory: string): Promise<void> {
  await fs.chmod(directory, 0o555);
  roots.unshift(directory);
}

describe("ensureStateRootWritable", () => {
  test("creates the state directory and returns it", async () => {
    const root = await makeRoot();
    const start = path.join(root, "project");
    await fs.mkdir(start);
    const loaded = await loadAIAgentConfig({ cwd: start, env: {}, resolveSecrets: false, userHomeDirectory: root });

    await expect(ensureStateRootWritable(loaded)).resolves.toBe(path.join(start, ".aia"));
    await expect(fs.stat(path.join(start, ".aia"))).resolves.toBeTruthy();
  });

  // The failure `aia` used to report from deep inside the memory service was a
  // bare "EACCES: permission denied, mkdir …", naming neither the rule that
  // chose the directory nor a way to move it.
  unwritableTest("explains the start-directory rule when no config was found", async () => {
    const root = await makeRoot();
    const start = path.join(root, "readonly");
    await fs.mkdir(start);
    await lockDirectory(start);
    const loaded = await loadAIAgentConfig({ cwd: start, env: {}, resolveSecrets: false, userHomeDirectory: root });

    const failure = await ensureStateRootWritable(loaded).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StateRootUnavailableError);
    expect((failure as Error).message).toContain(`Cannot create or write the state directory ${start}/.aia`);
    expect((failure as Error).message).toContain("permission denied");
    expect((failure as Error).message).toContain(`No aia.config.jsonc was found from ${start} upward`);
    expect((failure as Error).message).toContain("AIA_MEMORY_STATE_ROOT");
  });

  unwritableTest("names the config file when the workspace was found through one", async () => {
    const root = await makeRoot();
    const project = path.join(root, "project");
    await fs.mkdir(path.join(project, "src"), { recursive: true });
    await fs.writeFile(path.join(project, "aia.config.jsonc"), '{ "configVersion": 1 }', "utf8");
    await lockDirectory(project);
    const loaded = await loadAIAgentConfig({
      cwd: path.join(project, "src"),
      env: {},
      resolveSecrets: false,
      userHomeDirectory: root
    });

    const failure = (await ensureStateRootWritable(loaded).catch((error: unknown) => error)) as Error;

    expect(failure.message).toContain(`The workspace is ${project}, the directory holding aia.config.jsonc`);
  });

  unwritableTest("points at memory.stateRoot when that is what chose the directory", async () => {
    const root = await makeRoot();
    const locked = path.join(root, "locked");
    await fs.mkdir(locked);
    await lockDirectory(locked);
    const loaded = await loadAIAgentConfig({
      cwd: root,
      env: { AIA_MEMORY_STATE_ROOT: path.join(locked, "state") },
      resolveSecrets: false,
      userHomeDirectory: root
    });

    const failure = (await ensureStateRootWritable(loaded).catch((error: unknown) => error)) as Error;

    expect(failure.message).toContain("memory.stateRoot (or AIA_MEMORY_STATE_ROOT) points there");
  });
});
