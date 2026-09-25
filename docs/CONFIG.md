# Configuration & MCP servers

AIAgent builds its runtime config by deep-merging several layers. Later layers
override earlier ones; objects merge by key (so MCP servers, providers, etc.
combine across layers), while arrays and scalars are replaced wholesale.

## Layer precedence (lowest → highest)

1. Built-in defaults — `createDefaultAppConfig()` in `src/core/config/schema.ts`.
2. User-global config — `~/.aia/config.jsonc`, then `~/.aia/aia.config.jsonc`.
3. Workspace config — the nearest `aia.config.jsonc` found walking up from the cwd.
4. Environment overrides — `AIA_*` variables (see `src/core/config/env-overrides.ts`).

Secret references (`{ "source": "env" | "file" | "exec", "id": "…" }`) are
resolved after merging; any string-valued field, including MCP `headers`, accepts
either a literal string or a secret reference.

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
workspace can add or override servers locally.

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

Optional per-server fields:

- `timeoutMs` — request timeout (ms) applied to every SDK call to the server (connect,
  tool calls, listings). Omitted → the SDK default (60s).
- `trust` — `"prompt"` (default) or `"trusted"`. A trusted server's tools are
  auto-approved via a synthesized `mcp_server` allow rule; an explicit operator deny rule
  still wins, whether it targets the server (`mcp_server`) or a specific tool
  (`mcp_tool`/`tool`), so you can trust a server yet deny one of its tools. Otherwise every
  MCP tool call is gated by the approval policy — MCP tools are never silently executed on
  the strength of a server's `readOnlyHint`. See `docs/MCP.md`.

Servers can also be pulled in via `mcp.imports` (formats: `claude_desktop`,
`generic_mcp_servers_json`, `roo_project`) or injected for a single run with the
`AIA_MCP_CONFIG_JSON` environment variable.

The MCP manager watches every global and workspace config file (plus imported
files) and hot-reloads when they change, unless `mcp.watch` is set to `false`
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
`idleMs`, `readyPattern?`, `stabilityMs`, `turnTimeoutMs`) which wins over the defaults.
An agent with no `interactive` block can still run one-shot jobs but cannot start a session.

**The shipped `args` include the external agent's own approval-bypass flag**
(`--dangerously-skip-permissions` for Claude, `--dangerously-bypass-approvals-and-sandbox`
for Codex). That is deliberate and it lives in config precisely so you can delete it. Read
the security section of `docs/EXTERNAL_AGENTS.md` before leaving it enabled.

## Workspace config trust

Workspace config is discovered by walking **up** from the cwd, and a config file can
declare secret providers. The `exec` provider runs an arbitrary command; the `file`
provider reads an arbitrary path. Both are rebased against the config's own directory,
so merely running `aia` inside a cloned repo used to be enough to execute
`<repo>/payload.sh` with your environment (security review H3).

Those two provider kinds are therefore **inert until you trust the config**:

```bash
aia trust              # show the state and what trusting would allow; asks y/N at a terminal
aia trust --grant      # grant without asking (scripts, CI)
aia trust --revoke     # take it back
aia trust --cwd <path> # act on another workspace
```

- Bare `aia trust` never grants on its own. It prints the file, its hash, and one line
  per provider trusting would enable (`payload: runs /bin/sh -c '…'`,
  `keyfile: reads /path`), then asks `Trust this exact file now? [y/N]` when stdin is a
  terminal. Anything but `y`/`yes`, or no terminal at all, leaves it untrusted.
- Trust is keyed on the config's **path and the SHA-256 of its exact contents**, so a
  repo you trusted cannot silently grow an `exec` provider later — any edit revokes trust
  until you grant it again. `aia trust` prints the hash it is acting on.
- The record lives in `~/.aia/trust.json`, never in the workspace. A record stored inside
  the repo could simply be shipped pre-populated by whoever wrote the config.
- A `trust.json` that cannot be read or parsed fails closed with an
  `AIA_TRUST_STORE_UNREADABLE` warning: every workspace config is treated as untrusted,
  and `--grant`/`--revoke` refuse to rewrite it (that would erase every other grant it
  holds) until you fix or remove it.
- `env` providers are unaffected: they can only read the environment the process already
  has.
- Untrusted providers **fail closed and the load continues**, with one
  `AIA_UNTRUSTED_CONFIG` warning naming them. Nothing breaks unless a config value
  actually references one, in which case that resolution raises an error telling you to
  run `aia trust`.

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
