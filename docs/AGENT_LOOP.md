# Agent Loop: completion, no-progress safety, and tool-call recovery

Last updated: 2026-10-02

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
3. its **only** tool calls are planning/reasoning-family tools, or
4. **every** tool call in it was refused by the identical-call guard
   (`repeated_tool_call`, past `runtime.maxIdenticalToolCalls`), from the third
   such turn in a row: two are free, since a refusal is often what makes a model
   change course. Refused turns used to count as productive, so a small model
   calling the same thing again and again (`mcp_status` under the lean profile)
   never tripped the guard. They get the `repeatedCalls` nudge: use the results
   already above, change the call, or complete.

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

The interactive CLI only prints a summary that one of the current turn's runs wrote (the
run records' `messageIds`, including runs resumed after approvals). The session snapshot
holds every turn, so a session-wide lookup re-printed turn 1's answer under a later turn
that produced none, and hid the `Turn ended: …` notice for it.

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
(`providers.*.streamFirstTokenTimeoutMs`, default 30 min) until `observe()` sees the
first non-empty token, then switches to the tighter `idleTimeoutMs`. (`started` flag in
`createStreamGuard`.) This was a real regression: the idle guard firing during prompt
eval surfaced as "stream stalled: no new tokens arrived within the idle timeout."

- **30 minutes, not 5 (2026-10-02).** LM Studio read an 80k-token prompt for
  `qwen3.8-27b-mlx` at about 107 tokens/s on the operator's machine (its server log reports
  progress; the stream sends nothing meanwhile): 13 minutes, and a full 119k-token window
  takes about 20. The 300 s budget ran out at 39%. The setting is capped at 24 hours rather
  than the 10 minutes other timeouts allow. Usually the prompt is mostly cached and reading
  takes seconds; see "The system prompt stays put between runs" below for what made this
  one uncached.
- **The two budgets are reported apart.** The guard's abort reason is `first_token` or
  `idle` (codes `provider_stream_first_token`, `provider_stream_idle`), and the message
  names the budget and the setting: "The lm_studio model did not start answering within
  30 min. A local model may still be reading a long prompt; to wait longer, raise
  providers.lmStudio.streamFirstTokenTimeoutMs." Before, a first-token timeout read as a
  stalled stream.

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
- **Context-window resolution** (for the % and the auto-compaction threshold): configured
  `runtime.modelSettings.contextWindowTokens` → provider query
  (`adapter.getModelContextWindow`, looked up in `GatewayRuntime.initialize` and again before
  every run) → default `32_768`. For LM Studio the query reads the native `/api/v0/models`
  endpoint and uses the requested model's **`loaded_context_length`**, the window it is
  actually loaded with. Until LM Studio loads it (on its first request) that window is
  unknown, so the defaults apply and the next run looks again; an unknown answer keeps the
  last known window. Another model's window is used only when the configured id matches
  nothing listed, and then only a loaded chat model's (`llm`/`vlm`, never `embeddings`). A
  server too old to report `loaded_context_length` falls back to a loaded model's
  `max_context_length`. Ollama reads `/api/show` `*.context_length`. So the % renders even
  when nothing is configured. (The auto-compaction threshold still falls back to 100k, not
  32768, when no window is known — the 32768 default is metric-only.)
  - Why (2026-10-02): the lookup ran once, at startup, and fell back to "any loaded model".
    aia started before LM Studio had loaded `qwen3.8-27b-mlx`, the only loaded model was the
    nomic embedding model, and its 2048 tokens became the window: the threshold fell to ~1.6k
    tokens and the session compacted after its first turn (9,308 prompt tokens), then after
    every turn.
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
older on the next turn except the operator's own messages (see "Compaction keeps what
people said" below). The summary reaches the model through the Durable Memory
prompt section, exactly as after a threshold compaction.

Completion compaction (trigger `"completion"`, run after an accepted `attempt_complete`)
writes the same summary but deliberately does **not** move the watermark. Every chat
turn ends that way, and the summary carries no user messages, so hiding the transcript
there would make the next turn in a REPL, web, or channel session start with no memory
of the conversation. Only threshold compaction and `/compact` hide history.

