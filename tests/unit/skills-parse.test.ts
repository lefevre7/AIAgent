import { describe, expect, test, vi } from "vitest";

import { parseSkillFile, repairFrontmatter } from "@/core/skills";

function skill(frontmatter: string, body = "Do the thing."): string {
  return `---\n${frontmatter}\n---\n${body}`;
}

describe("parseSkillFile", () => {
  test("reads the spec's fields and the body after the frontmatter", () => {
    const parsed = parseSkillFile(
      skill(
        [
          "name: pdf-tools",
          "description: Extract text from PDF files. Use when a PDF is mentioned.",
          "license: MIT",
          "compatibility: Needs poppler installed",
          "metadata:",
          "  author: example",
          "  version: 2",
          "allowed-tools: Bash(pdftotext:*) Read"
        ].join("\n"),
        "\n# PDF tools\n\nRun `scripts/extract.sh`.\n"
      ),
      "pdf-tools"
    );

    expect(parsed).toEqual({
      ok: true,
      skill: {
        allowedTools: ["Bash(pdftotext:*)", "Read"],
        body: "# PDF tools\n\nRun `scripts/extract.sh`.",
        compatibility: "Needs poppler installed",
        description: "Extract text from PDF files. Use when a PDF is mentioned.",
        disableModelInvocation: false,
        license: "MIT",
        metadata: { author: "example", version: "2" },
        name: "pdf-tools"
      },
      warnings: []
    });
  });

  test("accepts CRLF line endings, a byte-order mark, and a folded description", () => {
    const parsed = parseSkillFile(
      "﻿---\r\nname: notes\r\ndescription: >\r\n  Summarize meeting\r\n  notes.\r\n---\r\nBody\r\n",
      "notes"
    );
    expect(parsed.ok && parsed.skill.description).toBe("Summarize meeting notes.");
    expect(parsed.ok && parsed.skill.body).toBe("Body");
  });

  test("reads allowed-tools as a list, and disable-model-invocation only when it is literally true", () => {
    const listed = parseSkillFile(
      skill(
        "name: deploy\ndescription: Deploy.\nallowed-tools: [shell_command, read_file]\ndisable-model-invocation: true"
      ),
      "deploy"
    );
    expect(listed.ok && listed.skill.allowedTools).toEqual(["shell_command", "read_file"]);
    expect(listed.ok && listed.skill.disableModelInvocation).toBe(true);

    const quoted = parseSkillFile(
      skill('name: deploy\ndescription: Deploy.\ndisable-model-invocation: "true"'),
      "deploy"
    );
    expect(quoted.ok && quoted.skill.disableModelInvocation).toBe(false);
  });

  test("a missing description, unclosed frontmatter, or non-mapping frontmatter is an error", () => {
    expect(parseSkillFile(skill("name: x"), "x")).toEqual({ error: "missing field `description`", ok: false });
    // No frontmatter and nothing but headings: nothing to describe it.
    expect(parseSkillFile("# Just markdown", "x")).toEqual({
      error: "missing YAML frontmatter delimited by ---, and no line that is not a heading to describe the skill",
      ok: false
    });
    expect(parseSkillFile("---\nname: x\ndescription: never closed\n", "x")).toEqual({
      error: "the YAML frontmatter is never closed with ---",
      ok: false
    });
    expect(parseSkillFile(skill("- just\n- a list"), "x")).toEqual({
      error: "frontmatter is not a YAML mapping",
      ok: false
    });
  });

  test("a SKILL.md without frontmatter loads as before: named after its directory, its first line the description", () => {
    // Before aia followed the spec, such a file loaded; it now vanished
    // without a word. It loads again, with a warning naming the format.
    const parsed = parseSkillFile(
      "# Release notes\n\nDraft the release notes from the merged PRs.\n\n1. Read the log.",
      "release-notes"
    );

    expect(parsed.ok && parsed.skill).toMatchObject({
      body: "# Release notes\n\nDraft the release notes from the merged PRs.\n\n1. Read the log.",
      description: "Draft the release notes from the merged PRs.",
      name: "release-notes"
    });
    expect(parsed.ok && parsed.warnings[0]).toContain("has no YAML frontmatter");
  });

  test("blank lines before the opening --- are skipped", () => {
    const parsed = parseSkillFile("\n\n---\nname: x\ndescription: Spaced out.\n---\nBody.", "x");
    expect(parsed).toMatchObject({ ok: true, skill: { body: "Body.", description: "Spaced out.", name: "x" } });
  });

  test("YAML that cannot be repaired is an error that says why", () => {
    // Quoting fixes values; it cannot fix a key given twice.
    const parsed = parseSkillFile(skill("name: x\nname: y\ndescription: z"), "x");
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.error).toMatch(/^invalid YAML: .*unique/u);
  });

  test("a flow value that does not parse is quoted, not rejected", () => {
    const parsed = parseSkillFile(skill("name: x\ndescription: [draft] notes"), "x");
    expect(parsed.ok && parsed.skill.description).toBe("[draft] notes");
  });

  test("spec problems are warnings, and the skill still loads", () => {
    const parsed = parseSkillFile(skill(`name: Big_Name\ndescription: ${"d".repeat(1_100)}`), "big-name");
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.warnings).toEqual([
      "description is 1100 characters; the spec allows 1024",
      'name "Big_Name" does not match its directory "big-name"',
      'name "Big_Name" is not lowercase letters, digits, and single hyphens, as the spec asks'
    ]);
  });

  test("a missing name falls back to the directory name, with a warning", () => {
    const parsed = parseSkillFile(skill("description: No name here."), "from-directory");
    expect(parsed.ok && parsed.skill.name).toBe("from-directory");
    expect(parsed.ok && parsed.warnings).toEqual(["missing field `name`; using the directory name"]);
  });

  test("a name a $mention cannot reach says so", () => {
    const parsed = parseSkillFile(skill("name: my skill\ndescription: Spaces."), "my skill");
    expect(parsed.ok && parsed.warnings).toContain(
      'name "my skill" cannot be mentioned as $my skill; use lowercase letters, digits, and hyphens'
    );
  });

  test("an unquoted value containing ': ' is repaired rather than rejected", () => {
    const parsed = parseSkillFile(skill("name: triage\ndescription: Use this when: a bug report arrives"), "triage");
    expect(parsed.ok && parsed.skill.description).toBe("Use this when: a bug report arrives");
  });
});

