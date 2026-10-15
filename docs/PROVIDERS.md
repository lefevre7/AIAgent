# Model providers: LM Studio, Ollama, and llama.cpp

Last updated: 2026-09-30

aia ships three local model runners. All three are enabled by default; a turn uses the one named by
`runtime.defaultProvider` (or a session's `activeProvider`), so an enabled runner that is not running costs nothing.

| Provider id | Config key           | Protocol                                        | Default URL                |
| ----------- | -------------------- | ----------------------------------------------- | -------------------------- |
| `lm_studio` | `providers.lmStudio` | OpenAI Chat Completions (+ `/api/v0` for n_ctx) | `http://localhost:1234/v1` |
| `llama_cpp` | `providers.llamaCpp` | OpenAI Chat Completions (+ `/health`, `/props`) | `http://127.0.0.1:8080/v1` |
| `ollama`    | `providers.ollama`   | Ollama `/api/chat`                              | `http://localhost:11434`   |

## Which model a turn asks for

A turn asks the provider for, in order: the session's own model, the provider's `model`
(`providers.<key>.model`), then `runtime.defaultModel` when that provider is the default one.
`resolveConfiguredModelId` in `src/core/lm/providers.ts` is the one definition; the runtime, `aia info`, the
CLI's "Chat model requested" hint, and the context-window lookup all use it.

## llama.cpp (`llama-server`)

### Install and run

```bash
brew install llama.cpp          # llama-server; Metal on Apple Silicon
llama-server -m ~/.lmstudio/models/lmstudio-community/gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q4_K_M.gguf \
  -c 8192 --host 127.0.0.1 --port 8080 --alias gemma-4-e4b
```

- **LM Studio's GGUF files load as they are** (`~/.lmstudio/models/<publisher>/<repo>/<file>.gguf`). MLX models do
  not: llama.cpp reads GGUF only.
- **Pin the port.** 8080 is today's default; upstream has announced a move to 9931.
- `-hf <user>/<repo>[:quant]` downloads from Hugging Face into the standard HF cache instead.

```jsonc
// aia.config.jsonc (or ~/.aia/config.jsonc)
{
  "runtime": { "defaultProvider": "llama_cpp", "defaultModel": "gemma-4-e4b" },
  "providers": {
    "llamaCpp": {
      "baseUrl": "http://127.0.0.1:8080/v1",
      "model": "gemma-4-e4b"
      // "apiKey": { "source": "env", "id": "LLAMA_API_KEY" },   // server started with --api-key
      // "requestExtras": { "chat_template_kwargs": { "enable_thinking": false } },
      // "embeddingsBaseUrl": "http://127.0.0.1:8081/v1",        // a separate --embeddings server
      // "maxRetries": 3
    }
  }
}
```

Environment overrides: `AIA_LLAMA_CPP_BASE_URL`, `AIA_LLAMA_CPP_MODEL`, `AIA_LLAMA_CPP_API_KEY`.

### Single-model and router mode

- **Single model** (`-m`): the server ignores the request's `model` and answers with its own id (the `--alias`, else
  the path). `providers.llamaCpp.model` is optional; set it to the alias so `aia info` and the model-mismatch notice
  name the right thing.
- **Router mode** (no `-m`; `--models-dir`, `--models-preset`, or the HF cache): the request's `model` selects the
  model and auto-loads it, so `providers.llamaCpp.model` is required. An unknown model is a 400 `model 'X' not
found`. `--models-dir` scans only one level of subfolders, so point it at `~/.lmstudio/models/<publisher>`, not
  `~/.lmstudio/models`. `listModels` shows every model the router knows, with non-loaded ones marked, e.g.
  `qwen3-coder (unloaded)`.

### What the adapter does differently from LM Studio

- **Health** comes from `/health`, which needs no API key. While a model loads, llama.cpp answers every endpoint
  with 503 `Loading model`; the adapter reports that as `degraded` (not `unavailable`), so the REPL starts with a
  notice that the first reply waits, and requests wait for the load within their own budgets (see "Retries").
- **The context window** is read from `/v1/models` → `meta.n_ctx`, then `/props` → `n_ctx`. It is the per-slot
  window, and it can be smaller than the model's training context: `-c`, `--parallel`, and `--fit` (which shrinks an
  unset context to fit memory) all decide it, so it is always queried rather than assumed. `/v1/models` is read first
  because in router mode `/props?model=…` would load the model.
- **Prompt caching**: `cache_prompt: true` is sent on every request (the server's default too, and `requestExtras`
  can turn it off). The server reuses the longest common prefix of the previous prompt in the slot, which is what
  keeps a long agent conversation from being re-evaluated from scratch every turn, and is also why anything that
  rewrites the start of the prompt (the system prompt, the tool list) is expensive on a local model.
- **Tool calling** needs a chat template that supports tools. `--jinja` is on by default, and llama.cpp's
  autoparser (since 2026-03) handles most templates, with dedicated handlers for Gemma 4, Qwen3-Coder/Qwen3.5,
  GPT-OSS, DeepSeek V3.2+, Ministral 3 and others. `/props` → `chat_template_caps.supports_tool_calls` says whether
  the loaded template can. Tool calls stream as OpenAI deltas; the shared adapter accumulates them by index.
