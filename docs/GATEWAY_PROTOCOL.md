# Gateway Protocol

Last updated: 2026-09-28

## Summary

The local gateway is the shared control-plane surface for the server, future SDK, and future web UI.

It exposes:

- request/response control topics over a single WebSocket connection
- live event subscriptions with replay-by-cursor
- HTTP debug/read routes for health, snapshots, approvals, and event replay
- the same core runtime used by the in-process server path

The implementation lives primarily in:

- `src/gateway/runtime.ts`
- `src/gateway/router.ts`
- `src/gateway/websocket.ts`

## Transport Model

### WebSocket

The main control-plane transport is a single WebSocket on `config.gateway.websocketPath`.

Clients send `GatewayRequest` envelopes and receive:

- a matching `GatewayResponse` envelope for each request
- unsolicited `GatewayEvent` envelopes for subscribed live events

Each connection has at most one active subscription filter. Sending `gateway.subscribe` replaces the current filter for that connection.

If a subscribe payload includes a cursor, the gateway replays matching persisted events after that cursor before continuing with live delivery. Without a cursor the subscription is live-only: the connection receives only matching events published after the subscribe. To read history instead, page through `GET /api/gateway/events` (or subscribe with the cursor of the last event you have).

#### Who listens

The dev/prod server (`src/server/start.ts`) attaches this WebSocket to its HTTP server on the configured
host and port. The **interactive CLI also serves it**, on loopback with an ephemeral port, and publishes
the URL (and, when no `gateway.auth.token` is configured, a per-launch token) in an owner-readable record
under `.aia/attach-endpoints/` — that is what lets `aia attach` join an external-agent terminal hosted by
a bare `aia` REPL rather than only by a running server. `aia attach` prefers the published endpoint, falls
back to the configured host/port, and honours an explicit `--url` above both. See
`docs/EXTERNAL_AGENTS.md`.

### HTTP

HTTP is kept for health and debug/read workflows:

- `GET /api/gateway/health`
- `GET /api/gateway/status`
- `GET /api/gateway/sessions/:sessionId/snapshot`
- `GET /api/gateway/approvals`
- `GET /api/gateway/approvals/:requestId`
- `GET /api/gateway/events`
- `POST /api/gateway/request`

`POST /api/gateway/request` accepts the same `GatewayRequest` envelope used on the WebSocket path.

A body the server cannot read gets the same `{ ok: false, error }` envelope as any other failure:
`400` with code `invalid_request` for malformed JSON, `413` for a body over 1 MB. It used to get
Express's HTML error page, with a stack trace in development.

## Auth

Gateway auth is transport-neutral and applied to both HTTP and WebSocket access.

- If `config.gateway.auth.token` is configured, that token is required everywhere.
- If no token is configured, loopback access is allowed and non-loopback access is rejected.
- Loopback is determined from the **socket peer address only**. `X-Forwarded-For` is client-supplied and
  is never consulted (security review H2).
- A server that binds a routable or unspecified address (`0.0.0.0` / `::`), or that enables a tunnel,
  **refuses to start** without a token (M13). A tunnel terminating in front of the gateway forwards to
  the loopback socket, so remote traffic is genuinely loopback by the time auth sees it — configuration
  is the only reliable signal that remote access is possible.
- Without a token, a request must also name this machine in its `Host` header (`localhost`,
  `*.localhost`, `127.x.x.x`, `[::1]`), and a request that sends `Origin` (a browser) must come from a
  loopback origin on the same port, a page this server served. Otherwise it gets `403` with code
  `forbidden`. A page on another site could otherwise open a WebSocket to the gateway (WebSockets are
  exempt from CORS) or drive it through a DNS-rebound name. Clients that are not browsers send no
  `Origin` and are unaffected.
- The CLI's loopback listener always requires a token: the configured one, or a per-launch token
  published in an owner-readable `.aia/attach-endpoints/<pid>.json`.
