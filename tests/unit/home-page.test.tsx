import React from "react";

import { render, screen } from "@testing-library/react";

import { createBootstrapInfo } from "@/core";
import type { ControlPlaneDashboard } from "@/server/control-plane/service";
import { HomePage } from "@/web/home-page";

describe("HomePage", () => {
  it("renders the control-plane dashboard summary", () => {
    render(
      <HomePage
        dashboard={createDashboardFixture()}
        memoryText=""
        redirectTo="/"
      />
    );

    expect(screen.getByRole("heading", { level: 1, name: "AIAgent" })).toBeVisible();
    expect(screen.getByText("Web Control Plane")).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: "Gateway" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: "Create Session" })).toBeVisible();
  });

  it("renders placeholders, flash messages, and token/tunnel badges for an empty dashboard", () => {
    const { container } = render(
      <HomePage dashboard={tokenAuthDashboard()} flash="Saved." flashError="Oops." redirectTo="/" />
    );
    const html = container.innerHTML;
    expect(html).toContain("No sessions yet.");
    expect(html).toContain("No session selected.");
    expect(html).toContain("Saved.");
    expect(html).toContain("Oops.");
    expect(html).toContain("Remote token required");
    expect(html).toContain("needs setup");
  });

  it("renders a fully populated dashboard with transcript parts, events, and the live-stream script", () => {
    const { container } = render(<HomePage dashboard={populatedDashboard()} memoryText="test" redirectTo="/" />);
    const html = container.innerHTML;
    expect(html).toContain("Active Session");
    // summarizeMessage covered every part kind
    expect(html).toContain("plain text");
    expect(html).toContain("spoken words");
    expect(html).toContain("a picture");
    // memory hits: summary, and a truncated long body (ellipsis appended)
    expect(html).toContain("a memory");
    expect(html).toContain("…");
    // task state
    expect(html).toContain("2/5 complete");
    expect(html).toContain("write tests");
    // channel route + delivery summary
    expect(html).toContain("Tester");
    expect(html).toContain("hello from channel");
    // approvals: open one has an Approve button; resolved shows its decision
    expect(html).toContain("Approve");
    expect(html).toContain("approved");
    // tunnel warning + exposure
    expect(html).toContain("exposed publicly");
    // describeEvent output across many topics
    expect(html).toContain("a log line");
    expect(html).toContain("reasoning: thinking");
    expect(html).toContain("claude is succeeded");
    // live stream script embedded for the selected session
    expect(html).toContain("EventSource");
    expect(html).toContain("session.populated");
  });

  it("renders a selected session that has no task state, route, or transcript", () => {
    const { container } = render(
      <HomePage dashboard={selectedEmptyDashboard()} memoryText="no results" redirectTo="/" />
    );
    const html = container.innerHTML;
    expect(html).toContain("No task plan or working memory recorded for this session.");
    expect(html).toContain("No channel route bound to this session.");
    expect(html).toContain("No messages yet.");
    expect(html).toContain("No turns recorded yet.");
    expect(html).toContain("No approvals for this session.");
    expect(html).toContain("No memory hits for this query.");
  });
});

function tokenAuthDashboard(): ControlPlaneDashboard {
  const dashboard = createDashboardFixture() as unknown as Record<string, unknown>;
  dashboard.gateway = {
    authMode: "token" as const,
    health: { ok: true as const, phase: "bootstrap", surface: "gateway" as const },
    status: { ok: true as const, status: "ready" },
    websocketPath: "/api/gateway/ws"
  };
  dashboard.tunnel = { enabled: true, exposures: [], metadata: {}, provider: "none", publicBaseUrl: undefined, ready: false, warnings: [] };
  return dashboard as unknown as ControlPlaneDashboard;
}

function messageWithAllParts(id: string) {
  return {
    createdAt: "2026-06-10T00:00:00.000Z",
    id,
    metadata: {},
    parts: [
      { kind: "text", text: "plain text" },
      { kind: "markdown", markdown: "**bold**" },
      { kind: "status", state: "running", summary: "working" },
      { kind: "json", value: { a: 1 } },
      { kind: "audio", title: "clip", transcript: "spoken words", uri: "file:///a.wav" },
      { kind: "citation", title: "a source" },
      { kind: "file", title: "doc.txt", uri: "file:///doc.txt" },
      { kind: "image", alt: "a picture", uri: "file:///pic.png" }
    ],
    role: "assistant",
    sessionId: "session.populated",
    source: "model",
    tags: [],
    turnId: "turn.1",
    visibility: "default"
  };
}

