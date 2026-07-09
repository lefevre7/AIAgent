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

| File | Role |
| --- | --- |
| `~/.aia/config.jsonc` | Base global layer. |
| `~/.aia/aia.config.jsonc` | Override global layer; also the canonical write/install target for `mcp install --user`. |

When both exist they are merged (`config.jsonc` first, `aia.config.jsonc`
overriding). Either one is optional. Each is parsed as a *fragment*, so it may
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
