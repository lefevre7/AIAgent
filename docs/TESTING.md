# Testing Guide

The repo now splits validation into deterministic and opt-in live layers.

## Deterministic Validation

Primary commands:

```bash
npm run typecheck
npm run lint
npm run test:deterministic
```

`npm run validate:penultimate` runs the static checks, then each test layer once: unit
and integration together under `test:coverage` (so the coverage floor is enforced on the
same run), then e2e, then the live-suite runner in its default opt-in mode.
`test:deterministic` stays the everyday command; the gate does not also run it, which
used to execute unit and integration twice.

Two integration tests need a local toolchain and skip without it. `browser-service-tsx.test.ts`
drives real Chromium under tsx, the way `npm run dev` runs: vitest compiles without esbuild's
keepNames, so no other test sees what tsx does to functions sent into a page.
`voice-apple-helper-compile.test.ts` needs macOS with `/usr/bin/swiftc`. It compiles the Swift voice
helper with the adapter's flags and runs nothing that reaches the microphone or speech recognition.

## Isolation from your own ~/.aia

Unit and integration test files run with `HOME` (and `USERPROFILE`) set to an empty
temporary directory (`tests/setup/isolated-home.ts`), and the e2e dev server uses
`.aia/e2e/home`. A test that names no `userHomeDirectory` therefore never reads your
config, MCP servers and credentials, trust grants or skills, and never writes into your
state directory. A test that needs a user config writes one into a home of its own and
passes that as `userHomeDirectory`. Only the live suites below use your real HOME.

## Coverage

```bash
npm run test:coverage
```

`vitest.coverage.config.ts` runs the unit (jsdom) and integration (node) suites as
two named projects and aggregates V8 coverage across both. Per the project
decision, **only `src/core/config/**`(plus`\*.d.ts`) is excluded\*\* from the
denominator; everything else counts.

Current measured coverage is **92.2% lines/statements, 82.6% branches, 97.2%
functions**, enforced by a threshold floor in the coverage config (92.1 / 78 /
97). The floor sits just under the measured numbers so regressions fail the
gate; ratchet it upward as more deterministic tests land.

Note the unit project sets `testTimeout: 30_000` to match the integration one.
A few unit tests spawn real macOS helpers (`say`, the native voice helper), and
under V8 coverage instrumentation those exceed vitest's 5s default — which used
to make `npm run test:coverage` fail intermittently while `npm run test:unit`
passed.

**Target: 100% of `src/` (config excepted).** Nothing else is excluded from the
denominator. Code that touches a non-deterministic boundary is covered by faking
that boundary rather than by exclusion:

- **Network adapters** (`src/core/lm/*`, `src/core/memory/embeddings.ts`,
  `src/core/image/comfyui.ts`) — every adapter takes an injectable `fetchImpl`; tests
  pass a fake `fetch` that returns canned `Response`s (see `tests/unit/embeddings.test.ts`).
- **Child-process layers** (`src/core/voice/utils.ts`, external-agent presets) — drive a
  real short-lived `node -e` / mock-CLI process, or inject the command, to exercise the
  spawn/stdout/timeout/error paths deterministically.
- **macOS-native voice** (`src/core/voice/apple-native.ts`, `local-system.ts`) and the
  **Playwright browser driver** (`src/core/browser/service.ts`) — mock `node:child_process`
  / the `playwright` module so the orchestration logic is covered without the native runtime.
- **Server entrypoints & app-router SSR** (`src/server/start.ts`, `src/app/**`) — import the
  module with the network/bootstrap mocked, or render the component with `renderToString`.

Opt-in live suites still exist (see below) to prove the real adapters end-to-end, but they
are no longer the _only_ coverage for these areas. `npm run test:coverage` is **part of
`validate:penultimate`**: it previously sat outside every gate, and the thresholds
silently fell below their own floor without anything failing.

Deterministic coverage now includes:

- unit and integration coverage for the shared runtime, contracts, approvals, memory, MCP, browser, image, channel routing, and SDK surfaces
- example smoke tests for the coding, research/web, and memory/skills/MCP examples
- Playwright e2e for CLI, gateway, and web control-plane flows

Playwright e2e uses `tests/e2e/dev-server.ts`, which starts:

- a fake LM provider server for deterministic completions
- the real local AIAgent server against isolated `.aia/e2e/` state roots

That keeps CLI/web/gateway end-to-end paths realistic without requiring live model credentials.

## Examples

Runnable example scripts:

```bash
npm run example:coding
npm run example:research
npm run example:memory-mcp
```

Set `AIA_KEEP_EXAMPLE_STATE=1` to keep the temporary example workspace on disk after a run.

## Live Suites

All live suites are opt-in. `npm run test:live` is safe to run with no flags; suites skip unless explicitly enabled.

Aggregate:

```bash
npm run test:live
```

Current live commands and flags:

- Browser automation:
  `AIA_RUN_LIVE_BROWSER_TESTS=1 npm run test:live:browser`
