import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { parseJsoncText, setSkillDisabledInConfigFile } from "@/core";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function tempConfigPath(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-skill-settings-"));
  tempRoots.push(root);
  return path.join(root, ".aia", "aia.config.jsonc");
}

describe("setSkillDisabledInConfigFile", () => {
  test("creates a missing config with the version and the list", async () => {
    const configPath = await tempConfigPath();
    await expect(setSkillDisabledInConfigFile({ configPath, disabled: true, name: "deploy" })).resolves.toEqual({
      changed: true,
      disabled: ["deploy"]
    });
    expect(parseJsoncText(await fs.readFile(configPath, "utf8"))).toEqual({
      configVersion: 1,
      skills: { disabled: ["deploy"] }
    });
  });

  test("adds and removes a name, leaving everything else as written", async () => {
    const configPath = await tempConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const original = [
      "{",
      "  // keep me",
      '  "configVersion": 1,',
      '  "skills": { "disabled": ["old"], "bundled": false },',
      '  "tools": { "profile": "full" }',
      "}",
      ""
    ].join("\n");
    await fs.writeFile(configPath, original, "utf8");

    await setSkillDisabledInConfigFile({ configPath, disabled: true, name: "deploy" });
    const added = await fs.readFile(configPath, "utf8");
    expect(added).toContain("// keep me");
    expect(parseJsoncText(added)).toEqual({
      configVersion: 1,
      skills: { bundled: false, disabled: ["old", "deploy"] },
      tools: { profile: "full" }
    });

    await setSkillDisabledInConfigFile({ configPath, disabled: false, name: "old" });
    expect(parseJsoncText(await fs.readFile(configPath, "utf8"))).toMatchObject({ skills: { disabled: ["deploy"] } });
  });

  test("does not touch the file when nothing changes", async () => {
    const configPath = await tempConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, '{ "configVersion": 1 }', "utf8");

    await expect(
      setSkillDisabledInConfigFile({ configPath, disabled: false, name: "never-disabled" })
    ).resolves.toEqual({ changed: false, disabled: [] });
    expect(await fs.readFile(configPath, "utf8")).toBe('{ "configVersion": 1 }');
  });
});
