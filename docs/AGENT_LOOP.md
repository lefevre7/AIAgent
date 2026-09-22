# Agent Loop: completion, no-progress safety, and tool-call recovery

Last updated: 2026-06-15

This document explains how the agent loop decides to keep going, nudge, or stop —
and how the LM layer recovers tool calls that local models emit as plain text.
It exists because of a real failure mode: a local model that loops
"think → plan → think → plan" and never finishes.

## The loop in one paragraph

`AgentLoop.run` (`src/core/agent/loop.ts`) drives turns until the model calls
`attempt_complete` and the runtime accepts it, an approval pause is hit, the model
fails, or a safety guard stops it. `runtime.maxTurnsPerRun` defaults to
`"unlimited"`, so the _only_ thing that ends a stuck-but-not-erroring session is
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

`think` and `update_plan` have no side effects, but they _are_ tool calls. Before
this fix, executing them reset the no-progress counter (`loop.ts`), so a model that
kept thinking and re-planning never tripped the no-tool guard and — with unlimited
turns — looped forever. Now a turn whose only calls are planning/reasoning still
executes (so plan and working-memory state persists) but counts toward the guard
and receives the `noProgress` nudge telling it to take a concrete action or
complete.

**One planning turn is free (2026-09-18).** "Think, then act" is exactly the
pattern the system prompt asks for, so punishing the first planning turn taught
the model to skip a step it should take. A second counter,
`consecutivePlanningTurns`, tracks the run of planning-only turns; the first one
is silent, and only from the second onward does `consecutiveNudges` increment and
the `noProgress` nudge fire. Both counters reset on any productive turn. A
**mixed** turn — `think` plus a real action tool — was already productive
(`nonCompletionCalls.every(...)`) and stays that way.

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
docs, _"if LM Studio cannot parse any correctly formatted tool calls, it will
simply return the response to `message.content`."_ Reasoning/coder models often
emit the call as text, so the runtime would see a tool-less turn and nudge forever
(see lmstudio-ai/lmstudio-bug-tracker#825 for Qwen3-Coder specifically).

`resolveToolCallProposals` in `src/core/lm/shared.ts` closes this gap. When native
`tool_calls` is empty it scans `content` for tool calls in the common local-model
formats, maps the name to the tool registry (alias/case aware), and strips only the
matched markup from the persisted content (surrounding prose and `<think>` reasoning
are preserved). Recovered turns set `metadata.toolCallsRecoveredFromText: true`.

### Formats recovered

| Source                    | Shape                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------- |
| Hermes (Qwen 3.5, Hermes) | `<tool_call>{"name":"NAME","arguments":{...}}</tool_call>`                            |
| Qwen3-Coder               | `<function=NAME><parameter=key>value</parameter>...</function>` (XML; values coerced) |
| GPT-OSS Harmony           | `<\|channel\|>commentary to=functions.NAME<\|message\|>{...}<\|call\|>`               |
| LM Studio default         | `[TOOL_REQUEST]{"name":"NAME","arguments":{...}}[END_TOOL_REQUEST]`                   |

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
  the persisted assistant message. Only tool-call _markup_ is removed.
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

## The completion summary is the final answer (2026-09-22)

`attempt_complete` is a runtime **completion gate**, not an executed tool: the loop
intercepts it, so it produces no `ToolCall` record, no `tool.updated` event, and no tool
result. Meanwhile the prompt pack tells the model to put its final answer in the
`summary` argument and _not_ to send it as a chat message. The two facts together meant
the answer was written to `messages.jsonl` as a tool-call argument and then dropped —
the CLI (both modes) and the web transcript showed reasoning, tool lines, and no answer.
The better a model followed the contract, the less the operator saw.

On an accepted completion the loop now persists that summary as an ordinary assistant
message tagged `COMPLETION_SUMMARY_MESSAGE_TAG` (`"completion-summary"`, defined in
`src/core/contracts/messages.ts` so the loop, the memory service and the CLI share one
spelling), and sets the session's `statusSummary` to it instead of the hardcoded
"The task completed successfully."

One canonical persist, so every surface gets it: the interactive CLI prints it after the
stream, `--prompt` returns it as `Assistant: …`, the web transcript renders it as text,
and `chat-session-memory` records it. The tag is what lets a surface tell the final
answer apart from narration the operator already watched stream by.

`buildSessionSummary` records it on its own `Final answer:` line rather than letting it
fall out of the same "latest assistant text" scan — otherwise a model that both narrates
and completes would have its narration silently replaced by its sign-off.

A blank or missing `summary` falls back to the generic status line and persists no
message; `tests/integration/agent-loop.test.ts` covers both paths.

**Test-fidelity note.** `tests/helpers/fake-language-model-server.ts` used to emit prose
in `content` plus `attempt_complete` with _empty_ arguments — the opposite of what the
shipped prompt asks for. That is why the CLI and web e2e passed against a product that
dropped every real answer. The fake is now contract-accurate.

## Completion-contract emphasis (2026-06-15)

Symptom this addresses: a small local model (observed with Gemma 4 26B on LM Studio
in the interactive REPL) finishes the requested work, posts a final-summary chat
message, and never emits `attempt_complete`. The loop's `taskContinuation` nudge
then fires repeatedly, the model emits empty responses, and the run ends with
`stopReason: "completion_blocked"` after `maxConsecutiveNudges`.

The fix is prompt + tool guidance, not a runtime behavior change. The existing
nudge text already mentions `attempt_complete`; the missing pressure was upfront
in the system prompt and in the tool's own `usageGuidance`.

- **`src/core/prompts/pack.tsx`** — the "Completion Contract" section now sits
  directly under the intro paragraph (above "Safety and Reliability"), is titled
  "Completion Contract (read first)", states explicitly that prose like "I'm
  done" or a final summary message does NOT end the task, and inlines the
  literal JSON shape the model should imitate:
  `{"name":"attempt_complete","arguments":{"summary":"<short paragraph>","status":"success"}}`.
  The "put the summary in the `summary` argument, do not send it as a separate
  chat message" sentence specifically addresses the two-step failure mode where
  the model produces a summary message and then expects to call the tool on a
  later turn.
- **`src/core/tools/builtins/attempt-complete.ts`** — `usageGuidance` now leads
  with "This tool is the ONLY way to end the task" and repeats the
  "summary-as-argument" cue. `usageGuidance` is not duplicated into the system
  prompt (lean profile keeps it in the provider tools array only), so this
  matters for providers that surface tool descriptions to the model.

What deliberately did NOT change:

- The nudge text itself (`promptPack.nudges.taskContinuation`) is unchanged.
  The existing nudge already says "call `attempt_complete`"; reworking it was
  optional per the user's direction.
- No runtime auto-detection or auto-synthesis of "I'm done" prose into an
  `attempt_complete` call. The explicit-tool-call requirement is non-negotiable
  per `AGENTS.md`; the fix is to make the model emit it, not to fake it.
- `maxConsecutiveNudges` defaults and the no-progress guard semantics are
  unchanged.

The `prompt-payload.test.ts` budget for the base system prompt was raised from
8,000 to 8,700 chars to cover the new section. If a future pass shrinks the
contract section back below the old budget, lower the constant again.

Tests covering this:

- `tests/integration/prompt-pack.test.ts` — asserts the section heading, the
  anti-prose sentence, the literal JSON template, and the section ordering
  (Completion Contract before Safety).
- `tests/unit/attempt-complete-tool.test.ts` — pins the strengthened
  `usageGuidance` wording so it is not softened by accident.
- The existing `tests/integration/agent-loop.test.ts` round-trip ("nudges the
  model when it replies without attempt_complete, and the model sees the
  nudge") already covers the loop behavior after the prompt change.

## Streaming timeout: inactivity, not an absolute deadline

A single generation can legitimately stream for minutes. The original code passed
`AbortSignal.timeout(timeoutMs)` to the streaming fetch, an **absolute** deadline
measured from request start — so a healthy long stream was killed mid-token with
undici's _"operation was aborted due to timeout."_

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

The no-progress guard above works _between_ turns; it cannot stop a model that loops
_inside one generation_ (e.g. emitting "I'll use apply_patch" forever). `createStreamGuard`
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

Reasoning leaks into `content` for many local models, and providers also return it
out of band (`reasoning_content` on LM Studio, `message.thinking` on Ollama). The
two paths are handled differently on purpose.

**Inline `<think>` markup → a first-class message part.** `buildAssistantTurnMessage`
runs `splitReasoningMarkup` over every assistant text part and moves the markup's
contents into a `{ kind: "reasoning", text }` part, leaving the answer in the text
part. It is no longer deleted on tool-call turns: deleting it lost detail the
operator wanted in the transcript, while leaving it inline meant every later turn
replayed the model's indecision back at it. Splitting satisfies both.

**Age-based filtering at the request boundary.** `filterModelVisibleMessages` (via
`dropStaleReasoningParts`) keeps reasoning only for the most recent
`runtime.reasoningContextTurns` turns (default `1` = the current turn). Filtering
is **per turn, not per message**, which is what lets this turn's reasoning survive
across its own tool results while older deliberation stops consuming the window.
`0` drops reasoning from requests entirely. A message left with no parts after
filtering is dropped. The transcript on disk always keeps every reasoning part.

**Provider-native reasoning never enters the transcript.** It streams as
unpersisted `message.reasoning` deltas (thousands per turn — the events log is not
a token stream) and is archived as exactly **one persisted** `message.reasoning`
event per turn with `payload.final === true`, flushed by `flushTurnReasoning` in
`src/gateway/runtime.ts`. Live consumers (CLI, web) skip `final` events so the text
is not rendered twice; readers of the events log see only the aggregate.

## Status metrics

`AgentLoop` emits `onStatus({ metrics })` after each model response with
`{ contextWindowPercentage, tokensUsed, elapsedSeconds }`. The gateway forwards them in
the `gateway.status` event payload; the CLI renders them dimmed on stderr during the run.

- **`tokensUsed` = cumulative generated tokens across the run** (sum of each turn's
  `usage.outputTokens`, i.e. completion/eval count, which already includes reasoning
  tokens) — analogous to how the context grows until compaction. **`contextWindowPercentage`**
  uses the latest prompt (input) tokens against the resolved window.
- Metrics are **not persisted**: `gateway.status` is emitted with `persist=false`, so the
  events log cannot be queried for e.g. the peak context of a past run. Persist the peak
  onto the session record if that becomes necessary.
- **Streaming usage must be requested.** LM Studio omits `usage` from streamed responses
  unless the payload sets `stream_options: { include_usage: true }` (the usage arrives in
  a final chunk with empty `choices`). Ollama returns `prompt_eval_count`/`eval_count`
  natively. Without this, every metric read 0.
- **Context-window resolution** (for the %): configured
  `runtime.modelSettings.contextWindowTokens` → provider query
  (`adapter.getModelContextWindow`, resolved once in `GatewayRuntime.initialize`) →
  default `32_768`. For LM Studio the query reads the native `/api/v0/models` endpoint
  and the context % is based on **`loaded_context_length`** — the window the model is
  actually loaded with (preferring the requested model, else the loaded model even if its
  id differs from the configured string; `loaded_context_length` always wins over
  `max_context_length`). Ollama reads `/api/show` `*.context_length`. So the % renders even
  when nothing is configured. (The auto-compaction threshold still falls back to 100k, not
  32768, when no window is set — the 32768 default is metric-only.)
- **Compaction depends on usage.** Threshold compaction fires when `usage.inputTokens`
  crosses the threshold. Before `include_usage`, streaming reported 0 input tokens, so
  compaction never fired and a session's prompt history could grow without bound (a real
  incident reached ~18M estimated tokens, dominated by a single multi-MB tool result).
  With streaming usage now populated, compaction works during streaming. There are
  intentionally no tool-result size caps, so a single huge `read_file` can still dominate
  the window — compaction is the backstop.

## Manual compaction (`/compact`, gateway `session.compact`) — 2026-09-14

Threshold compaction only fires when a model response reports enough input tokens,
so an operator watching the context-window percentage climb had no way to compact
early. The gateway now exposes a `session.compact` request topic
(`compactSessionNow` in `src/gateway/runtime.ts`), surfaced in the CLI as `/compact`
and in the SDK as `session.compact(...)` / `AIAgentSessionHandle.compact()`.

It reuses the exact pipeline the automatic triggers use
(`FileBackedMemoryService.compactSessionDetailed`, trigger `"manual"`, phase
`"manual"` in `.aia/memory/compactions/<session-id>.jsonl`), writes the
`chat-session-memory/<session-id>.md` summary, then sets the session's
`compactedThroughMessageId` metadata (the exported `COMPACTION_WATERMARK_METADATA_KEY`)
to the newest persisted message so `filterModelVisibleMessages` replays nothing
older on the next turn. The summary reaches the model through the Durable Memory
prompt section, exactly as after a threshold compaction.

Rules: the session must have no active gateway run and no pending approvals (the
resume metadata that tracks pending tool calls is deliberately left untouched), the
session status is preserved, and `session.updated` plus `memory.updated` events are
emitted (the latter carries `metadata.sessionId` so session-scoped subscriptions
receive it). The response reports `hiddenMessageCount`, `compactedThroughMessageId`,
the summary text, and `summaryPath`.

Tests: `tests/integration/gateway-runtime.test.ts` ("session.compact …"),
`tests/integration/memory-service.test.ts` (manual phase), and
`tests/integration/cli-interactive.test.ts` (`/compact` flows).

## CLI approval answers: y / a / deny-with-note — 2026-09-14

`resolvePendingApprovals` in `src/cli.ts` now accepts `y` (approve once), `a`
(approve and auto-approve the same `${target.kind}:${target.value}` for the rest of
that CLI process, tracked in an in-memory `CliApprovalState`; every request is still
recorded as its own resolution), or anything else to deny. A denial offers an
optional free-text note that is sent as the resolution `comment`; the gateway's
`ApprovalCoordinator` (`autoQueueDeniedCommentAsSteering: true`) turns it into a
queued `SteeringInjection`, so the "no, but do this instead" path designed in
`INITIAL_DESIGN.md` is finally reachable from the terminal. The request's
`justification` is printed (dimmed) above the prompt.

`question`-kind approvals (`ask_user_question`) are no longer answered with y/N:
the CLI prints the question and its options and sends the typed reply as the
resolution comment, which the resumed tool call returns to the model as the answer
(previously the CLI approved with no comment, so the tool saw an empty answer).

## Interactive external agents and the loop — 2026-09-18

An interactive external-agent session is a process that **outlives the tool call that
started it**. That is new for this runtime: every other tool either completes or is
explicitly a detached job. Consequences the loop has to respect:

- `send` blocks the tool call until the external agent's turn ends (idle + screen
  stability, or its ready pattern, bounded by `turnTimeoutMs`). From the loop's point of
  view this is just a slow tool — no loop changes were needed.
- The tool result leads with a one-paragraph summary produced by a **separate** model
  call, then includes the rendered screen as a text part. Leading with the summary means
  a small model reads prose first and only falls through to the raw screen when it needs
  detail. The summarizer runs with `toolChoice: "none"` — a summarizer that could call
  tools would be a second agent loop.
- Approval gates `start`, not `send`. Opening a channel to an autonomous agent is the
  consent-worthy act; re-approving every message would make a conversation unusable.
  `UNGATED_EXTERNAL_AGENT_ACTIONS` in `src/core/external-agents/service.ts` encodes this.
- A human can be typing in the same terminal. `writeHumanInput` is a separate entry point
  from `sendToSession` precisely so a human's bytes are never mistaken for a turn: they
  are not summarized, not counted, and they soft-lock the _agent's_ writes instead of
  being blocked by that lock.

See [EXTERNAL_AGENTS.md](EXTERNAL_AGENTS.md) for the full design.