- The `aia` CLI against your real config and model (workspace and `.aia` placement from a folder with
  no config and from below one, a scripted REPL, and the REPL at a real terminal):
  `AIA_RUN_LIVE_CLI_TESTS=1 npm run test:live:cli`
  Optional: `AIA_LIVE_CLI_TARGET=dist` or `=src` (default: both). The `dist` run fails fast when
  `dist/cli.js` is older than `src/`, since the linked `aia` would be running old code: run
  `npm run build:node` first. It uses your HOME, so `~/.aia/config.jsonc` must point at a reachable model.
- Command tools (`exec_command` / PTY sessions against real processes):
  `AIA_RUN_LIVE_COMMAND_TESTS=1 npm run test:live:commands`
- Codex external-agent flow:
  `AIA_RUN_LIVE_CODEX_TEST=1 npm run test:live:external-agents`
- Interactive external-agent terminal (real PTY against a real CLI):
  `AIA_LIVE_EXTERNAL_AGENT_INTERACTIVE=1 npm run test:live:external-agents-interactive`
  Optional: `AIA_LIVE_EXTERNAL_AGENT_COMMAND` (default `codex`), `AIA_LIVE_EXTERNAL_AGENT_READY`
  Note: this starts the CLI with its approval-bypass flag — see `docs/EXTERNAL_AGENTS.md`. It reads the
  screen before writing: if the CLI opens on a screen that needs a person (an update offer, a folder-trust
  question), the send is refused and the test fails showing that screen: it never answers a consent
  question for you. Codex asks whether to trust every new folder, so against Codex the test trusts the
  temporary folder it created, for that run only (`-c projects={"<folder>"={trust_level="trusted"}}`,
  which Codex does not save).
- llama.cpp (a running `llama-server`, see `docs/PROVIDERS.md`):
  `AIA_RUN_LIVE_LLAMA_CPP_TESTS=1 npm run test:live:llama-cpp`
  Optional: `AIA_LIVE_LLAMA_CPP_BASE_URL` (default `http://127.0.0.1:8080/v1`), `AIA_LIVE_LLAMA_CPP_MODEL`
  (default: the first model the server lists), `AIA_LIVE_LLAMA_CPP_MAX_OUTPUT_TOKENS` (default 2048). Covers health,
  the loaded context window, a streamed answer, a native tool call through the streamed deltas, and a prompt larger
  than the window being classified as `context_window_exceeded`. Verified 2026-09-30 against Homebrew `llama.cpp`
  0.5.0 serving LM Studio's `gemma-4-E4B-it-Q4_K_M.gguf` with `-c 8192`.
- LM Studio:
  `AIA_RUN_LIVE_LM_STUDIO_TESTS=1 npm run test:live:lm-studio`
  Optional: `AIA_LIVE_LM_STUDIO_BASE_URL`, `AIA_LIVE_LM_STUDIO_MODEL`, `AIA_LIVE_LM_STUDIO_MAX_OUTPUT_TOKENS`
  (default 2048, room for a reasoning model to think and still answer)
- Ollama:
  `AIA_RUN_LIVE_OLLAMA_TESTS=1 npm run test:live:ollama`
  Optional: `AIA_LIVE_OLLAMA_BASE_URL`, `AIA_LIVE_OLLAMA_MODEL`, `AIA_LIVE_OLLAMA_MAX_OUTPUT_TOKENS`
  (default 2048, room for a reasoning model to think and still answer)
- Memory embeddings:
  `AIA_RUN_LIVE_MEMORY_TESTS=1 npm run test:live:memory`
  Required: `AIA_LIVE_MEMORY_PROVIDER`, `AIA_LIVE_MEMORY_BASE_URL`
  Optional: `AIA_LIVE_MEMORY_MODEL`
- MCP manager:
  `AIA_RUN_LIVE_MCP_TESTS=1 npm run test:live:mcp`
  Required: `AIA_LIVE_MCP_CONFIG_JSON`, `{ "servers": { … } }` in the same shape as `mcp.servers` in
  `aia.config.jsonc`. It is parsed like a config file, so the same fields are required (`enabled`,
  `required`, `tags`, `type`, and `command` or `url`) and the rest get their defaults.
  Optional: `AIA_LIVE_MCP_SERVER_NAME`, `AIA_LIVE_MCP_TOOL_NAME`, `AIA_LIVE_MCP_TOOL_ARGS_JSON`
- Voice:
  `AIA_RUN_LIVE_VOICE_TESTS=1 npm run test:live:voice`
  Current local adapters are macOS-oriented.
- Image generation:
  `AIA_RUN_LIVE_IMAGE_TESTS=1 npm run test:live:image`
  Optional: `AIA_LIVE_IMAGE_BASE_URL`, `AIA_LIVE_IMAGE_MODEL`, `AIA_LIVE_IMAGE_PROVIDER_ID`
- WhatsApp session-directory bridge:
  `AIA_RUN_LIVE_WHATSAPP_TESTS=1 npm run test:live:whatsapp`
  Optional: `AIA_WHATSAPP_LIVE_SESSION_DIRECTORY`

Live suites are intended to prove the currently implemented adapters and services, not to replace deterministic CI-safe coverage.
