# MCP: discovery, status, and how the agent answers "what servers/tools do you have?"

Last updated: 2026-06-12

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

## Where things live

- `src/core/mcp/manager.ts` — `summarizeServers()`, statuses, catalog, connect/refresh.
- `src/core/tools/builtins/mcp-status.ts` — the `mcp_status` tool.
- `src/core/tools/defaults.ts` — MCP tool registration + `resolveVisibleToolDefinitions`.
- `src/core/contracts/mcp.ts` — `mcpServerSummarySchema` / `MCPServerSummary`.
- `src/core/contracts/gateway.ts` + `src/gateway/runtime.ts` — the `mcp.list` request.
- `src/cli.ts` — the `/mcp` command.
- Tests: `tests/integration/mcp-manager.test.ts` (summarize + `mcp_status` via runtime),
  `tests/unit/tool-profile.test.ts` (lean `alwaysInclude`).