function populatedDashboard(): ControlPlaneDashboard {
  const dashboard = createDashboardFixture() as unknown as Record<string, unknown>;
  const selectedRecord = {
    createdAt: "2026-06-10T00:00:00.000Z",
    cwd: "/workspace",
    goal: "Ship the feature",
    id: "session.populated",
    lastActiveAt: "2026-06-10T00:00:00.000Z",
    metadata: {},
    status: "running_model",
    tags: [],
    title: "Active Session",
    updatedAt: "2026-06-10T00:00:00.000Z"
  };

  dashboard.sessions = {
    items: [
      { goal: "g1", id: "session.populated", status: "awaiting_approval", title: "Caution", updatedAt: "2026-06-10T00:00:00.000Z" },
      { goal: "g2", id: "s2", status: "failed", title: "Error", updatedAt: "2026-06-10T00:00:00.000Z" },
      { goal: "g3", id: "s3", status: "completed", title: "Ok", updatedAt: "2026-06-10T00:00:00.000Z" },
      { goal: "g4", id: "s4", status: "running_model", title: "Info", updatedAt: "2026-06-10T00:00:00.000Z" }
    ],
    selected: {
      deliveries: [
        {
          channel: "whatsapp",
          direction: "outbound",
          id: "delivery.1",
          message: { parts: [{ kind: "text", text: "hello from channel" }] },
          status: "delivered"
        }
      ],
      route: { identity: { channel: "whatsapp", displayName: "Tester", roomId: "room-1", userId: "user-1" } },
      snapshot: {
        snapshot: {
          messages: [messageWithAllParts("message.1")],
          session: selectedRecord,
          toolCalls: [{ id: "tool.1", inputText: "run the thing", status: "succeeded", toolName: "shell_command" }],
          turns: [{ id: "turn.1", status: "completed", summary: "did work", trigger: "user" }]
        }
      },
      taskState: { nextStep: { text: "write tests" }, progress: { completed: 2, total: 5 }, summary: "halfway there" }
    }
  };

  dashboard.approvals = [
    {
      request: { id: "approval.open", justification: "needs approval", sessionId: "session.populated", status: "pending", target: { label: "shell_command" } },
      resolution: null
    },
    {
      request: { id: "approval.done", justification: "already resolved", sessionId: "session.populated", status: "resolved", target: { label: "write_file" } },
      resolution: { decision: "approved" }
    }
  ];

  dashboard.memory = {
    hits: [
      { entry: { content: "c", id: "m1", kind: "note", scope: "workspace", summary: "a memory" }, explanation: "matched" },
      { entry: { content: "x".repeat(400), id: "m2", kind: "fact", scope: "session", summary: undefined }, explanation: "matched too" }
    ],
    query: "test",
    sessionId: "session.populated",
    status: (createDashboardFixture() as unknown as { memory: { status: unknown } }).memory.status
  };

  dashboard.channels = {
    deliveries: [
      { channel: "whatsapp", direction: "inbound", id: "d1", message: { parts: [{ kind: "markdown", markdown: "**hi**" }] }, status: "received" }
    ],
    routes: [{ id: "route.1" }],
    statuses: [
      { capabilities: ["text", "media"], channel: "whatsapp", enabled: true, status: "ready" },
      { capabilities: [], channel: "slack", enabled: false, status: "disabled" }
    ],
    webhookEndpoints: [{ channel: "whatsapp", path: "/webhooks/whatsapp", publicUrl: "https://x/webhooks/whatsapp", status: "ready" }]
  };

  dashboard.tunnel = {
    enabled: true,
    exposures: [{ path: "/", publicUrl: "https://x/", requiresAuthentication: true, surface: "web" }],
    metadata: {},
    provider: "cloudflare",
    publicBaseUrl: "https://x",
    ready: true,
    warnings: ["exposed publicly"]
  };

  dashboard.logs = {
    events: [
      { createdAt: "2026-06-10T00:00:00.000Z", id: "e1", payload: { justification: "why", target: { label: "shell" } }, topic: "approval.requested" },
      { createdAt: "2026-06-10T00:00:00.000Z", id: "e2", payload: { actor: "operator", decision: "approved" }, topic: "approval.resolved" },
      { createdAt: "2026-06-10T00:00:00.000Z", id: "e3", payload: { direction: "inbound", identity: { channel: "whatsapp" }, parts: [{ kind: "text", text: "msg" }] }, topic: "channel.message" },
      { createdAt: "2026-06-10T00:00:00.000Z", id: "e4", payload: messageWithAllParts("m.created"), topic: "message.created" },
      { createdAt: "2026-06-10T00:00:00.000Z", id: "e5", payload: { delta: "streamed" }, topic: "message.delta" },
      { createdAt: "2026-06-10T00:00:00.000Z", id: "e6", payload: { delta: "thinking" }, topic: "message.reasoning" },
      { createdAt: "2026-06-10T00:00:00.000Z", id: "e7", payload: { kind: "message", status: "running" }, topic: "run.updated" },
      { createdAt: "2026-06-10T00:00:00.000Z", id: "e8", payload: { status: "running_model", title: "Active" }, topic: "session.updated" },
      { createdAt: "2026-06-10T00:00:00.000Z", id: "e9", payload: { status: "succeeded", toolName: "shell_command" }, topic: "tool.updated" },
      { createdAt: "2026-06-10T00:00:00.000Z", id: "e10", payload: { status: "completed", trigger: "user" }, topic: "turn.updated" },
      { createdAt: "2026-06-10T00:00:00.000Z", id: "e11", payload: { request: { agentId: "claude" }, status: "succeeded" }, topic: "external_agent.updated" },
      { createdAt: "2026-06-10T00:00:00.000Z", id: "e12", payload: { status: "ready" }, topic: "gateway.status" },
      { createdAt: "2026-06-10T00:00:00.000Z", id: "e13", payload: { message: "a log line" }, topic: "log.emitted" },
      { createdAt: "2026-06-10T00:00:00.000Z", id: "e14", payload: { entryId: "m1", scope: "workspace" }, topic: "memory.updated" }
    ]
  };

  return dashboard as unknown as ControlPlaneDashboard;
}

