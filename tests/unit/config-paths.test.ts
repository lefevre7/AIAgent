import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { resolveConfigPaths } from "@/core/config/paths";

const HOME = "/tmp/aiagent-home";
const CWD = "/tmp/aiagent-home/projects/example";

describe("resolveConfigPaths global config discovery", () => {
  test("reads both global filenames (base -> override) and writes installs to the legacy name", async () => {
    const paths = await resolveConfigPaths({
      cwd: CWD,
      env: {},
      userHomeDirectory: HOME
    });

    expect(paths.globalConfigPaths).toEqual([
      path.join(HOME, ".aia", "config.jsonc"),
      path.join(HOME, ".aia", "aia.config.jsonc")
    ]);
    // The highest-precedence (override) file is the canonical write/install target.
    expect(paths.globalConfigPath).toBe(path.join(HOME, ".aia", "aia.config.jsonc"));
    expect(paths.globalConfigPath).toBe(paths.globalConfigPaths.at(-1));
  });

  test("AIA_USER_CONFIG_PATH fully replaces discovery with a single explicit file", async () => {
    const explicit = "/etc/aiagent/custom.jsonc";
    const paths = await resolveConfigPaths({
      cwd: CWD,
      env: { AIA_USER_CONFIG_PATH: explicit },
      userHomeDirectory: HOME
    });

    expect(paths.globalConfigPaths).toEqual([explicit]);
    expect(paths.globalConfigPath).toBe(explicit);
  });
});

describe("resolveConfigPaths workspace root", () => {
  async function withTempTree(run: (root: string) => Promise<void>): Promise<void> {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-config-paths-")));
    try {
      await run(root);
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  }

  // With no config anywhere above it, the workspace is the directory `aia`
  // started in. It used to be that directory's parent, so starting `aia` in
  // the home directory put its state in `/Users/.aia`, which the user cannot
  // create, and every start failed with EACCES.
  test("is the start directory itself when no workspace config is found", async () => {
    await withTempTree(async (root) => {
      const start = path.join(root, "home", "someone");
      await fs.mkdir(start, { recursive: true });

      const paths = await resolveConfigPaths({ cwd: start, env: {}, userHomeDirectory: start });

      expect(paths.workspaceRoot).toBe(start);
      expect(paths.workspaceConfigPath).toBe(path.join(start, "aia.config.jsonc"));
    });
  });

  test("is the directory holding the nearest workspace config above the start directory", async () => {
    await withTempTree(async (root) => {
      const project = path.join(root, "project");
      const start = path.join(project, "src", "deep");
      await fs.mkdir(start, { recursive: true });
      await fs.writeFile(path.join(project, "aia.config.jsonc"), '{ "configVersion": 1 }', "utf8");

      const paths = await resolveConfigPaths({ cwd: start, env: {}, userHomeDirectory: path.join(root, "home") });

      expect(paths.workspaceRoot).toBe(project);
      expect(paths.workspaceConfigPath).toBe(path.join(project, "aia.config.jsonc"));
    });
  });

  test("falls back to the directory of a lone approvals file", async () => {
    await withTempTree(async (root) => {
      const project = path.join(root, "project");
      const start = path.join(project, "nested");
      await fs.mkdir(start, { recursive: true });
      await fs.writeFile(path.join(project, "aia.approvals.jsonc"), "{}", "utf8");

      const paths = await resolveConfigPaths({ cwd: start, env: {}, userHomeDirectory: path.join(root, "home") });

      expect(paths.workspaceRoot).toBe(project);
    });
  });
});
