# Testing Guide

The repo now splits validation into deterministic and opt-in live layers.

## Deterministic Validation

Primary commands:

```bash
npm run typecheck
npm run lint
npm run test:deterministic
```

`npm run validate:penultimate` runs the full deterministic stack plus the live-suite runner in its default opt-in mode.

## Coverage

```bash
npm run test:coverage
```

`vitest.coverage.config.ts` runs the unit (jsdom) and integration (node) suites as
two named projects and aggregates V8 coverage across both. Per the project
decision, **only `src/core/config/**` (plus `*.d.ts`) is excluded** from the
denominator; everything else counts.

Current measured coverage is ~77% lines / ~76% branches / ~83% functions, enforced
by a threshold floor in the coverage config. The floor is set just under the
measured numbers so regressions fail the gate; ratchet it upward as more
deterministic tests land.

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
are no longer the *only* coverage for these areas. The coverage gate is intentionally
separate from `validate:penultimate` so the main gate stays fast; run
`npm run test:coverage` when changing core runtime code.

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
- Codex external-agent flow:
  `AIA_RUN_LIVE_CODEX_TEST=1 npm run test:live:external-agents`
- LM Studio:
  `AIA_RUN_LIVE_LM_STUDIO_TESTS=1 npm run test:live:lm-studio`
  Optional: `AIA_LIVE_LM_STUDIO_BASE_URL`, `AIA_LIVE_LM_STUDIO_MODEL`
- Ollama:
  `AIA_RUN_LIVE_OLLAMA_TESTS=1 npm run test:live:ollama`
  Optional: `AIA_LIVE_OLLAMA_BASE_URL`, `AIA_LIVE_OLLAMA_MODEL`
- Memory embeddings:
  `AIA_RUN_LIVE_MEMORY_TESTS=1 npm run test:live:memory`
  Required: `AIA_LIVE_MEMORY_PROVIDER`, `AIA_LIVE_MEMORY_BASE_URL`
  Optional: `AIA_LIVE_MEMORY_MODEL`
- MCP manager:
  `AIA_RUN_LIVE_MCP_TESTS=1 npm run test:live:mcp`
  Required: `AIA_LIVE_MCP_CONFIG_JSON`
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
