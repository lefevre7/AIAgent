# Configuration & MCP servers

AIAgent builds its runtime config by deep-merging several layers. Later layers
override earlier ones; objects merge by key (so MCP servers, providers, etc.
combine across layers), while arrays and scalars are replaced wholesale.

## Layer precedence (lowest → highest)

1. Built-in defaults — `createDefaultAppConfig()` in `src/core/config/schema.ts`.
2. User-global config — `~/.aia/config.jsonc`, then `~/.aia/aia.config.jsonc`.
3. Workspace config — the nearest `aia.config.jsonc` found walking up from the cwd.
   The directory holding it (or a lone `aia.approvals.jsonc`) is the workspace root; with
   neither, the workspace root is the directory `aia` started in. Relative defaults such as
   `./.aia` and `./memory` resolve against it, so `aia` started in `~` keeps its state in `~/.aia`.
4. Environment overrides — `AIA_*` variables (see `src/core/config/env-overrides.ts`).

The state directory (`memory.stateRoot`, `./.aia` by default) is created and checked for write access
before anything else starts, on every surface. When that fails, `aia` stops with the reason and where
the directory came from: the workspace config that set the workspace root, or, with no config found,
the directory `aia` started in, plus what to do instead (start somewhere writable, or set
`memory.stateRoot` / `AIA_MEMORY_STATE_ROOT`). It used to fail later, often after MCP servers had been
started, with an `EACCES` from wherever the first write happened.

Secret references (`{ "source": "env" | "file" | "exec", "id": "…" }`, or the
shorthand string `"${ENV_VAR}"`) are resolved after merging; any string-valued field,
including MCP `headers` and `providers.llamaCpp.apiKey`, accepts either a literal string
or a secret reference.

## Keeping secrets out of config files

A literal API key in a config file is readable by anything that can read the file (and
by any tool that prints the config). Reference it instead:

```jsonc
{
  "mcp": {
    "servers": {
      "drps-jira": {
        "type": "streamable-http",
        "url": "https://…/mcp",
        // from the environment; the shorthand for { "source": "env", "id": "DRPS_API_KEY" }
        "headers": { "x-drps-api-key": "${DRPS_API_KEY}" },
        "enabled": true,
        "required": false,
        "tags": []
      }
    }
  }
}
```

Or keep it in the macOS Keychain (`security add-generic-password -a "$USER" -s drps-api-key -w`
prompts for the value, so it never lands in your shell history), and read it with an `exec`
provider. Raw stdout is the secret, so the reference's id is `"value"`:

```jsonc
{
  "secrets": {
    "providers": {
      "keychain": {
        "source": "exec",
        "command": "/usr/bin/security",
        "args": ["find-generic-password", "-a", "you", "-s", "drps-api-key", "-w"]
      }
    }
  },
  "mcp": {
    "servers": {
      "drps-jira": {
        // …
        "headers": { "x-drps-api-key": { "source": "exec", "provider": "keychain", "id": "value" } }
      }
    }
  }
}
```

Declared in the user-global config, an `exec` provider needs no trust. Declared in a
workspace config, it does (see "Workspace config trust").

## Model providers

LM Studio (`providers.lmStudio`), llama.cpp (`providers.llamaCpp`), and Ollama
(`providers.ollama`) are built in; `runtime.defaultProvider` picks one. Each takes
`maxRetries` (default 3) and the stream timeouts; the two OpenAI-compatible ones also take
`requestExtras`. See `docs/PROVIDERS.md` for setup, llama.cpp's router mode and API key,
retries, and context-overflow recovery.

## Agent Skills

`skills` controls which Agent Skills (SKILL.md folders) the agent can load:

```jsonc
{
  "skills": {
    "bundled": true, // include bundled-skills/ (skill-creator)
    "disabled": [], // names or SKILL.md paths to list but never use
    "enabled": true, // false: no catalog, no `skill` tool, no `$name` mentions
    "extraRoots": [] // more roots; relative to this file's directory, or `~/`
    // "maxCatalogChars": 8000 // catalog budget; unset (the default) = 2% of the context window, or 8,000 when unknown
  }
}
```

