---
name: skill-creator
description: Create or improve an Agent Skill, a folder with a SKILL.md that teaches the agent a repeatable task. Use when asked to make, write, fix, or review a skill, or to turn a workflow that just worked into one.
---

# Creating a skill

A skill is a folder holding a `SKILL.md`: YAML frontmatter, then Markdown
instructions. The agent sees only each skill's name and description until a
task matches, then loads the instructions. So the description decides whether
the skill is ever used, and the body decides whether it is used well.

## 1. Pin down the task

Before writing, know:

- what the skill does, in one sentence;
- when it should be used: the requests, file types, or words that signal it;
- the steps, and what "done" looks like;
- anything that goes wrong often, and how to recover.

If a workflow just succeeded in this conversation, take the steps from what
actually worked, not from what was first planned. Ask the operator only what
you cannot find out.

## 2. Choose where it lives

- `<repo>/.agents/skills/<name>/`: everyone working in the repository, and
  other clients that read `.agents/skills`.
- `<repo>/.aia/skills/<name>/`: everyone in the repository, in aia only.
- `~/.agents/skills/<name>/` or `~/.aia/skills/<name>/`: only this operator,
  in every project.

Prefer the repository's `.agents/skills` for a project workflow, and the home
folder for a personal one. A project skill overrides a personal skill of the
same name.

## 3. Write the frontmatter

```yaml
---
name: release-notes
description: Draft release notes from the commits since the last tag. Use when asked for release notes, a changelog entry, or what changed in a release.
---
```

- `name`: 1-64 characters of lowercase letters, digits, and hyphens, with no
  leading, trailing, or doubled hyphen. It must match the folder's name.
- `description`: up to 1,024 characters. Say what the skill does and when to
  use it, with the words a request would contain. Write it in the third
  person; it is read as a catalog entry.
- Optional: `license`, `compatibility` (requirements such as tools or network
  access, up to 500 characters), `metadata` (string keys and values).
- `disable-model-invocation: true` keeps the skill out of the model's catalog.
  It then runs only when the operator names it as `$name`: right for anything
  the agent should not start by itself, such as a deploy.
- `allowed-tools` is recorded but grants nothing: aia's approval rules still
  apply to every tool the skill uses.

Quote a value that contains `: `, or YAML reads it as a nested key.

## 4. Write the instructions

- Numbered steps for the procedure; say what to check before moving on.
- One short example of the expected input and output.
- The mistakes to avoid, and what to do when a step fails.
- Keep `SKILL.md` under about 500 lines. Move long reference material into
  `references/<topic>.md`, scripts into `scripts/`, and templates into
  `assets/`, and say in the body exactly when to read or run each one. Refer
  to them by paths relative to the skill folder.
- Prefer a script for anything that must be done exactly the same way each
  time; prefer instructions for anything that needs judgment.

## 5. Check it

1. Run `aia skills list` (or `/skills` in a session). The skill must appear
   without an error or warning under "Notes".
2. Try a request that should trigger it, and one that should not.
3. Try it by name: `$<name> <task>`.
4. Tighten the description if it triggered when it should not have, or did
   not trigger when it should.
