# MCP: discovery, status, and how the agent answers "what servers/tools do you have?"

Last updated: 2026-07-09

## How MCP is wired

1. **Config** — servers are declared in `aia.config.jsonc` (or `~/.aia/config.jsonc`)
   under `mcp.servers`. Each entry has a `type` (`stdio` | `streamable-http` | `sse` |
   `auto`), `enabled`, `required`, and transport details (command/args for stdio, url
   for HTTP).
2. **Manager** — `createMcpManagerFromLoadedConfig(...)` → `mcpManager.initialize()`
   connects on startup (`initialize()` calls `refresh()` which connects each enabled
   server). The manager tracks per-server status (`getServerStatuses()`: `state`,
   `transport`, capability counts, `error`), a capability catalog (`getCatalog()`),
   tool capabilities (`getToolCapabilities()`), and health (`getHealth()`).
3. **Registration** — MCP tools are composed into the agent's tool registry
   (`combineToolRegistries([base, dynamicMcpRegistry])`) with `kind:"mcp"` and
   `source.serverName`, so they are callable and searchable like any other tool.

## How the agent discovers MCP capabilities

- **`mcp_status`** (canonical) — lists every **configured** server with its connection
  `state`, `transport`, any connection `error`, and the tools it exposes. Crucially it
  includes **disabled and failed** servers, so the agent can answer "what MCP servers do
  you have?" and explain *why* an expected server has no tools. Aliases:
  `list_mcp_servers`, `mcp_servers`.
- **`tool_search`** with `kinds:["mcp"]` — lists connected MCP *tools* (returns
  `source.serverName`). It does **not** list servers or show connection state, so a
  failed/disabled/toolless server is invisible to it. Use `mcp_status` for the server
  question; use `tool_search` to find a specific tool to call.
- **`mcp_search`** — richer catalog search across connected tools, resources, prompts,
  resource templates, and installable server templates.

### Lean-profile visibility

The default `tools.profile: "lean"` keeps the model's tool list small. `mcp_status` is
surfaced under lean **only when at least one MCP server is configured**
(`resolveVisibleToolDefinitions({ alwaysInclude: ["mcp_status"], ... })` in
`src/gateway/runtime.ts`), so there's no catalog bloat when MCP is unused. `mcp_search`
and the MCP tools themselves remain discoverable via `tool_search`.

The system prompt's "Working With Tools" section points the agent at `mcp_status` when
it is available (see `src/core/prompts/pack.tsx`).

## Operator surfaces

- **CLI**: `/mcp` in the interactive session lists servers (state, transport) and their
  tools. Backed by the gateway request below.
- **Gateway**: the `mcp.list` request topic returns `{ servers: McpServerSummary[] }`
  (configured servers + state + tools), shared with the `mcp_status` tool through
  `MCPManager.summarizeServers()` (one canonical implementation).

## Why a configured server can show no tools

If `mcp_status` / `/mcp` shows a server in state `failed` (or `tool_search kinds:["mcp"]`
returns nothing), the server didn't connect. Common causes for an `npx`-launched stdio
server like `context7` (`npx -y @upstash/context7-mcp@latest`):

- **`npx` not on the spawned `PATH`.** The stdio transport uses the MCP SDK's
  `getDefaultEnvironment()`, which forwards only an allowlist (incl. `PATH`) from
  `process.env`. If `aia` was launched from a GUI rather than your shell, `process.env.PATH`
  may not include your node/npm bin (nvm/fnm/homebrew), so `npx` isn't found. Launch from
  a shell, or set an absolute `command`, or add `PATH` via the server's `env` in config.
- **First-run download latency.** `npx -y …@latest` downloads the package on first run;
  a slow download can exceed the MCP SDK's default request timeout. Pre-install the
  package, or pin a local command.
- **Network/offline** — context7 needs network access.

`mcp_status` surfaces the captured `error` for each failed server, which is the fastest
way to see the exact reason (the connection error is recorded in
`getServerStatuses().error` but is otherwise not displayed anywhere).

## Config knobs

Per-server (`mcp.servers.<name>`):

- **`timeoutMs`** — request timeout (ms) applied to *every* SDK call for the server
  (connect handshake, `callTool`, `list*`, `getPrompt`, `readResource`). Omitted →
  the SDK default (`DEFAULT_REQUEST_TIMEOUT_MSEC`, 60s). Progress notifications reset
  the timer (`resetTimeoutOnProgress`), so long, progress-reporting tools are not
  killed mid-stream.
- **`trust`** — `"prompt"` (default when omitted) or `"trusted"`. See "Approval &
  trust" below.

Top-level (`mcp`):

- **`watch`** — hot-reload MCP servers when a config/import file changes. Omitted →
  `true`. Set `false` for long-lived server processes that should not reconnect
  mid-session on unrelated config edits.

Runtime (`runtime.modelSettings`):

