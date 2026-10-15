# Agent Skills

Last updated: 2026-09-30

A skill is a folder with a `SKILL.md` in it: YAML frontmatter (a name and a
description), then Markdown instructions, plus any scripts, references, or
templates the instructions use. aia reads the open
[Agent Skills](https://agentskills.io/specification) format, the same one
Codex, Claude Code, and other clients read, so a skill written for one of them
works here.

The model does not read every skill up front. It gets a catalog of names and
descriptions, and loads a skill's instructions only when a task matches one
("progressive disclosure"). Dozens of skills cost a few hundred tokens until
one is used.

## Where aia looks

Highest precedence first. When two skills share a name, the first one found
wins, and `/skills` reports the other as shadowed.

1. **Project**: `.aia/skills/` and `.agents/skills/` in the start directory and
   each directory above it, up to the project root (the nearest `.git`),
   closest first. `.agents/skills` is the cross-client location; `.aia/skills`
   is read by aia only. Then, for a project laid out the way aia read skills
   before it followed the spec, the `skills/` folder in the same directories,
   one level deep (`skills/<name>/SKILL.md`), confined to the project like the
   others; each skill found there gets a warning naming the `.agents/skills/`
   folder to move it to.
2. **User**: `~/.aia/skills/`, then `~/.agents/skills/`.
3. **Extra**: each directory in `skills.extraRoots`, in order. Set by a
   workspace config (which needs `aia trust` for it), they are searched as
   project roots instead: inside the project only, ahead of yours.
4. **Bundled**: the skills aia ships in `bundled-skills/` (today
   `skill-creator`, which teaches the model to write a skill). Turn these off
   with `skills.bundled: false`.

A project skill that hides one of your own (user, extra, or bundled) is
reported as a warning in `/skills` and `aia skills list`, since a cloned
repository can do that on purpose.

Inside a root, a skill is any directory holding a regular `SKILL.md`, found
breadth-first. The bounds are Codex's:

- at most 6 levels deep, 2,000 directories, and 20,000 entries per root (a
  root that hits a limit is reported);
- directories whose names start with `.`, and `node_modules`, are skipped;
- a skill's own subdirectories are not searched, so a template `SKILL.md` in
  its `assets/` is not taken for another skill;
- a symlinked `SKILL.md` is ignored. A symlinked directory is followed in your
  own roots (user, extra, bundled). In a project root it is followed only when
  it stays inside the project, so a cloned repository cannot point the scan,
  or the file list the `skill` tool returns, at your home directory. That
  holds for the root itself: a `.agents/skills` (or `.agents`) that is a
  symlink out of the project is not searched, with a warning;
- a `SKILL.md` over 1 MiB is refused.

Parsed files are cached by modification time and size, so re-discovering at
the start of every run costs a directory walk, not a re-parse.

## The SKILL.md format

```markdown
---
name: release-notes
description: Draft release notes from the commits since the last tag. Use when asked for release notes, a changelog entry, or what changed in a release.
---

# Release notes

1. Find the last tag: `git describe --tags --abbrev=0`.
2. ...
```

| Field                      | Rule                                                                                                  | What aia does with it                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `name`                     | 1-64 lowercase letters, digits, and hyphens; no leading, trailing, or doubled `-`; matches the folder | Warns when a name breaks a rule; a missing one falls back to the folder name |
| `description`              | Required, up to 1,024 characters                                                                      | Missing: the skill is skipped, with an error. Longer: capped in the catalog  |
| `license`, `compatibility` | Optional; `compatibility` up to 500 characters                                                        | Listed by `aia skills list --json`                                           |
| `metadata`                 | Optional map of strings                                                                               | Listed; non-string values are kept as text                                   |
| `allowed-tools`            | Optional, experimental in the spec                                                                    | Listed only. **It never approves anything**; approval rules still apply      |
| `disable-model-invocation` | `true` (a Claude Code extension)                                                                      | Left out of the catalog and the `skill` tool; runs only as `$name`           |

Parsing is lenient, as the spec's client guide recommends: only a missing
description, or frontmatter that is not a YAML mapping, stops a skill from
loading. Frontmatter written for a laxer parser is repaired once before it is
rejected: a plain value containing `: ` (`description: Use when: ...`) is
quoted, as Codex does. Files written for aia before it followed the spec still
load, each with a warning saying what to change: a `skill.md` in any case, and
a file with no frontmatter at all (named after its folder, its first line that
is not a heading the description; one with only headings has nothing to
describe it and is invalid). Blank lines before the opening `---` are skipped.

## How the model uses skills

### The catalog

The system prompt gets an "Available Skills" section: a few lines on how to
use skills, then

```xml
<available_skills>
<skill><name>release-notes</name><description>Draft release notes ...</description><location>/repo/.agents/skills/release-notes/SKILL.md</location></skill>
</available_skills>
```

- Only enabled skills without `disable-model-invocation` are listed.
- Each entry carries its `<location>` (the SKILL.md path), so the model can
  find the files beside a skill, and can read the skill with `read_file` when
  the `skill` tool is not available (for example `tools.exclude: ["skill"]`).
- The budget is `skills.maxCatalogChars`, or 2% of the model's context window
  at 4 characters a token, or 8,000 characters when the window is unknown.
  Descriptions are capped at 1,024 characters. When the list still does not
  fit, the room left after the names is shared out evenly across the
  descriptions (a short description keeps all of it). When even the names do
  not fit, the list stops and ends with a line saying how many were left out.
  Discovery orders skills by scope, then name, so bundled skills are the first
  to go.
- The section sits before the task and memory sections of the prompt. Those
  change between runs; the catalog does not, so it stays in the part of the
  prompt a local server (llama.cpp, LM Studio) can reuse from its KV cache
  instead of re-reading it.

### The `skill` tool

`skill({ "name": "release-notes" })` returns the skill's instructions:

```text
<skill_content name="release-notes">
...the body, without its frontmatter...

Skill directory: /repo/.agents/skills/release-notes
Relative paths in this skill resolve against the skill directory; use absolute paths in tool calls.
<skill_resources>
<file>scripts/changelog.sh</file>
</skill_resources>
</skill_content>
```

- The result is plain text, so the Markdown reads as written rather than as an
  escaped JSON string.
- The files in the skill's folder are listed (up to 50, 3 levels deep, hidden
  entries skipped) but not read; the instructions say when to open them.
