import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { loadAIAgentConfig } from "@/core/config";
import {
  createSkillProvider,
  DEFAULT_SKILLS_SETTINGS,
  discoverSkills,
  findSkills,
  followSkillsSettings,
  resolveBundledSkillsRoot,
  setSkillDisabledInConfigFile,
  type SkillsSettings
} from "@/core/skills";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function createLayout() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-skills-")));
  tempRoots.push(root);
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const nested = path.join(workspace, "packages", "app");
  await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
  await fs.mkdir(nested, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  return { home, nested, root, workspace };
}

async function writeSkill(directory: string, name: string, description = `${name} from ${directory}`) {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}.\n`
  );
}

function discover(
  layout: { home: string },
  cwd: string,
  settings: Partial<SkillsSettings> = {},
  bundledRoot: string | null = null
) {
  return findSkills({
    bundledRoot,
    cwd,
    settings: { ...DEFAULT_SKILLS_SETTINGS, ...settings },
    userHomeDirectory: layout.home
  });
}

describe("skill discovery", () => {
  test("searches project, user, extra, then bundled roots, and the first of a name wins", async () => {
    const layout = await createLayout();
    const { home, nested, root, workspace } = layout;
    const bundled = path.join(root, "bundled");
    const extra = path.join(root, "extra");

    await writeSkill(path.join(nested, ".agents", "skills", "shared"), "shared", "closest project copy");
    await writeSkill(path.join(workspace, ".agents", "skills", "shared"), "shared", "outer project copy");
    await writeSkill(path.join(workspace, ".aia", "skills", "aia-first"), "aia-first", ".aia copy");
    await writeSkill(path.join(workspace, ".agents", "skills", "aia-first"), "aia-first", ".agents copy");
    await writeSkill(path.join(home, ".aia", "skills", "mine"), "mine");
    await writeSkill(path.join(home, ".agents", "skills", "shared"), "shared", "user copy");
    await writeSkill(path.join(extra, "extra-skill"), "extra-skill");
    await writeSkill(path.join(bundled, "shipped"), "shipped");
    await writeSkill(path.join(bundled, "mine"), "mine", "bundled copy");

    const discovery = await discover(layout, nested, { extraRoots: [extra] }, bundled);

    expect(discovery.skills.map((skill) => `${skill.scope}:${skill.name}`)).toEqual([
      "project:aia-first",
      "project:shared",
      "user:mine",
      "extra:extra-skill",
      "bundled:shipped"
    ]);
    expect(discovery.skills.find((skill) => skill.name === "shared")?.description).toBe("closest project copy");
    expect(discovery.skills.find((skill) => skill.name === "aia-first")?.description).toBe(".aia copy");

    const shadowed = discovery.diagnostics.filter((diagnostic) => diagnostic.kind === "shadowed");
    // A project skill hiding one of the operator's own is worth a warning;
    // the rest is ordinary precedence.
    expect(shadowed.find((diagnostic) => diagnostic.path.startsWith(home))).toMatchObject({
      name: "shared",
      severity: "warning"
    });
    expect(shadowed.find((diagnostic) => diagnostic.path.startsWith(bundled))).toMatchObject({
      name: "mine",
      severity: "info"
    });
    expect(shadowed).toHaveLength(4);
  });

  test("stops at the project root, and without one searches only the start directory", async () => {
    const layout = await createLayout();
    await writeSkill(path.join(layout.root, ".agents", "skills", "above-project"), "above-project");
    await writeSkill(path.join(layout.workspace, ".agents", "skills", "in-project"), "in-project");

    expect((await discover(layout, layout.nested)).skills.map((skill) => skill.name)).toEqual(["in-project"]);

    const loose = path.join(layout.root, "loose", "child");
    await fs.mkdir(loose, { recursive: true });
    await writeSkill(path.join(layout.root, "loose", ".agents", "skills", "parent-of-loose"), "parent-of-loose");
    expect((await discover(layout, loose)).skills).toEqual([]);
  });

  test("finds skills in grouping folders, but not in hidden folders, node_modules, or a skill's own subfolders", async () => {
    const layout = await createLayout();
    const skillsRoot = path.join(layout.workspace, ".agents", "skills");
    await writeSkill(path.join(skillsRoot, "group", "grouped"), "grouped");
    await writeSkill(path.join(skillsRoot, ".hidden", "secret"), "secret");
    await writeSkill(path.join(skillsRoot, "node_modules", "pkg"), "pkg");
    await writeSkill(path.join(skillsRoot, "outer"), "outer");
    await writeSkill(path.join(skillsRoot, "outer", "assets", "template"), "template");

    expect((await discover(layout, layout.workspace)).skills.map((skill) => skill.name)).toEqual(["grouped", "outer"]);
  });

  test("searches six levels below a root and no deeper", async () => {
    const layout = await createLayout();
    const skillsRoot = path.join(layout.workspace, ".agents", "skills");
    await writeSkill(path.join(skillsRoot, "a", "b", "c", "d", "e", "at-six"), "at-six");
    await writeSkill(path.join(skillsRoot, "a", "b", "c", "d", "e", "f", "at-seven"), "at-seven");

    expect((await discover(layout, layout.workspace)).skills.map((skill) => skill.name)).toEqual(["at-six"]);
  });

  test("stops a root after 2,000 directories and says so", async () => {
    const layout = await createLayout();
    const skillsRoot = path.join(layout.workspace, ".agents", "skills");
    await Promise.all(
      Array.from({ length: 2_001 }, (_, index) => fs.mkdir(path.join(skillsRoot, `dir-${index}`), { recursive: true }))
    );

    const discovery = await discover(layout, layout.workspace);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({ kind: "limit", path: skillsRoot, severity: "warning" })
    ]);
  });

  test("ignores a symlinked SKILL.md, and a project symlink that leaves the project", async () => {
    const layout = await createLayout();
    const skillsRoot = path.join(layout.workspace, ".agents", "skills");
    const outside = path.join(layout.root, "outside");
    await writeSkill(path.join(outside, "escaped"), "escaped");
    await writeSkill(path.join(layout.workspace, "tools", "inside"), "inside");
    await fs.mkdir(path.join(skillsRoot, "linked-file"), { recursive: true });
    await fs.symlink(path.join(outside, "escaped", "SKILL.md"), path.join(skillsRoot, "linked-file", "SKILL.md"));
    await fs.symlink(path.join(outside, "escaped"), path.join(skillsRoot, "escaped"));
    await fs.symlink(path.join(layout.workspace, "tools", "inside"), path.join(skillsRoot, "inside"));

    expect((await discover(layout, layout.workspace)).skills.map((skill) => skill.name)).toEqual(["inside"]);
  });

  test("skips a project skills folder that is itself a symlink out of the project", async () => {
    // A cloned repo could point .agents/skills at the operator's home; that
    // folder must not be scanned, or its files listed to the model.
    const layout = await createLayout();
    const outside = path.join(layout.root, "outside-skills");
    await writeSkill(path.join(outside, "private"), "private");
    await fs.mkdir(path.join(layout.workspace, ".agents"), { recursive: true });
    await fs.symlink(outside, path.join(layout.workspace, ".agents", "skills"));

    const discovery = await discover(layout, layout.workspace);
    expect(discovery.skills).toEqual([]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        kind: "limit",
        message: expect.stringContaining("leads outside the project"),
        path: path.join(layout.workspace, ".agents", "skills"),
        severity: "warning"
      })
    ]);
  });

  test("searches a workspace config's extra roots like project roots: inside the project only", async () => {
    const layout = await createLayout();
    await writeSkill(path.join(layout.workspace, "team-skills", "team"), "team");
    await writeSkill(path.join(layout.root, "elsewhere", "stray"), "stray");

    const discovery = await discover(layout, layout.workspace, {
      extraRoots: ["team-skills", "../elsewhere"],
      extraRootsScope: "project"
    });
    expect(discovery.skills.map((skill) => `${skill.scope}:${skill.name}`)).toEqual(["project:team"]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({ kind: "limit", path: path.join(layout.root, "elsewhere"), severity: "warning" })
    ]);
  });

  test("warns whenever a project skill hides one of the operator's, whatever its scope", async () => {
    const layout = await createLayout();
    const bundled = path.join(layout.root, "bundled");
    const extra = path.join(layout.root, "extra");
    await writeSkill(path.join(layout.workspace, ".agents", "skills", "deploy"), "deploy", "project copy");
    await writeSkill(path.join(layout.workspace, ".agents", "skills", "review"), "review", "project copy");
    await writeSkill(path.join(extra, "deploy"), "deploy", "extra copy");
    await writeSkill(path.join(bundled, "review"), "review", "bundled copy");

    const discovery = await discover(layout, layout.workspace, { extraRoots: [extra] }, bundled);
    const shadowed = discovery.diagnostics.filter((diagnostic) => diagnostic.kind === "shadowed");
    expect(shadowed).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("overrides your extra skill of the same name"),
        name: "deploy",
        severity: "warning"
      }),
      expect.objectContaining({
        message: expect.stringContaining("overrides your bundled skill of the same name"),
        name: "review",
        severity: "warning"
      })
    ]);
  });

  test("follows a symlink anywhere in the operator's own roots, and counts one file once", async () => {
    const layout = await createLayout();
    const shared = path.join(layout.root, "dotfiles", "skills");
    await writeSkill(path.join(shared, "dotfile-skill"), "dotfile-skill");
    await fs.mkdir(path.join(layout.home, ".agents", "skills"), { recursive: true });
    await fs.symlink(path.join(shared, "dotfile-skill"), path.join(layout.home, ".agents", "skills", "dotfile-skill"));

    const discovery = await discover(layout, layout.workspace, { extraRoots: [shared] });
    expect(discovery.skills.map((skill) => `${skill.scope}:${skill.name}`)).toEqual(["user:dotfile-skill"]);
    // Reached twice (the user symlink and the extra root), but it is one skill, not a shadowed pair.
    expect(discovery.diagnostics).toEqual([]);
  });

  test("resolves extra roots against the start directory and ~", async () => {
    const layout = await createLayout();
    await writeSkill(path.join(layout.workspace, "team-skills", "relative"), "relative");
    await writeSkill(path.join(layout.home, "my-skills", "from-home"), "from-home");

    const discovery = await discover(layout, layout.workspace, { extraRoots: ["team-skills", "~/my-skills"] });
    expect(discovery.skills.map((skill) => skill.name)).toEqual(["from-home", "relative"]);
  });

  test("lists a disabled skill as disabled, by name or by path", async () => {
    const layout = await createLayout();
    const skillsRoot = path.join(layout.workspace, ".agents", "skills");
    await writeSkill(path.join(skillsRoot, "by-name"), "by-name");
    await writeSkill(path.join(skillsRoot, "by-path"), "by-path");
    await writeSkill(path.join(skillsRoot, "kept"), "kept");

    const discovery = await discover(layout, layout.workspace, {
      disabled: ["by-name", path.join(skillsRoot, "by-path", "SKILL.md")]
    });
    expect(discovery.skills.map((skill) => `${skill.name}:${skill.enabled}`)).toEqual([
      "by-name:false",
      "by-path:false",
      "kept:true"
    ]);
  });

  test("a path in skills.disabled disables its skill however the path is written", async () => {
    // Only the exact SKILL.md path, as discovery reached it, used to count:
    // `~/`, relative, folder, symlinked, and other-case paths disabled nothing.
    const layout = await createLayout();
    const { home, root, workspace } = layout;
    const skillsRoot = path.join(workspace, ".agents", "skills");
    for (const name of ["by-home", "by-relative", "by-folder", "by-link", "by-case", "kept"]) {
      await writeSkill(path.join(skillsRoot, name), name);
    }
    await fs.mkdir(path.join(home, "links"), { recursive: true });
    await fs.symlink(skillsRoot, path.join(root, "linked-skills"));
    const homeRelative = path.relative(home, path.join(skillsRoot, "by-home", "SKILL.md"));

    const discovery = await discover(layout, workspace, {
      disabled: [
        `~/${homeRelative}`,
        "./.agents/skills/by-relative/SKILL.md",
        `${path.join(skillsRoot, "by-folder")}/`,
        path.join(root, "linked-skills", "by-link"),
        ...(process.platform === "darwin" || process.platform === "win32"
          ? [path.join(skillsRoot, "BY-CASE", "skill.md")]
          : [path.join(skillsRoot, "by-case")])
      ]
    });

    expect(discovery.skills.map((skill) => `${skill.name}:${skill.enabled}`)).toEqual([
      "by-case:false",
      "by-folder:false",
      "by-home:false",
      "by-link:false",
      "by-relative:false",
      "kept:true"
    ]);
  });

  test("finds nothing when skills are off, and leaves bundled skills out on request", async () => {
    const layout = await createLayout();
    const bundled = path.join(layout.root, "bundled");
    await writeSkill(path.join(bundled, "shipped"), "shipped");
    await writeSkill(path.join(layout.workspace, ".agents", "skills", "local"), "local");

    expect((await discover(layout, layout.workspace, { enabled: false }, bundled)).skills).toEqual([]);
    expect(
      (await discover(layout, layout.workspace, { bundled: false }, bundled)).skills.map((skill) => skill.name)
    ).toEqual(["local"]);
  });

  test("reports a SKILL.md it cannot use, and still loads the rest", async () => {
    const layout = await createLayout();
    const skillsRoot = path.join(layout.workspace, ".agents", "skills");
    await fs.mkdir(path.join(skillsRoot, "broken"), { recursive: true });
    await fs.writeFile(path.join(skillsRoot, "broken", "SKILL.md"), "---\nname: broken\n---\nNo description.\n");
    await fs.mkdir(path.join(skillsRoot, "huge"), { recursive: true });
    await fs.writeFile(
      path.join(skillsRoot, "huge", "SKILL.md"),
      `---\nname: huge\ndescription: Too big.\n---\n${"x".repeat(1_100_000)}`
    );
    await writeSkill(path.join(skillsRoot, "fine"), "fine");
    await writeSkill(path.join(skillsRoot, "renamed"), "not-renamed");

    const discovery = await discover(layout, layout.workspace);
    expect(discovery.skills.map((skill) => skill.name)).toEqual(["fine", "not-renamed"]);
    expect(discovery.diagnostics).toEqual([
      {
        kind: "invalid",
        message: "missing field `description`",
        path: path.join(skillsRoot, "broken", "SKILL.md"),
        severity: "error"
      },
      expect.objectContaining({ kind: "invalid", path: path.join(skillsRoot, "huge", "SKILL.md") }),
      {
        kind: "warning",
        message: 'name "not-renamed" does not match its directory "renamed"',
        name: "not-renamed",
        path: path.join(skillsRoot, "renamed", "SKILL.md"),
        severity: "warning"
      }
    ]);
  });

  test("a SKILL.md built to break the parser fails only itself", async () => {
    // A self-referencing alias used to throw out of discovery, failing every
    // run in the workspace and naming no file.
    const layout = await createLayout();
    const skillsRoot = path.join(layout.workspace, ".agents", "skills");
    await writeSkill(path.join(skillsRoot, "fine"), "fine");
    await fs.mkdir(path.join(skillsRoot, "loop"), { recursive: true });
    await fs.writeFile(
      path.join(skillsRoot, "loop", "SKILL.md"),
      "---\nname: loop\ndescription: d\nmetadata: &m {self: *m}\n---\nBody.\n"
    );

    const discovery = await discover(layout, layout.workspace);
    expect(discovery.skills.map((skill) => skill.name)).toEqual(["fine"]);
    expect(discovery.diagnostics).toEqual([
      expect.objectContaining({
        kind: "invalid",
        message: "invalid YAML: anchors and aliases (&name, *name) are not allowed",
        path: path.join(skillsRoot, "loop", "SKILL.md"),
        severity: "error"
      })
    ]);
  });

  test("sees an edited SKILL.md on the next discovery", async () => {
    const layout = await createLayout();
    const directory = path.join(layout.workspace, ".agents", "skills", "evolving");
    await writeSkill(directory, "evolving", "first version");
    expect((await discover(layout, layout.workspace)).skills[0]?.description).toBe("first version");

    await writeSkill(directory, "evolving", "second, longer version");
    expect((await discover(layout, layout.workspace)).skills[0]?.description).toBe("second, longer version");
  });

  test("a provider following the config files sees a skill disabled while it runs, and reloads only on a change", async () => {
    // Settings used to be read once at start, so `aia skills disable` in
    // another terminal did not reach a running session.
    const layout = await createLayout();
    const { home, workspace } = layout;
    await writeSkill(path.join(workspace, ".agents", "skills", "deploy"), "deploy");
    const userConfig = path.join(home, ".aia", "config.jsonc");
    await fs.mkdir(path.dirname(userConfig), { recursive: true });
    await fs.writeFile(userConfig, '{ "configVersion": 1 }\n');
    const load = () =>
      loadAIAgentConfig({
        cwd: workspace,
        env: {},
        resolveSecrets: false,
        userHomeDirectory: home,
        warnWhenUntrusted: false
      });
    let reloads = 0;
    const provider = createSkillProvider({
      bundledRoot: null,
      settings: await followSkillsSettings({
        loaded: await load(),
        reload: async () => {
          reloads += 1;
          return load();
        }
      }),
      userHomeDirectory: home
    });
    const deploy = async () => (await provider.discover(workspace)).skills.find((skill) => skill.name === "deploy");

    expect((await deploy())?.enabled).toBe(true);
    expect((await deploy())?.enabled).toBe(true);
    expect(reloads).toBe(0);

    await setSkillDisabledInConfigFile({ configPath: userConfig, disabled: true, name: "deploy" });
    expect((await deploy())?.enabled).toBe(false);
    expect(provider.settings.disabled).toContain("deploy");
    expect(reloads).toBe(1);
  });

  test("reads the old layouts: <dir>/skills/<name>/, a skill.md in any case, each with a note to move it", async () => {
    // These loaded before aia followed the spec, then vanished without a word.
    const layout = await createLayout();
    const { home, root, workspace } = layout;
    await writeSkill(path.join(workspace, "skills", "old-style"), "old-style");
    await writeSkill(path.join(workspace, "skills", "both"), "both", "old copy");
    await writeSkill(path.join(workspace, ".agents", "skills", "both"), "both", "new copy");
    // One level deep only: a skills/ folder of something else is not walked.
    await writeSkill(path.join(workspace, "skills", "group", "deeper"), "deeper");
    await fs.mkdir(path.join(home, ".agents", "skills", "lower"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".agents", "skills", "lower", "skill.md"),
      "---\nname: lower\ndescription: Lowercase file name.\n---\nBody.\n"
    );
    // Confined like the other project roots.
    await writeSkill(path.join(root, "outside", "escaped"), "escaped");
    await fs.symlink(path.join(root, "outside"), path.join(workspace, "packages", "skills"));

    const discovery = await discover(layout, path.join(workspace, "packages"));

    expect(discovery.skills.map((skill) => `${skill.scope}:${skill.name}:${skill.description}`)).toEqual([
      "project:both:new copy",
      `project:old-style:old-style from ${path.join(workspace, "skills", "old-style")}`,
      "user:lower:Lowercase file name."
    ]);
    const notes = discovery.diagnostics.map((diagnostic) => `${diagnostic.kind}:${diagnostic.message}`);
    expect(notes).toContain(
      "warning:is in the old skills/ folder, which aia still reads but other agents do not; move it to .agents/skills/old-style/"
    );
    expect(notes).toContain(
      "warning:is named skill.md; aia reads it, but other agents look for SKILL.md exactly, so rename it"
    );
    expect(discovery.diagnostics.some((diagnostic) => diagnostic.path.includes("escaped"))).toBe(false);
    expect(discovery.diagnostics.some((diagnostic) => diagnostic.message.includes("leads outside the project"))).toBe(
      true
    );
  });

  test("discoverSkills keeps its earlier shape for callers of the old API", async () => {
    // It was replaced by findSkills; code written against it still gets what
    // it got: the enabled project, user and extra skills, by name, each with
    // its whole SKILL.md as content, and no bundled ones.
    const layout = await createLayout();
    const { home, root, workspace } = layout;
    await writeSkill(path.join(workspace, ".agents", "skills", "proj"), "proj");
    await writeSkill(path.join(home, ".aia", "skills", "mine"), "mine");
    await writeSkill(path.join(root, "extra", "added"), "added");

    const discovered = await discoverSkills({
      cwd: workspace,
      extraRoots: [path.join(root, "extra")],
      userHomeDirectory: home
    });

    expect(discovered.map((skill) => `${skill.source}:${skill.name}`)).toEqual([
      "extra:added",
      "user:mine",
      "workspace:proj"
    ]);
    expect(discovered[2]).toMatchObject({
      content:
        "---\nname: proj\ndescription: proj from " +
        path.join(workspace, ".agents", "skills", "proj") +
        "\n---\nBody of proj.\n",
      skillDirectory: path.join(workspace, ".agents", "skills", "proj"),
      skillFilePath: path.join(workspace, ".agents", "skills", "proj", "SKILL.md")
    });
  });

  test("finds the skills aia ships", () => {
    const bundled = resolveBundledSkillsRoot();
    expect(bundled).toBe(path.resolve(__dirname, "..", "..", "bundled-skills"));
  });
});
