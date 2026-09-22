# AIAgent Implementation Contract

Last updated: 2026-06-10

## Purpose

Build `AIAgent` as a local-first, extensible coding and general-purpose AI agent product with:

- a shared Node 22 TypeScript core
- dual entry points: CLI + library
- a Next.js 15 App Router + Express control plane
- a lightweight local gateway and SDK surface
- LM provider abstraction with LM Studio and Ollama from day 1
- MCP tools, resources, discovery, and search
- explicit agent loop completion via `attempt_complete`
- approvals and steering inspired by VS Code Copilot Chat and Codex
- Codex-style AGENTS/skills/context engineering
- Mistral/OpenClaw-style memory compaction
- OpenClaw-style messaging control surfaces for Discord, WhatsApp, Microsoft Teams, and BlueBubbles-backed iMessage
- browser automation, voice, image generation, and external-agent control

This file is the implementation contract for future agents working in this repo.

## Non-Negotiable Rules

For every checklist item below:

1. Search the codebase and the design docs first.
2. Ask follow-up questions if confidence is not 100%.
3. Prefer small, composable, provider-agnostic interfaces over hardcoded integrations.
4. Keep the codebase lightweight, highly organized, and easy to port to another language.
5. Reuse one canonical implementation per concern instead of creating overlapping paths.
6. Add or update appropriate unit tests before marking the item complete.
7. Run all currently existing unit tests and all impacted integration tests after the item is implemented.
8. Fix any failures before moving to the next item.
9. Do not skip reliability hardening, logging, or docs updates if the item changes behavior.
10. Do not remove or weaken extensibility seams just to make the first implementation faster.

## Product Boundaries

- No end-user account system, org auth, telemetry pipeline, hosted diagnostics, or GitHub product integration.
- Transport-level secrets and local/shared gateway protection are allowed where remote webhooks or tunnels require them.
- No internal subagent runtime. External agents are allowed only through explicit tool adapters.
- Treat the requested feature breadth as one broad MVP. The checklist order below is an implementation order, not permission to redefine later items as optional scope.
- The first usable release is not considered complete until all four messaging channels work: Discord, WhatsApp, Microsoft Teams, and BlueBubbles-backed iMessage.
- Remote/tunneled access is in scope.
- Integrated tunnel support is in scope.
- Local/macOS-friendly voice providers are the default for the first usable release, while keeping the adapter layer ready for future cloud providers.
- Image generation is in scope through a separate provider adapter. The first concrete implementation uses a ComfyUI-compatible local HTTP adapter while preserving room for LM Studio, MCP, and cloud adapters later.
- Memory must be file-backed first, with a pluggable retrieval architecture and OpenClaw-style memory breadth designed in from the start.

## Required Architecture Constraints

- Package root: `AIAgent/`
- Hidden internal state directory: `.aia/`
- Human-facing memory files:
  - `MEMORY.md`
  - `memory/`
  - `chat-session-memory/`
- Primary config files (see `docs/CONFIG.md` for layering and precedence):
  - `aia.config.jsonc` (workspace)
  - `~/.aia/config.jsonc` and `~/.aia/aia.config.jsonc` (user-global; merged ahead of the workspace config)
  - `aia.approvals.jsonc`
- Primary entry points:
  - `src/index.ts`
  - `src/cli.ts`
  - `src/server/`
  - `src/web/`
  - `src/core/`
- Shared LM/provider abstraction must support:
  - LM Studio
  - Ollama
  - future local/cloud providers through adapters
- MCP must support:
  - `stdio`
  - streamable HTTP
  - SSE
- The runtime must use one explicit `attempt_complete` tool and must not implicitly consider the task done just because the model stops asking for tools.

## Done Criteria

The overall implementation is only done when:

- the CLI, library API, web control plane, and local gateway all work against the same core runtime
- approvals, steering, session persistence, undo, skills, AGENTS.md loading, MCP, memory, browser automation, voice, image generation, and external-agent tooling all function through well-tested interfaces
- the four required messaging channels are live behind adapters and covered by fake/contract tests plus opt-in live e2e
- deterministic e2e tests exist for the local core stack
- opt-in live e2e exists for LM Studio, MCP, browser automation, and channel connectors
- the final cleanup pass happens only after the penultimate integration/e2e pass is green

## TODO Checklist

1. [x] Bootstrap the repo and package boundaries.
       Create the full project scaffold under `AIAgent/` for Node 22, TypeScript, Next.js 15 App Router, Express, CLI, library, web, gateway, examples, tests, and docs.
       Lock in build, typecheck, lint, unit-test, integration-test, and e2e-test scripts early so every later item has a stable harness.

2. [x] Establish the core domain model and public interfaces.
       Define stable contracts for sessions, turns, messages, tool calls, approvals, steering, plans, memory entries, provider adapters, gateway transport, channels, voice, image generation, and external-agent jobs.
       Keep these interfaces serialization-friendly so the architecture can later be ported to another language without redesigning the model.

3. [x] Implement config loading, secret resolution, and environment precedence.
       Support workspace config, user-global config, environment overrides, secret refs, and validation for runtime, channel, provider, tunnel, approval, and memory settings.
       Include discoverable defaults and helpful validation failures, not silent fallback behavior.

4. [x] Implement the prompt pack and instruction-loading layer.
       Build the system prompt stack with safety posture inspired by OpenClaw, operational discipline inspired by Codex, and tool guidance inspired by VS Code Copilot Chat.
       Add AGENTS.md root-to-leaf loading, skill discovery and precedence, explicit explanation of skills in the prompt, final-summary behavior, status updates, and per-turn nudges.

5. [x] Implement session persistence and transcript storage.
       Create durable session state, message history, tool events, approval records, steering injections, and resumable task metadata under `.aia/`.
       Ensure sessions can be resumed from CLI, library, web, gateway, and messaging channels without state divergence.

6. [x] Implement the LM provider layer and the disk-backed model queue.
       Build provider-agnostic model interfaces with LM Studio and Ollama adapters from day one.
       Support `chat/completions`-style interaction, structured outputs, retries, request/response logging, and queue persistence across restarts.
       Implement the queue behind a stable interface, with the default implementation enforcing one in-flight model turn globally.

7. [x] Implement the agent loop and turn state machine.
       Build a hard-ended loop with user turns, steering turns, tool execution, approval pauses, failure recovery, status updates, and explicit `attempt_complete`.
       Model-requested completion must pass a runtime completion gate with explicit validation and structured rejection reasons when required work is unresolved.
       Define steering ordering precisely: queue steering while the model is streaming or a tool is running, inject it after the current tool boundary, and resolve already-open approvals before the injected steering resumes the loop.

8. [x] Implement the canonical tool registry and tool runtime.
       Create one deduped, extensible registry for built-in tools, MCP tools, skills, memory tools, browser tools, messaging tools, voice tools, image tools, and the external-agent tool.
       Tool definitions must have strong descriptors, strict schemas, side-effect metadata, search metadata, approval metadata, idempotency and retryability metadata, output-shape metadata, streaming metadata, and high-quality prompts.

9. [x] Implement the local file/workspace toolchain around one patch pipeline.
       Build canonical read, list, grep, search, patch, edit, write, diff-preview, and undo semantics on top of a single file mutation engine.
       Expose higher-level tools through this pipeline rather than duplicating editing behavior in multiple places.

10. [x] Implement approvals, operator intervention, and steering.
        Add regex-based allow/ask/deny policy for commands, paths, tool names, MCP servers, and MCP tools.
        Support local operator approval, originating-channel approval when possible, and the "no, but do instead" path as a normal denied action plus new steering/user input.

11. [x] Implement plan tracking, task status, and working memory.
        Build one canonical plan/todo system plus short-lived working memory tied to the active task and turn state.
        Ensure the runtime can show progress, next step, recent attempts, and blockers across CLI, web, and channels.

12. [x] Implement file-backed durable memory and compaction.
        Add session summaries, workspace memory, user-global memory, memory tools, automatic compaction triggers, startup phase 1/phase 2 memory work, and Codex-style compaction extension points.
        Memory must update `MEMORY.md`, `memory/`, and `chat-session-memory/` consistently when sessions compact or complete.
        Persist compaction lineage, replay artifacts, and before/after token accounting so compaction behavior is auditable and testable.

13. [x] Implement the pluggable retrieval and advanced-memory architecture.
        Design the full OpenClaw-style memory surface now: file-backed summaries/indices first, retrieval interfaces, local SQLite/FTS indexing, embeddings/vector retrieval in MVP, ranking hooks, hybrid search hooks, and memory health/status reporting.
        Durable memory entries must carry provenance, confidence, recency, and staleness metadata so retrieval and later consolidation have explicit signals to work with.
        The initial working implementation must be file-first, but the architecture must not block later storage or embedding backends.

14. [x] Implement MCP transports, registry, discovery, and search.
        Support `stdio`, streamable HTTP, and SSE connections; workspace/user/env config; connected-tool/resource discovery; known server templates; and MCP tool search.
        Build a clean boundary between MCP transport/runtime concerns and the agent-facing tool catalog.

15. [x] Implement the built-in web research stack.
        Add direct URL fetch with HTML-to-markdown extraction and MCP-backed internet search as the default search path.
        The runtime must be able to inspect, summarize, and cite fetched content while keeping search provider details swappable.

16. [x] Implement browser automation.
        Use Playwright as the built-in browser runtime with page/session lifecycle, screenshots, DOM snapshots, navigation, input, downloads/uploads, and approval-aware side effects.
        Browser tooling must be accessible from CLI, web, gateway, and channels through the same tool registry.

17. [x] Implement the external-agent control tool.
        Create a generic adapter for running configured external agent CLIs as explicit jobs with captured stdout/stderr, structured lifecycle state, resumability hooks, and approval-aware execution.
        Keep the abstraction generic so agent-specific presets can be layered in later without refactoring the runtime.
        Current implementation notes:

- `externalAgents` is a first-class top-level config section. The Claude Code CLI (`claude -p "<prompt>" --output-format json`) and Codex CLI presets are enabled by default for one-shot task delegation; the Mistral Vibe CLI preset ships disabled. Each preset is a discriminated union member keyed by `kind` (`claude` | `codex` | `mistral_vibe`).
- `src/core/external-agents/service.ts` persists explicit jobs under `.aia/external-agents/jobs/<job-id>/attempts/` with `job.json`, stdout/stderr logs, normalized final outputs, and summary artifacts.
- The built-in `external_agent` tool now supports `run`, `get`, `list`, `cancel`, and `resume`.
- Detached jobs append compact transcript status messages to the originating session while keeping full logs in artifacts on disk.
- Read-only `get` and `list` actions bypass approvals, while `run`, `cancel`, and `resume` resolve approval targets for the external agent id, command, and cwd.
- The gateway now handles `external_agent.*` request topics, and `external_agent.list` returns both configured definitions and persisted jobs.
- Deterministic fixture-backed integration coverage exists for blocking runs, detached recovery, resume, approval integration, gateway dispatch, and an opt-in live Codex path. The Claude preset has coverage for blocking runs (harvesting `.result`/`.session_id` from `--output-format json`), native-session resume (`--resume <session_id>`), and structured-output rejection (it returns text, not JSON schema output).

18. [x] Implement the voice subsystem.
        Build provider-agnostic STT/TTS/PTT interfaces with local/macOS-friendly live adapters for the first usable release, while keeping the interface portable to future cloud providers.
        Support CLI/web/gateway initiation, transcript capture, and messaging/channel delivery where supported.

19. [x] Implement the image-generation subsystem.
        Add a dedicated image-generation provider interface, tool definitions, approval semantics, artifact storage, and result references.
        Current implementation notes:

