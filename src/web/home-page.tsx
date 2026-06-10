import React from "react";

import type { ChannelDeliveryRecord, GatewayEvent, Message, TaskStateSnapshot } from "@/core/contracts";
import type { ControlPlaneDashboard } from "@/server/control-plane/service";

type HomePageProps = {
  dashboard: ControlPlaneDashboard;
  flash?: string;
  flashError?: string;
  memoryText?: string;
  redirectTo: string;
};

export function HomePage({ dashboard, flash, flashError, memoryText = "", redirectTo }: HomePageProps) {
  const selectedSession = dashboard.sessions.selected;
  const selectedSnapshot = selectedSession?.snapshot.snapshot;
  const selectedRecord = selectedSnapshot?.session;
  const selectedSessionId = selectedRecord?.id;
  const selectedApprovals = dashboard.approvals.filter(
    (approval) => approval.request.sessionId === selectedSessionId
  );

  return (
    <main className="cp-shell">
      <section className="cp-hero">
        <div>
          <p className="eyebrow">Web Control Plane</p>
          <h1>{dashboard.bootstrap.name}</h1>
          <p className="lede">
            One local dashboard for gateway health, sessions, approvals, steering, memory, logs, tunnel exposure, and
            channel routing.
          </p>
        </div>

        <div className="cp-badges" aria-label="Runtime summary">
          <span className={`badge ${dashboard.gateway.authMode === "token" ? "badge-caution" : "badge-ok"}`}>
            {dashboard.gateway.authMode === "token" ? "Remote token required" : "Loopback only"}
          </span>
          <span className={`badge ${dashboard.tunnel.ready ? "badge-ok" : "badge-muted"}`}>
            Tunnel {dashboard.tunnel.ready ? "ready" : dashboard.tunnel.enabled ? "needs setup" : "disabled"}
          </span>
          <span className="badge badge-info">{dashboard.sessions.items.length} sessions</span>
          <span className="badge badge-info">{dashboard.approvals.length} approvals</span>
        </div>
      </section>

      {flash ? <p className="flash flash-ok">{flash}</p> : null}
      {flashError ? <p className="flash flash-error">{flashError}</p> : null}

      <section className="stats-grid" aria-label="Status overview">
        <article className="stat-card">
          <h2>Gateway</h2>
          <p className="stat-value">{dashboard.gateway.status.status}</p>
          <p className="stat-copy">
            {dashboard.settings.gateway.hostname}:{dashboard.settings.gateway.port}
          </p>
          <p className="stat-copy">{dashboard.gateway.websocketPath}</p>
        </article>

        <article className="stat-card">
          <h2>Memory</h2>
          <p className="stat-value">{dashboard.memory.status.index.documentCount} docs</p>
          <p className="stat-copy">
            {dashboard.memory.status.lexical.enabled ? "Lexical index ready" : "Lexical search disabled"}
          </p>
          <p className="stat-copy">
            {dashboard.memory.status.embeddings.enabled
              ? `Embeddings ${dashboard.memory.status.embeddings.status}`
              : "Embeddings unavailable"}
          </p>
        </article>

        <article className="stat-card">
          <h2>Tunnel</h2>
          <p className="stat-value">{dashboard.tunnel.provider}</p>
          <p className="stat-copy">{dashboard.tunnel.publicBaseUrl ?? "No public base URL configured"}</p>
          <p className="stat-copy">{dashboard.tunnel.warnings[0] ?? "Remote exposure summary available below."}</p>
        </article>

        <article className="stat-card">
          <h2>Channels</h2>
          <p className="stat-value">{dashboard.channels.statuses.filter((status) => status.enabled).length} enabled</p>
          <p className="stat-copy">{dashboard.channels.routes.length} active routes</p>
          <p className="stat-copy">{dashboard.channels.deliveries.length} tracked deliveries</p>
        </article>
      </section>

      <section className="control-grid">
        <article className="panel">
          <div className="panel-heading">
            <h2>Create Session</h2>
            <p>Start a new session directly from the web control plane.</p>
          </div>
          <form action="/api/control-plane/sessions" method="post" className="stack-form">
            <input type="hidden" name="redirectTo" value={redirectTo} />
            <label>
              <span>Title</span>
              <input name="title" type="text" defaultValue="Web Session" required />
            </label>
            <label>
              <span>Goal</span>
              <textarea name="goal" rows={3} defaultValue="Continue the current task carefully." required />
            </label>
            <label>
              <span>Working directory</span>
              <input name="cwd" type="text" defaultValue={dashboard.settings.memory.workspaceRoot} required />
            </label>
            <label>
              <span>Initial message</span>
              <textarea name="initialMessage" rows={3} placeholder="Optional bootstrap message" />
            </label>
            <button type="submit">Create Session</button>
          </form>
        </article>

        <article className="panel">
          <div className="panel-heading">
            <h2>Sessions</h2>
            <p>Choose a session to inspect transcript, task state, approvals, and channel routing.</p>
          </div>
          {dashboard.sessions.items.length === 0 ? (
            <p className="empty">No sessions yet.</p>
          ) : (
            <div className="session-list">
              {dashboard.sessions.items.map((session) => (
                <a
                  key={session.id}
                  className={`session-card ${session.id === selectedSessionId ? "session-card-active" : ""}`}
                  href={`/?sessionId=${encodeURIComponent(session.id)}`}
                >
                  <div>
                    <strong>{session.title}</strong>
                    <p>{session.goal}</p>
                  </div>
                  <div className="session-meta">
                    <span className={`badge ${badgeClassForStatus(session.status)}`}>{session.status}</span>
                    <span>{formatTimestamp(session.updatedAt)}</span>
                  </div>
                </a>
              ))}
            </div>
          )}
        </article>

        <article className="panel">
          <div className="panel-heading">
            <h2>Memory Inspection</h2>
            <p>Inspect retrieval status and run a focused search across workspace and session memory.</p>
          </div>
          <form action="/" method="get" className="stack-form">
            {selectedSessionId ? <input type="hidden" name="sessionId" value={selectedSessionId} /> : null}
            {selectedSessionId ? <input type="hidden" name="memorySessionId" value={selectedSessionId} /> : null}
            <label>
              <span>Query</span>
              <input name="memoryText" type="text" defaultValue={memoryText} placeholder="Search memory" />
            </label>
            <button type="submit">Search Memory</button>
          </form>
          <div className="memory-summary">
            <p>
              Last compaction:{" "}
              {dashboard.memory.status.lastCompaction
                ? `${dashboard.memory.status.lastCompaction.trigger} on ${formatTimestamp(
                    dashboard.memory.status.lastCompaction.updatedAt
                  )}`
                : "none"}
            </p>
            <p>SQLite: {dashboard.memory.status.index.sqlitePath}</p>
          </div>
          {dashboard.memory.hits.length > 0 ? (
            <div className="list-stack">
              {dashboard.memory.hits.map((hit) => (
                <article key={hit.entry.id} className="memory-hit">
                  <header>
                    <strong>{hit.entry.kind}</strong>
                    <span>{hit.entry.scope}</span>
                  </header>
                  <p>{hit.entry.summary ?? truncate(hit.entry.content, 220)}</p>
                  <small>{hit.explanation}</small>
                </article>
              ))}
            </div>
          ) : memoryText ? (
            <p className="empty">No memory hits for this query.</p>
          ) : null}
        </article>

        <article className="panel">
          <div className="panel-heading">
            <h2>Settings</h2>
            <p>Current non-secret runtime configuration for the shared local product surfaces.</p>
          </div>
          <dl className="definition-list">
            <div>
              <dt>Model</dt>
              <dd>
                {dashboard.settings.runtime.defaultProvider} / {dashboard.settings.runtime.defaultModel}
              </dd>
            </div>
            <div>
              <dt>Gateway auth</dt>
              <dd>{dashboard.settings.gateway.authRequired ? "token" : "loopback only"}</dd>
            </div>
            <div>
              <dt>Browser</dt>
              <dd>{dashboard.settings.browser.headless ? "headless" : "headed"}</dd>
            </div>
            <div>
              <dt>Embeddings</dt>
              <dd>{dashboard.settings.memory.embeddingsEnabled ? "enabled" : "disabled"}</dd>
            </div>
            <div>
              <dt>Workspace root</dt>
              <dd>{dashboard.settings.memory.workspaceRoot}</dd>
            </div>
          </dl>
        </article>
      </section>

      <section className="detail-grid">
        <article className="panel panel-large">
          <div className="panel-heading">
            <h2>Selected Session</h2>
            <p>
              {selectedRecord
                ? `${selectedRecord.title} in ${selectedRecord.cwd}`
                : "Choose a session to see transcript, controls, and task state."}
            </p>
          </div>

          {!selectedRecord || !selectedSnapshot ? (
            <p className="empty">No session selected.</p>
          ) : (
            <>
              <div className="session-header">
                <div>
                  <h3>{selectedRecord.title}</h3>
                  <p>{selectedRecord.goal}</p>
                </div>
                <div className="session-meta">
                  <span className={`badge ${badgeClassForStatus(selectedRecord.status)}`}>{selectedRecord.status}</span>
                  <span>{formatTimestamp(selectedRecord.updatedAt)}</span>
                </div>
              </div>

              <div className="session-actions">
                <form action={`/api/control-plane/sessions/${encodeURIComponent(selectedRecord.id)}/messages`} method="post" className="stack-form">
                  <input type="hidden" name="redirectTo" value={redirectTo} />
                  <label>
                    <span>Message</span>
                    <textarea name="text" rows={3} placeholder="Send a new user message" required />
                  </label>
                  <button type="submit">Queue Message</button>
                </form>

                <form action={`/api/control-plane/sessions/${encodeURIComponent(selectedRecord.id)}/steering`} method="post" className="stack-form">
                  <input type="hidden" name="redirectTo" value={redirectTo} />
                  <label>
                    <span>Steering</span>
                    <textarea name="message" rows={3} placeholder="Inject operator guidance" required />
                  </label>
                  <button type="submit">Inject Steering</button>
                </form>
              </div>

              <div className="detail-columns">
                <section>
                  <h3>Task State</h3>
                  <TaskStateCard taskState={selectedSession.taskState} />
                </section>

                <section>
                  <h3>Transcript</h3>
                  <div className="list-stack">
                    {selectedSnapshot.messages.length === 0 ? (
                      <p className="empty">No messages yet.</p>
                    ) : (
                      selectedSnapshot.messages.map((message) => (
                        <article key={message.id} className={`message-card role-${message.role}`}>
                          <header>
                            <strong>
                              {message.role} / {message.source}
                            </strong>
                            <span>{formatTimestamp(message.createdAt)}</span>
                          </header>
                          <p>{summarizeMessage(message)}</p>
                        </article>
                      ))
                    )}
                  </div>
                  {selectedSessionId ? (
                    <div className="live-stream">
                      <h4>Live response</h4>
                      <pre id="live-reasoning-output" className="live-reasoning-output" aria-live="polite" />
                      <pre id="live-stream-output" className="live-stream-output" aria-live="polite" />
                      <script dangerouslySetInnerHTML={{ __html: buildLiveStreamScript(selectedSessionId) }} />
                    </div>
                  ) : null}
                </section>
              </div>

              <div className="detail-columns">
                <section>
                  <h3>Turns and Tools</h3>
                  <div className="list-stack">
                    {selectedSnapshot.turns.length === 0 ? (
                      <p className="empty">No turns recorded yet.</p>
                    ) : (
                      selectedSnapshot.turns
                        .slice()
                        .reverse()
                        .slice(0, 10)
                        .map((turn) => (
                          <article key={turn.id} className="list-card">
                            <header>
                              <strong>{turn.trigger}</strong>
                              <span>{turn.status}</span>
                            </header>
                            <p>{turn.summary ?? "No summary recorded."}</p>
                          </article>
                        ))
                    )}
                    {selectedSnapshot.toolCalls
                      .slice()
                      .reverse()
                      .slice(0, 6)
                      .map((toolCall) => (
                        <article key={toolCall.id} className="list-card">
                          <header>
                            <strong>{toolCall.toolName}</strong>
                            <span>{toolCall.status}</span>
                          </header>
                          <p>{toolCall.inputText ?? "No freeform input."}</p>
                        </article>
                      ))}
                  </div>
                </section>

                <section>
                  <h3>Approvals</h3>
                  <div className="list-stack">
                    {selectedApprovals.length === 0 ? (
                      <p className="empty">No approvals for this session.</p>
                    ) : (
                      selectedApprovals.map((approval) => (
                        <article key={approval.request.id} className="approval-card">
                          <header>
                            <strong>{approval.request.target.label}</strong>
                            <span>{approval.resolution ? approval.resolution.decision : approval.request.status}</span>
                          </header>
                          <p>{approval.request.justification}</p>
                          {!approval.resolution ? (
                            <form
                              action={`/api/control-plane/approvals/${encodeURIComponent(approval.request.id)}/resolve`}
                              method="post"
                              className="inline-form"
                            >
                              <input type="hidden" name="redirectTo" value={redirectTo} />
                              <input type="hidden" name="decision" value="approved" />
                              <button type="submit">Approve</button>
                            </form>
                          ) : null}
                        </article>
                      ))
                    )}
                  </div>
                </section>
              </div>

              <section>
                <h3>Channel Route</h3>
                {selectedSession.route ? (
                  <div className="route-card">
                    <p>
                      {selectedSession.route.identity.channel} / {selectedSession.route.identity.userId}
                    </p>
                    <p>{selectedSession.route.identity.displayName ?? "No display name"}</p>
                    <p>{selectedSession.route.identity.roomId ?? "Direct route"}</p>
                  </div>
                ) : (
                  <p className="empty">No channel route bound to this session.</p>
                )}
                <div className="list-stack">
                  {selectedSession.deliveries.map((delivery) => (
                    <article key={delivery.id} className="list-card">
                      <header>
                        <strong>{delivery.channel}</strong>
                        <span>{delivery.status}</span>
                      </header>
                      <p>{summarizeChannelDelivery(delivery)}</p>
                    </article>
                  ))}
                </div>
              </section>
            </>
          )}
        </article>

        <article className="panel">
          <div className="panel-heading">
            <h2>Tunnel and Webhooks</h2>
            <p>Remote exposure summary for the web control plane, gateway surfaces, and channel webhook endpoints.</p>
          </div>
          <div className="list-stack">
            {dashboard.tunnel.exposures.map((exposure) => (
              <article key={`${exposure.surface}:${exposure.path}`} className="list-card">
                <header>
                  <strong>{exposure.surface}</strong>
                  <span>{exposure.requiresAuthentication ? "auth" : "open"}</span>
                </header>
                <p>{exposure.publicUrl}</p>
              </article>
            ))}
            {dashboard.channels.webhookEndpoints.map((endpoint) => (
              <article key={`${endpoint.channel}:${endpoint.path}`} className="list-card">
                <header>
                  <strong>{endpoint.channel}</strong>
                  <span>{endpoint.status}</span>
                </header>
                <p>{endpoint.publicUrl ?? endpoint.path}</p>
              </article>
            ))}
          </div>
          {dashboard.tunnel.warnings.length > 0 ? (
            <ul className="warning-list">
              {dashboard.tunnel.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </article>

        <article className="panel">
          <div className="panel-heading">
            <h2>Channels and Events</h2>
            <p>Shared channel runtime status, route bindings, recent deliveries, and gateway event replay.</p>
          </div>
          <div className="list-stack">
            {dashboard.channels.statuses.map((status) => (
              <article key={status.channel} className="list-card">
                <header>
                  <strong>{status.channel}</strong>
                  <span>{status.status}</span>
                </header>
                <p>{status.capabilities.join(", ") || "No capabilities advertised."}</p>
              </article>
            ))}
          </div>
          <div className="list-stack">
            {dashboard.logs.events.map((event) => (
              <article key={event.id} className="log-card">
                <header>
                  <strong>{event.topic}</strong>
                  <span>{formatTimestamp(event.createdAt)}</span>
                </header>
                <p>{describeEvent(event)}</p>
              </article>
            ))}
          </div>
        </article>
      </section>
    </main>
  );
}

function TaskStateCard({ taskState }: { taskState: TaskStateSnapshot | null }) {
  if (!taskState) {
    return <p className="empty">No task plan or working memory recorded for this session.</p>;
  }

  return (
    <div className="task-card">
      <p>
        Progress: {taskState.progress.completed}/{taskState.progress.total} complete
      </p>
      <p>Next step: {taskState.nextStep?.text ?? "No explicit next step."}</p>
      <p>Summary: {taskState.summary ?? "No summary recorded."}</p>
    </div>
  );
}

function badgeClassForStatus(status: string): string {
  switch (status) {
    case "awaiting_approval":
    case "awaiting_tool_execution":
      return "badge-caution";
    case "cancelled":
    case "failed":
      return "badge-error";
    case "completed":
    case "idle":
      return "badge-ok";
    default:
      return "badge-info";
  }
}

function buildLiveStreamScript(sessionId: string): string {
  // sessionId matches the entity-id charset ([A-Za-z0-9._:-]); JSON-encoding it
  // keeps the inline script safe. Streams assistant deltas + tool activity live.
  return [
    "(function(){",
    `  var id = ${JSON.stringify(sessionId)};`,
    '  var out = document.getElementById("live-stream-output");',
    '  var reasoningOut = document.getElementById("live-reasoning-output");',
    '  if (!out || typeof EventSource === "undefined") { return; }',
    '  var es = new EventSource("/api/control-plane/events/stream?sessionId=" + encodeURIComponent(id));',
    "  es.onmessage = function(e){",
    "    try {",
    "      var ev = JSON.parse(e.data);",
    '      if (ev.topic === "message.delta") { out.textContent += ev.payload.delta; }',
    '      else if (ev.topic === "message.reasoning") { if (reasoningOut) { reasoningOut.textContent += ev.payload.delta; } }',
    '      else if (ev.topic === "tool.updated") { out.textContent += "\\n[tool] " + ev.payload.toolName + ": " + ev.payload.status + "\\n"; }',
    '      else if (ev.topic === "message.created" && ev.payload.role === "assistant") { out.textContent += "\\n"; }',
    "    } catch (err) {}",
    "  };",
    '  window.addEventListener("beforeunload", function(){ es.close(); });',
    "})();"
  ].join("\n");
}

function describeEvent(event: GatewayEvent): string {
  switch (event.topic) {
    case "approval.requested":
      return `${event.payload.target.label}: ${event.payload.justification}`;
    case "approval.resolved":
      return `${event.payload.decision} by ${event.payload.actor}`;
    case "channel.message":
      return summarizeChannelDelivery({
        channel: event.payload.identity.channel,
        direction: event.payload.direction,
        message: event.payload
      } as Pick<ChannelDeliveryRecord, "channel" | "direction" | "message"> & ChannelDeliveryRecord);
    case "message.created":
      return summarizeMessage(event.payload);
    case "message.delta":
      return event.payload.delta;
    case "message.reasoning":
      return `reasoning: ${event.payload.delta}`;
    case "run.updated":
      return `${event.payload.kind} is ${event.payload.status}`;
    case "session.updated":
      return `${event.payload.title} is ${event.payload.status}`;
    case "tool.updated":
      return `${event.payload.toolName} is ${event.payload.status}`;
    case "turn.updated":
      return `${event.payload.trigger} is ${event.payload.status}`;
    case "external_agent.updated":
      return `${event.payload.request.agentId} is ${event.payload.status}`;
    case "gateway.status":
      return event.payload.status;
    case "log.emitted":
      return event.payload.message;
    case "memory.updated":
      return `${event.payload.scope}:${event.payload.entryId}`;
  }
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString();
}

function summarizeChannelDelivery(delivery: Pick<ChannelDeliveryRecord, "channel" | "direction" | "message">): string {
  return `${delivery.direction} ${delivery.channel}: ${truncate(
    delivery.message.parts
      .map((part) => {
        switch (part.kind) {
          case "text":
            return part.text;
          case "markdown":
            return part.markdown;
          case "status":
            return part.summary;
          case "json":
            return JSON.stringify(part.value);
          case "audio":
            return part.transcript ?? part.title ?? part.uri;
          case "citation":
            return part.title;
          case "file":
            return part.title ?? part.uri;
          case "image":
            return part.alt ?? part.uri;
        }
      })
      .join(" "),
    180
  )}`;
}

function summarizeMessage(message: Message): string {
  return truncate(
    message.parts
      .map((part) => {
        switch (part.kind) {
          case "text":
            return part.text;
          case "markdown":
            return part.markdown;
          case "status":
            return `${part.state}: ${part.summary}`;
          case "json":
            return JSON.stringify(part.value);
          case "audio":
            return part.transcript ?? part.title ?? part.uri;
          case "citation":
            return part.title;
          case "file":
            return part.title ?? part.uri;
          case "image":
            return part.alt ?? part.uri;
        }
      })
      .join(" "),
    220
  );
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}…`;
}
