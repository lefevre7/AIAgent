import { describe, expect, test } from "vitest";

import { resolveSkillMentions, type SkillRecord } from "@/core/skills";

function skill(name: string, overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    allowedTools: [],
    body: `${name} instructions`,
    description: `${name} description`,
    directory: `/skills/${name}`,
    disableModelInvocation: false,
    enabled: true,
    filePath: `/skills/${name}/SKILL.md`,
    metadata: {},
    name,
    scope: "project",
    ...overrides
  };
}

const skills = [
  skill("deploy", { disableModelInvocation: true }),
  skill("notes:summarize"),
  skill("pdf-tools"),
  skill("retired", { enabled: false }),
  skill("home")
];

function names(text: string): string[] {
  return resolveSkillMentions(text, skills).map((entry) => entry.name);
}

describe("resolveSkillMentions", () => {
  test("finds $name mentions in the order they appear, each once", () => {
    expect(names("Use $pdf-tools, then $notes:summarize, then $pdf-tools again.")).toEqual([
      "pdf-tools",
      "notes:summarize"
    ]);
  });

  test("matches names exactly, case included", () => {
    expect(names("$PDF-tools $pdf-tool $pdf-toolsx")).toEqual([]);
  });

  test("ignores a $ after a word character or another $, and shell variables in capitals", () => {
    expect(names("US$pdf-tools costs $$pdf-tools")).toEqual([]);
    expect(names("cd $HOME && echo $PATH")).toEqual([]);
    // Lowercase, it is the skill: "home" used to be unmentionable.
    expect(names("then $home")).toEqual(["home"]);
  });

  test("a name followed by punctuation still counts", () => {
    // The colon used to be taken into the name, and "deploy:" matched nothing.
    expect(names("Run $pdf-tools: then $notes:summarize, then $deploy.")).toEqual([
      "pdf-tools",
      "notes:summarize",
      "deploy"
    ]);
  });

  test("code and URLs name no skill", () => {
    // A shell line quoted in a question, or an address, used to load the skill.
    expect(names("Why does `echo $pdf-tools` print nothing?")).toEqual([]);
    expect(names("```sh\nexport X=$pdf-tools\n```\nand $deploy")).toEqual(["deploy"]);
    expect(names("see https://x.test/$pdf-tools and $deploy")).toEqual(["deploy"]);
  });

  test("never uses a disabled skill, and does use one reserved for the operator", () => {
    expect(names("$retired then $deploy")).toEqual(["deploy"]);
  });

  test("a [$name](path) link matches by the skill's SKILL.md or directory, whatever the name says", () => {
    expect(names("[$anything](/skills/pdf-tools/SKILL.md)")).toEqual(["pdf-tools"]);
    expect(names("[$pdf](/skills/pdf-tools/)")).toEqual(["pdf-tools"]);
    expect(names("[$pdf](skill:///skills/pdf-tools/skill.md)")).toEqual(["pdf-tools"]);
    // The name inside a link that matches nothing is not read as a plain mention.
    expect(names("[$pdf-tools](/elsewhere/SKILL.md)")).toEqual([]);
  });

  test("a link matches the same directory however it is written: ~, a symlink, or another case", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-mentions-")));
    try {
      const real = path.join(root, "real", "pdf-tools");
      await fs.mkdir(real, { recursive: true });
      await fs.symlink(path.join(root, "real"), path.join(root, "linked"));
      const onDisk = [skill("pdf-tools", { directory: real, filePath: path.join(real, "SKILL.md") })];
      const resolve = (text: string) =>
        resolveSkillMentions(text, onDisk, { userHomeDirectory: root }).map((entry) => entry.name);

      expect(resolve(`[$x](${path.join(root, "linked", "pdf-tools", "SKILL.md")})`)).toEqual(["pdf-tools"]);
      expect(resolve("[$x](~/real/pdf-tools)")).toEqual(["pdf-tools"]);
      // A relative path is taken from the session's directory, not the process's.
      const fromSession = (text: string) =>
        resolveSkillMentions(text, onDisk, { cwd: path.join(root, "real") }).map((entry) => entry.name);
      expect(fromSession("[$x](pdf-tools/SKILL.md)")).toEqual(["pdf-tools"]);
      expect(fromSession("[$x](./pdf-tools)")).toEqual(["pdf-tools"]);
      expect(resolve("[$x](pdf-tools/SKILL.md)")).toEqual([]);
      if (process.platform === "darwin" || process.platform === "win32") {
        expect(resolve(`[$x](${real.toUpperCase()}/skill.md)`)).toEqual(["pdf-tools"]);
      }
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });

  test("links and plain mentions share one order and one list", () => {
    expect(names("$notes:summarize and [$x](/skills/pdf-tools) and $pdf-tools")).toEqual([
      "notes:summarize",
      "pdf-tools"
    ]);
  });
});