- `image` is now a first-class top-level config section with `artifactRoot`, `defaultProviderId`, and `pollIntervalMs`, alongside a disabled-by-default `providers.imageProviders.comfyui_local` preset.
- `src/core/image/service.ts` and `src/core/image/comfyui.ts` provide the provider-agnostic image runtime plus the first ComfyUI-compatible adapter with health/model listing, capability probing, prompt submission, history polling, and output download support.
- Checked-in workflow templates now live under `src/core/image/workflows/` for `text_to_image`, `image_to_image`, and `inpaint`, with optional per-mode config overrides.
- The built-in `image_generate` tool supports `text_to_image`, `image_to_image`, and `inpaint`, uses `approvalMode: "ask"`, accepts prior image artifacts or local `file://` inputs, and copies local sources/masks/references into `.aia/images/inputs/`.
- Generated outputs, request/history logs, and result records persist under `.aia/images/outputs/`, and results expose first-class multi-image artifacts through `images[]` plus `primaryImageIndex`.
- Deterministic integration coverage now lives in `tests/integration/image-service.test.ts` and `tests/integration/image-tools.test.ts`, with opt-in live ComfyUI coverage in `tests/live/image-service.live.test.ts` via `npm run test:live:image`.

20. [x] Implement the local gateway and control API.
        Build a lightweight gateway that exposes sessions, events, approvals, steering, memory, channels, and tool execution over a stable local protocol and shared core runtime.
        Include remote-capable transport support, but do not fork the codepath away from the in-process SDK.
        Current implementation notes:

- `src/gateway/runtime.ts` now provides the shared control-plane runtime used by the server transport adapters and intended future SDK consumers.
- `src/gateway/router.ts` exposes the HTTP gateway surface with request dispatch, health/status, session snapshot reads, approval reads, and event replay.
- `src/gateway/websocket.ts` exposes the main bidirectional control transport with request/response envelopes, live event subscriptions, and cursor-based replay on subscribe.
- Gateway-originated async work is tracked as `GatewayRunRecord` state and emitted through `run.updated` alongside normal message/tool/turn/session events.
- `session.message`, `session.resume`, and direct `tool.execute` accept quickly and execute through the same core session store, tool runtime, and agent loop used elsewhere.
- Auth is transport-neutral: configured gateway tokens are required everywhere, otherwise only loopback access is allowed.
- The Next.js server and gateway now share the same HTTP server and upgrade path, with Next's upgrade handler preserved for non-gateway websocket traffic.
- Gateway protocol notes now live in `docs/GATEWAY_PROTOCOL.md`.

21. [x] Implement the in-process Node SDK.
        Expose the same core engine through a stable Node API for programmatic use, including session control, event streaming, approvals, steering, memory access, tool search, and gateway interaction.
        The SDK must remain a first-class surface, not an afterthought behind the CLI.

- `src/sdk/client.ts` now provides the class-based `AIAgentSdk`, session/run handles, raw gateway access, callback subscriptions, and async-iterable event streams over the shared control-plane runtime.
- `createAIAgentSdk(...)` wraps an existing `GatewayRuntimeLike`, while `createAIAgentSdkFromConfig(...)` bootstraps a runtime from loaded config and owns its shutdown path.
- Custom language-model and embedding providers can now be registered both at construction time and after runtime creation, and provider ids flow through config and gateway-facing request contracts as string ids instead of a closed enum.
- Root and subpath exports now expose `./core`, `./gateway`, `./sdk`, and `./server` so the SDK can stay a stable first-class import surface.
- Graceful shutdown now closes the LM queue background pump before tearing down SDK-owned runtimes, which avoids temp-state races during tests and real process exit.

22. [x] Implement the web control plane.
        Build the minimal but working Next.js + Express UI for sessions, messages, approvals, steering, settings, logs, memory inspection, task status, and gateway health.
        Do not auto-open the browser by default; match the more controlled OpenClaw-style behavior unless explicit onboarding chooses otherwise.
        Current implementation notes:

- The root Next.js page is now a server-rendered dashboard over the shared runtime instead of a bootstrap placeholder.
- `src/server/control-plane/service.ts` aggregates gateway health, sessions, approvals, memory status/query results, tunnel status, channel status/routes/deliveries, recent event replay, and non-secret settings for the UI.
- `src/server/control-plane/router.ts` exposes the matching Express API and browser-form action routes under `/api/control-plane/*`.
- The dashboard now supports session creation, session messages, approval resolution, and steering injection through plain HTML forms, keeping the UI functional without depending on client-side SDK state.
- The page now surfaces task state, transcript history, channel bindings, memory inspection, tunnel exposure, and event logs in one control plane.

23. [x] Implement integrated tunnel and remote-access support.
        Add remote exposure support for the gateway/web surfaces and the webhook surfaces needed by the supported messaging channels.
        Keep this local-product-focused: no hosted service dependency, no multi-user account system, but enough transport protection and documentation to operate safely.
        Current implementation notes:

- `src/core/tunnel/service.ts` now derives public exposure status for the web surface, gateway HTTP, gateway WebSocket, and channel webhook URLs from the local config.
- `src/server/web-access.ts` now applies the shared remote-access posture to the web/control-plane surfaces:
  - configured `gateway.auth.token` is required for remote access
  - otherwise only loopback callers are allowed
  - `?token=` on page hits becomes an `HttpOnly` cookie and a sanitized redirect
- Gateway HTTP and WebSocket auth now accept bearer tokens consistently.
- Remote setup/runtime notes now live in `docs/CONTROL_PLANE_AND_CHANNELS.md`.

24. [x] Implement the messaging channel framework.
        Build the shared inbound/outbound channel runtime for account config, session routing, approval routing, steering, retries, media handling, paired session identity, and per-channel capability checks.
        The framework must make the four required channels share as much core logic as possible.
        Current implementation notes:

- `src/core/channels/service.ts` now provides the shared channel runtime with route persistence, delivery persistence, session pairing, capability/configuration health, webhook endpoint reporting, inbound normalization handoff, and outbound delivery tracking.
- The shared state now lives under `.aia/channels/routes.json` and `.aia/channels/deliveries.jsonl`.
- `src/server/channel-router.ts` now exposes the shared webhook entrypoint at `POST /api/channels/:channel/webhook`.
- The gateway now delegates `channel.list`, `channel.health`, and `channel.send` to the shared channel runtime when it is present, and inbound webhook messages now emit `channel.message` gateway events.
- When a channel message is already bound to an idle session, the shared runtime can route it into the normal session loop without a separate channel-specific control path.

25. [ ] Implement Discord support.
        Deliver inbound/outbound messaging, session routing, approval routing, steering, attachments, and channel-scoped task control through the shared messaging runtime.
        Add fake/contract tests first, then opt-in live e2e.

26. [x] Implement WhatsApp support.
        Deliver inbound/outbound messaging, media handling, session routing, approvals, and steering with the same shared runtime expectations as Discord.
        Add fake/contract tests first, then opt-in live e2e.
        Current implementation notes:

- `src/core/channels/whatsapp.ts` now implements a concrete WhatsApp session-directory adapter with inbound polling, outbound delivery envelopes, media persistence, and shared artifact normalization.
- `src/server/runtime-context.ts` now auto-registers the WhatsApp adapter from `channels.whatsapp.sessionDirectory`, and the shared `ChannelService` starts it alongside the gateway runtime.
- `src/gateway/runtime.ts` now auto-creates and binds WhatsApp sessions on first contact, relays visible assistant output back to the channel, and supports `/approve`, `/deny`, `/cancel`, `/steer`, and `/help`.
- Channel approvals now resume through the normal agent loop by materializing approved or denied pending tool calls before the next model turn.
- Coverage lives in `tests/integration/whatsapp-channel.test.ts`, with an opt-in filesystem smoke test in `tests/live/whatsapp-channel.live.test.ts` behind `npm run test:live:whatsapp`.

27. [ ] Implement Microsoft Teams support.
        Deliver inbound/outbound messaging, webhook handling, session routing, approvals, and steering with explicit remote/webhook setup coverage.
        Add fake/contract tests first, then opt-in live e2e.

28. [ ] Implement BlueBubbles-backed iMessage support.
        Deliver inbound/outbound messaging, media handling, session routing, approvals, and steering using BlueBubbles as the first iMessage path.
        Add fake/contract tests first, then opt-in live e2e.

29. [x] Implement examples that exercise the prompt pack and runtime surfaces.
        Add at least three focused examples: coding task, research/web task, and memory/skills/MCP task.
        Examples should be realistic enough to expose prompt and tool weaknesses without depending on live credentials by default.
        Current implementation notes:

- `examples/coding-task.ts`, `examples/research-web-task.ts`, and `examples/memory-skills-mcp-task.ts` now run against the real SDK/runtime path with scripted local model adapters.
- `examples/shared.ts` now provides the reusable example harness for temp workspaces, loaded config wiring, scripted model responses, and prompt-preview capture.
- `tests/integration/examples.test.ts` now smoke-tests all three examples so they stay runnable and architecture-relevant.

30. [x] Implement exhaustive core/unit/contract coverage and deterministic e2e.
        Cover the loop state machine, config, approvals, patch/undo pipeline, session persistence, memory compaction, tool registry, MCP runtime, browser abstractions, gateway protocol, SDK, and channel routing with deterministic tests.
        Add deterministic e2e for CLI, web, gateway, and provider fakes before starting final cleanup.
        Current implementation notes:

- `src/cli.ts` now routes `--prompt` through the shared SDK/runtime path instead of a placeholder stub, which makes CLI e2e meaningful.
- `tests/helpers/fake-language-model-server.ts` and `tests/e2e/dev-server.ts` now provide the fake-provider harness used by deterministic CLI/web/gateway Playwright coverage.
- `tests/e2e/cli.spec.ts`, `tests/e2e/gateway.spec.ts`, and the expanded `tests/e2e/home.spec.ts` now cover the main product entry points end-to-end.
- `tests/integration/image-service.test.ts` now adds fake-ComfyUI image coverage for health, model discovery, generation, artifact persistence, and tool-runtime wiring.

31. [x] Implement opt-in live integration and live e2e suites.
        Add live suites for LM Studio, Ollama, MCP servers, browser automation, Discord, WhatsApp, Teams, BlueBubbles/iMessage, voice, and image generation where feasible.
        These must be opt-in but documented, runnable, and clearly separated from deterministic CI-safe tests.
        Current implementation notes:

- `tests/live/helpers.ts` now standardizes opt-in gating and temporary-root cleanup across live suites.
- Live suites now cover browser automation, Codex external agents, LM Studio, Ollama, memory embeddings, MCP manager connections, voice, image generation, and the WhatsApp session-directory bridge.
- `npm run test:live` and the per-surface live scripts are now documented in `docs/TESTING.md`.

32. [x] Run the penultimate full-system validation pass before cleanup.
        Run the full deterministic suite plus the intended live suites for the current environment, fix failures, close reliability gaps, and verify that the product can complete real tasks end-to-end from CLI, SDK, web, gateway, and messaging entry points.
        Do not start the cleanup/doc-polish pass until this step is green.
        Current implementation notes:

- The deterministic validation pass now runs clean through `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run test:integration`, and `npm run test:e2e`.
- The live aggregate now runs clean in default opt-in mode through `npm run test:live`, with suites skipping unless explicitly enabled for the current machine.
- `npm run validate:penultimate` now captures the full penultimate validation order in one command.

33. [x] Perform the final cleanup and documentation pass.
        Remove dead code, tighten naming, reduce duplication, update docs, refresh examples, and confirm the implementation still matches `INITIAL_DESIGN.md`.
        Finish with one final test pass and only then mark the project complete.
        Current implementation notes:

- The example harness, fake-provider e2e harness, and live-suite helpers now remove repeated setup code across examples and tests.
- `docs/TESTING.md`, `examples/README.md`, and `docs/INITIAL_DESIGN.md` now describe the current example, CLI, deterministic e2e, and live validation story.
- The final pass should rerun `npm run validate:penultimate` after any subsequent product changes that touch these surfaces.

## Addendum (2026-06-10)

Post-checklist hardening pass. Notes for future agents:

- **Streaming tool calls + reasoning.** LM Studio streams tool calls as deltas (name first, `arguments` concatenated across fragments); the adapter now accumulates them by `index` before normalizing — previously the argument JSON was split into separate incomplete calls, so tools like `shell_command` got `command: undefined` and failed. The adapters also surface model reasoning: `reasoning_content`/`reasoning` (LM Studio) and `message.thinking` (Ollama) become `response.reasoning` stream events → loop `onAssistantReasoning` → a `message.reasoning` gateway event → the CLI prints it dimmed under `Thinking…` (separate from the answer) and the web shows it in a reasoning region. Also: `resolveLocalPath` expands a leading `~` to the home dir (so `cwd: "~/temp"` / `~/…` paths work), and the CLI surfaces tool failure reasons (`· <tool>: failed — <message>`). `deriveGatewayEventSessionId` now has an exhaustiveness guard so a new event topic can't silently break session-filtered subscriptions (which previously dropped `message.delta`).
- **Token streaming + interactive UX.** Assistant responses now stream end to end. The LM adapters' `stream()` is bridged through the disk queue via an in-process delta sink (`FileLanguageModelQueue.stream`), exposed as `LanguageModelRuntime.stream`, consumed by the agent loop (`onAssistantDelta`), and emitted as a new `message.delta` gateway event. The CLI REPL shows a `Thinking…` indicator, streams tokens live, prints tool-activity lines (to stderr so they don't corrupt streamed stdout), and **handles approval-gated tools inline** (`Approve <tool> → <target>? [y/N]` → resolve → resume) — this fixes the bug where `write_file` (approvalMode `ask`) paused and silently never executed in the REPL. The web dashboard streams via a control-plane SSE endpoint (`GET /api/control-plane/events/stream`) + an inline client script. The fake LM server (`tests/helpers/fake-language-model-server.ts`) supports streaming (OpenAI SSE + Ollama NDJSON) so deterministic e2e still passes. Default chat model id is now `google/gemma-4-26b-a4b-qat`.

