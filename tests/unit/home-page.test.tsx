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
});

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
