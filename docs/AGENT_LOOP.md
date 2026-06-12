# Agent Loop: completion, no-progress safety, and tool-call recovery

Last updated: 2026-06-12

This document explains how the agent loop decides to keep going, nudge, or stop —
and how the LM layer recovers tool calls that local models emit as plain text.
It exists because of a real failure mode: a local model that loops
"think → plan → think → plan" and never finishes.

## The loop in one paragraph

`AgentLoop.run` (`src/core/agent/loop.ts`) drives turns until the model calls
`attempt_complete` and the runtime accepts it, an approval pause is hit, the model
fails, or a safety guard stops it. `runtime.maxTurnsPerRun` defaults to
`"unlimited"`, so the *only* thing that ends a stuck-but-not-erroring session is
the **no-progress guard**.

## What counts as "no progress"

The guard shares one counter, `consecutiveNudges`, bounded by
`runtime.maxConsecutiveNudges` (default 3). A turn is **unproductive** when:

1. it has **no tool calls** (a plain chat reply), or
2. it **mixes `attempt_complete` with other calls**, or it makes a completion
   attempt the gate **rejects**, or
3. its **only** tool calls are planning/reasoning-family tools.

Each unproductive turn increments the counter and injects a `compact`-visibility
nudge; any genuinely productive turn (a real action tool ran) resets it to 0.
When the counter exceeds `maxConsecutiveNudges` the loop stops with
`stopReason: "completion_blocked"`.

### Why case 3 exists

`think` and `update_plan` have no side effects, but they *are* tool calls. Before
this fix, executing them reset the no-progress counter (`loop.ts`), so a model that
kept thinking and re-planning never tripped the no-tool guard and — with unlimited
turns — looped forever. Now a turn whose only calls are planning/reasoning still
executes (so plan and working-memory state persists) but counts toward the guard
and receives the `noProgress` nudge telling it to take a concrete action or
complete.

### How a tool is classified (no per-model magic)

Classification is by the tool's **declared family**, not by which model is loaded:

```ts
// loop.ts
const NO_PROGRESS_TOOL_FAMILIES = new Set(["planning", "reasoning"]);
// a call is no-progress when its definition's annotations.meta.family is in that set
```

`think` declares `family: "reasoning"`, `update_plan` declares `family: "planning"`.
A future planning/reasoning tool is covered automatically by setting its family;
nothing keys off the model name. Note `sideEffects: ["none"]` is **not** used for
this — many useful tools (searches, reads, browser) also declare no side effects,
and counting those as no-progress would prematurely kill legitimate research loops.

## Tool calls that arrive as text (the real trigger)

Local runtimes only populate the native OpenAI `tool_calls` field when their
server-side chat template recognizes the model's tool-call syntax. Per LM Studio's
docs, *"if LM Studio cannot parse any correctly formatted tool calls, it will
simply return the response to `message.content`."* Reasoning/coder models often
emit the call as text, so the runtime would see a tool-less turn and nudge forever
(see lmstudio-ai/lmstudio-bug-tracker#825 for Qwen3-Coder specifically).

`resolveToolCallProposals` in `src/core/lm/shared.ts` closes this gap. When native
`tool_calls` is empty it scans `content` for tool calls in the common local-model
formats, maps the name to the tool registry (alias/case aware), and strips only the
matched markup from the persisted content (surrounding prose and `<think>` reasoning
are preserved). Recovered turns set `metadata.toolCallsRecoveredFromText: true`.

### Formats recovered

| Source | Shape |
| --- | --- |
| Hermes (Qwen 3.5, Hermes) | `<tool_call>{"name":"NAME","arguments":{...}}</tool_call>` |
| Qwen3-Coder | `<function=NAME><parameter=key>value</parameter>...</function>` (XML; values coerced) |
| GPT-OSS Harmony | `<\|channel\|>commentary to=functions.NAME<\|message\|>{...}<\|call\|>` |
| LM Studio default | `[TOOL_REQUEST]{"name":"NAME","arguments":{...}}[END_TOOL_REQUEST]` |

There is also a tolerance for idiosyncratic JSON like
`{"status":"ok","attempt_complete":{}}`, where the tool name is itself a key whose
value is the arguments object.

Native `tool_calls` always win — the text fallback only runs when the native array
is empty, so well-behaved models are unaffected.

### Where it's wired

`src/core/lm/lm-studio.ts` and `src/core/lm/ollama.ts` both route their non-stream
`buildResponse` and their streaming `response.completed` paths through
`resolveToolCallProposals`. `stopReason` is forced to `"tool_calls"` when a call is
recovered so downstream behaves identically to native parsing.

## Out of scope (deliberately)

- **Reasoning text is left as-is.** `<think>`/analysis content is not stripped from
  the persisted assistant message. Only tool-call *markup* is removed.
- **No new turn cap.** `maxTurnsPerRun` stays `"unlimited"`; the no-progress guard
  is the stopping mechanism. See [[small-model-optimization-choices]] rationale in
  `docs/SMALL_MODELS.md`.
- **No per-model conditioning.** Behavior is identical regardless of which model is
  configured.

## Tests

- `tests/unit/lm-text-tool-calls.test.ts` — every recovered format, name
  resolution, content stripping, and native-takes-precedence.
- `tests/integration/agent-loop.test.ts` — "stops with completion_blocked when the
  model only plans or reasons without acting" exercises the planning-loop guard.

## If you change this

- Adding a tool-call text format: extend `parseTextToolCalls` and add a fixture to
  `lm-text-tool-calls.test.ts`. Keep detectors conservative (only accept when a tool
  name resolves) to avoid eating legitimate JSON answers.
- Adding a no-progress-style tool: give it `annotations.meta.family` of `reasoning`
  or `planning` rather than special-casing it in the loop.
