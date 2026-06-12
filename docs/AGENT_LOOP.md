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

## Streaming timeout: inactivity, not an absolute deadline

A single generation can legitimately stream for minutes. The original code passed
`AbortSignal.timeout(timeoutMs)` to the streaming fetch, an **absolute** deadline
measured from request start — so a healthy long stream was killed mid-token with
undici's *"operation was aborted due to timeout."*

The fix is an **idle timeout**. Each adapter creates a `createStreamGuard`
(`src/core/lm/shared.ts`) whose timer resets on every received chunk (`guard.touch()`)
and passes `guard.signal` to `fetchStream`; `http.ts` uses that signal instead of an
absolute timeout for streaming. `fetchJson` (non-streaming) keeps the absolute
`timeoutMs`. The idle window is `providers.<provider>.streamIdleTimeoutMs` (default
60s) — abort fires only when **no tokens arrive** for that long, never while data
flows.

**Time-to-first-token is budgeted separately.** A large local model with a big
context can spend minutes on prompt evaluation before the first token — during which
no bytes arrive. If the 60s idle window were armed from request start, it would abort
that healthy request. So the guard arms `firstTokenTimeoutMs`
(`providers.*.streamFirstTokenTimeoutMs`, default 300s) until `observe()` sees the
first non-empty token, then switches to the tighter `idleTimeoutMs`. (`started` flag in
`createStreamGuard`.) This was a real regression: the idle guard firing during prompt
eval surfaced as "stream stalled: no new tokens arrived within the idle timeout."

## In-generation repetition guard

The no-progress guard above works *between* turns; it cannot stop a model that loops
*inside one generation* (e.g. emitting "I'll use apply_patch" forever). `createStreamGuard`
also watches the streamed text (`guard.observe(delta)` on content and reasoning) and
aborts when the same non-trivial line repeats ≥6× consecutively. Combined with the
`runtime.modelSettings.maxOutputTokens` cap (default 8192) and the idle timeout, a
runaway generation is bounded three ways.

Idle and repetition aborts surface as a `response.error` event; the LM queue throws on
it (`queue.ts`), so the agent loop fails that turn with a clear message
(`buildStreamAbortError`) rather than spinning.

## Sampling controls

`runtime.modelSettings` threads `maxOutputTokens`, `temperature`, `topP`, plus the
anti-repetition controls `repetitionPenalty` (default 1.1, sent as `repeat_penalty`),
`presencePenalty`, `frequencyPenalty`, `topK`, and `minP`. They flow through
`languageModelSettingsSchema` → the loop's request builder → both adapters' `buildPayload`
(LM Studio: OpenAI-compatible `presence_penalty`/`frequency_penalty` + llama.cpp
`repeat_penalty`/`top_k`/`min_p`; Ollama: all under `options`). Unset fields are dropped
by `compactRecord`, so a control you do not set never overrides a model's own preset.
Per-model recommended values live in `docs/SMALL_MODELS.md`.

## Reasoning persistence (`<think>`)

Reasoning leaks into `content` for many local models. We strip `<think>`/analysis
markup from the **persisted** assistant message **only on turns that also produced a
tool call** (`stripReasoningMarkup`) — once the model has committed to an action, its
deliberation is noise that, if replayed, reinforces indecision loops. Pure-text turns
keep their reasoning, and live streaming display is never altered.

## Status metrics

`AgentLoop` emits `onStatus({ metrics })` after each model response with
`{ contextWindowPercentage, tokensUsed, elapsedSeconds }`. The gateway forwards them in
the `gateway.status` event payload; the CLI renders them dimmed on stderr during the run.

- **`tokensUsed` = generated tokens** (`usage.outputTokens`, i.e. completion/eval count),
  which already includes any reasoning tokens. **`contextWindowPercentage`** uses prompt
  (input) tokens against the resolved window.
- **Streaming usage must be requested.** LM Studio omits `usage` from streamed responses
  unless the payload sets `stream_options: { include_usage: true }` (the usage arrives in
  a final chunk with empty `choices`). Ollama returns `prompt_eval_count`/`eval_count`
  natively. Without this, every metric read 0.
- **Context-window resolution** (for the %): configured
  `runtime.modelSettings.contextWindowTokens` → provider query
  (`adapter.getModelContextWindow`; LM Studio `/api/v0/models`, Ollama `/api/show`
  `*.context_length`; best-effort, resolved once in `GatewayRuntime.initialize`) →
  default `32_768`. So the % renders even when nothing is configured. (The auto-compaction
  threshold still falls back to 100k, not 32768, when no window is set — the 32768 default
  is metric-only.)