Skills are always read from the project's `.aia/skills` and `.agents/skills` and from
`~/.aia/skills` and `~/.agents/skills`; `extraRoots` adds to those. Set in a workspace config,
`extraRoots` needs `aia trust`, and those roots are searched like the project's own: inside
the project only, ahead of yours. Other lists replace rather than merge, but
`skills.disabled` adds up across the files: a skill disabled in any of them stays disabled.
`aia skills disable <name>` adds it to your user config (`~/.aia/config.jsonc` when it exists),
and `aia skills enable <name>` removes it from every file that lists it, keeping their
comments. See `docs/SKILLS.md`.

## User-global config files

Two filenames are discovered inside `~/.aia`:

| File                      | Role                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `~/.aia/config.jsonc`     | Base global layer.                                                                       |
| `~/.aia/aia.config.jsonc` | Override global layer; also the canonical write/install target for `mcp install --user`. |

When both exist they are merged (`config.jsonc` first, `aia.config.jsonc`
overriding). Either one is optional. Each is parsed as a _fragment_, so it may
contain only the sections you want to set (e.g. just `mcp.servers`).

`AIA_USER_CONFIG_PATH` overrides discovery entirely: when set, that single file
is the only global layer read and the install target.

Filenames are defined by `GLOBAL_CONFIG_FILE_NAMES` in
`src/core/config/constants.ts`; path resolution lives in
`src/core/config/paths.ts` (`resolveConfigPaths`), and merging in
`src/core/config/load.ts`.

## Defining MCP servers

MCP servers are keyed by name under `mcp.servers`. Because servers merge by key
across layers, a server defined globally is available in every workspace, and a
**trusted** workspace can add or override servers locally. Until the workspace config
is trusted, its MCP entries are held back (see "Workspace config trust" below).

Stdio server:

```jsonc
{
  "mcp": {
    "servers": {
      "context7": {
        "type": "stdio",
        "enabled": true,
        "required": false,
        "tags": [],
        "command": "npx",
        "args": ["-y", "@upstash/context7-mcp@latest"]
      }
    }
  }
}
```

HTTP server (`type` is one of `auto`, `sse`, `streamable-http`):

```jsonc
{
  "mcp": {
    "servers": {
      "example": {
        "type": "streamable-http",
        "enabled": true,
        "required": false,
        "tags": [],
        "url": "https://example.org/mcp",
        "headers": { "x-api-key": { "source": "env", "id": "EXAMPLE_API_KEY" } }
      }
    }
  }
}
```

`url` must be `http://` or `https://`. Plain http to another machine works, but warns once
(`AIA_MCP_INSECURE_URL`): its headers and every tool call travel unencrypted. `headers` go only
to the server's own origin, never to an OAuth authorization server it points aia at.

Servers connect in parallel and in the background: startup waits only for `required` servers
and a short grace for the rest (see `docs/MCP.md`, "Startup"). A stdio server runs in its own
process group (on macOS and Linux), so the Ctrl-C that stops a turn in the REPL reaches `aia` only.
With `stderr: "pipe"` (the default) its stderr is drained continuously and the last few KB kept, so
a crash is reported with what the server said.

Optional per-server fields:

- `startupTimeoutMs` (default 30 000) — each phase of connecting (starting and the handshake,
  then each listing) gets this long.
- `toolTimeoutMs` (default 300 000) — how long a tool call may go without progress. Progress
  notifications restart it; it stops while you answer the server's question.
- `timeoutMs` — the older single setting; used for both of the above when they are unset.
- `enabledTools` / `disabledTools` — exact tool names as the server lists them. `enabledTools`,
  when set, is the whole list (even `[]`); `disabledTools` removes names from what is left.
- `passEnv` (stdio) — variables copied from aia's environment, on top of the base allowlist
  (`HOME`, `PATH`, `LANG` and the locale categories, proxies, CA bundles, ...; on Windows also
  `SystemRoot`, `ComSpec`, `PATHEXT` and the profile folders). Nothing else in your shell is
  inherited, API keys included; `env` sets values outright and wins. Each entry must be a
  variable name.
- `oauth` (HTTP) — `{ clientId?, clientSecret?, scopes?, callbackPort? }` for `aia mcp login`,
  when the server's authorization server has no dynamic client registration or wants
  specific scopes or a fixed redirect port. `clientSecret` may be a secret reference.
