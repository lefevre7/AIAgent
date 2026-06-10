# Control Plane, Remote Access, and Channel Runtime

This note captures the current implementation state for AGENTS items 22 through 26.

## Web Control Plane

- The root Next.js page now renders a server-side dashboard over the shared runtime.
- The dashboard covers:
  - gateway health and auth mode
  - tunnel status and public exposure URLs
  - session listing and selected-session transcript/task state
  - pending/resolved approvals
  - operator message and steering forms
  - memory status and memory search
  - non-secret runtime settings
  - channel status/routes/deliveries
  - recent gateway event replay
- The UI is intentionally server-rendered first and uses plain HTML forms that post into the Express control-plane routes, so it does not depend on unfinished client SDK work.

## Control-Plane HTTP Surface

- `GET /api/control-plane/dashboard`
- `GET /api/control-plane/sessions`
- `GET /api/control-plane/sessions/:sessionId`
- `GET /api/control-plane/approvals`
- `GET /api/control-plane/memory`
- `GET /api/control-plane/channels`
- `GET /api/control-plane/gateway`
- `GET /api/control-plane/logs`
- `GET /api/control-plane/settings`
- `GET /api/control-plane/tunnel`
- `POST /api/control-plane/sessions`
- `POST /api/control-plane/sessions/:sessionId/messages`
- `POST /api/control-plane/sessions/:sessionId/steering`
- `POST /api/control-plane/approvals/:requestId/resolve`

Write endpoints return JSON by default and also support browser-form redirects through `redirectTo`.

## Remote Access Model

- Web/control-plane access uses the same shared-secret posture as the gateway:
  - if `gateway.auth.token` is configured, the token is required for remote web access
  - if no token is configured, only loopback callers are allowed
- Remote page access accepts:
  - `Authorization: Bearer <token>`
  - `x-aia-gateway-token`
  - `x-aia-web-token`
  - `?token=<token>` on the initial page hit
- A valid `?token=` on page requests is converted into an `HttpOnly` cookie and redirected to a cleaned URL.
- Gateway HTTP and WebSocket auth now accept bearer tokens consistently as well.

## Tunnel Status

- `TunnelService` is status-oriented for now: it does not launch a hosted tunnel provider itself.
- It derives remote exposure metadata from:
  - `tunnel.enabled`
  - `tunnel.provider`
  - `tunnel.publicBaseUrl` or `tunnel.hostname`
  - `gateway.auth.token`
- It reports public URLs for:
  - web `/`
  - gateway HTTP `/api/gateway`
  - gateway WebSocket `gateway.websocketPath`
- It also feeds public webhook URLs into the channel runtime where possible.

## Channel Runtime

- `ChannelService` is the shared channel framework for the four required channels:
  - Discord
  - WhatsApp
  - Microsoft Teams
  - BlueBubbles-backed iMessage
- The current shared responsibilities are:
  - route persistence under `.aia/channels/routes.json`
  - append-only delivery tracking under `.aia/channels/deliveries.jsonl`
  - per-channel capability and configuration health reporting
  - session binding and paired `channelThreadId` updates
  - inbound normalization handoff through adapters
  - outbound send tracking with success/failure snapshots
  - webhook endpoint exposure metadata
- The gateway now delegates `channel.list`, `channel.health`, and `channel.send` to this shared runtime when available.
- Inbound webhook messages emit `channel.message` gateway events and will enqueue a normal session run when they are already bound to an idle session.

## WhatsApp Adapter

- `WhatsAppChannelAdapter` is now implemented as a filesystem/session-directory bridge rooted at `channels.whatsapp.sessionDirectory`.
- Directory layout:
  - `inbound/` for inbound JSON envelopes to be polled
  - `processed/inbound/` for successfully consumed inbound envelopes
  - `failed/inbound/` for invalid or failed inbound envelopes
  - `media/inbound/` for copied inbound media artifacts referenced by session messages
  - `outbound/` for normalized outbound JSON envelopes emitted by the runtime
- Supported inbound payload shapes:
  - the native `ChannelMessage` contract
  - the adapter-specific bridge schema exported as `whatsappBridgeInboundEntrySchema`
- Gateway/channel behavior on top of the adapter:
  - first inbound contact auto-creates a tagged session and binds the channel identity to it
  - assistant replies are relayed back out as outbound bridge envelopes
  - pending approvals are rendered into channel prompts
  - `/approve`, `/deny`, `/cancel`, `/steer`, and `/help` are handled directly from inbound channel text
  - approval decisions resume the normal session loop by materializing the paused tool result first

## WhatsApp Testing

- Deterministic coverage lives in `tests/integration/whatsapp-channel.test.ts`.
- An opt-in smoke path lives in `tests/live/whatsapp-channel.live.test.ts`.
- Live invocation:
  - set `AIA_RUN_LIVE_WHATSAPP_TESTS=1`
  - optionally set `AIA_WHATSAPP_LIVE_SESSION_DIRECTORY=/path/to/bridge-dir`
  - run `npm run test:live:whatsapp`
- The live smoke uses the real adapter polling/send path and leaves the session-directory contract visible for manual inspection when a fixed directory is supplied.

## Channel Webhooks

- The shared webhook entrypoint is:
  - `POST /api/channels/:channel/webhook`
- Webhook routes are intentionally not protected by the web/gateway auth token because channel providers need public callback access.
- Adapter-specific verification remains the responsibility of each future channel adapter.

## Current Limits

- Discord, Teams, and BlueBubbles/iMessage adapters are still not implemented in-tree.
- The WhatsApp path is currently a local/session-directory bridge, not a hosted WhatsApp Cloud API webhook adapter.
- Outbound relay policy is intentionally conservative: only visible assistant messages and explicit approval/status prompts are mirrored back to the channel.
- Tunnel orchestration is still configuration-driven rather than process-managed.
