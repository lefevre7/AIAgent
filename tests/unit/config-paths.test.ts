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