Rules: the session must have no active gateway run and no pending approvals (the
resume metadata that tracks pending tool calls is deliberately left untouched), the
session status is preserved, and `session.updated` plus `memory.updated` events are
emitted (the latter carries `metadata.sessionId` so session-scoped subscriptions
receive it). The response reports `hiddenMessageCount` (how many messages left the model's
view: visible before minus visible after, since the operator's messages stay),
`compactedThroughMessageId`, the summary text, and `summaryPath`.

Tests: `tests/integration/gateway-runtime.test.ts` ("session.compact …"),
`tests/integration/memory-service.test.ts` (manual phase), and
`tests/integration/cli-interactive.test.ts` (`/compact` flows).

## Context overflow: compact once and retry — 2026-09-30

Threshold compaction reads the _previous_ response's input tokens, so one huge tool result
between two turns can push the next prompt past the window before any threshold is seen.
The provider then refuses the request (llama.cpp: 400 `exceed_context_size_error` with
`n_prompt_tokens` and `n_ctx`). Every adapter classifies its provider's spelling of that
refusal as `context_window_exceeded` (`CONTEXT_WINDOW_EXCEEDED_ERROR_CODE`, in
`src/core/contracts/providers.ts`), and the model queue keeps the structured error instead of
flattening it to a message.

On that code the loop (`compactForContextOverflow` in `src/core/agent/loop.ts`), once per turn:

1. folds the history **before the current task** into the session summary (compaction trigger
   and phase `"overflow"`): the watermark moves to just before the latest thing a person said
   at or before this run started, which is this run's request, or for a run resumed after an
   approval, the request it paused on. The task itself (its request, its tool calls and their
   results, steering that arrived mid-run) is kept whole: folding it, as the first version did,
   handed the model its request and none of its own work, and it started over. The operator's
   earlier messages stay too (see "Compaction keeps what people said").
2. rebuilds the prompt pack (the summary reaches the model through Durable Memory) and re-sends
   the request with the now-visible messages, **under its own id** (`<id>.overflow-retry`): a
   request id is the model queue's job id, and the file queue refuses one it has seen, so the
   first version's retry failed with `Language model queue job "…" already exists.`

When the retry overflows again, the run fails with a message naming both sizes and the fix:
"The prompt (N tokens) is larger than the model's context window (M tokens), even after
compacting the session. Start llama-server with a larger context (-c), or start a new
session." The fix is the failing provider's own (its adapter puts it on the error as
`details.remedy`, from the provider table in `src/core/lm/provider-table.ts`: a larger `-c`
for llama.cpp, a larger context length in LM Studio, `providers.ollama.contextLength` for
Ollama); a provider an SDK host registered gets "Load the model with a larger context
window". When nothing
before the task is left to fold, it fails at once instead, saying so: the task's own messages
and tool results do not fit, so the advice is a larger context or asking for less at a time (a
line range, a narrower search). No tool result is cut down to fit: there is deliberately no
tool-output cap. The session's `lastError` keeps the provider's structured code rather than a
generic `agent_loop_error`.

Tests: `tests/integration/agent-loop.test.ts` ("context window overflow", one case through the
real file-backed queue), `tests/unit/lm-http-retry.test.ts` (classification),
`tests/live/llama-cpp.live.test.ts`.

## Compaction keeps what people said — 2026-10-02

The session summary records the goal, the tool calls, and the agent's narration. It never
recorded what the operator asked. Threshold compaction, overflow compaction, and `/compact`
hid every message up to the watermark, so after any of them the model was working on a task
nobody had stated. The replayed history also opened with whatever followed the watermark,
usually the assistant's tool call. The Qwen 3.5-family chat template (the one
`qwen3.8-27b-mlx` ships) refuses a conversation whose first message after the system prompt
is not a user turn. LM Studio
reports that as `Error rendering prompt with jinja template: "No user query found in
messages."`, in an HTTP 200 stream. A compacted session failed every later request, even
after the operator spoke again, because the history still opened with that tool call.
(Probed against LM Studio: `[system, assistant, tool, user]` is refused,
`[system, user, assistant, tool, system, user]` renders.)

`filterModelVisibleMessages` now keeps the conversation's own messages from before the
watermark (`retainConversationInput` in `src/core/agent/loop.ts`), ahead of everything after
it, as Codex's `build_compacted_history` does:

- **What counts:** user-role messages from the operator (`source: "user"`), steering
  (`"operator"`), and channels (`"channel"`). A user-role message the runtime wrote (a loaded
  skill's instructions, `source: "system"`) is not kept; the prompt restates active skills.
- **Budget:** newest first, up to 80,000 characters (Codex's 20k-token
  `COMPACT_USER_MESSAGE_MAX_TOKENS` at ~4 characters per token). The message that straddles the
  budget keeps its start and end around a "[N characters of this message were dropped when the
  session was compacted]" marker; older ones are dropped.
- **Text only:** `text` and `markdown` parts. Images and other parts in a folded message are
  not replayed. A text message that fits whole is replayed as stored.

Everything else before the watermark (assistant turns, tool calls and results, nudges) is
still folded, and the summary is unchanged. The memory service's source-token estimate and
`/compact`'s `hiddenMessageCount` go through the same filter, so both count the kept messages
as still in context.

