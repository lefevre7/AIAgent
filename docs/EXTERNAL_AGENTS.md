# External Agents

AIAgent can delegate work to other coding-agent CLIs (Claude Code, Codex, Mistral Vibe). There are two
distinct modes, and they serve different shapes of work:

|               | One-shot jobs                            | Interactive sessions                              |
| ------------- | ---------------------------------------- | ------------------------------------------------- |
| Tool actions  | `run`, `get`, `list`, `cancel`, `resume` | `start`, `send`, `read`, `stop`, `attach`, `list` |
| Process model | spawn per job, exit when done            | one long-lived PTY that outlives the turn         |
| Best for      | "write this file", "fix this test"       | back-and-forth work, or work you want to watch    |
| State         | `.aia/external-agents/jobs/<id>/`        | `.aia/external-agents/sessions/<id>/`             |

Both live on the same `external_agent` tool. Adding interactive mode did not change any one-shot behavior.

## Why a PTY, and why an emulator

Interactive mode runs the external CLI in a **pseudo-terminal** (`node-pty`), not a pipe.

CLIs check `isatty()`. Piped, Claude and Codex drop their TUI, stop prompting, and often refuse to run
at all. A PTY makes the child believe it is talking to a terminal, so it behaves exactly as it does in
your own shell.

The cost is that a PTY emits a byte stream full of ANSI escapes — cursor moves, colours, in-place
rewrites. Stripping escapes with a regex is the tempting shortcut and it is wrong: a spinner that
rewrote `working -` → `working \` → `working |` in place would come out as three lines of garbage, and
anything drawn with cursor addressing would come out scrambled.

So AIAgent feeds the stream through [`@xterm/headless`](https://www.npmjs.com/package/@xterm/headless),
a real terminal emulator with no DOM. It maintains a screen buffer and applies the escapes. `read` and
`send` return **the screen a human would see**, which is both smaller and more accurate than the raw
bytes.

`src/core/process/` owns this: `session.ts` (PTY/pipe lifecycle), `screen.ts` (the emulator wrapper),
`turn-watcher.ts` (turn boundaries), `terminal-window.ts` (the macOS window launcher).
`CommandRuntime` — which powers `exec_command` — uses the same `startProcessSession` primitive, so
there is exactly one PTY lifecycle in the codebase.

### If the PTY silently becomes a pipe

`startProcessSession` falls back to pipes when `node-pty` cannot spawn, because a platform without a
prebuilt native binary must still be able to run non-interactive children. Interactive sessions are
effectively dead in that mode — the CLI sees a pipe and never renders — so the fallback warns once per
process with `AIA_PTY_FALLBACK`, and `startSession` records `pty: false` on the session.

The most common cause on macOS is npm extracting `node-pty`'s prebuilt `spawn-helper` **without the
execute bit**, which makes every `pty.spawn` throw `posix_spawnp failed`. `npm run postinstall`
(`scripts/ensure-pty-helper.mjs`) repairs it and runs automatically after install.

## Knowing when a turn is over

A CLI does not announce that it finished thinking. Three weak signals are combined
(`TerminalTurnWatcher`):

1. **Byte idle** (`idleMs`) — no output for a while. Alone, this false-positives on any spinner, which
   keeps emitting bytes forever.
2. **Screen stability** (`stabilityMs`) — the _rendered screen_ is unchanged across two samples. This
   is what survives spinners: the frames overwrite each other, so the screen stops changing even while
   bytes keep arriving.
3. **Ready pattern** (`readyPattern`) — a regex matching the agent's prompt, e.g. `^>\s*$`. When it
   matches, the turn ends immediately. This is the fastest and most reliable signal, but it is
   per-agent and optional.

`turnTimeoutMs` bounds the wait. The result reports `turnEndReason: "idle" | "ready_pattern" | "timeout"`
so the model knows whether it got a real answer or just ran out of patience.

## Sharing the terminal with a human

An interactive session is not private to the agent. **Starting one opens a real terminal window on your
desktop**, running `aia attach <sessionId>`, so you and the agent are driving the same PTY from the first
turn. `external_agent { action: "attach" }` and the CLI's `/attach <id>` open one on demand as well —
useful after you have closed a window, or for a session started with auto-attach off.

That window is a thin relay over the existing gateway WebSocket: your keystrokes become
`external_agent.session.write` requests, and the session's output arrives as `tool.output.delta` events.
Because it rides the gateway, attaching inherits gateway auth and works over the tunnel surface.
Press **Ctrl-]** to detach without killing the session.

### Where the window connects (and why the CLI now listens)

`aia attach` is a _client_: the PTY lives in whichever process hosts the gateway, and the window dials in.
That used to mean windows only worked while `npm run dev` / `npm start` was running, because those were
the only places that attached the gateway WebSocket — a window opened from a bare `aia` REPL died on
`ECONNREFUSED` before showing anything.

The interactive CLI therefore serves the gateway itself, on **loopback with an ephemeral port**, and
publishes the URL to `.aia/attach-endpoint.json`. `aia attach` prefers that published endpoint, falls back
to the configured `gateway` host/port, and an explicit `--url` always wins.

- The ephemeral port means a running dev server on 3000 never blocks it.
- The record carries the CLI's pid; a record whose process is gone is ignored, so a crashed CLI cannot
  send a window to a dead listener.
- The listener is removed on exit.
- It is **loopback-only**, and — exactly like the dev server — unauthenticated unless `gateway.auth.token`
  is set. Any process on the machine can reach it. That is the same trust boundary the dev server has
  always had, but it now exists whenever you run `aia` interactively.
- If the listener cannot start, the REPL runs normally; only the shared window is unavailable.

### Auto-attach

`externalAgents.interactive.autoAttachOnStart` (**default true**) controls whether `start` opens the
window. Set it to `false` to keep sessions headless; `start` then prints the attach command as before.

Opening a window is **never allowed to fail the start**. On a host with no window server, or off macOS,
the session still starts and the result carries `attachError` alongside the normal session record — the
window is a convenience, not the session.

> **This reverses an earlier decision.** R4 in `AGENTS.md` said windows must never open by themselves
> ("a background agent that spawns windows is hostile"). The operator reversed it: the point of an
> interactive session is that a human and the agent share one terminal, and that cannot happen if someone
> has to notice a printed command first. Starting a session is still approval-gated (decision 32), so a
> window only ever appears for a session you approved.

Two writers need a rule. AIAgent uses a **soft write lock**: after a human keystroke, agent `send` calls
are refused for `humanLockMs` (default 10s) with a structured error telling the agent to wait. Human
input is never blocked and is never counted as a turn. Queuing the agent's write instead would be worse
— it would land in the middle of whatever you were typing.

## Turn summaries

A 40-line TUI screen is expensive context and mostly chrome. After each `send`, AIAgent spends one small
model call to reduce the screen to a paragraph (`createExternalAgentTurnSummarizer`). The full screen is
still returned; the summary just leads. If the summarizer fails, the turn still succeeds — a missing
summary is never fatal.

## Security: the bypass flags are on by default

**Read this before deploying.** The shipped interactive presets pass the external agent's own
approval-bypass flag:

- Claude: `--dangerously-skip-permissions`
- Codex: `--dangerously-bypass-approvals-and-sandbox`

This is a deliberate, operator-chosen default, not an oversight. An external agent that stops to ask its
_own_ approval questions inside a PTY that AIAgent is driving would deadlock on a prompt nobody answers.
Decision: external agents run in their own auto-approve mode, and AIAgent gates the thing that matters —
**opening the session**.

Consequences you are accepting:

- A started session can read, write, and execute anything the external CLI can, in its `cwd`.
- AIAgent's own approval policy does **not** apply to actions taken inside that session.

Mitigations in place:

- The flags are **visible config values** (`externalAgents.agents.<id>.interactive.args`), never
  hardcoded in spawn logic. Delete them and the agent runs with its normal prompts.
- `start` always resolves approval targets: the agent id, the resolved command, and the canonicalized
  `cwd`. A different `cwd` is a different approval. The command target includes the preset's
  `interactive.args`, so the bypass flags are part of what the operator approves and part of what an
  approval-policy rule matches against — a `deny` rule on `dangerously` refuses `start` while leaving
  the one-shot `run` path alone.
- `send`, `read`, `stop`, and `attach` are **not** separately approved. Re-asking every turn would make
  a conversation unusable, and consent was already given at `start`.
- Arguments are argv-only. No shell string is ever constructed, so there is no shell-injection surface.
- The environment is a real allowlist, shared by the one-shot and interactive paths
  (`buildExternalAgentEnvironment`, `src/core/external-agents/environment.ts`). A child gets a fixed
  floor — `PATH`, `HOME`, `SHELL`, `TERM*`, `LANG`/`LC_*`, `TMPDIR`, `TZ`, `USER`, proxy and CA
  variables — plus whatever the agent's own `passEnv` names and its `env` map sets. Nothing else in
  the operator's shell is inherited, which matters precisely because this agent runs with its own
  approvals bypassed.

> **Behaviour change (2026-09-21).** Both paths previously inherited the whole of `process.env`: the
> one-shot builder seeded from `{ ...process.env }` and then re-copied each `passEnv` key back into
> it, which is a no-op, and the interactive path passed no `env` at all — so it honoured neither
> `passEnv` nor `env`. If an agent of yours depended on an inherited variable, name it in that agent's
> `passEnv`.

### A second hazard: unexpected modal prompts

Observed on the first real live run. A freshly started `codex` did not show its chat prompt — it showed
an update notice:

```
  ✨  Update available! 0.155.0 -> 0.155.1
