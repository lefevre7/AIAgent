import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, test } from "vitest";

export function createLiveTestHarness(options: {
  enabled: boolean;
  prefix: string;
}) {
  const tempRoots: string[] = [];
  const liveTest = options.enabled ? test : test.skip;

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map(async (root) => {
        await fs.rm(root, { force: true, recursive: true });
      })
    );
  });

  return {
    async createTempRoot() {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), options.prefix));
      tempRoots.push(root);
      return root;
    },
    liveTest,
    runLive: options.enabled
  };
}

export function envFlag(name: string): boolean {
  return process.env[name] === "1";
}

export function readJsonEnv<T>(name: string): T | null {
  const raw = process.env[name];
  if (!raw) {
    return null;
  }
  return JSON.parse(raw) as T;
}
