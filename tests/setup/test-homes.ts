import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    testHomesRoot: string;
  }
}

// One directory per run holds each test file's empty home
// (tests/setup/isolated-home.ts). Removing it at the end also removes the home
// of a file whose tests were all skipped, which never runs its afterAll.
export default function setup(project: TestProject): () => void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aiagent-test-homes-"));
  project.provide("testHomesRoot", root);
  return () => fs.rmSync(root, { force: true, recursive: true });
}
