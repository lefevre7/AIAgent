# Running AIAgent on Small Local Models

Last updated: 2026-06-12

This document explains how the runtime is optimized for ~25-40B-class local models (Gemma 4 26B, Qwen 3.5 35B, Qwen Coder 30B and similar) served through LM Studio or Ollama, what configuration to use, and why these defaults exist.

## Why small models need a different harness posture

Audit findings from 2026-06-12 (this repo, pre-optimization):

- A default gateway session registered **~55+ tools**, each serialized with an 8-field descriptor into the provider `tools` array, and then **duplicated again** as a per-tool catalog inside the system prompt. Native chat templates (for example Qwen's ChatML `<tools>` block) render the tools array into the prompt, so every descriptor landed in the token stream twice.
- The repo's full `AGENTS.md` (~33KB) and memory summaries were injected whole.
- Estimated first-request payload: **~25-35K tokens before the user said a word.** Small models degrade measurably under that instruction load, and their usable context is far below the advertised window.
- Assistant tool calls were never recorded in message history and tool results were flattened into `[TOOL]`-prefixed user-role text, so the model could not see what it had already called — out-of-distribution for natively tool-trained models and a direct cause of repeated calls.
- Runtime nudges (task continuation, `attempt_complete` rejection reasons, mixed-completion warnings) were stored with `visibility: "hidden"`, which the model request filtered out — the model never saw them and burned turns repeating itself.
- Malformed tool calls were silently dropped with no corrective feedback.
- Ollama requests never set `num_ctx`, so Ollama's small default context silently truncated the oversized prompt.
- No temperature/top_p/max-token settings were ever sent; no context budgeting or threshold compaction existed (`trigger: "threshold"` was specced but never wired).

## What the runtime does now

### Lean tool profile (default)

`tools.profile` defaults to `"lean"`: only a ~16-tool core set is advertised to the model (`read_file`, `list_files`, `search_paths`, `grep_files`, `create_file`, `edit_file`, `apply_patch`, `shell_command`, `read_command_output`, `web_fetch`, `web_search`, `think`, `update_plan`, `ask_user_question`, `tool_search`, `attempt_complete`). Everything else (browser, memory, voice, image, notebooks, channels, external agents, MCP tools) stays registered and executable but is **discovered on demand**: when the model calls `tool_search`, matching tools are activated for the session and appear in the tools array from the next turn on (`activatedToolNames` in session metadata).

```jsonc
"tools": {
  "profile": "lean",          // or "full"
  "include": ["view_image"],  // always-visible extras
  "exclude": []                // never advertised to the model
}
```

The payload budget is enforced by `tests/integration/prompt-payload.test.ts` so future tools cannot silently re-bloat the harness.

### No duplicated tool catalog in the system prompt

The system prompt no longer lists tools; it contains a short "Working With Tools" section that defers to the provider tool list and explains `tool_search` activation. Tool descriptions exist in exactly one place: the `tools` array (`renderToolDescription` in `src/core/lm/shared.ts`).

### Native tool-call transcript fidelity

- Assistant tool calls are recorded as `tool_call` message parts (`src/core/contracts/messages.ts`) and serialized natively: OpenAI-compatible `assistant.tool_calls` + `role: "tool"` results with `tool_call_id` (LM Studio), and Ollama `message.tool_calls` (object arguments) + `role: "tool"` results with `tool_call_id`/`tool_name`.
- Tool results that cannot be paired with a recorded assistant tool call (for example pre-upgrade sessions) fall back to the old flattened-text form.
- Tool-result JSON is compact-printed and null/empty envelope fields are dropped.

### Feedback loops that small models need

- Nudges, completion-rejection reasons, and mixed-completion warnings are now `visibility: "compact"` — sent to the model, de-emphasized in UIs.
- Malformed tool calls (non-object entries, missing function names) are reported in `response.metadata.rejectedToolCalls` and surfaced to the model in the continuation nudge with concrete reasons; unparseable JSON arguments keep the raw text on the proposal (`inputText`) so schema-validation errors are actionable on retry.
- Unknown tool names return an error suggesting `tool_search`.

### Turns and the no-progress guard

`runtime.maxTurnsPerRun` defaults to `"unlimited"` (matching codex/Roo-Code-style loops, which bound work by completion discipline rather than turn count; mistral-vibe uses a finite configurable cap; openai-agents-js defaults to 10). A no-progress guard stops the run as `completion_blocked` after `runtime.maxConsecutiveNudges` (default 3) consecutive unproductive turns (no tool calls, or completion attempts that were mixed/rejected). Productive tool execution resets the guard.

### Threshold compaction

When the last model request's real `usage.inputTokens` reaches the threshold, the loop triggers `compactSession({ trigger: "threshold" })`, refreshes the prompt pack (so the new session summary lands in the Durable Memory section), and sets a session watermark — messages before the watermark are no longer replayed to the model. Threshold resolution order:

1. `memory.autoCompactThresholdTokens` (0 disables)
2. `runtime.modelSettings.contextWindowTokens × 0.8`
3. fallback `100_000` tokens

### Model settings and Ollama context

```jsonc
"runtime": {
  "maxTurnsPerRun": "unlimited",
  "maxConsecutiveNudges": 3,
  "modelSettings": {
    "contextWindowTokens": 32768,  // drives compaction, Ollama num_ctx fallback, and context% metric
    "temperature": 0.7,
    "topP": 0.8,
    "maxOutputTokens": 8192,       // default 8192; caps a single generation so a loop can't stream unbounded
    "repetitionPenalty": 1.1,      // default 1.1; sent as repeat_penalty to both adapters
    "presencePenalty": 0.0,        // optional; e.g. 2.0 for Qwen3.5 non-thinking text
    "topK": 20,                    // optional
    "minP": 0.0                    // optional
  },
  "promptBudgets": {
    "instructionDocChars": 12000,  // per AGENTS.md document; truncated with a read_file pointer
    "memorySummaryChars": 4000     // per memory summary block
  }
},
"providers": {
  "lmStudio": {
    "streamIdleTimeoutMs": 60000   // abort a stream only after 60s with no new tokens (not an absolute deadline)
  },
  "ollama": {
    "contextLength": 32768,        // sent as options.num_ctx on every request
    "keepAlive": "10m",            // keeps the model loaded between turns
    "streamIdleTimeoutMs": 60000
  }
}
```

Every `modelSettings` sampling control is threaded through both adapters' request
payloads (LM Studio top-level OpenAI-compatible fields + llama.cpp `repeat_penalty`/
`top_k`/`min_p`; Ollama under `options`). Fields you leave unset are omitted entirely,
so they never override a model preset/Modelfile default. `streamIdleTimeoutMs` governs
streaming aborts by **inactivity**; `timeoutMs` still bounds non-streaming requests. A
generation is also aborted if the same line repeats ≥6× (a decode loop) — see
`docs/AGENT_LOOP.md`.

`modelSettings` are global request defaults (applied by the agent loop when set; provider/server defaults apply otherwise). `providers.ollama.contextLength` falls back to `runtime.modelSettings.contextWindowTokens` when unset. LM Studio's context length is configured in LM Studio itself.

## Suggested starting points per model family

These were verified against vendor/community docs on 2026-06-12; check the
linked sources before changing them if you upgrade model families.

| Model | Suggested sampling | Notes |
| --- | --- | --- |
| Qwen3-Coder-30B-A3B (Instruct) | `temperature 0.7`, `topP 0.8`, `topK 20`, `repetitionPenalty 1.05` | Official Qwen recommendation: `temperature=0.7, top_p=0.8, top_k=20, repetition_penalty=1.05`. All of these are now threaded through `runtime.modelSettings` and sent to both adapters, so you can set them directly instead of relying on the serving-stack preset. Qwen3-Coder emits tool calls as `<function=NAME><parameter=k>v</parameter></function>` XML that LM Studio often leaves in `content` — recovered by the text fallback parser (see `docs/AGENT_LOOP.md`). ([Qwen3-Coder card](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct), [Unsloth guide](https://unsloth.ai/docs/models/tutorials/qwen3-coder-how-to-run-locally), [LM Studio recommended preset](https://lmstudio.ai/wobondar/qwen3-coder-30b-a3b-recommended), [tool-call format bug](https://github.com/lmstudio-ai/lmstudio-bug-tracker/issues/825)) |
| Qwen3.5 35B-A3B (non-thinking, text/code) | `temperature 1.0`, `topP 1.0` (or `0.7`/`0.8` for VL) | Official Qwen guidance: non-thinking text uses `temperature=1.0, top_p=1.0, top_k=20, presence_penalty=2.0`; non-thinking VL uses `temperature=0.7, top_p=0.8, top_k=20, presence_penalty=1.5`. Thinking-mode text uses `temperature=1.0, top_p=0.95, presence_penalty=1.5`; thinking-mode VL/precise-coding uses `temperature=0.6, top_p=0.95`. Avoid greedy decoding — Qwen3.5 reports infinite-loop issues with `temperature=0`. ([Qwen3.5 thinking-mode guide](https://docs.bswen.com/blog/2026-03-24-qwen35-thinking-mode-parameters/), [Qwen3.5 infinite-loop issue](https://github.com/QwenLM/Qwen3.6/issues/145), [vendor parameter reference](https://muxup.com/2025q2/recommended-llm-parameter-quick-reference)) |
| Gemma 3 / Gemma 4 26B | leave unset or `temperature 1.0` | Native tool calling is supported in both LM Studio and Ollama; Gemma emits the call via a `<tool_call>{…JSON…}</tool_call>` block that Ollama parses into `message.tool_calls`. Tool-selection accuracy degrades once the catalog hits 15-22 tools — Gemma 3 starts falling back to JSON-in-markdown that the parser misses ([Ollama tool-calling tracking issue](https://github.com/ollama/ollama/issues/9941), [Function calling with Gemma 3](https://medium.com/google-cloud/function-calling-with-gemma3-using-ollama-120194577fa6)). This is one of the strongest empirical reasons to keep the lean profile small. |

General guidance that holds regardless of family:

- Keep `tools.profile: "lean"`. Tool-selection accuracy falls as the catalog grows. The 15-22-tool degradation cliff observed on Gemma 3 is right at the boundary of our lean profile (~16 tools); adding more tools should go through `tool_search` activation, not the always-visible set.
- Set `contextWindowTokens` to what the server is actually configured for, not the advertised maximum. Effective attention quality degrades well before the advertised limit.
- Keep `AGENTS.md` files small; the runtime truncates each document at `promptBudgets.instructionDocChars` with a `read_file` pointer, but a focused document beats a truncated one.
- On Ollama, always set `contextLength` (or `contextWindowTokens`). The default is 4,096 tokens (some sources say 2,048), and Ollama silently clips any input that exceeds it — you get no error, the model just never sees the truncated tokens. For coding/agentic use, Ollama's own docs recommend ≥64,000. ([Ollama context-length docs](https://docs.ollama.com/context-length), [HN discussion of the silent-truncation default](https://news.ycombinator.com/item?id=42833427))

## File map for this optimization

- `src/core/tools/defaults.ts` — `LEAN_TOOL_PROFILE_INVOCATION_NAMES`, `resolveVisibleToolDefinitions`
- `src/core/agent/loop.ts` — effective-tool resolution + `tool_search` activation, no-progress guard, unlimited turns, threshold compaction + watermark, rejected-call feedback, native assistant `tool_call` parts, model settings threading
- `src/core/lm/shared.ts` — native tool-call serialization (OpenAI-compatible + Ollama), malformed-call reporting, compact JSON rendering
- `src/core/lm/ollama.ts` — `num_ctx` / `keep_alive`
- `src/core/prompts/pack.tsx` — Working With Tools section, instruction/memory budgets
- `src/core/config/schema.ts` — `tools`, `runtime.modelSettings`, `runtime.promptBudgets`, `runtime.maxTurnsPerRun`, `runtime.maxConsecutiveNudges`, `memory.autoCompactThresholdTokens`, `providers.ollama.contextLength`/`keepAlive`
- `tests/integration/prompt-payload.test.ts` — payload budget regression tests