- `trust` — `"prompt"` (default) or `"trusted"`. A trusted server's tools are
  auto-approved via a synthesized `mcp_server` allow rule; an explicit operator deny rule
  still wins, whether it targets the server (`mcp_server`) or a specific tool
  (`mcp_tool`/`tool`), so you can trust a server yet deny one of its tools. An `mcp_tool` rule
  matches `<server>.<tool>`, the server's name and the tool's own name as the server lists it
  (`docs.lookup` for the `lookup` tool of server `docs`); a `tool` rule matches the invocation name
  the model sees (`mcp_docs_lookup`). Otherwise every
  MCP tool call is gated by the approval policy — MCP tools are never silently executed on
  the strength of a server's `readOnlyHint`. See `docs/MCP.md`.

Top-level `mcp` settings:

- `passEnv` — variables every stdio server gets. A workspace config needs trust to set it.
- `optionalStartupGraceMs` (default 1 000) — how long a request waits, from startup, for
  optional servers still connecting. `0` waits for each server's full startup timeout.
- `elicitationTimeoutMs` (default 600 000) — how long a server's question waits for your
  answer before it is declined.

`aia mcp add|remove` edit these entries for you (user config by default, `--workspace` for the
workspace one), keeping the file's comments: the user file that defines a server is the one
edited, and a new one goes to `~/.aia/config.jsonc` when it exists. Every edit is written
atomically, and a new file is created readable by its owner only (0600). `aia mcp login <name>`
signs in to an OAuth server and stores the tokens in `~/.aia/mcp-credentials.json` (mode 0600).
See `docs/MCP.md`.

Servers can also be pulled in via `mcp.imports` (formats: `claude_desktop`,
`generic_mcp_servers_json`, `roo_project`) or injected for a single run with the
`AIA_MCP_CONFIG_JSON` environment variable.

The MCP manager watches every global and workspace config file, imported files, the trust
store, and the MCP credentials file, and reloads when they change (a sign-in in another
terminal reconnects the servers that were waiting on it), unless `mcp.watch` is `false`
(useful for long-lived server processes that should not reconnect on unrelated edits).

Vision note: image content returned by MCP tools is forwarded to the model unless
`runtime.modelSettings.supportsVision` is `false` (see `docs/SMALL_MODELS.md`); set it
false for text-only local models so such content becomes a text placeholder instead.

## Reasoning in the context window

`runtime.reasoningContextTurns` (default `1`) controls how many of the most recent
turns keep their `<think>` reasoning in the request sent to the model. `1` keeps
only the current turn, so reasoning survives across that turn's tool results while
older deliberation stops consuming the window (and stops reinforcing plan/re-plan
loops). `0` removes reasoning from requests entirely.

This affects **only** what the model sees. The transcript on disk always keeps every
reasoning part, and provider-native reasoning is archived in the events log. See
`docs/AGENT_LOOP.md` → "Reasoning persistence".

## Interactive external agents

`externalAgents.passEnv` is a global environment allowlist applied to every agent, merged with each
agent's own `passEnv` (the agent's entry wins). Empty by default. A spawned agent otherwise sees only a
fixed floor of variables — see `docs/EXTERNAL_AGENTS.md` → "What an external agent can read" for the
floor, a starter list, and why there is no inherit-everything switch.

`externalAgents.interactive` holds the defaults for long-lived external-agent terminals:

| Key                       | Default      | Meaning                                                         |
| ------------------------- | ------------ | --------------------------------------------------------------- |
| `cols` / `rows`           | `120` / `40` | PTY size. The rendered screen the model reads is this size.     |
| `idleMs`                  | `2000`       | No output for this long counts toward turn end.                 |
| `stabilityMs`             | `1000`       | Rendered screen unchanged for this long counts toward turn end. |
| `turnTimeoutMs`           | `600000`     | Hard bound on one `send`.                                       |
| `humanLockMs`             | `10000`      | Agent writes are refused this long after a human keystroke.     |
| `sessionWarningThreshold` | `4`          | Warn (never block) past this many live sessions.                |
| `terminalApp`             | `"Terminal"` | macOS app opened by `attach`.                                   |
| `autoAttachOnStart`       | `true`       | Open the shared terminal window as soon as a session starts.    |