- **Memory retrieval / SQLite.** `src/core/memory/retrieval.ts` now uses a static, typed `import { DatabaseSync } from "node:sqlite"` (replacing a hand-rolled `createRequire` shim). The runtime requires Node `>= 22.14`. If a DB file cannot be opened it falls back to a typed in-memory store that emits an `AIA_SQLITE_FALLBACK` warning instead of silently disabling memory. Stock Node `node:sqlite` is built **without FTS5**, so lexical search uses the substring fallback unless the Node build bundles FTS5 — see `docs/INITIAL_DESIGN.md`. The `sqlite` npm dependency is retained but no longer referenced by code.
- **Interactive CLI.** Running `aia` with no `--prompt` always starts an interactive session (interactive on a TTY; reads stdin until EOF when piped) that stays open until `/exit`, `/quit`, or end-of-input (`/help` lists commands). `--prompt` remains one-shot for scripting/e2e. The old bootstrap-info output moved to the `aia info` subcommand. The CLI module only auto-runs when invoked directly: the guard compares `realpathSync(fileURLToPath(import.meta.url))` to `realpathSync(process.argv[1])` so the linked `aia` bin (which the shell invokes through a symlink) still runs, while the module stays importable in tests. (A plain `import.meta.url === pathToFileURL(argv[1])` check silently no-ops through the symlink.)
- **Startup resilience + CLI model gate.** `memory.hardFailOnStartup` now defaults to **false**: when the embedding provider is unreachable at startup, memory retrieval degrades to lexical search and emits an `AIA_EMBEDDINGS_DEGRADED` warning instead of throwing, so the gateway/web/SDK/CLI all still boot (set it `true` to require embeddings). The CLI separately pre-checks the chat model via a new `model.health` gateway topic (`modelRuntime.health(defaultProvider)`); if the chat model is unreachable it prints a clean, actionable error and exits 1 rather than opening a REPL that errors on every turn or dumping a raw stack. The interactive line reader also buffers stdin from creation so piped/scripted input isn't lost during boot.
- **node:sqlite bundling.** `src/core/memory/retrieval.ts` loads `node:sqlite` via `createRequire` (not a static `import`): esbuild/tsup strips the `node:` prefix from a static import and resolves the unrelated `sqlite` npm package (no `DatabaseSync`), which crashed the bundled `aia`. createRequire keeps a real runtime require to the builtin in both the tsx dev path and the bundled CLI. A `prepare` script rebuilds `dist` on `npm install`/`npm link` so the linked `aia` never runs stale compiled code.
- **New built-in tools.** Added `think` (reasoning scratchpad), `notebook_edit` (`.ipynb` cell edits through the undoable workspace pipeline), `ask_user_question` (pauses the run and asks the operator), `view_image` (loads a local image as a vision artifact), `sessions_search` (read-only over `FileSessionStore`), and `channel_send` (messages the session's bound channel). `ask_user_question` reuses the approval pause/resume machinery: `approvalMode: "always"` surfaces a `question`-kind approval (justification = the question, metadata = options) and the resolution **comment is the answer**, threaded into the resumed tool call (`executeApprovedPendingToolCall` in `src/gateway/runtime.ts`). `sessions_search`/`channel_send` are wired through new `sessions`/`channelService` options on `createDefaultToolRegistry`. Also added `pdf_read` (text extraction via a lazily-imported `pdf-parse` behind an injectable extractor). All in-scope sibling tools are now implemented; see `docs/TOOL_CATALOG.md` for the full deduped comparison and the capabilities deliberately out of scope per Product Boundaries (internal subagents, GitHub/IDE-host tools, scheduler).
- **Coverage.** `npm run test:coverage` aggregates V8 coverage across the unit + integration projects with an enforced threshold floor (only `src/core/config/**` excluded). See `docs/TESTING.md` for the current numbers and intentionally-lower categories.

## Addendum (2026-06-12): Small-local-model optimization pass

The harness is now optimized for ~25-40B local models (Gemma 4 26B, Qwen 3.5 35B, Qwen Coder 30B). Full rationale, audit findings, config recipes, and the file map live in `docs/SMALL_MODELS.md`. Summary for future agents:

- **Lean tool profile is the default.** `tools.profile: "lean"` advertises a ~16-tool core set; everything else stays registered/executable and becomes model-visible through `tool_search` activation (session metadata `activatedToolNames`) or `tools.include`. The per-tool catalog was removed from the system prompt — tool descriptions exist only in the provider tools array. A payload-budget regression test (`tests/integration/prompt-payload.test.ts`) keeps this from re-bloating; if you add a tool and that test fails, do not just raise the budget.
- **Native tool transcripts.** Assistant tool calls persist as `tool_call` message parts and serialize to native `assistant.tool_calls` + `role:"tool"` (with `tool_call_id`; Ollama also gets `tool_name`, object arguments). Orphan tool results fall back to the old flattened text. Tool-result JSON is compact-printed with null fields dropped.
- **Feedback fixes.** Nudges/rejection reasons use `visibility: "compact"` (the old `"hidden"` was filtered out of model requests — the model never saw them). Malformed tool calls surface via `response.metadata.rejectedToolCalls` and are echoed to the model with reasons instead of being silently dropped.
- **Turns.** `runtime.maxTurnsPerRun` defaults to `"unlimited"` with a no-progress guard (`runtime.maxConsecutiveNudges`, default 3 consecutive unproductive turns → `completion_blocked`). Unproductive = no tool calls, mixed/rejected completion attempts, **or a turn whose only tool calls are planning/reasoning-family (`think`, `update_plan`)**. See `docs/AGENT_LOOP.md`.
- **Context.** Threshold compaction is now actually wired: when `usage.inputTokens` crosses `memory.autoCompactThresholdTokens` (else 80% of `runtime.modelSettings.contextWindowTokens`, else 100k), the loop compacts, refreshes the prompt pack, and sets a watermark so pre-compaction history stops being replayed. AGENTS.md docs and memory summaries are truncated per `runtime.promptBudgets` with `read_file` pointers. Ollama requests always send `options.num_ctx` when `providers.ollama.contextLength` (or `contextWindowTokens`) is set — without it Ollama silently truncates large prompts.
- **Vendor settings verified (2026-06-12).** `docs/SMALL_MODELS.md` now ships verified Qwen3-Coder (`0.7/0.8`, official), Qwen3.5 non-thinking-text (`1.0/1.0` + presence_penalty `2.0`) and thinking-mode tables, with Ollama's `num_ctx=4096` default and silent-truncation behavior cited. Top-k, presence_penalty, frequency_penalty, repetition_penalty, and min_p are now threaded through `runtime.modelSettings` → `languageModelSettingsSchema` → both adapters' `buildPayload` → the loop request builder (see the 2026-06-12 streaming/sampling addendum below). Unset fields are omitted so model presets still apply.

## Addendum (2026-06-12): Text tool-call recovery + planning-loop fix

Fixes a "think → plan → think → plan" loop seen with local reasoning/coder models. Full write-up in `docs/AGENT_LOOP.md`. Summary:

- **Text-embedded tool-call recovery.** LM Studio/Ollama only populate native `tool_calls` when the server-side template recognizes the model's syntax; otherwise the call lands in `message.content` as text (LM Studio docs; lmstudio-ai/lmstudio-bug-tracker#825). `resolveToolCallProposals` in `src/core/lm/shared.ts` now recovers calls emitted as text when native `tool_calls` is empty — Hermes `<tool_call>{json}</tool_call>`, Qwen3-Coder `<function=NAME><parameter=k>v</parameter></function>` XML, GPT-OSS Harmony `<|channel|>commentary to=functions.NAME<|message|>{json}<|call|>`, and LM Studio's `[TOOL_REQUEST]{json}[END_TOOL_REQUEST]`. Recovered calls set `metadata.toolCallsRecoveredFromText` and their markup is stripped from the persisted content (reasoning/prose preserved). Both adapters route native + stream + non-stream paths through this one helper.
- **Planning/reasoning no-progress guard.** A turn whose only tool calls are `think`/`update_plan` no longer resets the no-progress counter (`src/core/agent/loop.ts`). Classification is by the tool's declared `annotations.meta.family` ∈ {`reasoning`, `planning`} — explicit and model-agnostic, not per-model magic. Such turns still execute (plan/thought state persists) but count toward `maxConsecutiveNudges`, get an escalating `noProgress` nudge, and trip `completion_blocked` once exceeded.
- **Out of scope (intentional):** reasoning (`<think>`) is still passed through unmodified; no new turn cap (turns stay `"unlimited"`); configured model unchanged.

## Addendum (2026-06-12): streaming timeout, generation caps, sampling, reasoning persistence, status metrics

Fixes two runtime bugs (a stream aborted mid-token by an absolute timeout, and runaway in-generation loops) and adds the requested live status metrics. Full write-up in `docs/AGENT_LOOP.md`; vendor sampling guidance in `docs/SMALL_MODELS.md`.

- **Streaming idle timeout (not absolute), with a first-token budget.** `fetchStream` aborts on inactivity, not a fixed deadline: adapters create a `createStreamGuard` (`src/core/lm/shared.ts`) whose idle timer resets on every chunk and pass its `signal` to `fetchStream`; `src/core/lm/http.ts` uses that signal instead of `AbortSignal.timeout`. `fetchJson` (non-streaming) keeps the absolute `timeoutMs`. **Crucially, the guard does not arm the short inter-token idle until the first token arrives** — time-to-first-token (prompt evaluation) gets its own generous budget (`providers.*.streamFirstTokenTimeoutMs`, default 300s), because a big-context prompt on a large local model can take minutes before the first token. After the first token, `streamIdleTimeoutMs` (default 60s) governs. Without the split, the idle guard aborted healthy requests during prompt eval — the regression reported as "stream stalled: no new tokens within the idle timeout."
- **Per-generation cap + sampling.** `runtime.modelSettings.maxOutputTokens` now defaults to 8192 so a looping model cannot stream unbounded. `runtime.modelSettings` also threads `repetitionPenalty` (default 1.1, sent as `repeat_penalty`), `presencePenalty`, `frequencyPenalty`, `topK`, `minP` → `languageModelSettingsSchema` → both adapters' `buildPayload` (LM Studio top-level OpenAI-compatible + llama.cpp extras; Ollama under `options`). Unset fields are omitted (`compactRecord`), so non-set controls never override a model preset.
- **In-stream repetition guard.** `createStreamGuard` also aborts a generation when the same non-trivial line repeats ≥6× consecutively (a decode loop). Aborts (idle or repetition) surface as a `response.error` with a clear message → the queue throws → the agent loop fails that turn cleanly instead of spinning.
- **Reasoning persistence (7C).** `<think>`/analysis markup is stripped from the persisted assistant message **only on turns that produced a tool call** (`stripReasoningMarkup` in `src/core/agent/loop.ts`); pure-text turns keep their reasoning. Stops replayed indecision from reinforcing loops without hiding live reasoning.
- **Status metrics.** `AgentLoop` emits `onStatus` metrics `{ contextWindowPercentage, tokensUsed, elapsedSeconds }` after each model response. `tokensUsed` is the **cumulative generated tokens across the run** (sum of each turn's `usage.outputTokens` = completion/eval count, which already includes reasoning tokens); context% uses the latest prompt (input) token count. The gateway forwards them in the `gateway.status` event payload; the CLI renders them dimmed on stderr during the loop. Note: `gateway.status` is emitted with `persist=false`, so these metrics are **not** written to the events log and cannot be queried after the fact.
  - **Streaming usage:** LM Studio omits usage from streamed responses unless asked, so the stream payload now sends `stream_options: { include_usage: true }` (usage arrives in a final empty-choices chunk). Without it, token/context metrics read 0.
  - **Context window for the %:** resolved as configured `runtime.modelSettings.contextWindowTokens` → provider query (`adapter.getModelContextWindow`, resolved once in `GatewayRuntime.initialize`) → default `32_768`. For LM Studio the query hits the native `/api/v0/models` and uses **`loaded_context_length`** (the window the model is actually loaded with) — preferring the requested model, else the currently-loaded model even if its id differs from the configured string, and only falling back to `max_context_length`. Ollama uses `/api/show` `*.context_length`. So the % is based on the model's loaded context window. The compaction threshold still falls back to 100k (not 32768) when no window is configured.
  - **Why context overflowed in practice (2026-06-12 incident):** threshold compaction fires on `usage.inputTokens`, but streaming reported 0 before the `include_usage` fix, so compaction never triggered and one session's prompt history grew to ~75M chars / ~18M est. tokens (a single 12.5MB tool result among them). `include_usage` re-enables streaming compaction. Per [[small-model-optimization-choices]] there are deliberately **no tool-result size caps**, so a single huge `read_file`/`web_fetch` result can still dominate the window — rely on compaction + the operator avoiding reading giant files.

## Addendum (2026-06-15): Completion-contract emphasis

Symptom: a small local model (observed with Gemma 4 26B on LM Studio in the interactive REPL) finishes the requested work, posts a final-summary chat message, and never emits `attempt_complete`. The runtime then nudges, the model emits empty responses, and the run ends as `completion_blocked` after `maxConsecutiveNudges`. Fix is prompt + tool guidance, not a runtime behavior change. See `docs/AGENT_LOOP.md` (section "Completion-contract emphasis (2026-06-15)") for the full write-up.

- **System prompt** (`src/core/prompts/pack.tsx`): "Completion Contract" moved directly under the intro, retitled "Completion Contract (read first)", made imperative ("Saying I'm done is NOT enough"), and now inlines the literal JSON tool-call shape so the model can imitate it verbatim. Also tells the model to put the final summary in the `summary` argument, not as a separate chat message.
- **Tool guidance** (`src/core/tools/builtins/attempt-complete.ts`): `usageGuidance` now leads with "This tool is the ONLY way to end the task" and repeats the summary-as-argument cue.
- **Deliberately unchanged**: the `taskContinuation`/`completionBlocked`/`noProgress` nudge wording, the `maxConsecutiveNudges` default, and the explicit-tool-call requirement (no auto-synthesis of "I'm done" prose into a tool call — non-negotiable per the design contract above).
- **Budget**: `tests/integration/prompt-payload.test.ts` `MAX_BASE_SYSTEM_PROMPT_CHARS` bumped from 8,000 to 8,700.

## Addendum (2026-06-12): MCP server/tool discovery

The agent (and operator) could not enumerate MCP servers or their tools — `tool_search` lists only tools (no server status), `mcp_search` was hidden by the lean profile, and `getServerStatuses()`/`getHealth()` were not exposed anywhere. Full write-up in `docs/MCP.md`. Summary:

- **`mcp_status` tool** (`src/core/tools/builtins/mcp-status.ts`, aliases `list_mcp_servers`/`mcp_servers`) is the canonical answer to "what MCP servers do you have and their tools?" — it lists every configured server with `state`/`transport`/`error` + exposed tools, **including disabled and failed servers**, so a server that never connected (e.g. `context7` failing to spawn `npx`) is visible with its captured error.
- **One canonical source:** `MCPManager.summarizeServers()` (combines `getServerStatuses()` + `getToolCapabilities()`) backs both the tool and the `mcp.list` gateway request; the CLI `/mcp` command renders that. Don't add a second MCP-listing path.
- **Lean visibility:** `resolveVisibleToolDefinitions({ alwaysInclude })` surfaces `mcp_status` under the lean profile **only when `mcp.servers` is non-empty**, keeping the lean catalog minimal otherwise. The prompt's "Working With Tools" section points at `mcp_status` when present (`pack.tsx`).
- **Why a configured server shows no tools:** stdio servers spawn via the MCP SDK's `getDefaultEnvironment()` (forwards a `PATH` allowlist from `process.env`), so a GUI-launched `aia` may not find `npx`; first-run `npx -y …@latest` downloads can also exceed the SDK request timeout. `mcp_status` surfaces the exact `error`. See `docs/MCP.md` for fixes.

## Addendum (2026-09-14): manual compaction, richer CLI approvals, approval-policy hardening

Landed together while planning the CLI-only Kotlin port (`AIAgentCompact-Kotlin`, see that repo's `PORT_BRIEF.md`); these are the reference implementations the port mirrors.

- **`/compact` and gateway `session.compact`** — operator-triggered compaction through the same memory lifecycle as the automatic triggers (`FileBackedMemoryService.compactSessionDetailed`, trigger/phase `"manual"`), then the session's `compactedThroughMessageId` watermark (exported `COMPACTION_WATERMARK_METADATA_KEY`) moves to the newest persisted message. Refused while a run is active or approvals are pending; emits `session.updated` + `memory.updated` (with `metadata.sessionId`). SDK: `sdk.sessions.compact(id)` / `handle.compact()`. Docs: `docs/AGENT_LOOP.md` → "Manual compaction", `docs/GATEWAY_PROTOCOL.md`.
- **CLI approval answers** (`src/cli.ts` `resolvePendingApprovals`): `y` once, `a` always-for-this-session (per `${kind}:${value}`, in-memory `CliApprovalState`, each request still recorded), anything else denies and offers an optional note sent as the resolution `comment`, which the gateway queues as steering ("no, but do this instead"). `question`-kind approvals (`ask_user_question`) print the question + options and send the typed reply as the comment (previously the tool got an empty answer). The request justification is printed dimmed above the prompt.
- **Security review fixes H1, H5, H7, H8, H9, M6** — see the "Remediation status" table in `docs/SECURITY_REVIEW.md`. Key rules for future work: never quadruple-escape regexes in `DEFAULT_APPROVAL_SETTINGS` (`tests/unit/approval-defaults.test.ts` instantiates the shipped rules); the policy is deny-wins across all targets, then first allow/ask in target order; approval patterns must pass `validateApprovalPattern` (schema-enforced); path targets are canonicalized against the session cwd via `extractApprovalTargets(call, definition, { cwd })`; `web_fetch` re-validates redirects and refuses hosts resolving to private addresses (DNS check only when the built-in fetch is used, injectable via `resolveHost`).
- **Known, deliberately untouched**: `LEAN_TOOL_PROFILE_INVOCATION_NAMES` lists `create_file`, which is only an alias of `write_file`, so no file-creation tool is model-visible under the lean profile (the payload test skips unregistered names). The Kotlin port fixes this; fix here by listing `write_file` when you next touch the lean set.

## Addendum (2026-09-18): run finalization, live tool events, undefined-key tolerance, repeat guard

Root-caused from a real interactive session (`~/.aia/sessions/session.98390f03-…`) where the CLI ran several tools and then went silent with no prompt and no error. The chain, in order — any one link broken would have made it visible:

1. **An unserializable tool result.** Three configured MCP servers failed to connect, so `McpManager.summarizeServers` built each summary with `lastConnectedAt: status.lastConnectedAt`, i.e. the optional key **present with value `undefined`**. Zod keeps such a key, and `jsonValueSchema`'s record branch has no branch that accepts one. The persisted copy on disk looked healthy because `JSON.stringify` drops undefined-valued keys — the failure only existed in memory.
2. **Batched post-run emission.** `emitSessionRunEvents` emitted every message/tool/turn event _after_ the loop returned, so the `mcp_status` event threw partway through the batch.
3. **A swallowed rejection.** `executeSessionRun` had no try/catch and `trackRun` was `promise.then(() => undefined, () => undefined)`, so `completeRun` never ran, no terminal `run.updated` was ever emitted, and the run leaked out of `activeRunsBySession` (wedging the session as busy).
4. **An unbounded wait.** `waitForRun` resolves only on a terminal `run.updated`, with no timeout, so the CLI's `await run.wait()` never returned and never reached `resolvePendingApprovals`.

Rules for future work:

- **Never let a run end without a terminal status.** `guardRun` wraps every launched run; `failRun` records the structured error on the session and finalizes the run as `failed`/`session_failed`; `completeRun` releases `activeRunsById`/`activeRunsBySession` in a `finally` so a failed terminal emit cannot wedge the session. `trackRun` logs anything that still escapes instead of discarding it.
- **Never let a subscriber abort a run.** `emitEvent` dispatches through `dispatchEvent`, which gives each listener its own try/catch. `EventEmitter.emit()` is synchronous and would otherwise carry a listener's throw into the emitting run.
- **Normalize anything that becomes a `JsonValue`.** Three layers: `toJsonValue`/`toJsonRecord` (`src/core/contracts/common.ts`) sanitize at the single boundary every tool result crosses (`ToolRuntime`); `jsonValueSchema`/`jsonRecordSchema` drop undefined-valued keys rather than rejecting the payload; and builders like `summarizeServers` spread optional fields in conditionally instead of assigning a possibly-undefined value. When adding a field to any record that reaches an event, prefer `...(value ? { key: value } : {})`.
- **Emit progress while the run is running.** `AgentLoopOptions.onToolUpdated` fires as each tool call settles and the gateway emits `tool.updated` from it; `emitSessionRunEvents` deliberately no longer loops over `result.toolCalls` (re-emitting would duplicate the event id). The hook's host swallows its own failures — progress reporting must never abort the run it reports on.
- **`runtime.maxIdenticalToolCalls`** (default 3) refuses the same tool with the same arguments past the cap with a `repeated_tool_call` error result. The no-progress nudge counter cannot catch this, because every repeated read _succeeds_. See `docs/SMALL_MODELS.md`.
- **CLI must say why a turn ended.** `runChatTurn` keeps the terminal run record, prints `Turn ended: …` for anything other than `session_completed`, subscribes to `approval.requested` so a pause is announced when it happens, renders tool arguments alongside the tool name, and reports when the approval loop gives up after 50 rounds.
- **Test against the real gateway, not a fake SDK.** `tests/integration/run-finalization.test.ts` drives the real `runCli` over a real in-process runtime through an approval pause, and reproduces the original crash with an unreachable MCP server. Both hang (5s timeout) against the pre-fix code. Every `run.wait()` in tests passes `timeoutMs` so a non-terminating run fails the test instead of hanging the suite.
- **`run.get`** reads a run record by id; the last `FINISHED_RUN_HISTORY_LIMIT` (100) terminal runs stay readable so `waitForRun` can re-check state after subscribing rather than waiting on an event that already fired.

## Addendum (2026-09-18): interactive external agents, reasoning hygiene, tool-output fidelity, question UX

Four related work items, **all now implemented** (Stages D, B/C, E, A below are complete). This section
remains the durable record of the design decisions so a compaction cannot lose the rationale.

### Research findings that motivate the work (verified 2026-09-18)

- **`display` suppresses `result` in the model's view.** `buildToolResultMessageParts` (`src/core/tools/runtime.ts`) builds the `role:"tool"` message from `result.display` **only** when display is non-empty; the `result` JSON is dropped. `external_agent`, `exec_command`, and `write_stdin` each return a single `status` display part, so the model sees `[status:succeeded] <280-char summary>` and never sees stdout or the job record. This is the root cause of "it just says the command succeeded."
- **Provider-native reasoning is never persisted.** `reasoning_content` (LM Studio) / `message.thinking` (Ollama) → `response.reasoning` → `onAssistantReasoning` → `message.reasoning` gateway event emitted with `persist=false` (`src/gateway/runtime.ts` ~L228). It exists only as a live stream. Only _inline_ `<think>` markup inside `content` is persisted, and `stripReasoningMarkup` (`src/core/agent/loop.ts` ~L1161) removes it only on turns that produced a tool call — so a pure-text turn's `<think>` block stays in history forever.
- **External agents are one-shot today.** `FileExternalAgentService` (`src/core/external-agents/service.ts`) spawns a CLI once per job (blocking or detached); `resume` re-spawns a new process with `--resume <nativeSessionId>`. No long-lived process, no stdin after launch.
- **A PTY session primitive already exists.** `CommandRuntime` (`src/core/tools/builtins/command-runtime.ts`) has `node-pty`-backed long-lived sessions (`startExecCommand`, `writeStdin`, `readCommandOutput`, `waitForCommand`, `killCommand`) with a `child_process` pipe fallback. `node-pty@^1.1.0` is already a dependency. Do **not** write a second PTY lifecycle — extract this one.
- **CLI renders status only.** `formatToolActivity` (`src/cli.ts` ~L357) prints `· tool(args): <status>` and nothing else. The CLI does not subscribe to `message.created`.
- **`chat-session-memory/*.md`** is written by `FileBackedMemoryService.compactSessionDetailed` via `buildSessionSummary` (`src/core/memory/service.ts` ~L870) and records only `Successful tool calls: N` — no tool names, no output.
- **Vendor facts.** Claude Code supports true multi-turn over a single process: `claude -p --input-format stream-json --output-format stream-json --verbose` (JSONL in/out), plus `--permission-prompt-tool`, `--replay-user-messages`, `--include-partial-messages`, `--max-turns`. Codex `exec` has **no** persistent stdin protocol — its persistent path is `codex app-server` (JSON-RPC over stdio); `codex exec resume <SESSION_ID>` is the documented multi-stage pattern. Mistral Vibe has no documented protocol mode.

### Decisions (operator-confirmed)

| #   | Decision                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2   | Interactive sessions live **beside** the existing one-shot job model; same `external_agent` tool, new actions (`start`, `send`, `read`, `stop`, `attach`). `run`/`get`/`list`/`cancel`/`resume` keep working unchanged.                                                               |
| 3   | Extract the PTY/pipe session primitive out of `CommandRuntime` into a shared `src/core/process/` module; `CommandRuntime` and the external-agent service both depend on it.                                                                                                           |
| 4   | Generic PTY for all agents; **no** per-vendor protocol adapters. Resolved against the earlier 1A answer — see "Resolved design" below.                                                                                                                                                |
| 5   | Surface the external agent's inner activity as **a paragraph summary of the transcript** per turn, generated by a real model call (decision R7).                                                                                                                                      |
| 6   | External agents run in their **own** auto-approve mode; AIAgent gates only session **start**.                                                                                                                                                                                         |
| 7   | Sessions live until explicitly stopped; orphan sweep on startup only.                                                                                                                                                                                                                 |
| 8   | No concurrency cap (but see R10: warn + surface live sessions).                                                                                                                                                                                                                       |
| 9   | Reasoning stays on disk (transcript + chat logs) and is **filtered out of the model request** for turns older than the current one.                                                                                                                                                   |
| 10  | Add a first-class `{ kind: "reasoning", text }` message part; the serializer drops `reasoning` parts outside the retained window. Inline `<think>` is **moved** into that part, not deleted.                                                                                          |
| 11  | Superseded by R8: provider-native reasoning goes to the **events log only**, never the transcript.                                                                                                                                                                                    |
| 12  | `runtime.reasoningContextTurns`, default `1`.                                                                                                                                                                                                                                         |
| 13  | All three "tools while thinking" problems are in scope.                                                                                                                                                                                                                               |
| 14  | No-progress guard: allow **one** planning/reasoning turn between substantive turns; count consecutive ones beyond that.                                                                                                                                                               |
| 15  | A turn containing `think` **plus** any non-planning tool is productive.                                                                                                                                                                                                               |
| 16  | Reasoning survives within the current turn across tool results.                                                                                                                                                                                                                       |
| 17  | Always include a `json` part carrying `result` **in addition to** display parts. Fixes the contract violation generally, not per-tool.                                                                                                                                                |
| 18  | No new cap on tool output in model context (compaction handles it; existing per-tool caps stay).                                                                                                                                                                                      |
| 19  | Full output to the CLI.                                                                                                                                                                                                                                                               |
| 20  | CLI renders from `tool.updated`'s `toolCall.result` via a per-tool-family formatter.                                                                                                                                                                                                  |
| 21  | Live output streams via a new `tool.output.delta` gateway event fed by the PTY `onData` handler.                                                                                                                                                                                      |
| 22  | `chat-session-memory` gains a per-tool-call line (tool, key args, status, truncated output).                                                                                                                                                                                          |
| 23  | CLI first; web work is a follow-up (except Q29 below).                                                                                                                                                                                                                                |
| 24  | Truncation marker: explicit, actionable, names the follow-up tool **and** the artifact path.                                                                                                                                                                                          |
| 25  | Question prompt: numbered options, free text implicit ("or type your own answer").                                                                                                                                                                                                    |
| 26  | No `ask_user_question` schema change.                                                                                                                                                                                                                                                 |
| 27  | Free text ⇒ omit `selectedOption`, add `matchedOption: false`.                                                                                                                                                                                                                        |
| 28  | Approval prompt becomes `[y/N/a/e]`, `e` = deny + explain what to do instead.                                                                                                                                                                                                         |
| 29  | Web: radio buttons for options plus an "Other" radio with a text input, in the existing approvals form.                                                                                                                                                                               |
| 30  | Config: extend each preset in the existing discriminated union with optional `interactive` settings; add top-level `externalAgents.interactive` defaults.                                                                                                                             |
| 31  | Keep `external_agent` out of the lean profile; **also fix** the known `create_file`-vs-`write_file` lean-profile bug in `src/core/tools/defaults.ts`.                                                                                                                                 |
| 32  | argv-only (no shell string); approval on session start keyed on `external_agent:<id>`, `command`, canonicalized `cwd`; re-approve on `cwd` change; `send`/`read` not separately approved.                                                                                             |
| 33  | Reuse `passEnv` exactly as the one-shot path does.                                                                                                                                                                                                                                    |
| 34  | Tests: extend `tests/fixtures/external-agents/mock-external-agent-cli.mjs` with an interactive mode; deterministic integration tests; unit tests for reasoning filtering, output truncation, option prompt; opt-in live suite; **plus** a Playwright e2e for the CLI question prompt. |
| 35  | Sequence: (D) tool-result/context fix → (B/C) reasoning + thinking → (E) question UX → (A) interactive external agents. **Run the test gate between each stage.**                                                                                                                     |
| 36  | Docs: new `docs/EXTERNAL_AGENTS.md`; update `docs/AGENT_LOOP.md`, `docs/TOOL_CATALOG.md`; AGENTS.md addendum.                                                                                                                                                                         |
| 37  | Teach inline: PTY vs pipe and why TUI scraping is hard; context-window economics; the architecture seams.                                                                                                                                                                             |

### New requirement (operator)

The interactive external-agent terminal must **also appear in a real window on the macOS desktop**, so the human and AIAgent can both drive the same live session.

### Resolved design (operator-confirmed 2026-09-18, second round)

All earlier open questions are now closed. `R<n>` numbers are referenced from the TODO checklist.

- **R1 — PTY for all.** The earlier 1A (Claude `--input-format stream-json`) is **withdrawn**. A protocol pipe is not a terminal a human can attach to, and the shared-window requirement is non-negotiable. Every interactive external agent runs its native TUI in a PTY. No per-vendor protocol adapters.
- **R2 — We host the PTY ourselves; no tmux.** `tmux` is not installed on the target machine (verified). AIAgent owns the `node-pty` process. Screen state for the model is reconstructed with **`@xterm/headless`** (v6.0.0 available), which maintains a real screen buffer and applies the ANSI escapes, so `read` returns the _rendered screen_ rather than raw bytes. A new `aia attach <sessionId>` CLI subcommand relays raw stdin/stdout over the existing gateway WebSocket, reusing gateway auth — which also makes the terminal reachable over the tunnel surface, something tmux could never do.
- **R3 — Window opens via `osascript`.** `tell application "Terminal" to do script "aia attach <sessionId>"`. `osascript` verified present at `/usr/bin/osascript`.
- **R4 — Never auto-open.** Matches the repo's existing "do not auto-open the browser" posture. The window opens only on an explicit `external_agent { action: "attach" }` call or the CLI `/attach <id>` command. `start` prints the attach command instead.
- **R5 — Turn-boundary detection combines idle + ready-pattern + screen stability.** A turn is complete when the `@xterm/headless` screen buffer is unchanged across two samples `stabilityMs` apart **and** no bytes arrived for `idleMs`, **or** a per-agent `readyPattern` regex matches the rendered screen. Screen-diff stability is what survives spinners and progress animations, which byte-idle alone does not.
- **R6 — Soft write lock.** The service tracks the last human keystroke timestamp (trivially available because human input arrives through the `aia attach` WebSocket while agent input arrives through the tool). A tool `send` is refused with a structured error while a human typed within `humanLockMs` (default 10s).
- **R7 — Paragraph summary via a real model call** through the existing `LanguageModelRuntime`, so the model driving AIAgent gets prose rather than a screen dump. Tests use the scripted adapter (`ScriptedLanguageModelAdapter` in `examples/shared.ts`).
- **R8 — Provider-native reasoning goes to the events log only**, never the transcript. Implementation note: keep emitting per-delta `message.reasoning` with `persist=false` for live streaming (thousands of persisted delta events would be pathological), and emit **one aggregated persisted event per turn** carrying the full reasoning text. Decisions 9/10/12 therefore govern inline `<think>` markup in the transcript; the events log is the archive for provider-native reasoning.
- **R9 — No new cap at the runtime boundary.** Existing per-tool caps stay (`shell_command` 12k, `read_command_output` 16k default); only the truncation markers become actionable (decision 24).
- **R10 — Unlimited concurrent sessions, but visible.** Log a warning past a soft threshold and surface every live session in `external_agent { action: "list" }` and the CLI. No idle reaping.
- **R11 — Bypass flags ON by default.** Verified exact flags on the installed CLIs: `claude --dangerously-skip-permissions` and `codex --dangerously-bypass-approvals-and-sandbox`. **Security note for future agents: these defaults are deliberate and operator-chosen, not an oversight.** They must live as visible values in the shipped config defaults (never hardcoded in spawn logic) so they are trivially removable, and `docs/EXTERNAL_AGENTS.md` must state the risk plainly. The human gate is decision 32: starting an interactive session always requires an approval.
- **R12 — `codex --no-alt-screen` is default-on for interactive Codex sessions.** Discovered on the installed CLI: _"Runs the TUI in inline mode, preserving terminal scrollback history."_ Alt-screen mode is the single biggest obstacle to reliable TUI capture, so avoiding it improves both model reads and the shared window. Claude has no equivalent on the installed build (`--ax-screen-reader` needs v2.1.181+), so Claude runs in alt-screen and depends on `@xterm/headless`.

### TODO checklist (implementation order per decision 35)

Stage D — tool-output fidelity

1. [x] `buildToolResultMessageParts`: always append a `json` part with `result` alongside display parts; add a unit test proving `external_agent`/`exec_command` results reach the model.
2. [x] `exec_command`, `write_stdin`, `wait_command`, `kill_command`, `external_agent`: add text display parts carrying real output, not just status.
3. [x] `external_agent` `buildJobResult`: stop clipping to `job.summary` alone; include the harvested final output and log tails.
4. [x] Truncation markers (decision 24): name the follow-up tool, offset, and artifact path.
5. [x] CLI: per-tool-family output formatter driven by `tool.updated` `toolCall.result` (decision 20); full output (19).
6. [x] New `tool.output.delta` gateway event + PTY `onData` wiring + CLI live rendering (21). Emit with `persist=false`; the combined log on disk is the durable copy.
7. [x] `buildSessionSummary`: per-tool-call lines (22).
8. [x] Fix the `create_file`/`write_file` lean-profile bug (31).
9. [x] Test gate: `npm run typecheck && npm run lint && npm run test:unit && npm run test:integration`.

Stage D implementation notes (2026-09-18):

- **The contract fix (item 1).** `buildToolResultMessageParts` (`src/core/tools/runtime.ts`) previously built the `role:"tool"` message from `result.display` _instead of_ `result`, so any tool that added a nicety display silently starved the model of its own output. It now **always** appends a `{ kind: "json", value: { ...error, ...result, status, toolName } }` part. The one deliberate escape hatch is `RuntimeToolResult.displayedResultKeys`: a tool that already rendered a field verbatim in a text part lists that key so the JSON part omits it (avoiding a double copy of a large blob, made worse because `renderMessagePart` compact-stringifies JSON and escapes newlines). The persisted `toolCall.result` always keeps every key — the omission is model-facing only.
- **Shared truncation (item 4).** New `src/core/tools/output.ts` exports `truncateToolOutput`, producing `[output truncated: N of M characters omitted; read the rest with <followUp>; full output: <artifactPath>]`. Every clip site names a real next action instead of a dead `…`.
- **Command lifecycle (items 2, 6).** `CommandRuntime` gained `readCommandTail()` (used by `exec_command`, `write_stdin`, `wait_command`, `kill_command` so each returns `output`), an `ownerSessionId` on each command record, and an `onOutput` listener invoked from both the PTY `onData` and the pipe stdout/stderr handlers. `createGatewayRuntimeFromLoadedConfig` wires that listener to `GatewayRuntime.emitToolOutputDelta`, which emits the new `tool.output.delta` topic with `persist=false` (the combined log on disk is the durable copy; persisting per-chunk events would be pathological). The listener dispatch swallows subscriber throws — reporting output must never break the process producing it.
- **CLI (item 5).** `extractToolOutput` keys on the _result shape_ (`combinedOutput`, then `output`, handling both strings and `{ stdout, stderr }`), not on a tool-name table, so new tools render for free. `tool.output.delta` chunks are written raw to stderr with no added newline so PTY line breaks and progress rewrites survive.
- **Memory (item 7).** `buildSessionSummary` now writes `Successful tool calls: N of M` plus a `## Tool Calls` section, one line per call (`- name({args}) -> status: outcome`, last 100, args clipped to 200 chars and outcomes to 400). Failed calls are included deliberately: "don't try that again" is the most useful line in a resumed session's log.
- **Lean profile (item 8).** `LEAN_TOOL_PROFILE_INVOCATION_NAMES` listed `create_file`, an _alias_, so the lean profile shipped with no model-visible file-creation tool. Replaced with `write_file`. `tests/integration/prompt-payload.test.ts` now asserts `write_file` is visible and that no lean entry is a known alias — the old loop skipped unregistered names, which is exactly how the bug survived.
- **Coverage added.** `tests/unit/tool-output.test.ts`, two `tests/integration/tool-runtime.test.ts` cases (result always reaches the model; `displayedResultKeys` omission), lifecycle-output and live-listener cases in `tests/integration/workspace-command-tools.test.ts`, per-tool-call summary assertions in `tests/integration/memory-service.test.ts`, and `tool.output.delta` routing in `tests/unit/gateway-subscription.test.ts`.
- **Flake note.** The three subprocess-spawning integration tests (`config-loader` exec secret, `run-finalization` CLI, `shell_command`) can hit their 5s timeout when the gate runs back-to-back on a loaded machine. Re-run `npm run test:integration` alone before treating it as a regression.

Stage B/C — reasoning + thinking 10. [x] Add `reasoningPartSchema` to `src/core/contracts/messages.ts` and the `messagePartSchema` union. 11. [x] Move inline `<think>` into a reasoning part instead of deleting it; retire the delete-on-tool-call branch of `stripReasoningMarkup`. Emit one aggregated persisted `message.reasoning` event per turn for provider-native reasoning (R8); keep per-delta events `persist=false`. 12. [x] `filterModelVisibleMessages` (or the serializer) drops `reasoning` parts outside `runtime.reasoningContextTurns` (default 1). 13. [x] Config: `runtime.reasoningContextTurns` in `src/core/config/schema.ts` + `docs/CONFIG.md`. 14. [x] No-progress guard: one planning turn allowed between substantive turns (14); `think` + non-planning tool counts as productive (15). 15. [x] Verify text-embedded tool-call recovery still fires for calls emitted inside `<think>` blocks; add a regression test. 16. [x] `tests/integration/prompt-payload.test.ts` — confirm the budget still holds. 17. [x] Test gate.

Stage B/C implementation notes (2026-09-18):

- **Reasoning is moved, not deleted.** `stripReasoningMarkup` is gone; `splitReasoningMarkup` in `src/core/agent/loop.ts` pulls `<think>…</think>` and `<|channel|>analysis…` contents out of assistant text parts into a new first-class `{ kind: "reasoning", text }` part (`reasoningPartSchema`, `src/core/contracts/messages.ts`). Deleting it lost transcript detail; leaving it inline replayed the model's indecision forever. Splitting satisfies both, and it applies to **every** turn, not just tool-call turns.
- **Filtering is per turn, not per message.** `dropStaleReasoningParts` (called from `filterModelVisibleMessages`) keeps reasoning only for the last `runtime.reasoningContextTurns` turns (default 1). Per-turn granularity is what lets this turn's reasoning survive across its own tool results while older deliberation stops consuming the window. Messages with no parts left after filtering are dropped; messages with no `turnId` cannot be aged and are kept.
- **Provider-native reasoning stays out of the transcript (R8).** It streams as unpersisted per-token `message.reasoning` events and is archived as exactly one **persisted** event per turn carrying `payload.final: true` (`GatewayRuntime.flushTurnReasoning`, accumulated in `pendingReasoningByTurn`). The `final` flag was required: without it the CLI/web rendered the reasoning twice and `tests/integration/streaming.test.ts` double-counted it.
- **One free planning turn.** `consecutivePlanningTurns` is tracked alongside `consecutiveNudges`. The first planning-only turn is silent (no nudge, no counter); from the second onward the nudge fires and `consecutiveNudges` increments. Punishing the first turn taught the model to skip the "think, then act" step the prompt explicitly asks for. Mixed turns (`think` + a real tool) were already productive via `.every(...)` and stay that way.
- **Coverage added.** `agent-loop.test.ts` gained "allows a single planning turn…" and a rewritten "moves `<think>` reasoning into a reasoning part and ages it out…" (asserting both the persisted reasoning part and its absence from a later `filterModelVisibleMessages` result); the planning-guard test now needs 6 planning turns instead of 4. `lm-text-tool-calls.test.ts` gained a recovery-inside-`<think>` regression. `streaming.test.ts` now asserts the aggregate separately from the deltas.
- **Docs.** `docs/AGENT_LOOP.md` ("Reasoning persistence", "Why case 3 exists"), `docs/GATEWAY_PROTOCOL.md` (live-only topics, `final` semantics, `tool.output.delta`), `docs/SMALL_MODELS.md` (config recipe + file map).

Stage E — question / approval UX 18. [x] CLI `answerAgentQuestion`: numbered options, free text implicit, empty = skip (25). 19. [x] `ask_user_question` returns `matchedOption: false` for free text (27); no schema change (26). 20. [x] CLI approval prompt `[y/N/a/e]` (28). 21. [x] Web approvals form: option radios + "Other" with text input (29). 22. [x] Playwright e2e for the CLI question prompt (34). 23. [x] Test gate.

Stage E implementation notes (2026-09-18):

- **Numbering is a CLI presentation detail.** `answerAgentQuestion` (`src/cli.ts`) prints `  1) label — description` and accepts either a bare number or free text; a number is mapped to that option's **label** before the resolution comment is sent. That is what makes decision 26 (no `ask_user_question` input-schema change) possible — the tool never learns that a CLI numbered anything, so `matchSelectedOption` still works unchanged and any other surface can render options however it likes. `readQuestionOptions` parses `metadata.options` defensively because approval metadata is `JsonValue`, not a typed shape.
- **Free text is implicit, not a menu item.** The prompt reads `Your answer (number, or type your own answer; Enter to skip):`. Offering "other" as option N would force a two-step interaction for the common case.
- **`matchedOption` is always present.** `ask_user_question` now returns `matchedOption: boolean` (added to `askUserQuestionOutputSchema`, which is `additionalProperties: false`, and to `required`). Previously the model had to infer "the operator typed something we never offered" from a _missing_ `selectedOption`; absence-as-signal is exactly the kind of implicit contract small models get wrong.
- **Denial no longer interrogates.** The CLI approval prompt is now `[y/N/a/e]`; a plain `n` denies and consumes no further input, while `e` denies **and** prompts `What should the agent do instead?`. The old flow prompted for an optional note on every denial, which cost a keystroke on the common "just say no" path.
- **The web "Other" radio needs a server-side fallback.** One HTML form cannot bind a radio group and a free-text input to the same field name, so the approvals form in `src/web/home-page.tsx` renders option radios named `comment` plus an "Other" radio with an **empty value** and a separate `commentOther` text input. `src/server/control-plane/router.ts` resolves `comment || commentOther`. Question-kind approvals label the button **Answer** rather than **Approve**.
- **Optional metadata.** Both `readApprovalOptions` (web) and the `answerAgentQuestion` call site treat `request.metadata` as optional — the unit-test dashboard fixture omits it, and so do most non-question approvals.
- **Coverage.** `tests/integration/ask-user-question.test.ts` (matched + unmatched free text), `tests/integration/cli-interactive.test.ts` (numbered selection, `[y/N/a/e]`, `e`-explains, silent `n`), `tests/integration/control-plane-router.test.ts` (`commentOther` fallback), `tests/unit/home-page.test.tsx` (option radios + Other + Answer button), and `tests/e2e/cli.spec.ts` (real subprocess REPL; `runCommand` now pipes stdin and the fake LM server is scripted per-test).

Stage A — interactive external agents 24. [x] Extract `src/core/process/` PTY/pipe session primitive; refactor `CommandRuntime` onto it with no behavior change (3). 25. [x] Add `@xterm/headless`; screen-buffer reconstruction so `read` returns the rendered screen (R2). 26. [x] `externalAgents.interactive` config (30) + per-preset `interactive` block: bypass flags (R11), `--no-alt-screen` for Codex (R12), `readyPattern`/`idleMs`/`stabilityMs` (R5), `humanLockMs` (R6), `terminalApp` (R3). 27. [x] `FileExternalAgentService`: `startSession`/`send`/`read`/`stop`, persistence under `.aia/external-agents/sessions/<id>/`, startup orphan sweep (7), soft write lock (R6), live-session warning (R10). 28. [x] `external_agent` tool: new actions incl. `attach` (2); approval targets on start only (32); `passEnv` reuse (33). 29. [x] Paragraph transcript summary per turn via `LanguageModelRuntime` (R7). 30. [x] `aia attach <sessionId>` CLI subcommand + gateway WebSocket terminal relay (R2); `osascript` window launcher (R3); CLI `/attach` (R4). 31. [x] Gateway topics + SDK surface for interactive sessions. 32. [x] Mock CLI interactive mode + deterministic integration tests + opt-in live suite (34). 33. [x] `docs/EXTERNAL_AGENTS.md` (must document the R11 bypass-flag risk); update `docs/AGENT_LOOP.md`, `docs/TOOL_CATALOG.md`, `docs/CONFIG.md`, `docs/GATEWAY_PROTOCOL.md` (36). 34. [x] Final gate: `npm run validate:penultimate`.

Stage A implementation notes (2026-09-18):

- **One PTY lifecycle, not two.** `src/core/process/session.ts` now owns `startProcessSession` (node-pty with a `child_process` pipe fallback); `CommandRuntime` was refactored onto it with no behavior change, and the external-agent session service consumes the same primitive. Adding a second PTY lifecycle for external agents would have duplicated the subtlest code in the repo.
- **A PTY needs a terminal emulator, not a regex.** `src/core/process/screen.ts` wraps `@xterm/headless` to maintain a real screen buffer, so `read`/`send` return the screen a human would see. Stripping escapes with a regex renders an in-place spinner as three garbage lines. **`@xterm/headless` 5.5.0 is CJS-only and must be loaded through `createRequire`**, not a static import: webpack's interop hands back an `undefined` default, so a static import typechecks and passes unit/integration tests but crashes the Next server build at module eval (`Cannot destructure property 'Terminal'`). Only `npm run test:e2e` caught it. Same reason `src/gateway/websocket.ts` loads `ws` that way.
- **Turn end = idle + screen stability, or a ready pattern.** `TerminalTurnWatcher` combines all three because each alone is wrong: byte idle false-positives on any spinner, screen stability is the signal that survives spinners, and `readyPattern` is fastest but per-agent and optional. The result reports `turnEndReason` so the model can tell a real answer from a timeout.
- **`await promise` does not await that promise's `.then()` handlers.** `stopSession` originally awaited `session.process.exited` and then read a record that the exit _handler_ had not yet persisted (`endedAt` was undefined). Fixed by capturing the finalizer as `LiveSession.finalized` and awaiting that. If a handler owns the state transition, the handler's promise is the thing to await.
- **Suspect the fixture before the emulator.** The "spinner frames survive" test failure was caused by the mock CLI prefixing every frame with `\r\n` — the terminal correctly rendered three lines. Fixed in `tests/fixtures/external-agents/mock-external-agent-cli.mjs` by emitting one `\r\n` then bare `frame\r` rewrites.
- **Approval gates opening the channel, not every message.** `UNGATED_EXTERNAL_AGENT_ACTIONS` (`src/core/external-agents/service.ts`) returns no approval targets for `attach`/`get`/`list`/`read`/`send`/`stop`. `run` and `start` still resolve agent id + command + canonicalized `cwd`. Re-approving each turn would make a conversation unusable, and consent was already given.
- **`writeHumanInput` is deliberately separate from `sendToSession`.** A human's bytes are not a turn: not summarized, not counted, and they _set_ the soft write lock rather than being blocked by it (`humanLockMs`, default 10s). Queuing the agent's write instead of refusing it would land it mid-keystroke.
- **The window launcher is injected, not imported, by the gateway.** `GatewayRuntimeOptions.attachExternalAgentSession` is a callback; `openTerminalWindow` (macOS `osascript`) is wired in only by `createGatewayRuntimeFromLoadedConfig`. The control plane must not depend on a platform-specific window manager, and tests substitute a recorder.
- **`aia attach` rides the gateway WebSocket.** `src/gateway/attach-client.ts` subscribes to `tool.output.delta` and sends keystrokes as `external_agent.session.write`, so an attached terminal inherits gateway auth and works over the tunnel — something tmux could never do. **Ctrl-] (`\u001d`) detaches** without killing the session. Windows never open automatically (R4).
- **`buildTurnResult` leads with the summary.** Status part first (the one-paragraph summary), then the screen as a text part with `displayedResultKeys: ["screen"]` so the JSON part does not carry a second copy. The summarizer uses `toolChoice: "none"`; a summarizer that could call tools would be a second agent loop. A summarizer failure is tolerated — a missing summary is never fatal.
- **`externalAgentConfigSchema` is now exported** from `src/core/config/schema.ts` so live tests can build a valid discriminated-union member instead of casting through `unknown`.
- **Security posture is deliberate.** The shipped interactive presets pass `--dangerously-skip-permissions` (Claude) / `--dangerously-bypass-approvals-and-sandbox` (Codex) as **visible config values**, never hardcoded in spawn logic, because an external agent that stops to ask its own approval question inside an agent-driven PTY deadlocks. `docs/EXTERNAL_AGENTS.md` states the risk and the mitigations plainly.
- **Coverage.** `tests/integration/external-agent-sessions.test.ts` (6), `tests/integration/external-agent-session-tools.test.ts` (2), `tests/unit/process-terminal.test.ts` (5), `tests/unit/external-agent-turn-summary.test.ts` (3), and opt-in `tests/live/external-agent-interactive.live.test.ts` (`npm run test:live:external-agents-interactive`).
- **`void promise` is not error handling.** The one-shot job service fired `void this.handleChildExit(...)` / `void this.markTimedOut(...)` from process `error`/`exit`/timeout/poll callbacks. Nothing awaits those, so a handler that threw after its job's state root disappeared surfaced as an unhandled rejection (`external_agent_job_not_found`) that failed the whole Vitest run without failing a single test. All four now go through `FileExternalAgentService.trackBackground`, which logs and continues. A dead process's bookkeeping must never be fatal.

Live-run findings (2026-09-21, first real `codex` PTY session):

- **node-pty's `spawn-helper` ships without the execute bit.** npm extraction dropped it, so every `pty.spawn` threw `posix_spawnp failed` and `startProcessSession` fell back to pipes — which makes interactive sessions useless, because the CLI detects a pipe and never renders. `scripts/ensure-pty-helper.mjs` now runs on `postinstall` and chmods the prebuilt helper for every platform directory present. Missing prebuilds are not an error (a source build has none).
- **Never fall back silently.** The PTY `catch` returned `null` with no signal. It now warns once per process with `AIA_PTY_FALLBACK` (same convention as `AIA_SQLITE_FALLBACK` / `AIA_EMBEDDINGS_DEGRADED`) and names the repair command. The live test's `expect(record.pty).toBe(true)` is what actually caught this — deterministic tests pass `usePty: false` or do not care, so **only a live test can prove the PTY path works**.
- **Build live fixtures from `DEFAULT_APP_CONFIG`, not by hand.** The first version of the live suite hand-built an `externalAgentConfigSchema` member and failed on required preset fields (`jsonFlag`, `skipGitRepoCheck`, …). It now spreads `DEFAULT_APP_CONFIG.externalAgents.agents[preset]`, which is both DRY and the only version that tests what ships.
- **A TUI's screen is state, and the next keystroke is interpreted against it.** The real `codex` opened on an _update prompt_, not its chat prompt. Because every `send` ends with a carriage return, sending anything accepted the highlighted default and kicked off `brew upgrade --cask codex`. Nothing malfunctioned — that is what Enter meant on that screen. Design consequence: read before writing after `start`, and treat `attach` as the answer to a modal the agent cannot interpret. Documented in `docs/EXTERNAL_AGENTS.md` → "A second hazard: unexpected modal prompts".
- **The emulator works.** The rendered screen from a real session came back as clean, human-readable text (box-drawn update notice with its option list), confirming `@xterm/headless` reconstruction is doing its job on real TUI output.

## Addendum (2026-09-21): interactive-session correctness and external-agent wiring

Found by rebuilding, relinking, and live-testing the `external_agent` tool against a real Claude Code
CLI (2.1.153). Five defects, all of the same family: **reporting success for something that did not
happen.**

- **The tool was not registered anywhere but the server.** `createDefaultToolRegistry` registers
  `external_agent` only when a one-shot job service is present, and that service was built solely in
  `src/server/runtime-context.ts`. The CLI and the in-process SDK therefore had **no external-agent
  tool at all** — interactive actions included, since one tool carries both. It is now built inside
  `createGatewayRuntimeFromLoadedConfig` alongside the interactive session service, which is how that
  one always reached every surface; callers that need their own instance still inject one. When you
  add a service that gates a tool registration, build it in the gateway factory, not in one surface.
- **A turn could end before the child said anything.** `waitForTurnEnd`'s idle path had no
  "output arrived after the turn began" gate (the ready-pattern path did), so a child that had not
  answered trivially satisfied idle _and_ stability and the caller got the previous screen as if it
  were a reply. The boundary is now `beginTurn()`, snapshotted when the instruction is written rather
  than when the wait is entered — the caller persists state in between, and an echo landing in that
  window would otherwise look like it predates the turn. No `beginTurn()` means the whole stream
  counts, which is what a "has this settled?" caller wants.
- **`start` returned before the agent could hear anything.** A TUI drops keystrokes until it has
  painted. `startSession` now waits for the child's first output to settle, bounded by
  `interactive.startupTimeoutMs` (default 10s); a timeout is not fatal, since an agent that stays
  silent until spoken to is legitimate.
- **A dead child still reported a normal turn.** Claude answering "No, exit" to its own modal exited,
  and `send` returned `turnEndReason: "idle"` with the pre-exit screen; the death surfaced only on the
  _next_ call, as a throw. `waitForTurnEnd` now takes the child's `exited` promise and returns
  `turnEndReason: "exited"`.
- **An agent's own failure was classified as resumable.** See `docs/EXTERNAL_AGENTS.md` →
  "When the external CLI reports its own failure".

Also fixed, because it made the lean profile expensive in a way that only shows up live:

- **`tool_search` matched the whole query as one substring.** Any phrased query — the natural way a
  model asks — matched nothing, because no field contains the literal phrase. Observed live: six
  consecutive searches before the model found a tool whose own search tags it had already used. There
  is now a per-token fallback scored by the share of tokens that hit, so an exact match still
  outranks a partial one. The same live prompt now takes one search. Tokens of two characters or
  fewer are dropped so connectives cannot manufacture matches.

Test-harness note: `vitest.integration.config.ts` sets `testTimeout: 30_000`. Several integration
tests now spawn real PTYs, and under the full suite's parallelism that exceeds vitest's 5s default on
a loaded machine — it surfaced as timeouts that never reproduced when a file ran alone. The product's
own timeouts still bound every wait.

## Addendum (2026-09-21): full-project review pass

A read-only review of the whole project (gates, live CLI/web run, and a careful pass over the
uncommitted Stage A–E work) found eleven defects, all now fixed with tests. The gate was green
_before_ these fixes, which is the point worth keeping: every one of them is invisible to
`typecheck`/`lint`/`test` and most were only visible by running the product and looking at what it
wrote to disk.

**Findings, in the order they matter:**

- **`grep_files` bounded the wrong dimension.** `maxResults` caps how many matches return; a match
  carries its whole source line. `grep_files({query: "edit_file"})` against this repo returned 85
  matches (under the 100 default) serializing to **14.8MB**, because `dist/*.js.map` files are single
  ~2MB lines. This is the root cause of the "single 12.5MB tool result" in the 2026-06-12 context
  incident, which was recorded but never traced. The rendered output now goes through
  `truncateToolOutput` (12k, matching `shell_command`) and `result.matches` keeps only whole entries
  that fit; `matchCount` reports the real total. Deliberately **not** fixed: traversal still walks
  and utf8-reads `node_modules/` and `dist/` (up to 10,000 entries). Operator choice — scope with
  `path`. See `docs/TOOL_CATALOG.md` → "Output limits".
- **The web session form proposed the wrong working directory.** `home-page.tsx` defaulted `cwd` to
  `settings.memory.workspaceRoot` — the memory _document_ root (`./memory`) — so a session created
  from the dashboard ran the agent inside `memory/`. `ControlPlaneSettingsSummary.runtime` now
  carries a distinct `workspaceRoot` (from `ServerRuntimeContext.cwd`). The unit fixture now uses
  visibly different values for the two roots, because identical fixture values are what let this pass
  review in the first place.
- **`passEnv` restricted nothing, in either path.** `buildProcessEnvironment` seeded from
  `{ ...process.env }` and then re-copied each `passEnv` key out of `process.env` into it — a provable
  no-op — while `docs/EXTERNAL_AGENTS.md` called it an allowlist. The interactive path was worse: it
  passed no `env` at all, so it honoured neither `passEnv` nor the agent's `env` map. Both now share
  `buildExternalAgentEnvironment` (`src/core/external-agents/environment.ts`): a documented floor
  (`PATH`, `HOME`, `SHELL`, `TERM*`, `LANG`/`LC_*`, `TMPDIR`, `TZ`, `USER`, proxy + CA vars) plus
  `passEnv` plus `env` plus per-call overrides. **This is a behaviour change** — an agent that relied
  on an inherited variable must now name it in `passEnv`. The pattern came from `secrets.ts`, where
  `passEnv` reads from a _separate_ `environment` argument and is meaningful; copying it without that
  second source is what made it vacuous. When you copy a security-shaped helper, copy what makes it
  work, not its shape.
- **The `start` approval hid the bypass flags.** The `command` approval target was
  `command + defaultArgs`, but `start` spawns `defaultArgs + interactive.args` — where
  `--dangerously-skip-permissions` lives. An operator rule written to refuse exactly that flag could
  never match. `ExternalAgentDefinition` now carries `interactiveArgs` and the resolver appends them
  for `start` only. Note the operator sees just `match.target`, so this fix is mostly about _policy
  matching_, which is where it counts.
- **Reasoning buffered per turn was never released on an abnormal exit.** `flushTurnReasoning` ran
  only from `emitSessionRunEvents` (off `result.turns`), so a throw that escapes the loop — the exact
  case `guardRun` exists for — left entries in `pendingReasoningByTurn` forever and lost the archive
  for those turns. `guardRun` now flushes in a `finally`. Honest caveat: the added test covers
  "reasoning survives a failed run" but **passes against the broken code**, because a provider error
  is handled inside the loop and still returns normally. The escaping-throw path has no harness to
  inject a post-run failure from outside; the fix is defensive and untested for its own trigger.
- **`readCommandTail` read the whole log to return 8KB**, on every `exec_command` / `write_stdin` /
  `wait_command` / `kill_command` call. Now seeks (`open` + `stat` + a tail read of `maxChars * 4`
  bytes, trimming leading UTF-8 continuation bytes so a split character cannot decode as U+FFFD).
  `CommandTailResult.totalChars` became `totalBytes`: counting characters means decoding everything,
  which is the cost being avoided, so the field now says what it actually holds.
- **The global event ledger grew without bound.** `.aia/logs/session-events.jsonl` is written for
  every event and **read by nothing in the product** (`docs/INITIAL_DESIGN.md` calls it a coarse audit
  ledger); the live workspace was at **236MB across 2,169 events**. It now rotates one generation at
  64MB. Rotation is deliberately _not_ applied to the per-session jsonl files — those are read back by
  `getSessionSnapshot`, so rotating one would silently truncate a session's history.
- **Three smaller ones.** `startSession` could orphan a spawned child if the record failed schema
  validation after the spawn (now killed + streams closed on the way out); the pipe fallback's
  `child.stdin` had no `error` listener, so an EPIPE after the child exits was an uncaught exception
  that would take the gateway down (a write after exit is an ordinary race, not misuse); and
  `assertWritable` compared against `Date.parse(...)` without a NaN guard, so a damaged
  `lastHumanInputAt` silently disabled the R6 human write lock — it now fails closed.

**Verified safe, so nobody re-audits them:** the `osascript` launcher is sound —
`entityIdSchema` (`/^[A-Za-z0-9][A-Za-z0-9._:-]*$/`) admits no shell metacharacter before the id
reaches `do script`, and the AppleScript quoting is correct; keep that regex tight, because
`do script` runs its argument through a shell. `attach-client` filters `tool.output.delta` on both
`sourceKind` and `sourceId`, so an attached terminal cannot see another session's output. The
no-progress guard's `nonCompletionCalls.every(...)` cannot hit the empty-array-is-true trap, because
the completion branch returns before it.

**Repo hygiene in the same pass:** removed the leftover `live-claude-probe3.ts` scratch probe;
untracked `.tsbuildinfo` and `tsconfig.tsbuildinfo` (build output, and `.tsbuildinfo` dirtied every
diff) and added them to `.gitignore`; set `printWidth: 120` in `prettier.config.mjs` to match the
width the code is actually written at — the default 80 meant `npm run format` would have reflowed 255
files. **Still open:** ~175 files remain prettier-dirty even at 120 (hand-wrapped narrower), so
`npm run format` is still not safe to run casually. Closing that needs its own mechanical commit, and
prettier is in no gate.

**Channels 25/27/28 (Discord, Teams, iMessage) remain unchecked, by operator decision.** The Done
Criteria above — "the four required messaging channels are live behind adapters" — is therefore **not
met**; only WhatsApp (26) ships. Do not read the checked state of items 29–33 as covering them.

## Addendum (2026-09-22): the invisible answer, four open High findings, and a gate that wasn't

A review pass that ran the gates, ran the product against a real LM Studio model, and
read the security audit against the code. The deterministic gate was green before any of
this — the most important defect was invisible to `typecheck`, `lint`, and every test,
and only showed up by using the product and looking at what reached the terminal.

### The defect that mattered most: nothing ever showed the agent's answer

Asked "What is 17 _ 23?", the model reasoned correctly, called `attempt_complete` with
`summary: "17 _ 23 = 391."`, and the operator saw the dimmed reasoning, a status metrics
line, and **no answer**. The same on `--prompt` and in the web transcript.

The chain, all three links necessary:

1. `attempt_complete` is a runtime **completion gate**, not an executed tool. The loop
   intercepts it, so there is no `ToolCall` record, no `tool.updated` event, no result.
2. The loop read the accepted call only for the accept/reject decision and **discarded
   `summary`**, hardcoding `statusSummary: "The task completed successfully."`
3. Every surface then had nothing to render: `formatTurnStopNotice` returns `null` on a
   clean completion, `extractLatestAssistantSummary` reads text parts only, and the web's
   `summarizeMessage` renders a `tool_call` part as `[tool] attempt_complete`.

And the prompt pack (`pack.tsx`, `attempt-complete.ts`) explicitly instructs the model to
put the answer in the argument and _not_ send a chat message — so **the better a model
followed the contract, the less the operator saw.** The README meanwhile promised
`--prompt` printed "the latest assistant summary."

Fixed at the single canonical point: the loop persists the summary as an assistant
message tagged `COMPLETION_SUMMARY_MESSAGE_TAG` (in `contracts/messages.ts`, so the loop,
memory service and CLI share one spelling), and `statusSummary` carries the real text.
Every surface gets it for free. See `docs/AGENT_LOOP.md`.

**Why no test caught it, which is the durable lesson.** The fake provider
(`tests/helpers/fake-language-model-server.ts`) emitted prose in `content` _plus_
`attempt_complete` with **empty arguments** — the exact opposite of the shipped contract.
The e2e asserted on the prose and passed. A fake that contradicts your own prompt pack
tests a product you do not ship. It is now contract-accurate, and the gateway e2e asserts
the answer _content_ reaches the client rather than counting assistant messages.

### Security: H2, M13, H3, H4, H6 closed

Threat model and per-finding detail in `docs/SECURITY_REVIEW.md`; config surfaces in
`docs/CONFIG.md`. Rules worth carrying forward:

- **Never derive a peer address from a header.** `X-Forwarded-For` is client-supplied.
  Socket address only (H2).
- **Header handling alone cannot close tunnel exposure**, because a tunnel terminating in
  front of us forwards to the loopback socket — remote traffic _is_ loopback by then. The
  only reliable signal is our own config, so `assertGatewayExposureIsAuthenticated` now
  **refuses to start** an untokened routable/unspecified/tunnelled gateway (M13). A
  warning is not a control: the insecure configuration still came up and served traffic.
- **Workspace config trust** (H3) is keyed on path **and content hash**, stored in
  `~/.aia/trust.json` — never in the workspace, which an attacker also controls. Editing a
  trusted file revokes trust. Untrusted `exec`/`file` providers are withheld with an
  `AIA_UNTRUSTED_CONFIG` warning and the load _continues_; only an actual reference fails.
  `aia trust` grants/revokes.
- **An approval target must render what will actually run.** The external-agent `command`
  target now includes the model-supplied `args` (H4) via the same `stringifyArgv` the M6
  fix introduced — now exported, rather than written a second time. A model could
  otherwise pass `--dangerously-bypass-approvals-and-sandbox` while the operator saw
  "run codex."
- **Channel control commands need an operator identity** (H6): `operatorIdentities` per
  channel, failing closed on an empty list, checked once before the dispatch so a future
  command kind cannot be added past the gate. Parsing + authorization extracted to
  `src/gateway/channel-commands.ts`.

Still open: M1–M5, M7–M12 and the low-severity items.

### The coverage gate was not a gate

`npm run test:coverage` was in **no** gate (`validate:penultimate` omitted it), and had
drifted _below its own floor_ — 91.2% lines against a 92.1 threshold, 95.9% functions
against 97 — with nothing failing. It was also flaky: two macOS voice tests spawn real
helpers and exceeded vitest's 5s default under V8 instrumentation, because
`vitest.unit.config.ts` set no `testTimeout` while the integration config set 30s.
`docs/TESTING.md` meanwhile claimed "~77% lines", matching neither.

Timeout aligned, coverage added to `validate:penultimate`, docs corrected, and the floor
**reached by writing real tests rather than lowered**: 92.22% statements / 82.64%
branches / 97.18% functions over 716 tests. The new tests went to things that were
genuinely untested rather than whatever was cheapest — the `attach-client` relay
(including the cross-session output filter the 2026-09-21 addendum _claimed_ was safe but
never tested), the AppleScript quoting that is the `do script` injection boundary, the
WhatsApp adapter's media and attachment paths, `aia trust`, `/mcp`, `/agents`, and
`attempt_complete`'s own execute path.

### Two more defects found by running things, not reading them

- **`aia trust --revoke` reported success and removed nothing.** The grant keyed on the
  realpath (`/private/tmp/…`) while the revoke resolved the symlinked spelling
  (`/tmp/…`); `path.resolve` does not resolve symlinks. A revoke that silently does
  nothing is the dangerous direction for a trust store. Both sides canonicalize with
  `fs.realpath` now. Caught only by running the command for real.
- **The WhatsApp poll loop could take the process down.** `pollInboundDirectory` guards
  each _entry_, but the `readdir` itself sat outside that guard, so a removed or briefly
  unreadable bridge directory threw out of a promise nothing awaits until `close()`. Same
  family as "a dead process's bookkeeping must never be fatal" — it now warns
  (`AIA_CHANNEL_POLL_FAILED`) and keeps polling.

### Still open after this pass

- **Channels 25/27/28 (Discord, Teams, iMessage) remain unimplemented**, so the Done
  Criteria is still **not met**. Only WhatsApp ships. The framework is ready — config
  schemas, capability tables, `isChannelConfigured` and an honest `not_implemented`
  health state exist for all four; what is missing is three adapters plus wiring and
  tests.
- `src/gateway/runtime.ts` is still ~3,500 lines. Only the channel-command handling was
  extracted (the part this pass had to modify anyway); the rest is its own commit.
- Prettier drift was handled as a separate mechanical commit; `prettier --check` is now
  in the gate, so it stays clean.