› 1. Update now (runs `brew upgrade --cask codex`)
  2. Skip
  3. Skip until next version
  Press enter to continue
```

Every `send` ends with a carriage return, so sending _anything_ into that screen accepted the
highlighted default and started a `brew upgrade`. Nothing malfunctioned; the terminal did exactly what
a human pressing Enter would have done.

The lesson generalizes beyond this one prompt: **a TUI's current screen is state, and the agent's next
keystroke is interpreted against it**. Consequences to design around:

- Read before you write. The first `send` after `start` should be preceded by a `read`, and the model
  should be told to check what is on screen rather than assume a prompt.
- A modal an agent cannot understand is exactly what `attach` is for — open the window and answer it
  yourself.
- Whatever the outer approval policy says, the external agent's blast radius is its own `cwd` **plus
  whatever its own UI can trigger**, which may include package managers and auth flows.

Confirmed again against Claude Code 2.1.153, which greets a fresh directory with **two** modals in a
row, and their option order is **inverted between them**:

```
 ❯ 1. Yes, I trust this folder          ❯ 1. No, exit
   2. No, exit                            2. Yes, I accept
```

The first is the workspace trust check; the second is the Bypass Permissions warning that
`--dangerously-skip-permissions` triggers. A caller that answers "2" to both accepts the first and
**exits** on the second. There is no safe fixed key sequence — the model has to read each screen.
`send` after either modal returns `turnEndReason: "exited"` if the child took the exit branch, so the
failure is at least immediate and named rather than silent.

### When the external CLI reports its own failure

A CLI can exit non-zero while still printing a well-formed result. Claude does this for auth
failures: `subtype: "success"`, a real `session_id`, and `is_error: true` with the message in
`result`. The session id used to be enough to classify the job `awaiting_resume`, which invited a
resume that would fail identically. A job whose agent reported `is_error` is now `failed`, carrying
the agent's own message and `retriable: false` (`external_agent_reported_failure`).

If every one-shot job comes back with `Failed to authenticate. API Error: 401`, the delegate CLI is
signed out — run `claude` and `/login`. Nothing in AIAgent can paper over that.

## Configuration

```jsonc
{
  "externalAgents": {
    "enabled": true,
    "interactive": {
      "cols": 120,
      "humanLockMs": 10000, // agent writes refused this long after a human keystroke
      "idleMs": 2000,
      "rows": 40,
      "sessionWarningThreshold": 4, // warn (do not block) past this many live sessions
      "stabilityMs": 1000,
      "terminalApp": "Terminal", // macOS app used by `attach`
      "autoAttachOnStart": true, // open the shared window as soon as a session starts
      "turnTimeoutMs": 600000
    },
    "agents": {
      "codex": {
        "kind": "codex",
        "command": "codex",
        "interactive": {
          // --no-alt-screen keeps the TUI inline, which makes both the screen
          // capture and the shared window far more readable.
          "args": ["--no-alt-screen", "--dangerously-bypass-approvals-and-sandbox"],
          "idleMs": 2000,
          "stabilityMs": 1000,
          "turnTimeoutMs": 600000
        }
      }
    }
  }
}
```

Per-agent `interactive` values win over the top-level defaults. An agent with no `interactive` block
(the shipped `mistral_vibe` preset) can still run one-shot jobs.

## Lifecycle and recovery

Sessions live until explicitly stopped — they are not reaped on idle, because "the agent is thinking"
and "the agent is idle" are indistinguishable from the outside. There is no concurrency cap, but a
warning is logged past `sessionWarningThreshold` and every session is visible in `list` / `/agents`.

Each session persists `session.json` and a full `terminal.log`. On startup any record still marked
`running` is swept to `stopped`: the process died with the previous host, and a record claiming
otherwise would be a lie the next `send` would trip over. `read` on an ended session returns the raw log
(escape sequences included — that is the honest record of what happened).

## Gateway and SDK

| Topic                           | Purpose                                            |
| ------------------------------- | -------------------------------------------------- |
| `external_agent.session.start`  | Start a session                                    |
| `external_agent.session.send`   | Send an instruction and wait for the turn          |
| `external_agent.session.read`   | Re-read the screen                                 |
| `external_agent.session.stop`   | Stop a session                                     |
| `external_agent.session.list`   | List sessions                                      |
| `external_agent.session.attach` | Open a desktop terminal window                     |
| `external_agent.session.write`  | Relay a raw human keystroke (used by `aia attach`) |

Live output streams as `tool.output.delta` with `sourceKind: "external_agent"` and
`sourceId: <externalSessionId>`. These events are emitted with `persist: false` — `terminal.log` is the
durable copy.

## Testing

- `tests/integration/external-agent-sessions.test.ts` — service lifecycle against a mock CLI whose
  interactive mode deliberately draws an in-place spinner, proving the rendered screen is reported.
- `tests/integration/external-agent-session-tools.test.ts` — the tool actions end to end.
- `tests/unit/process-terminal.test.ts` — screen reconstruction and turn detection.
- `tests/unit/external-agent-turn-summary.test.ts` — the summarizer.
- `tests/live/external-agent-interactive.live.test.ts` — a real CLI. Opt in with
  `AIA_LIVE_EXTERNAL_AGENT_INTERACTIVE=1` (`npm run test:live:external-agents-interactive`). It builds
  its agent from `DEFAULT_APP_CONFIG.externalAgents.agents.<preset>` so it exercises the configuration
  that actually ships, and it asserts `record.pty === true` — the assertion that caught the
  `spawn-helper` permission bug described above.
