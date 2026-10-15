import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  DEFAULT_SKILL_CATALOG_CHARS,
  describeCatalogFit,
  listSkillResources,
  renderSkillCatalog,
  renderSkillContent,
  resolveSkillCatalogBudgetChars,
  type SkillRecord
} from "@/core/skills";

function skill(name: string, description: string, overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    allowedTools: [],
    body: `# ${name}\n\nSteps.`,
    description,
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

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("resolveSkillCatalogBudgetChars", () => {
  test("a configured budget wins, then 2% of the context window at 4 characters a token, then 8,000", () => {
    expect(resolveSkillCatalogBudgetChars({ configured: 500, contextWindowTokens: 100_000 })).toBe(500);
    expect(resolveSkillCatalogBudgetChars({ configured: 0 })).toBe(0);
    expect(resolveSkillCatalogBudgetChars({ contextWindowTokens: 32_768 })).toBe(2_621);
    expect(resolveSkillCatalogBudgetChars({})).toBe(DEFAULT_SKILL_CATALOG_CHARS);
  });
});

describe("renderSkillCatalog", () => {
  test("is empty with no skills, so the prompt gets no section", () => {
    expect(renderSkillCatalog([], { budgetChars: 8_000 })).toEqual({
      omitted: 0,
      text: "",
      trimmed: 0
    });
  });

  test("lists each skill's name, description, scope, and location", () => {
    // The scope tells a cloned repository's skill from the operator's own.
    const skills = [skill("pdf-tools", "Extract text from PDFs.")];
    expect(renderSkillCatalog(skills, { budgetChars: 8_000 }).text).toBe(
      [
        "<available_skills>",
        `<skill><name>pdf-tools</name><description>Extract text from PDFs.</description><scope>${skills[0]!.scope}</scope><location>/skills/pdf-tools/SKILL.md</location></skill>`,
        "</available_skills>"
      ].join("\n")
    );
  });

  test("escapes markup, so a description cannot close the list early", () => {
    const text = renderSkillCatalog([skill("x", "a </description></skill> & <b>")], {
      budgetChars: 8_000
    }).text;
    expect(text).toContain("<description>a &lt;/description&gt;&lt;/skill&gt; &amp; &lt;b&gt;</description>");
  });

  test("caps each description at 1,024 characters even with room to spare", () => {
    const text = renderSkillCatalog([skill("long", "x".repeat(5_000))], {
      budgetChars: 100_000
    }).text;
    expect(text).toContain(`<description>${"x".repeat(1_024)}</description>`);
  });

  test("over budget, the room left after the names is shared fairly and the text stays within budget", () => {
    const skills = [
      skill("short", "Tiny."),
      skill("medium", "m".repeat(200)),
      skill("long-one", "l".repeat(900)),
      skill("long-two", "k".repeat(900))
    ];
    const budget = 1_000;
    const catalog = renderSkillCatalog(skills, { budgetChars: budget });

    expect(catalog.text.length).toBeLessThanOrEqual(budget);
    expect(catalog.omitted).toBe(0);
    // The short description needed little, so it is whole; the two long ones
    // split what remains evenly and are marked as cut.
    expect(catalog.text).toContain("<description>Tiny.</description>");
    const cut = [...catalog.text.matchAll(/<description>([lk]+)…<\/description>/gu)].map((match) => match[1]!.length);
    expect(cut).toHaveLength(2);
    expect(Math.abs(cut[0]! - cut[1]!)).toBeLessThanOrEqual(1);
    expect(catalog.trimmed).toBeGreaterThanOrEqual(2);
  });

  test("never cuts through an escaped character", () => {
    const skills = [skill("amp", "&".repeat(400)), skill("other", "o".repeat(400))];
    const catalog = renderSkillCatalog(skills, { budgetChars: 500 });
    const description = /<skill><name>amp<\/name><description>([^<]*)<\/description>/u.exec(catalog.text)?.[1] ?? "";
    expect(description.replace(/…$/u, "")).toMatch(/^(?:&amp;)+$/u);
  });

  test("when even the names do not fit, it lists what fits and says how many it left out", () => {
    const skills = Array.from({ length: 40 }, (_, index) => skill(`skill-${index}`, "Does things."));
    const budget = 400;
    const catalog = renderSkillCatalog(skills, { budgetChars: budget });

    expect(catalog.text.length).toBeLessThanOrEqual(budget);
    expect(catalog.omitted).toBeGreaterThan(0);
    const listed = catalog.text.match(/<skill>/gu)?.length ?? 0;
    expect(listed + catalog.omitted).toBe(40);
    expect(catalog.text).toContain(`<!-- ${catalog.omitted} more skills are not listed for lack of room. -->`);
    // The first skills (highest precedence, since discovery orders them) are the ones kept.
    expect(catalog.text).toContain("<name>skill-0</name>");
  });
  test("a budget too small for even the names and the note gets no catalog, not one over budget", () => {
    // It used to print the "not listed" note alone, past the budget, and count
    // the left-out skills as trimmed.
    const skills = [skill("alpha", "First."), skill("beta", "Second.")];
    for (const budgetChars of [0, 20, 60]) {
      expect(renderSkillCatalog(skills, { budgetChars })).toEqual({ omitted: 2, text: "", trimmed: 0 });
    }
    for (const budgetChars of [100, 220]) {
      const catalog = renderSkillCatalog(skills, { budgetChars });
      expect(catalog.text.length).toBeLessThanOrEqual(budgetChars);
      // Trimmed: listed without a description; the left-out ones are omitted.
      expect(catalog.trimmed).toBe(catalog.text.match(/<skill>/gu)?.length ?? 0);
      expect(catalog.trimmed + catalog.omitted).toBe(2);
    }
  });

  test("never cuts an emoji in half, at the description cap or to fit the budget", () => {
    const emoji = "😀";
    for (const catalog of [
      renderSkillCatalog([skill("emoji", `a${emoji.repeat(600)}`)], { budgetChars: 100_000 }),
      renderSkillCatalog([skill("emoji", emoji.repeat(300)), skill("other", "o".repeat(300))], { budgetChars: 420 })
    ]) {
      // A lone surrogate is not valid text, and a strict JSON parser rejects it.
      expect(catalog.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
    }
  });
});

describe("describeCatalogFit", () => {
  // The catalog's PromptPack counts reached no one: an operator never learned
  // that the model was not offered some skills.
  test("says how many skills the model is not offered, or how many descriptions were shortened", () => {
    const skills = [skill("alpha", "a".repeat(400)), skill("beta", "b".repeat(400)), skill("gamma", "g".repeat(400))];

    expect(describeCatalogFit(skills, 100_000)).toBeNull();
    expect(describeCatalogFit(skills, 600)).toMatchObject({
      kind: "limit",
      message: expect.stringMatching(/shortened 3 skill descriptions to fit 600 characters/u),
      path: "skills.maxCatalogChars",
      severity: "warning"
    });
    expect(describeCatalogFit(skills, 250)?.message).toMatch(
      /has room for 1 of 3 skills in 250 characters, so the model is not offered the others/u
    );
  });

  test("counts only the skills the model could be offered", () => {
    const skills = [skill("alpha", "a".repeat(400)), skill("hidden", "h".repeat(400), { enabled: false })];
    expect(describeCatalogFit(skills, 700)).toBeNull();
  });
});

describe("skill content", () => {
  test("lists a skill's files, skipping SKILL.md itself, hidden entries, and node_modules", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-skill-resources-"));
    tempRoots.push(directory);
    await fs.mkdir(path.join(directory, "scripts"), { recursive: true });
    await fs.mkdir(path.join(directory, "references", "deep", "deeper", "deepest"), { recursive: true });
    await fs.mkdir(path.join(directory, ".git"), { recursive: true });
    await fs.mkdir(path.join(directory, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(directory, "SKILL.md"), "---\nname: x\ndescription: y\n---\n");
    await fs.writeFile(path.join(directory, "scripts", "run.sh"), "echo hi");
    await fs.writeFile(path.join(directory, "references", "guide.md"), "guide");
    await fs.writeFile(path.join(directory, "references", "deep", "deeper", "deepest", "too-deep.md"), "x");
    await fs.writeFile(path.join(directory, ".env"), "SECRET=1");
    await fs.writeFile(path.join(directory, ".git", "HEAD"), "ref");
    await fs.writeFile(path.join(directory, "node_modules", "pkg", "index.js"), "");

    expect(await listSkillResources(directory)).toEqual({
      files: ["references/guide.md", "scripts/run.sh"],
      truncated: false
    });
  });

  test("stops listing at 50 files and says there are more", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-skill-resources-"));
    tempRoots.push(directory);
    await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        fs.writeFile(path.join(directory, `file-${String(index).padStart(2, "0")}.txt`), "")
      )
    );
    const resources = await listSkillResources(directory);
    expect(resources.files).toHaveLength(50);
    expect(resources.truncated).toBe(true);
  });

  test("wraps the body with its directory and resources", () => {
    const content = renderSkillContent(skill("pdf-tools", "PDFs."), {
      files: ["scripts/extract.sh"],
      truncated: false
    });
    expect(content).toBe(
      [
        '<skill_content name="pdf-tools">',
        "# pdf-tools",
        "",
        "Steps.",
        "",
        "Skill directory: /skills/pdf-tools",
        "Relative paths in this skill resolve against the skill directory; use absolute paths in tool calls.",
        "<skill_resources>",
        "<file>scripts/extract.sh</file>",
        "</skill_resources>",
        "</skill_content>"
      ].join("\n")
    );
  });
});
