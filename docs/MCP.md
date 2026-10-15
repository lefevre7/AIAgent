# MCP: discovery, status, and how the agent answers "what servers/tools do you have?"

Last updated: 2026-09-30

## How MCP is wired

1. **Config** — servers are declared in `aia.config.jsonc` (or `~/.aia/config.jsonc`)
   under `mcp.servers`. Each entry has a `type` (`stdio` | `streamable-http` | `sse` |
   `auto`), `enabled`, `required`, and transport details (command/args for stdio, url
   for HTTP).
2. **Manager** — `createMcpManagerFromLoadedConfig(...)` → `mcpManager.initialize()`
   starts connecting every enabled server in the background and waits for the required ones
   plus a short grace (see "Startup"). The manager tracks per-server status (`getServerStatuses()`: `state`,
   `transport`, capability counts, `error`), a capability catalog (`getCatalog()`),
   tool capabilities (`getToolCapabilities()`), and health (`getHealth()`).
3. **Registration** — MCP tools are composed into the agent's tool registry
   (`combineToolRegistries([base, dynamicMcpRegistry])`) with `kind:"mcp"` and
   `source.serverName`, so they are callable and searchable like any other tool.

## How the agent discovers MCP capabilities

- **`mcp_status`** (canonical) — lists every **configured** server with its connection
  `state`, `transport`, any connection `error`, and the tools it exposes. Crucially it
  includes **disabled and failed** servers, so the agent can answer "what MCP servers do
  you have?" and explain _why_ an expected server has no tools. Aliases:
  `list_mcp_servers`, `mcp_servers`.