describe("parseSkillFile on hostile frontmatter", () => {
  // `metadata: &m {self: *m}` made a structure that refers to itself, and
  // writing it out threw from discovery: every run in that workspace failed.
  test("refuses anchors and aliases, with an error naming them", () => {
    for (const frontmatter of [
      "name: x\ndescription: d\nmetadata: &m {self: *m}",
      "name: x\ndescription: d\na: &a [1, 2]\nb: [*a, *a, *a]"
    ]) {
      expect(parseSkillFile(skill(frontmatter), "x")).toEqual({
        error: "invalid YAML: anchors and aliases (&name, *name) are not allowed",
        ok: false
      });
    }
  });

  test("returns the YAML library's warnings instead of printing them", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const parsed = parseSkillFile(skill("name: x\ndescription: d\nkind: !!custom value"), "x");
      expect(parsed.ok && parsed.warnings.some((warning) => warning.startsWith("YAML: Unresolved tag"))).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("repairs a line holding a long run of spaces in linear time", () => {
    // The old pattern, `(.*?)\s*$`, retried the whole run of spaces at every
    // step: about 200,000² steps for this line, in a file that may be 1 MiB.
    const spaces = " ".repeat(200_000);
    const startedAt = Date.now();
    const repaired = repairFrontmatter(`description: x${spaces}y: z`);
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(repaired === `description: 'x${spaces}y: z'`).toBe(true);
  });
});

describe("repairFrontmatter", () => {
  test("single-quotes risky plain values and doubles their quotes", () => {
    expect(repairFrontmatter("description: It's for: triage")).toBe("description: 'It''s for: triage'");
    expect(repairFrontmatter("description: @mentions")).toBe("description: '@mentions'");
  });

  test("leaves quoted values, block scalars, and flow values that parse alone", () => {
    const text = [
      'description: "already: quoted"',
      "notes: |",
      "  keep: this line",
      "  and: this one",
      "tags: [a, b]",
      "name: plain"
    ].join("\n");
    expect(repairFrontmatter(text)).toBe(text);
  });

  test("knows every block scalar header: indentation and chomping in either order, and a comment", () => {
    for (const header of ["|2-", ">-2", "|+", ">1", "| # literal", ">- # folded"]) {
      const text = [`description: ${header}`, "    Use this when: it rains", "name: x"].join("\n");
      expect(repairFrontmatter(text)).toBe(text);
    }
    expect(parseSkillFile(skill("name: x\ndescription: |2-\n    Use this when: it rains"), "x")).toMatchObject({
      ok: true,
      skill: { description: "Use this when: it rains" }
    });
  });
});