- HTTP accepts `Authorization: Bearer <token>`, raw `Authorization`, or `x-aia-gateway-token`.
- WebSocket accepts the same headers and also a `token` query parameter for browser-compatible auth.

## Runtime Semantics

### Shared Runtime

`GatewayRuntime` is the reusable control-plane service behind both HTTP and WebSocket adapters.

It owns:

- topic dispatch
- run tracking
- approval lookups and resolution
- session snapshots
- event persistence and replay
- live event fanout

### Runs

Gateway-originated async work is tracked as a `GatewayRunRecord`.

Implemented run kinds:

- `session_create`
- `session_message`
- `session_resume`
- `tool_execute`
- `session_cancel`

Rules:

- only one active gateway run may exist per session
- new work on a busy session returns `busy`
- `session.message`, `session.resume`, and `tool.execute` return quickly with an accepted run record
- clients follow progress through `run.updated` plus the normal message/tool/turn/session events
- every run reaches a terminal status (`cancelled`, `completed`, `failed`). A run that throws
  anywhere after the agent loop returns is finalized as `failed` with completion reason
  `session_failed`, and the session records the structured error. Nothing may leave a run
  non-terminal: a client waiting on `run.updated` has no other way to learn the run is over,
  and the run's session would stay permanently `busy`.
- `run.get` reads the current record for a run id. Terminal runs stay readable for the last
  100 runs, so a client that subscribes just after a run ends can still see that it finished
  instead of waiting for an event that will never come.
- `tool.updated` is emitted as each tool call settles, during the run, not batched after it.
- `run.cancel` / `session.cancel` stop the work, not only the bookkeeping: the in-flight model request
  is aborted, and no further tool call or turn starts (a tool call already running finishes). The run
  ends `cancelled`. Closing the runtime cancels active runs before it drains them. See
  [AGENT_LOOP.md](AGENT_LOOP.md).
- Steering injected while a run is active is delivered to that run at its next tool boundary.

### Direct Tool Execution

`tool.execute` runs inside an existing session and creates a synthetic turn with trigger `gateway_request`.

The result is persisted through the normal session store so snapshots and later resumes see the same state as model-driven tool execution.

When a direct call pauses for approval, `session.resume` after the approval runs that call and
completes the run (`tool_succeeded`, `tool_failed`, or `tool_awaiting_approval`). It does not start a
model turn: nothing asked the model to do anything. Approvals of calls the model made still resume the
model.

`tool.search` accepts `all: true` (gateway clients only) to return every registered tool;
`sdk.tools.list()` uses it. Without it the usual `limit` applies (default 10, at most 100), as for
the model's own `tool_search`.

### Interactive External-Agent Sessions

Long-lived external-agent terminals are driven through:

- `external_agent.session.start` / `send` / `read` / `stop` / `list`
- `external_agent.session.attach` — opens a desktop terminal window and returns the command it runs
- `external_agent.session.write` — relays one raw keystroke from an attached human terminal

`send` refuses, sending nothing, while the agent's screen shows a consent or menu screen (an update
offer, a trust question), and until the agent's own input prompt shows when its config names one
(`interactive.inputPattern`). Text sent to such a screen chooses one of its options.

`write` is deliberately separate from `send`: a human's bytes are not a turn. They are not
summarized, not counted, and they soft-lock _agent_ writes rather than being blocked by that
lock. `aia attach <id>` is a thin client over these topics plus the `tool.output.delta` stream,
so an attached window inherits gateway auth and works over a tunnel. See
[EXTERNAL_AGENTS.md](EXTERNAL_AGENTS.md).

### Approvals

The gateway exposes:

- `approval.get`
- `approval.list`
- `approval.resolve`

`approval.requested` is emitted the moment a tool pauses, so a surface can tell the operator
about the pause before the run yields.

Approval resolution uses actor `gateway` by default and can create denied-comment steering through the shared approval coordinator.