- **Reasoning** arrives as `reasoning_content` and is shown as reasoning, never as the answer. Turn it off per model
  with `requestExtras: { "chat_template_kwargs": { "enable_thinking": false } }` or `{ "reasoning_effort": "none" }`.
- **Always sends `max_tokens`** (`runtime.modelSettings.maxOutputTokens`, default 8192): llama-server's own default
  is unlimited.

### Embeddings

`/v1/embeddings` needs a server started with `--embeddings` and an embedding model, which is usually not the chat
server. Run a second one and set `providers.llamaCpp.embeddingsBaseUrl`, then `memory.embeddingProvider:
"llama_cpp"` and `memory.embeddingModel`. A router can serve both from one URL.

Embedding requests, for every provider, go through the same HTTP client as model requests (see Shared behavior):
the same retries, the same wait for a server still loading its model (up to the provider's `timeoutMs`), and the
same rule that redirects stay within the server's origin. A retrieval whose query cannot be embedded in that time
falls back to lexical search.

## Shared behavior

The OpenAI-compatible protocol (payload, SSE streaming, tool-call accumulation, response normalization) is one
implementation, `OpenAICompatibleChatAdapter` in `src/core/lm/openai-compatible.ts`; LM Studio and llama.cpp
subclass it and supply only health, model listing, the context-window lookup, and request defaults.

- **Retries.** A model request is retried on 408/429/5xx and network failures up to `providers.<key>.maxRetries`
  times (default 3), with exponential backoff from 200ms (±10% jitter, capped at 8s) that honours `Retry-After`
  (capped at 60s). A stream is retried only before it starts, when nothing has been generated or shown. A 503 keeps
  being retried past `maxRetries` for the request's own budget (`timeoutMs`, or `streamFirstTokenTimeoutMs` for a
  stream), polling at least every 2s: that is a server loading its model. A 4xx is never retried, nor a 501 or 505,
  nor undici's header and body timeouts (the server already worked on the request for minutes). A `Retry-After: 0`
  still waits 200ms. Cancelling the run ends a wait between attempts at once. Node reports every connection failure
  as a bare `fetch failed` with the errno in `cause`; that is what the retry check reads.
- **Redirects stay with the provider.** A redirect is followed by hand, within the base URL's origin only (at most
  10), as for MCP servers: Node's fetch would otherwise send custom headers, and on a 307/308 the whole prompt, to
  wherever a server pointed. Header values are redacted from fetch's own error messages, which quote an invalid
  header's value.
- **Errors inside a stream are reported.** A server that fails mid-generation sends `data: {"error": {…}}` and ends
  the stream without `[DONE]` (llama.cpp does this when a tool call does not parse). The adapter used to skip that
  event, so a failed generation looked like an empty answer and the model was nudged for not responding. It is now a
  `response.error` with the server's message.
- **Context overflow is recovered once.** Every provider's "prompt too long" (llama.cpp's
  `exceed_context_size_error` with both token counts, OpenAI's `context_length_exceeded`, and the plain messages
  other servers send) is classified as `context_window_exceeded` by the adapter (`classifyContextOverflow` in
  `src/core/lm/overflow.ts`; the shared HTTP client classifies nothing, since ComfyUI uses it too), which also adds
  its provider's remedy (`details.remedy`, from the provider table). The structured error survives the model queue.
  The agent loop then folds the history before the current task into the session summary (compaction trigger
  `overflow`), keeping the task's own messages and tool results whole, and retries once under a new request id; if
  it still does not fit, or nothing was left to fold, the run fails naming both sizes and that provider's remedy.
  See `docs/AGENT_LOOP.md`.
- **`requestExtras`** (LM Studio and llama.cpp): extra top-level request fields for server parameters the runtime has
  no setting for. They may override sampling fields but never `model`, `messages`, `tools`, `tool_choice`, `stream`,
  or `stream_options`.
- **Listing models across providers tolerates one that is down**; asking a specific provider still reports its
  failure.

## Where things live

- `src/core/lm/provider-table.ts` — the built-in provider table: ids, config keys, display names, context-window
  remedies.
- `src/core/lm/providers.ts` — `resolveConfiguredModelId`, adapter construction (one factory per provider over
  shared options), headers (`buildProviderHeaders`: an `apiKey` → `Authorization: Bearer`, unless an Authorization
  header is configured). Embedding adapters are built the same way in `src/core/memory/factory.ts`.
- `src/core/lm/openai-compatible.ts` — the shared Chat Completions adapter.
- `src/core/lm/lm-studio.ts`, `src/core/lm/llama-cpp.ts`, `src/core/lm/ollama.ts` — the providers.
- `src/core/lm/http.ts` — retries, `Retry-After`, streamed errors; `src/core/lm/overflow.ts` — overflow
  classification; `src/core/lm/shared.ts` — what both adapter families share (finishing a response, health, URLs).
- `src/core/agent/loop.ts` — `compactForContextOverflow`, `explainContextOverflow`.
- Tests: `tests/unit/lm-llama-cpp.test.ts`, `tests/unit/lm-http-retry.test.ts`, `tests/unit/lm-providers.test.ts`,
  `tests/integration/lm-runtime.test.ts`, `tests/integration/agent-loop.test.ts` ("context window overflow"), and the
  opt-in `tests/live/llama-cpp.live.test.ts` (`npm run test:live:llama-cpp`, see `docs/TESTING.md`).