Templates that enforce strict user/assistant alternation (Gemma 3 and 3n, Mistral Small 4,
Devstral 2, Ministral 3) refuse two user turns in a row. A `/compact` followed by a new
message produces one, and so do several shapes the runtime already sent: steering or a tool
image right after tool results, and a `$skill` injection after the operator's message.
Qwen 3.x and Gemma 4 templates do not check alternation. This is still open.

Tests: `tests/integration/agent-loop.test.ts` ("compaction keeps the conversation's own
messages", and the threshold and overflow compaction cases, which check the wire roles),
`tests/integration/gateway-runtime.test.ts` ("the operator's earlier messages survive
/compact"), `tests/integration/memory-service.test.ts` (the estimate).

## The system prompt stays put between runs — 2026-10-02

A local server (LM Studio, llama.cpp) keeps what it has already read of a prompt and reuses it
for the next request only up to the first changed character. The whole conversation follows the
system prompt, so a change anywhere in it makes the server re-read every message. Two sections
used to change between runs without anything being folded:

- **Task State**, read live at the start of every run, so the run after an `update_plan` call
  had a different plan in it. In the reported session that meant re-reading about 80k tokens:
  13 minutes (LM Studio's log), past the 5-minute first-token budget of the time. The run before
  it, with nothing changed, read its prompt in 18 s.
- **This session's summary** in Durable Memory, rewritten by completion compaction after every
  accepted `attempt_complete`, while the whole transcript was still replayed anyway. Every
  message after a finished task paid the same re-read.

Both now change only when history is folded (threshold, overflow, or manual compaction, which
change what is replayed and so the prompt anyway):

- the loop renders the task state as of the last fold, kept in session metadata
  (`compactedTaskState`, written with the watermark by `foldedSessionMetadata`; progress and
  notes only, not the plan record), and shows none before the first fold. Until then the model
  sees its plan through its own plan-tool calls in the transcript.
- `FileBackedMemoryService.getPromptContext` returns the summary as of the last fold (a frozen
  copy in `.aia/memory/folded-summaries/`), and none before the first. The
  `chat-session-memory/` file is still rewritten on every completion for people to read.
- A session folded before this change keeps the live state and summary, as before, until its next
  fold.

Measured live in the REPL: two runs, each calling `update_plan`, the first ending in an accepted
completion. All four requests carried a byte-identical system prompt, and LM Studio read the
second run's first prompt in 2 s.

Still changing the system prompt between runs: an edited AGENTS.md or skill, a context window
that becomes known after the first run (it sizes the skill catalog), and tools that
`tool_search` activates. Chat templates such as Qwen's render the tool list ahead of the system
message, so an activation re-reads everything after the tools.

Tests: `tests/integration/agent-loop.test.ts` ("the system prompt between runs"),
`tests/integration/memory-service.test.ts` (folded and legacy summaries),
`tests/integration/gateway-runtime.test.ts` (`/compact` records the task state).

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

### An answer must be typed after the question — 2026-09-22

Operator report: "sometimes when I press `a` for always, it thinks I've rejected."

The parser was fine; the problem was _which line it read_. The stdin reader buffers
from the moment it is created (so piped input is never lost), which means anything
typed while the agent was working is already queued when an approval prompt appears
— most often an impatient Enter. That stale line was handed back as the answer, was
neither `y` nor `a`, and the request was denied; the operator's real keystroke then
landed on the next prompt. The REPL had always skipped blank lines, but the approval
prompt treated blank as "no", so the two readers of the same stream disagreed about
what an empty line meant.

`CliLineReader` now replaces the bare `nextLine` callback and exposes
`discardBuffered()`. `createOperatorPrompt` drains, writes the question, then reads,
and every operator question goes through it: approvals, the "what should it do
instead?" follow-up, and `ask_user_question`.

Two rules that keep this correct:

- **Draining is TTY-only.** Piped input is a script's deliberately pre-supplied
  answers; discarding it would break every scripted run.
- **The conversation prompt deliberately does not drain.** A line typed while the
  agent worked _is_ the operator's next message. Only questions discard stale input
  — which is why the distinction lives in the reader's API, not in a flag at one
  call site.

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

## Cancel, mid-run steering, and approval resumes — 2026-09-28

Found by running a real model, not by reading: cancel stopped nothing, steering sent mid-run waited
for the next run, and approving one direct tool call handed the session to the model.

**Cancel is real.** Each gateway run owns an `AbortController`. `run.cancel` / `session.cancel` abort
it, and the signal reaches `AgentLoop.run` (`signal`), the model call, the LM queue (a queued job is
dropped, a running one aborted) and the provider's `fetch`. A cancelled request is never retried. The
loop checks the signal before every turn and before every tool call: a call already running finishes,
the rest are recorded as `cancelled` (each still gets a result, so the transcript keeps one result per
proposed call), and no further turn starts. The session ends `cancelled`. `GatewayRuntime.close()`
(REPL `/exit`, SDK `close()`, server stop) cancels active runs first, then drains; draining alone
waited for a generation that was still going.

**Steering is delivered at the next tool boundary.** At the start of every turn after the first, the
loop reads queued steering, marks it applied, and hands it to the model with trigger `steering`. It
used to be read only when a run started. Steering that is queued when the model calls
`attempt_complete` holds the completion: the model gets a system message saying steering arrived and
to act on it before completing again, and that turn does not count toward the no-progress guard.
Steering that arrives after a completion was accepted waits for the next run. A channel `/steer` sent
while the session is busy is now queued with "the running task will read it before its next step"
instead of being refused.

**A direct `tool.execute` approval resumes only that call.** When every approval being resumed belongs
to calls made by `tool.execute` (turn trigger `gateway_request`) and no message came with the resume,
the gateway runs the approved calls and completes the run (`tool_succeeded`, `tool_failed`, or
`tool_awaiting_approval` if more remain) with the session back at `awaiting_user`. No model turn
starts. Approvals of calls the model made still continue the model, as before. The web dashboard now
resumes the session once its last pending approval is resolved, as the CLI and channel `/approve`
already did.

**A provider that answers with another model is reported once per session**: a `log.emitted` warning
with `metadata.code: "model_mismatch"`, `requestedModel` and `answeredModel` (LM Studio serves
whatever model is loaded when the requested one is unknown). Spellings of one model are not reported:
a `:latest` or `:2` suffix, or the id with or without its publisher. The REPL prints it dimmed with the
chat-model provenance.

### The REPL at a terminal

- The prompt comes up as soon as the config files are read, and the state directory checked. MCP
  servers, memory, the model check and the session start behind it. A message typed meanwhile is held
  ("Still starting up…") and sent once the session exists, announced as `· Sending: …`. `/help` and an
  unknown command are answered at once. `/exit`, Ctrl-D and Ctrl-C stop startup and leave, and a
  startup failure (an unreachable model included) prints the error; either way, held lines are
  printed under "Not sent:". The session id is printed on its own line when startup finishes.
- **Piped input keeps the old order.** Nothing is read until startup is done, so a script's lines,
  approval answers included, mean what they always did.
- **While a prompt is up, readline owns the line** (2026-10-02, `src/commands/terminal-input.ts`, when
  stdin and stdout are both terminals). Output nobody typed for (startup finishing, an MCP server
  failing, a Node warning) is written above the prompt, and what the operator is typing is redrawn
  under it, cursor included. A line of any length can be sent, and Up recalls earlier lines. In the
  terminal's own line mode the kernel held the half-typed text where aia could not redraw it: when
  startup finished during a paste, the session line printed after the pasted text and an empty prompt
  followed, so the paste looked sent and ignored. That mode also caps a line at 1,023 bytes on macOS
  (MAX_CANON); past that, Enter did nothing.
- **While a turn runs, the terminal is back in line mode**, as before: typing echoes, a line typed
  ahead is sent at the next prompt, and Ctrl-C is SIGINT. A half-typed line comes back at the next
  prompt. Readline stays out of a turn because it redraws its line on edits and on every resize, which
  would erase streamed output.
- **A question or approval prompt drops what was typed before it appeared**: lines and a half-typed
  line alike, read from the terminal for 50 ms and discarded, so an Enter pressed while the agent
  worked cannot answer it.
- Elsewhere (a test's reader, or a terminal on only one end) line mode is unchanged: output starts on
  its own line, the prompt is put back, and a half-typed line is still sent whole on Enter. Each line
  of a multi-line paste is still its own message.
- **Ctrl-C** during a turn cancels it (as above) and the REPL carries on; a second Ctrl-C while it is
  still cancelling exits, as does Ctrl-C at the prompt (exit code 130). Once exiting, a further Ctrl-C
  ends the process without waiting for cleanup. At an approval or question prompt, Ctrl-C cancels the
  turn and resolves every pending approval with the `cancelled` decision and the note "Cancelled by
  the operator (Ctrl-C)". Unlike a denial, that note is not turned into steering, and nothing is
  resumed. At a prompt, readline gets Ctrl-C as a keystroke (raw mode turns off the terminal's own
  SIGINT); the terminal input hands it to the same handler, and the line being typed is abandoned, as
  the terminal itself would.
- An approval prompt lists every target the policy weighed (the full command line with its argv, each
  path, the tool), from the request's `metadata.evaluatedTargets`, and `a` says what it covers: this
  exact command line, every request for a path, every tool on an MCP server, or every call of a tool.
- A completion summary that only repeats text that already streamed is not printed again (and not
  relayed to a channel twice).