- For each session the agent loop narrows the tool's `name` parameter to an
  `enum` of that session's skills. A server that constrains tool calls to
  their JSON schema, as llama.cpp does with a grammar, then cannot produce a
  skill that does not exist, which matters for small models. The tool still
  checks the name against the skills on disk, for servers that do not
  constrain, and accepts a name that differs only in case.
- A session with no model-visible skills does not get the tool at all. Under
  the lean tool profile it is exposed whenever there is a skill.
- It needs no approval: it only reads a SKILL.md. Whatever the instructions
  lead to goes through the approval of each tool used.

### Naming a skill: `$name`

In a message (the CLI, the web UI, the SDK, or steering), `$release-notes`
loads that skill before the model sees the message:

- the skill's instructions are added as the next message, in the same
  `<skill_content>` form the tool returns, so there is no tool round trip;
- `[$anything](/path/to/skill/SKILL.md)` (or the skill's directory) picks the
  skill by path, the form a UI inserts when it knows exactly which skill: `~`
  is expanded, a relative path is taken from the session's directory, a
  symlinked path matches the skill's real one, and case is ignored on macOS
  and Windows;
- names match exactly, case included, less a trailing `:`, `-` or `_`
  (`Run $release-notes: for v2` names `release-notes`). A `$` right after a
  letter, digit, underscore, or another `$` is not a mention (`US$5`, `$$`),
  nor is one inside code (an inline code span or a fenced block) or a URL,
  nor a common shell variable in capitals (`$HOME`, `$PATH`, ...). In lowercase
  (`$home`) it can name a skill; a skill named `HOME` gets a warning that it
  cannot be named;
- a disabled skill is never loaded; a `disable-model-invocation` skill can be,
  since this is the only way it runs;
- only the operator's own messages count. A message from a channel (Discord,
  WhatsApp, Teams, iMessage) counts only when its sender is one of that
  channel's `operatorIdentities`; the gateway records that on the message
  (`metadata.channelOperator`, set after the adapter's own metadata so a
  sender cannot supply it). Anyone else in a group chat cannot start a skill
  by naming it, though the model can still load one with the tool if the task
  calls for it.