Each agent in `externalAgents.agents` may carry its own `interactive` block (`args`,
`idleMs`, `inputPattern?`, `readyPattern?`, `stabilityMs`, `turnTimeoutMs`) which wins over the
defaults. An agent with no `interactive` block can still run one-shot jobs but cannot start a session.

A send is refused while the bottom of the screen shows something that answers to Enter by choosing:
"Enter to confirm", "Press enter to continue", or a numbered menu with a selection cursor. The model
is told a person needs to attach and answer it. `inputPattern` (a regex source) goes further: when set,
a send is refused unless the bottom of the screen matches it, the CLI's own input prompt. The Codex
preset sets it to `Ask Codex to do anything`, and adds `-c check_for_update_on_startup=false` so Codex
does not open on its update screen, where a send once chose "Update now" and started `brew upgrade`.
If a Codex update changes that prompt, sends are refused with a message naming this key.

**The shipped `args` include the external agent's own approval-bypass flag**
(`--dangerously-skip-permissions` for Claude, `--dangerously-bypass-approvals-and-sandbox`
for Codex). That is deliberate and it lives in config precisely so you can delete it. Read
the security section of `docs/EXTERNAL_AGENTS.md` before leaving it enabled.

## Workspace config trust

Workspace config is discovered by walking **up** from the cwd, so a cloned repository can put
an `aia.config.jsonc` (and an `aia.approvals.jsonc`) in your path. Merely running `aia` inside
one used to be enough to execute `<repo>/payload.sh` through an `exec` secret provider
(security review H3), or a stdio MCP server's command (M11).

What a workspace config may only use once you trust it (`TRUST_GATED_SETTINGS` and friends in
`src/core/config/trust.ts`):

- `exec` and `file` secret providers (they run a command, read a path);
- `mcp.servers`, `mcp.imports`, `mcp.templates`, and `mcp.passEnv` (even `[]`, which would
  replace yours): a stdio server's command runs the moment aia starts;
- where model requests go and what they carry: `providers.lmStudio`/`llamaCpp`/`ollama`
  `baseUrl`, `headers`, `apiKey`, `requestExtras`, `embeddingsBaseUrl`, and the image and
  voice providers;