function selectedEmptyDashboard(): ControlPlaneDashboard {
  const dashboard = createDashboardFixture() as unknown as Record<string, unknown>;
  const record = {
    createdAt: "2026-06-10T00:00:00.000Z",
    cwd: "/workspace",
    goal: "Empty session",
    id: "session.empty",
    lastActiveAt: "2026-06-10T00:00:00.000Z",
    metadata: {},
    status: "idle",
    tags: [],
    title: "Empty",
    updatedAt: "2026-06-10T00:00:00.000Z"
  };
  dashboard.sessions = {
    items: [{ goal: "g", id: "session.empty", status: "idle", title: "Empty", updatedAt: "2026-06-10T00:00:00.000Z" }],
    selected: {
      deliveries: [],
      route: null,
      snapshot: { snapshot: { messages: [], session: record, toolCalls: [], turns: [] } },
      taskState: null
    }
  };
  dashboard.memory = {
    hits: [],
    query: "no results",
    sessionId: "session.empty",
    status: (createDashboardFixture() as unknown as { memory: { status: unknown } }).memory.status
  };
  return dashboard as unknown as ControlPlaneDashboard;
}

function createDashboardFixture(): ControlPlaneDashboard {
  return {
    approvals: [],
    bootstrap: createBootstrapInfo(),
    channels: {
      deliveries: [],
      routes: [],
      statuses: [],
      webhookEndpoints: []
    },
    gateway: {
      authMode: "loopback_only" as const,
      health: {
        ok: true as const,
        phase: "bootstrap",
        surface: "gateway" as const
      },
      status: {
        ok: true as const,
        status: "ready"
      },
      websocketPath: "/api/gateway/ws"
    },
    logs: {
      events: []
    },
    memory: {
      hits: [],
      query: null,
      sessionId: null,
      status: {
        dirty: false,
        embeddings: {
          enabled: false,
          hardFailOnStartup: false,
          modelId: null,
          providerId: null,
          status: "unavailable"
        },
        index: {
          chunkCount: 0,
          configFingerprint: null,
          documentCount: 0,
          embeddingDimensions: null,
          fileCount: 0,
          lastIndexedAt: null,
          schemaVersion: 1,
          sqlitePath: "/tmp/memory.sqlite"
        },
        lastCompaction: null,
        lexical: {
          enabled: false,
          ready: false
        },
        modes: ["lexical"],
        sources: {
          chatSessionRoot: "/tmp/chat",
          extraPaths: [],
          includeSessionSummaries: true,
          userGlobalRoot: "/tmp/user",
          workspaceRoot: "/tmp/workspace"
        }
      }
    },
    sessions: {
      items: [],
      selected: null
    },
    settings: {
      browser: {
        artifactRoot: "/tmp/browser",
        headless: true,
        viewport: {
          height: 900,
          width: 1440
        }
      },
      channels: [],
      gateway: {
        authRequired: false,
        hostname: "127.0.0.1",
        port: 3000,
        requestTimeoutMs: 120000,
        websocketPath: "/api/gateway/ws"
      },
      memory: {
        embeddingModel: null,
        embeddingProvider: "ollama",
        embeddingsEnabled: false,
        retrievalLimit: 8,
        stateRoot: "/tmp/state",
        userGlobalRoot: "/tmp/user",
        workspaceRoot: "/tmp/workspace"
      },
      runtime: {
        defaultModel: "gpt-5.4",
        defaultProvider: "lm_studio",
        logLevel: "info",
        statusUpdates: true,
        verboseEvents: false
      },
      tunnel: {
        enabled: false,
        hostname: null,
        provider: "none",
        publicBaseUrl: null
      }
    },
    tunnel: {
      enabled: false,
      exposures: [],
      metadata: {},
      provider: "none",
      publicBaseUrl: undefined,
      ready: false,
      warnings: []
    }
  };
}