The added message is a `user` message (`source: "system"`, tag `skill`,
`visibility: "compact"`). Every chat template accepts a user message
mid-conversation. Several accept a `system` message only at the start
(Gemma 3's refuses one anywhere else).

## Loaded skills and compaction

Each load is recorded in the session's `activatedSkills` metadata, with the id
of the message that carries the instructions, as soon as the call that loaded
it finishes: on every path a tool runs (a run, a turn paused for approval and
resumed, a direct `tool.execute`). With that record:

- loading a skill twice costs nothing, even twice in one response: the tool
  answers that it is already loaded, and a repeated `$name` adds nothing;
- when compaction folds a load out of the replayed transcript (threshold,
  overflow, or `/compact`), the next prompt restates the skill in an "Active
  Skills" section. Compaction never silently unloads a skill the model is
  following. Compaction already changes the prompt, so this costs no cache
  reuse that was not already lost.
- the section has a budget, `runtime.promptBudgets.activeSkillsChars`
  (default 16,000, all restated skills together; 0 for none): skills are
  restated whole, in the order they were loaded, while they fit; the next is
  cut there, and any after it are named with their SKILL.md to read (with
  `read_file`, when the model has it). Without a budget, one large skill came
  straight back after every compaction, and a small window overflowed on every
  later prompt of the session.

## Operator commands

| Surface | Command                              | What it does                                                                                                        |
| ------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| CLI     | `/skills`                            | Lists the skills for the session's workspace, with scope, state, path, and any problems                             |
| CLI     | `aia skills list [--json] [--cwd p]` | The same without starting a session; `--json` prints the summaries and diagnostics                                  |
| CLI     | `aia skills disable <name>`          | Adds the name to `skills.disabled` in your user config (`~/.aia/config.jsonc` when it exists), keeping its comments |
| CLI     | `aia skills enable <name>`           | Removes it from every config file that lists it, the workspace one included                                         |
| Gateway | `skills.list` `{ cwd? }`             | `{ skills, diagnostics }` for `cwd` (default: the gateway's workspace). Summaries, no bodies                        |
| SDK     | `sdk.skills.list({ cwd? })`          | The same over the SDK                                                                                               |

`enable` and `disable` reach sessions already running too, from their next run: a running
gateway stats the config files (and the trust store) at each discovery and reloads the skills
settings when one changed (`followSkillsSettings`, `src/core/skills/provider.ts`). No restart.

A diagnostic is `{ kind, severity, path, message, name? }`, where `kind` is
`invalid` (not loaded), `warning` (loaded, with a spec problem), `shadowed`, or
`limit`.

## Config

```jsonc
{
  "skills": {
    // Include the skills aia ships (bundled-skills/).
    "bundled": true,
    // Names, or SKILL.md paths, listed but never used.
    "disabled": [],
    // false turns skills off: no catalog, no `skill` tool, no `$name` mentions.
    "enabled": true,
    // More roots, after the project and user roots. Relative paths resolve
    // against the config file's directory; `~/` against your home.
    "extraRoots": []
    // Catalog budget in characters. Unset (the default), it is 2% of the
    // model's context window, or 8,000 when the window is unknown; setting it
    // fixes the budget for every model.
    // "maxCatalogChars": 8000
  }
}
```

Other config lists replace rather than merge, but `skills.disabled` adds up
across your user config and the workspace config: a skill disabled in any of
them stays disabled. A workspace list used to replace yours, quietly turning a
skill you had disabled back on.

## Security model

- A skill is instructions, like an `AGENTS.md`. aia reads both from a
  repository whether or not its config is trusted: reading instructions runs
  nothing. What a skill leads the model to do (run a script, edit files, call
  an MCP tool) goes through the same approval as any other tool call. Workspace
  config trust (docs/CONFIG.md) gates what does run code: exec secret
  providers and MCP servers.
- `allowed-tools` never approves a tool. Claude Code treats it as
  pre-approval; aia records it and nothing more.
- A project cannot aim discovery outside itself through symlinks (its skills
  roots included) or through a workspace config's `skills.extraRoots`, and a
  symlinked `SKILL.md` is never read.
- Names, descriptions, and paths from SKILL.md files are printed through the
  terminal sanitizer, so a skill cannot drive your terminal with escape
  sequences.
- A channel message loads a skill by naming it only when its sender is an
  allowlisted operator identity.
- A project skill that shadows one of your own is a warning in `/skills`.
- Skills are prompt content: a malicious skill in a cloned repository can try
  to steer the model, exactly as a malicious `AGENTS.md` can. Review the
  `.agents/skills/` of a repository you do not trust, as you would its
  `AGENTS.md`.

## Compared with Codex

aia follows Codex where Codex has settled a question, and differs where aia's
small local models need it:

|                                                 | Codex                                                                               | aia                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Frontmatter read                                | name, description, `metadata.short-description`                                     | All spec fields, plus `disable-model-invocation`                     |
| Scan bounds, symlinked `SKILL.md`, colon repair | depth 6 / 2,000 dirs / 20,000 entries; ignored; yes                                 | The same                                                             |
| Catalog                                         | Markdown list with paths; 2% budget; round-robin trimming                           | XML list with paths; 2% budget; the same fair trimming               |
| Loading                                         | The model reads SKILL.md itself (a file read, or `skills.read` for packaged skills) | A `skill` tool whose `name` is an enum of the session's skills       |
| `$name`                                         | Injects the skill for that turn                                                     | The same, deduplicated for the session and restored after compaction |
| Untrusted project                               | Skills load                                                                         | Skills load (instructions only; approvals still apply)               |

## Code map

- `src/core/skills/parse.ts`: SKILL.md parsing, lenient validation, frontmatter repair.
- `src/core/skills/discovery.ts`: roots, precedence, scan bounds, symlink rules, parse cache.
- `src/core/skills/catalog.ts`: catalog budget and fitting, resource listing, `<skill_content>`.
- `src/core/skills/mentions.ts`: `$name` and `[$name](path)` resolution.
- `src/core/skills/activations.ts`: the session record, the tool contract, the enum narrowing.
- `src/core/skills/provider.ts`: one discovery per config, shared by the loop, the tool, and `skills.list`.
- `src/core/skills/settings.ts`: `aia skills enable|disable` config edits.
- `src/core/tools/builtins/skill.ts`: the `skill` tool.
- `src/core/agent/loop.ts`: per-run discovery, enum narrowing, `$name` injection, load records, Active Skills.
- `src/core/prompts/pack.tsx`: the Available Skills and Active Skills sections.

Tests: `tests/unit/skills-*.test.ts` (parser, mentions, catalog, config
edits), `tests/integration/skills-discovery.test.ts`,
`tests/integration/agent-loop-skills.test.ts`, the `aia skills` and `/skills`
cases in `tests/integration/cli-interactive.test.ts`, and `skills.list` in
`tests/integration/sdk.test.ts`.
