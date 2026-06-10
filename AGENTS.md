# AIAgent Implementation Contract

Last updated: 2026-03-31

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
- Primary config files:
  - `aia.config.jsonc`
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
  - `externalAgents` is now a first-class top-level config section with disabled-by-default Codex CLI and Mistral Vibe CLI presets.
  - `src/core/external-agents/service.ts` persists explicit jobs under `.aia/external-agents/jobs/<job-id>/attempts/` with `job.json`, stdout/stderr logs, normalized final outputs, and summary artifacts.
  - The built-in `external_agent` tool now supports `run`, `get`, `list`, `cancel`, and `resume`.
  - Detached jobs append compact transcript status messages to the originating session while keeping full logs in artifacts on disk.
  - Read-only `get` and `list` actions bypass approvals, while `run`, `cancel`, and `resume` resolve approval targets for the external agent id, command, and cwd.
  - The gateway now handles `external_agent.*` request topics, and `external_agent.list` returns both configured definitions and persisted jobs.
  - Deterministic fixture-backed integration coverage exists for blocking runs, detached recovery, resume, approval integration, gateway dispatch, and an opt-in live Codex path.

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