- **`supportsVision`** — whether the active model accepts image input. Omitted →
  `true` (opt-out). When true, image content returned by an MCP tool is forwarded to
  the model; when false, it is summarized as a `[image: …]` text placeholder instead.
  Set `false` for text-only local models. Also documented in `docs/CONFIG.md` and
  `docs/SMALL_MODELS.md`.

## Approval & trust

MCP tools are **always** `approvalMode: "ask"` — the server-reported `readOnlyHint` is
an advisory, untrusted annotation (per the MCP spec) and never grants silent execution
or bypasses operator deny rules. Each MCP tool call is evaluated by the approval policy,
which sees `mcp_server` and `mcp_tool` targets (`extractApprovalTargets`).

To auto-approve a server you trust, set `trust: "trusted"` on it. The gateway
synthesizes an `mcp_server` **allow** rule for each trusted server and appends it *after*
your configured rules (`withMcpTrustRules` in `src/core/approvals/policy.ts`). An explicit
operator **deny** rule still wins — a server-level (`mcp_server`) deny because it precedes
the appended trust rule, and a tool-level (`mcp_tool`/`tool`) deny because the `mcp_tool`
target is evaluated before `mcp_server`. So you can trust a server yet still deny one of
its tools.

## Transport selection & fallback

`connectClient` (`src/core/mcp/manager.ts`) picks the transport from `type`:

- `stdio` — spawns the command; env is the SDK allowlist (`getDefaultEnvironment`) merged
  with the server's `env`.
- `sse` — legacy SSE. Custom `headers` are injected via a `fetch` wrapper so they reach
  **both** the SSE stream open (GET) and the message POSTs (`eventSourceInit` alone would
  miss the GET).
- `streamable-http` — modern HTTP; no fallback.
- `auto` — try Streamable HTTP, and fall back to SSE **only** on a `StreamableHTTPError`
  with a 4xx status that is not `401`/`403` (`shouldFallbackToSse`). Network/TLS/5xx/auth
  failures surface as-is rather than being masked by a second, misleading SSE error.

## Reliability

- **Tools-only servers connect.** `list*` calls are gated on the server's advertised
  capabilities (`getServerCapabilities()`) and each is wrapped so a failure yields `[]`.
  A tools-only server no longer fails wholesale on `resources/list` → `MethodNotFound`.
- **Failed servers are retried.** A `failed` (or `disabled`) entry is not reused across
  `refresh()`; only a `connected` entry with an unchanged config signature is kept. A
  transiently-failed server reconnects on the next refresh once it recovers.
- **`refresh()` is serialized** (`refreshQueue`) so overlapping reloads cannot orphan
  clients or spawn duplicate stdio processes. A connect/enumeration failure closes the
  client so no transport/child process leaks.
- **Injective invocation names.** Names are de-duplicated per server and across servers
  with a `-2`/`-3` suffix (`disambiguateInvocationName`), and the MCP registry skips (and
  logs) a duplicate rather than throwing — one misbehaving server can't take down the
  whole tool catalog.
- **Registry memoization.** The dynamic MCP registry rebuilds only when the manager's
  generation changes (`getGeneration()`), not on every lookup.

## Non-text tool output

`createMcpRuntimeTool.execute` lifts text and embedded-resource *text* into the display,
emits `[image|audio|resource …]` placeholders for binary content, and — when an artifact
root is configured — persists image/audio/blob blocks as artifacts. Images are forwarded
to the model as a follow-up user message when `supportsVision` is not false (see above);
otherwise only the placeholder text reaches the model.

## Where things live

- `src/core/mcp/manager.ts` — `summarizeServers()`, statuses, catalog, connect/refresh,
  transport selection, `shouldFallbackToSse`, timeout wiring, capability-gated enumeration.
- `src/core/mcp/names.ts` — `sanitizeMcpInvocationName`, `disambiguateInvocationName`.
- `src/core/mcp/runtime-tools.ts` — MCP tool definitions/execution, content→display/artifacts, registry memoization.
- `src/core/approvals/policy.ts` — `withMcpTrustRules` (trusted-server allow rules).
- `src/core/tools/builtins/mcp-status.ts` — the `mcp_status` tool.
- `src/core/tools/defaults.ts` — MCP tool registration + `resolveVisibleToolDefinitions`.
- `src/core/contracts/mcp.ts` — `mcpServerSummarySchema` / `MCPServerSummary`.
- `src/core/contracts/gateway.ts` + `src/gateway/runtime.ts` — the `mcp.list` request.
- `src/cli.ts` — the `/mcp` command.
- Tests: `tests/integration/mcp-manager.test.ts` (summarize + `mcp_status` via runtime,
  tools-only server, failed-server retry, raw-name routing, trust round-trip),
  `tests/unit/mcp-names.test.ts`, `tests/unit/mcp-transport.test.ts` (fallback predicate),
  `tests/unit/mcp-catalog.test.ts`, `tests/unit/mcp-runtime-tools.test.ts` (approval,
  content/artifacts, de-dup, memoization), `tests/unit/mcp-trust-rules.test.ts`,
  `tests/unit/tool-profile.test.ts` (lean `alwaysInclude`).