- **`tool_search`** with `kinds:["mcp"]` — lists connected MCP _tools_ (returns
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
and the MCP tools themselves remain discoverable via `tool_search`, and become callable once
`tool_search` finds them. Until then `mcp_status` marks them `callable: false` ("not callable
yet") and gives the `tool_search` arguments that activate the server's tools
(`activateWith: { query: "<server>", limit: <its tool count> }`): listed as if callable, a
small model called them, was refused, and asked `mcp_status` again, in a loop. The agent loop
tells each tool call which tools the model can call that turn
(`RuntimeToolContext.callableToolNames`); a direct `tool.execute` call marks nothing.

The system prompt's "Working With Tools" section points the agent at `mcp_status` when
it is available (see `src/core/prompts/pack.tsx`).

## Operator surfaces

- **CLI, in a session**: `/mcp` lists servers (state, transport, error, tools);
  `/mcp reconnect <name>` drops a server's connection and connects it again now. The REPL
  prints one dim line for each server that fails or needs a sign-in, at startup and whenever
  it happens later (`· MCP context7 failed: spawn npx ENOENT — /mcp`).
- **CLI, standalone** (`aia mcp`, `src/commands/mcp.ts`):
  - `list [--json]` and `get <name> [--json]` show the configured servers without starting
    them: transport, command or URL, enabled, required, where each is defined, and whether an
    HTTP server is signed in (`auth`; a stdio server has none, so its JSON has no `auth`).
    Secret values, an OAuth `clientSecret` included, are masked in text **and** JSON (`*****`;
    a secret reference shows as the reference). Codex's `--json` prints them. A bare `aia mcp`
    prints this help.
  - `add <name> -- <command> [args...]`, `add <name> --url <url>`, `add <name> --template <id>`
    write an entry to the user-global config (`--workspace` for the workspace config) with
    `--env KEY=VALUE`, `--pass-env NAME`, `--header KEY=VALUE`, `--transport`. The entry is
    checked against the config schema first and the file's comments survive. The user file
    that already defines the server is the one edited; a new one goes to `~/.aia/config.jsonc`
    when it exists, else `~/.aia/aia.config.jsonc`. An existing server is replaced only with
    `--force`, and then whole (Codex overwrites silently): a merge kept the old entry's headers,
    an API key included, for the new URL. A name the other scope (user or workspace) defines is
    refused even with `--force`, since the loader would merge the two. Adding to a workspace
    config the operator already owns keeps its trust.
  - `remove <name> [--workspace]` removes it from every file of that scope that defines it.
  - Every edit is written atomically (a temporary file renamed into place, through a symlinked
    config to the file it points at), and a new file is readable by its owner only (0600).
  - `login <name> [--no-browser] [--scopes a,b]` and `logout <name>`: see "OAuth". Login reads
    the resolved config, so a header or client secret given as a secret reference is used.
  - `reconnect <name>` asks every running `aia` session of the workspace at once (through the
    loopback gateways they publish for `aia attach`) to reconnect the server; with none
    published it asks the configured gateway, where `aia serve` listens, with the configured
    token. It exits 1 when any of them could not be asked.
- **Gateway**: `mcp.list` returns `{ servers: McpServerSummary[] }`, shared with `mcp_status`
  through `MCPManager.summarizeServers()`; `mcp.reconnect { serverName }` returns the server's
  summary; the live-only `mcp.updated` event (`{ previousState?, server }`, where `server` is
  the summary without `tools` and `instructions`; ask `mcp.list` for those) fires on every
  state or tool-list change and reaches session-filtered subscribers too (a server serves every
  session). The SDK has the same through `sdk.request(...)` and `sdk.subscribe(...)`.

## Why a configured server can show no tools

If `mcp_status` / `/mcp` shows a server `failed`, `needs_login`, or `untrusted`, the error
beside it is the reason. For an `npx`-launched stdio server like `context7`:

- **`npx` not on the spawned `PATH`.** A stdio server gets only the base allowlist of aia's
  environment (see "Environment"). If `aia` was launched from a GUI rather than your shell,
  its `PATH` may lack your node/npm bin (nvm, fnm, Homebrew). Launch from a shell, use an
  absolute `command`, or set `PATH` in the server's `env`.
- **First-run download latency.** `npx -y …@latest` downloads the package first. Each phase
  of connecting gets `startupTimeoutMs` (default 30 s); raise it, or pre-install the package.
- **A variable the server needs is not passed.** API keys are not inherited; name them in
  `passEnv` (see "Environment").
- **A crash.** A server that exits shows `failed` with its exit code and the last lines of its
  stderr, and is retried (see "Crashes").

## Config knobs

Per server (`mcp.servers.<name>`). The name may use any characters (`brave search`,
`@playwright/mcp`), from 1 to 128 of them; where it becomes part of an id (a tool's, an event's)
it is slugged with a short hash of the original (`toMcpIdSegment`). A name with a space used to
crash the REPL through an event id, and a call to its tool left the session unreadable. An
imported file's server whose name is empty or longer is skipped with `[AIA_MCP_IMPORT_SKIPPED]`.

- **`startupTimeoutMs`** (default 30 000): each phase of connecting (starting and the
  handshake, then each listing) gets this long. Starting covers the transport's own start too:
  an SSE server that opens its stream and never names its endpoint used to hold the connect
  forever. **`toolTimeoutMs`** (default 300 000): how
  long a tool call, resource read, or prompt may go **without progress**; a server's progress
  notifications restart the clock, and it stops while the operator answers the server's
  question. **`timeoutMs`**, the older single setting, is used for both when they are unset.
- **`enabledTools`** / **`disabledTools`**: exact tool names as the server lists them.
  `enabledTools`, when set, is the whole list (even `[]`); `disabledTools` then removes names.
  Checked when listing and again when a call arrives, since a raw name reaches past the
  catalog (Codex does the same).
- **`passEnv`** (stdio): variables copied from aia's environment on top of the base allowlist.
- **`oauth`** (HTTP): `clientId`, `clientSecret` (a secret), `scopes`, `callbackPort`, for a
  server whose authorization server has no dynamic registration or wants fixed values.
- **`trust`**: `"prompt"` (default) or `"trusted"`; see "Approval & trust".

Top level (`mcp`):

- **`optionalStartupGraceMs`** (default 1 000): how long a request waits, from startup, for
  optional servers still connecting. `0` waits for each one's full startup timeout.
- **`passEnv`**: variables every stdio server gets. It needs workspace trust when a workspace
  config sets it: it would hand the operator's environment to the operator's own servers.
- **`elicitationTimeoutMs`** (default 600 000): how long a server's question waits for an
  answer before it is declined.
- **`watch`** (default `true`): reload when a config, import, trust, or credentials file
  changes.

Runtime (`runtime.modelSettings.supportsVision`): whether image content from an MCP tool is
forwarded to the model (default true) or summarized as `[image: …]`.

## Workspace trust (which configs may declare servers)

A stdio server's command runs the moment aia starts, and a workspace `aia.config.jsonc` is
discovered by walking up from cwd, so a cloned repo could run anything just by declaring a
server (security review M11). A workspace config therefore needs the same trust as its
`exec`/`file` secret providers before any of its `mcp.servers`, `mcp.imports`,
`mcp.templates`, or `mcp.passEnv` (even `[]`) take effect (`TRUST_GATED_MCP_KEYS` in
`src/core/config/trust.ts`; `docs/CONFIG.md` → "Workspace config trust" lists the other
settings gated the same way).

- **Untrusted, the layer is merged without those keys** (`withoutTrustGatedEntries`), so it can
  neither add a server nor change one from the user-global config (its command, url, or
  `trust`). `mcp.watch` is not gated. The user-global config is the operator's own and is
  never gated.
- **Withheld servers stay visible**: `mcp_status` and `/mcp` list them with state `untrusted`
  and an error naming the file, and calling one says why it did not start.
- **Granting**: `aia trust` shows exactly what trusting would run (`MCP server docs: runs npx -y
…`, with its `cwd`, its `env` (values whose names look like secrets hidden), its `passEnv`, the
  names of the headers it sends, and whether `trust: "trusted"` would auto-approve its tools;
  for an import, the servers the file declares), and `--grant` grants it. At a terminal the
  REPL asks before anything starts. Trust is keyed on the file's real directory and name and
  the SHA-256 of the exact text that was parsed, with each imported file's contents folded in,
  so editing the file or anything it imports revokes it.
- **Hot reload goes through the same gate.** The manager also watches `~/.aia/trust.json`, so
  a grant made in another terminal starts the servers on the next reload, and a model that
  edits the config revokes its trust rather than gaining a new process.
- **aia's own edits** (`installTemplate` into the workspace config) re-grant trust for the
  result only when the file was the operator's own before the edit: absent, declaring nothing
  gated, or trusted as-is (`isConfigTextOperatorOwned`). An untrusted file stays untrusted.

## Approval & trust

MCP tools are **always** `approvalMode: "ask"` — the server-reported `readOnlyHint` is
an advisory, untrusted annotation (per the MCP spec) and never grants silent execution
or bypasses operator deny rules. Each MCP tool call is evaluated by the approval policy,
which sees `mcp_server` and `mcp_tool` targets (`buildMcpApprovalTargets`, shared by every
path below so one rule matches all of them).

Built-ins that act _through_ a server are approved as that server's capability, through the
tool's `resolveApprovalScope`:

- **`web_search`** runs the connected MCP tool it selects under that tool's own approval: a
  trusted server or an allow rule runs it, otherwise the operator is asked, and a deny rule
  refuses it. The selected tool is pinned on the call (`approvalBinding`), so an approval
  resolved after the catalog changed fails with `web_search_backend_changed` instead of
  running a different tool. (It used to be `approvalMode: "never"` and run any tool that had a
  `query` field.)
- **`mcp_read_resource`** and **`mcp_read_resource_template`** still never ask, but they carry
  the server's `mcp_server` target, so an operator deny rule on the server refuses them too.

An `mcp_tool` target's value is `<server>.<tool>`: the configured server name and the tool's own name
as the server lists it (`docs.lookup` for the `lookup` tool of server `docs`). The `tool` target is
the invocation name the model sees (`mcp_docs_lookup`), and the `mcp_server` target is the server name.

To auto-approve a server you trust, set `trust: "trusted"` on it. The gateway
synthesizes an `mcp_server` **allow** rule for each trusted server and appends it _after_
your configured rules (`withMcpTrustRules` in `src/core/approvals/policy.ts`). An explicit
operator **deny** rule always wins: since 2026-09-14 the policy evaluates deny rules across
every target (`mcp_tool`, `mcp_server`, `tool`, `command`, `path`) before considering any
allow/ask rule, regardless of rule or target order. So you can trust a server yet still deny
one of its tools with an `mcp_tool` or `tool` deny rule.

## Startup

Servers connect in parallel and in the background (`src/core/mcp/manager.ts`). Startup
(`initialize()`, and every `refresh()`) waits for **required** servers, and fails if one fails,
plus the grace period for the rest. A server still connecting after that joins the catalog when
it connects: under the lean tool profile its tools are found through `tool_search` as soon as
they exist, so the tool list sent to the model does not change mid-run (no KV-cache churn);
under the full profile they appear from the next run. A call to a server still connecting
waits for it. The gateway gives each run the rest of the grace before it resolves its tools.

## Environment

A stdio server's environment is built by `buildChildProcessEnvironment`
(`src/core/process/environment.ts`, shared with external agents): the base allowlist, then
`mcp.passEnv`, then the server's `passEnv` (each copied only when set), then its `env`. The
allowlist is what a process needs to run at all: `HOME`, `PATH`, `SHELL`, `USER`, `LOGNAME`,
`TERM`, `TMPDIR`, `TZ`, `LANG`, `LANGUAGE` and the locale categories by name (`LC_ALL`,
`LC_CTYPE`, `LC_MESSAGES`, ...; not every `LC_*`, which sshd forwards by default), macOS's
`__CF_USER_TEXT_ENCODING`, the proxy variables in both cases, and Codex's list of CA-bundle
variables (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`,
`GIT_SSL_CAINFO`, ...). On Windows, names match in any case (`Path` is `PATH`), and
`SystemRoot`, `windir`, `ComSpec`, `PATHEXT`, and the profile folders (`USERPROFILE`,
`APPDATA`, `LOCALAPPDATA`, ...) are on it too. API keys and everything else in the operator's
shell are not inherited unless named; a `passEnv` entry must be a variable name.

## Crashes and reconnecting

When a connection drops (a stdio server exits, a stream closes), the server is marked `failed`
with the reason: the exit code or signal and the last five lines of stderr. It is retried after
1 s, then 2, 4, 8, and 16 s (Codex only reconnects its own apps server; other servers wait for
a config reload). After the fifth failed try it stays `failed` with a hint to run
`/mcp reconnect <name>`, which reconnects now and resets the count. A config reload also
retries every server that is not connected, and a sign-in made elsewhere (`aia mcp login`)
wakes the servers waiting on one: the manager watches the credentials file.

Each server's slot carries an epoch that moves on whenever its connection is replaced, so a
late connect, close event, or relist from an older connection never touches the newer one, and
a deliberate close is never taken for a crash.

## Tool lists

- **Listed in full.** `tools/list` and the other listings follow `nextCursor` to the end
  (Codex's default mode reads the first page only). A repeated cursor or 1 000 pages stops
  paging with a warning; a cursor over 64 KiB, or more than 2 048 tools, fails the server
  (Codex's limits). `enabledTools` narrows a server over the limit.
- **Relisted when they change.** A server that sends `notifications/tools/list_changed` (or the
  prompt and resource equivalents) is listed again through the SDK's debounced handler
  (`autoRefresh: false`, since the SDK's own refresh reads one page). Codex only logs these.
- **Schemas repaired, not rewritten** (`src/core/mcp/schema.ts`): only what is invalid changes,
  by Codex's rules. A bare `true`/`false` schema becomes `{ "type": "string" }`, `const` becomes a
  one-value `enum`, an unknown `type` is dropped and a missing one inferred, an object gets
  `properties: {}`, and unreferenced `$defs` are dropped. Every other keyword stays, the
  server's own `additionalProperties` included (the provider layer used to force `false` on
  every schema; it now fills `false` in only where a schema says nothing), and nothing is
  shrunk to a size budget: a local server turns the schema into a grammar, and a keyword
  dropped here is a constraint lost there. A tool whose root schema is not an object is skipped
  with an `[AIA_MCP_TOOL_SKIPPED]` warning, and the rest of the server loads.
- **Server instructions** (from `initialize`) show in `mcp_status`, `mcp.list`, and
  `tool_search` results (once per server), and `tool_search` ranks on them.

## HTTP transports

`connectMcpClient` (`src/core/mcp/connection.ts`) picks the transport from `type`: `stdio`,
`sse`, `streamable-http`, or `auto` (Streamable HTTP, falling back to SSE **only** on a 4xx
that is not 401/403, `shouldFallbackToSse`). Every HTTP request goes through `createMcpFetch`
(`src/core/mcp/http.ts`):

- `url` is http(s) only (an imported server is checked when it connects); plain http to another
  machine warns once (`AIA_MCP_INSECURE_URL`);
- configured headers reach every request to the server's own origin, the SSE stream's GET
  included, and never another origin: OAuth discovery, registration, and token requests go
  through this fetch too, to whichever authorization server the MCP server names;
- `User-Agent: aia-mcp-client/<version>`, and the handshake's clientInfo is
  `{ name: "aia", title: "AIAgent", version }` (it used to claim `0.1.0`);
- redirects are followed by hand, **same origin only**, at most 10, so a server cannot send the
  requests (and their credentials) elsewhere or downgrade https to http; a 303, and a 301/302
  answering a POST, continue as a GET without a body.

The handshake and each listing are tried again after 250 ms and 1 s when they fail
transiently (a network error, 408, 429, 5xx), never on 401/403. A Streamable-HTTP server that
answers 404 for our session has forgotten it: the manager connects again (once, however many
calls noticed) and replays the operation once, since a 404 means it never ran. Calls still in
flight on the forgotten session are left to get their own answer (and replay on a 404) before the
old connection is closed. A `tools/call` is otherwise never retried.

On macOS and Linux the stdio transport (`src/core/mcp/stdio-transport.ts`) starts the server in
its own process group (so a Ctrl-C meant for a turn does not kill it), stops the whole group on
close, drains stderr into a tail, and records how the process ended.

## OAuth

`aia mcp login <name>` signs in to an HTTP server (`src/core/mcp/oauth.ts`, on the SDK's
`OAuthClientProvider`):

1. The authorization server is discovered from the MCP server (protected-resource metadata,
   then the authorization server's metadata).
2. aia registers itself as a client with dynamic client registration, or uses the configured
   `oauth.clientId`/`clientSecret`. A configured secret stays in the config (or wherever its
   reference points); only the client id and the issuer it is bound to are stored.
3. The browser opens the authorization URL (PKCE S256, a random `state`), and only an http(s)
   one: `open` on macOS, `xdg-open` on Linux, `rundll32 url.dll,FileProtocolHandler` on Windows
   (`cmd /c start` would reparse the `&` between query parameters). The URL is printed through
   the terminal sanitizer either way. The callback listens
   on `127.0.0.1` only, on `/callback/<id>`, where the id is a hash of the server's URL, so a code
   issued for one server cannot complete another's sign-in (Codex's scheme). It waits up to 300 s.
   With `--no-browser` the URL is printed, and the address the browser ends on can be pasted
   back (for a browser on another machine).
4. The callback's `state` must match, or nothing is saved.

Tokens and the client registration go to `~/.aia/mcp-credentials.json`: mode 0600, refused
when the path is a symlink or not a regular file, keyed by server name **and** a hash of its
URL, and deleted when empty. What the SDK stamps on a token (the issuer, SDK 1.31) is stored
unchanged, so a refresh token is never presented to a different authorization server.

In a session, OAuth is used only for a server that has a stored sign-in or an `oauth` block,
and never over an `Authorization` header from config. Tokens are sent and refreshed (on a 401,
through the SDK); a session never registers a client or opens a browser. A server that needs a
sign-in shows `needs_login` with the command to run, and connects by itself once
`aia mcp login` has run anywhere. `aia mcp logout <name>` removes what is stored.

## Elicitation (a server asks the operator)

aia advertises form and URL elicitation. When a server asks during a call, the manager stops
that call's clock and hands the question to the gateway's broker (`src/gateway/elicitation.ts`),
which reuses the question approvals every surface already shows:

- A form becomes one question per field, in order: text and numbers typed, a boolean or a
  choice picked from options (by its label or value first, then by its number, so a label like
  "5" is never read as the fifth option), a multi-select as a comma-separated list. Denying a
  question declines the request; answering them all accepts it with typed values. A form with
  no fields is a confirmation: one Accept/Decline question, accepted only by an explicit yes
  (skipping it declines). A URL request is one question carrying the link.
- The CLI asks as soon as the question arrives, mid-turn (Ctrl-C cancels it, and the server is
  told at once), printing the question and its options through the terminal sanitizer. A
  question answered elsewhere, expired, or outlived by its turn stops waiting on stdin (its read
  used to take the operator's next line too), and an answer longer than an approval comment
  allows (2,000 characters) is asked for again; the web
  UI shows it as a pending approval; a channel conversation bound to the session gets it as a
  message, answered with `/approve <answer>` even while the run is busy. The first word of the
  answer is taken for a request id only when it is one (`approval.…`), so `/approve 3.5`
  answers 3.5, and a conversation can resolve only its own session's questions.
- With no one able to answer (no subscriber that shows approvals for the session, no channel;
  a one-shot `--prompt` run, say), the request is declined at once rather than holding the call.
  An unanswered question is declined after `mcp.elicitationTimeoutMs`, and cancelling the run
  cancels it.

## Tool search

`tool_search` ranks with BM25 (`src/core/tools/search.ts`) across the whole catalog, built-in
and MCP tools together, over names, titles, aliases, tags, descriptions, usage notes, the MCP
server's name and instructions, and argument names, weighted by field. `mcp_search` ranks MCP
capabilities (tools, resources, templates, prompts) with the same BM25 and words
(`src/core/text/search.ts`), so a query gets one order from either. Words are runs of Unicode
letters and digits, split on `_`, `-`, and camelCase (the query too) with plurals folded
(`files`, `patches`, `queries`), so "read files" and "readFile" meet `read_file`; two-character
names (`gh`, `s3`) count, single letters and common connectives match nothing alone; a word of
four or more letters counts partly when it begins a longer one; a query that is exactly a
tool's name or alias comes first.

A server's instructions are tokenized once per server and shared by its tools' entries, at the
lowest field weight and without adding to a tool's length (a server that writes long
instructions does not push its own tools down). They are not copied onto the tool definitions,
which travel in every model request. Each tool is indexed once for the life of its definition,
not on every search.

## Non-text tool output

`createMcpRuntimeTool.execute` lifts text and embedded-resource _text_ into the display,
emits `[image|audio|resource …]` placeholders for binary content, and, when an artifact root is
configured, persists image/audio/blob blocks as artifacts. Images reach the model when
`supportsVision` is not false.

## Where things live

- `src/core/mcp/manager.ts`: server slots and their lifecycle, startup grace, reconnects,
  relists, timed calls, session recovery, elicitation hook, statuses and summaries.
- `src/core/mcp/connection.ts`: transports, OAuth attachment, the stdio environment, timeouts.
- `src/core/mcp/enumerate.ts`: listings, limits, filters, schema repair, capabilities.
- `src/core/mcp/http.ts`: the fetch wrapper, retries, failure classification.
- `src/core/mcp/oauth.ts`: the credentials store, the OAuth provider, `loginToMcpServer`.
- `src/core/mcp/schema.ts`, `src/core/mcp/call-timer.ts`, `src/core/mcp/config-file.ts`.
- `src/core/process/environment.ts`: the child-process environment.
- `src/core/tools/search.ts`: BM25 `tool_search`; `src/core/text/search.ts`: the tokenizer and
  ranker it shares with `mcp_search` (`src/core/mcp/catalog.ts`) and memory search.
- `src/gateway/elicitation.ts`, `src/gateway/runtime.ts` (`mcp.list`, `mcp.reconnect`,
  `mcp.updated`), `src/commands/mcp.ts` (`aia mcp`), `src/cli.ts` (`/mcp`).
- Tests: `tests/integration/mcp-manager.test.ts`, `mcp-manager-lifecycle.test.ts` (startup,
  crash and reconnect, relist, filters, instructions, environment, timeouts, elicitation,
  limits), `mcp-oauth.test.ts` (login against a local authorization server, refresh, forged
  state), `gateway-mcp.test.ts`; `tests/unit/mcp-schema.test.ts`, `mcp-http.test.ts`,
  `mcp-oauth.test.ts`, `gateway-elicitation.test.ts`, `tool-search-bm25.test.ts`,
  `process-environment.test.ts`, and the `aia mcp` cases in
  `tests/integration/cli-interactive.test.ts`.