- `externalAgents`, `gateway`, `tunnel`, and `channels`;
- `skills.extraRoots` and `memory.extraPaths` (folders read into the model's context);
- any secret reference (`"${NAME}"` or `{ "source": …, "id": … }`) anywhere else, which
  would copy one of your environment variables into a setting.

Untrusted, the workspace layer is merged **without** those, and the rest of it applies.
It can neither start a server nor change one from your user-global config; withheld servers
show as `untrusted` in `/mcp` and `mcp_status`. One `AIA_UNTRUSTED_CONFIG` warning names what
was withheld. A value in your own config that references a provider the untrusted workspace
declares fails with an error saying so.

A workspace `aia.approvals.jsonc` is trusted the same way, but never replaces your settings:
its rules are added **after** yours, so it can add a refusal or a question but cannot override
one of your rules. Untrusted, its deny and ask rules and a `defaultMode` at least as strict as
yours apply; its allow rules and a looser `defaultMode` wait for trust.

```bash
aia trust              # show the state and what trusting would allow; asks y/N at a terminal
aia trust --grant      # grant without asking (scripts, CI)
aia trust --revoke     # take it back
aia trust --cwd <path> # act on another workspace
```

- `aia trust` covers both files. Bare `aia trust` never grants on its own: it prints each
  file, its hash, and one line per thing trusting would enable (`secret provider payload:
runs /bin/sh -c '…'`, `MCP server docs: runs npx -y …` with its `cwd`, `env` (values whose
  names look like secrets shown as `<hidden>`), `passEnv`, header names and `trust:
"trusted"`, the servers an import would load, each withheld setting, each approvals allow
  rule), then asks `Trust this exact file now? [y/N]` when stdin is a terminal. Anything but
  `y`/`yes`, or no terminal at all, leaves it untrusted. At a terminal the REPL asks the same
  before anything starts; a yes it cannot record starts untrusted, saying why.
- Trust is keyed on the file's **path and the SHA-256 of its exact contents**, plus the
  contents of every file its `mcp.imports` names, so any edit to the config or to an imported
  file revokes trust until you grant it again. The hash is of the exact text the loader
  parsed, not a second read.
- The path is the file's real directory plus its own name: a workspace config that is a
  symlink to a trusted file elsewhere needs a grant of its own, since its relative paths
  resolve where it sits.
- The record lives in `~/.aia/trust.json`, never in the workspace. A record stored inside
  the repo could simply be shipped pre-populated by whoever wrote the config.
- A `trust.json` that cannot be read or parsed fails closed with an
  `AIA_TRUST_STORE_UNREADABLE` warning: every workspace config is treated as untrusted,
  and `--grant`/`--revoke` refuse to rewrite it (that would erase every other grant it
  holds) until you fix or remove it.
- `env` secret providers are unaffected: they can only read the environment the process
  already has, and only through a reference, which is itself gated.
- No config, approvals, or import file may use a `__proto__`, `constructor`, or `prototype`
  key: one would set an object's prototype while parsing, hiding what is under it from these
  checks.

## Gateway exposure requires a token

`gateway.auth.token` is optional only for a loopback-bound gateway with no tunnel. The
server **refuses to start** without one when:

- `hostname` is a routable address, or
- `hostname` is `0.0.0.0` / `::` (every interface), or
- `tunnel.enabled` is `true`.

This was previously a warning, so the insecure configuration still came up and served
traffic (security review M13). It also covers the case header handling cannot: a tunnel
or reverse proxy terminating in front of AIAgent forwards to the loopback socket, so
remote requests _are_ genuinely loopback by the time the auth check sees them.

Without a token, a request that carries proxy forwarding headers (`Forwarded`,
`X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP`,
`CF-Connecting-IP`, `True-Client-IP`) is refused even on the loopback socket: that is what
an undeclared `cloudflared`, `ngrok`, `tailscale funnel`, or nginx in front of AIAgent
looks like. The headers' _values_ are never trusted — honouring `X-Forwarded-For:
127.0.0.1` was security review H2 — so their presence can only make a request less
trusted. A raw TCP tunnel adds no headers and stays indistinguishable from local traffic:
declare it with `tunnel.enabled` or set a token.

Without a token, being on this machine is the only credential, and every web page the operator opens
is on this machine too. So a tokenless request must also name this machine in its `Host` header
(`localhost`, `*.localhost`, `127.x.x.x` or `[::1]`), which keeps DNS-rebinding pages out, and a
browser request (one that sends `Origin`) must come from a page this server served (a loopback origin
on the same port). This covers the gateway WebSocket, the gateway HTTP API, the control-plane API and
the dashboard pages. It closes two holes: a page on another site opening a WebSocket to the gateway
(WebSockets are exempt from CORS), and a form on another site posting to `/api/control-plane`
(security review M1). Clients that are not browsers (the CLI, the SDK, `aia attach`, curl) send no
`Origin` and are unaffected. With a token, the token is the check, so a tunnel's own `Host` works.

The server's `hostname` and `port` default to `gateway.hostname` / `gateway.port`; `--hostname` /
`--port` and the `HOSTNAME` / `PORT` environment variables override them. A port already in use stops
the server with that reason instead of an uncaught error.

## Channel operator identities

Each channel takes `operatorIdentities`, the sender ids allowed to issue control
commands (`/approve`, `/deny`, `/cancel`, `/steer`):

```jsonc
"channels": {
  "whatsapp": {
    "enabled": true,
    "operatorIdentities": ["15551234567"],
    "sessionDirectory": "./.aia/channels/whatsapp"
  }
}
```

An entry may be a bare `userId` or a channel-qualified `channel:userId`. Matching ignores
case and surrounding whitespace.

**This fails closed: an empty list authorizes nobody**, and control commands from an
unlisted sender are refused with a message naming this setting. Without it, anyone who
could post into the bound conversation — the correspondent, or anyone able to write into
the bridge's inbound directory — could approve a pending dangerous tool call (security
review H6). Ordinary (non-command) messages are unaffected; they still reach the agent,
and they still hit the normal approval gate.
