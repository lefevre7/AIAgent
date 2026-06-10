# Gateway Protocol

Last updated: 2026-03-31

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

If a subscribe payload includes a cursor, the gateway replays matching persisted events before continuing with live delivery.

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

## Auth

Gateway auth is transport-neutral and applied to both HTTP and WebSocket access.

- If `config.gateway.auth.token` is configured, that token is required everywhere.
- If no token is configured, loopback access is allowed and non-loopback access is rejected.
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

### Direct Tool Execution

`tool.execute` runs inside an existing session and creates a synthetic turn with trigger `gateway_request`.

The result is persisted through the normal session store so snapshots and later resumes see the same state as model-driven tool execution.

### Approvals

The gateway exposes:

- `approval.get`
- `approval.list`
- `approval.resolve`

Approval resolution uses actor `gateway` by default and can create denied-comment steering through the shared approval coordinator.

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
- `run.updated`
- `session.updated`
- `tool.updated`
- `turn.updated`

Replay only guarantees persisted events. Some live-only status events may still be emitted without replay persistence.

## Server Integration

The Next.js custom server and gateway share one HTTP server.

- Express mounts the HTTP debug routes under `/api/gateway`
- the same server handles gateway WebSocket upgrades
- non-gateway upgrade traffic falls back to Next's upgrade handler so dev/server WebSocket behavior is preserved

This keeps the local web surface and local gateway on the same port and process while still reusing the same core runtime seam planned for the future SDK.