A request's `target` is the target that decided it; `metadata.evaluatedTargets` lists every target the
policy weighed (the command line with its argv, each resolved path, the tool…). `readApprovalTargets`
in `@/core/contracts` reads it, falling back to `target` for requests recorded before it existed. The
CLI and the dashboard show the full list. The dashboard resumes a session once its last pending
approval is resolved, as the CLI and channel `/approve` do.

## Event Model

Persisted replayable events use one opaque global cursor backed by `.aia/gateway/events.jsonl`.

Current topics:

- `approval.requested`
- `approval.resolved`
- `channel.message`
- `external_agent.updated`
- `gateway.status`
- `log.emitted`
- `memory.updated`
- `message.created`
- `message.reasoning` (persisted only when `payload.final === true`; see below)
- `run.updated`
- `session.updated`
- `tool.updated`
- `turn.updated`

Live-only (never persisted) topics: `message.delta`, `message.reasoning` deltas,
`tool.output.delta`, and `gateway.status`.

- `tool.output.delta` carries a raw chunk of a running process's output
  (`{ chunk, sessionId?, sourceId, sourceKind, stream }`). It is unpersisted because the
  process's combined log on disk is the durable copy; persisting per-chunk events would
  bloat the log without adding information. `sessionId` is the _agent_ session that owns
  the process, so session-filtered subscribers only see their own output. `sourceKind` is
  `command` for `exec_command` processes and `external_agent` for interactive external-agent
  sessions; `sourceId` is the command id or external session id respectively.
- `message.reasoning` is emitted twice over: unpersisted per-token deltas for live
  rendering, then exactly one **persisted** aggregate per turn with `payload.final === true`
  carrying the full text. Provider-native reasoning never enters the transcript, so this
  aggregate is the only durable record of it. Live consumers must skip `final` events or
  they will render the reasoning twice.

Replay only guarantees persisted events. Some live-only status events may still be emitted without replay persistence.

`log.emitted` with `metadata.code: "model_mismatch"` (and `requestedModel`, `answeredModel`,
`providerId`, `sessionId`) says the provider answered with a model other than the one requested, once
per session.

Subscribers are dispatched independently: an exception thrown by one listener is logged and
dropped rather than propagating back into whatever emitted the event. A subscriber must never
be able to abort the run it is observing.

## Server Integration

The Next.js custom server and gateway share one HTTP server.

- Express mounts the HTTP debug routes under `/api/gateway`
- the same server handles gateway WebSocket upgrades
- upgrades under `/_next/` (the dev server's hot-reload socket) get the same access check a dashboard
  page gets (so the browser's access cookie counts). A refused one is closed; an allowed one is left to
  Next's own upgrade listener, which Next's custom server adds to the HTTP server on its first request.
  The gateway's listener is added before the server takes requests, so it always runs first. Any other
  path is answered `404`; unknown paths used to be handed to Next's production upgrade handler, which is
  empty, and hung.
- the dashboard pages and the custom server share one runtime context per process
  (`getServerRuntimeContext` keeps it in a global slot). Next compiles pages with their own copy of the
  module, and the first page render used to build a second runtime: a second gateway, MCP manager
  (duplicate MCP server processes), channel pollers and events-log writer.

This keeps the local web surface and local gateway on the same port and process while still reusing the same core runtime seam planned for the future SDK.

## `session.compact` (added 2026-09-14)

Request payload: `{ sessionId }`. Response: `{ compactedThroughMessageId?, hiddenMessageCount, session, summary, summaryPath? }`.

Summarizes the session transcript into chat-session memory through the shared memory
lifecycle (trigger `manual`) and sets the session's compaction watermark so later model
requests no longer replay the summarized messages. Rejected with `busy` while the session
has an active run or pending approvals. Emits `session.updated` and `memory.updated`
(with `metadata.sessionId`). See `docs/AGENT_LOOP.md` → "Manual compaction".
