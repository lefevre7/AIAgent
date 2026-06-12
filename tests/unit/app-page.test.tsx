import React from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("@/server/runtime-context", () => ({
  getServerRuntimeContext: async () => ({})
}));

vi.mock("@/server/control-plane/service", () => {
  const baseStatus = {
    dirty: false,
    embeddings: { enabled: false, hardFailOnStartup: false, modelId: null, providerId: null, status: "unavailable" },
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
    lexical: { enabled: false, ready: false },
    modes: ["lexical"],
    sources: { chatSessionRoot: "/tmp/chat", extraPaths: [], includeSessionSummaries: true, userGlobalRoot: "/tmp/user", workspaceRoot: "/tmp/ws" }
  };
  const settings = {
    browser: { artifactRoot: "/tmp/b", headless: true, viewport: { height: 900, width: 1440 } },
    channels: [],
    gateway: { authRequired: false, hostname: "127.0.0.1", port: 3000, requestTimeoutMs: 120000, websocketPath: "/api/gateway/ws" },
    memory: { embeddingModel: null, embeddingProvider: "ollama", embeddingsEnabled: false, retrievalLimit: 8, stateRoot: "/tmp/s", userGlobalRoot: "/tmp/u", workspaceRoot: "/tmp/ws" },
    runtime: { defaultModel: "m", defaultProvider: "lm_studio", logLevel: "info", statusUpdates: true, verboseEvents: false },
    tunnel: { enabled: false, hostname: null, provider: "none", publicBaseUrl: null }
  };
  return {
    ControlPlaneService: class {
      async getDashboard(query: { memoryText?: string }) {
        return {
          approvals: [],
          bootstrap: { directories: [], name: "AIAgent", providers: [], surfaces: [] },
          channels: { deliveries: [], routes: [], statuses: [], webhookEndpoints: [] },
          gateway: { authMode: "loopback_only", health: { ok: true, phase: "bootstrap", surface: "gateway" }, status: { ok: true, status: "ready" }, websocketPath: "/api/gateway/ws" },
          logs: { events: [] },
          memory: { hits: [], query: query.memoryText ?? null, sessionId: null, status: baseStatus },
          sessions: { items: [], selected: null },
          settings,
          tunnel: { enabled: false, exposures: [], metadata: {}, provider: "none", publicBaseUrl: undefined, ready: false, warnings: [] }
        };
      }
    }
  };
});

import Page from "@/app/page";

describe("app router Page", () => {
  test("renders the dashboard and threads search params", async () => {
    const element = await Page({
      searchParams: Promise.resolve({ flash: "saved", memoryText: "query", sessionId: "session.1", token: "secret" })
    });
    const html = renderToString(element as React.ReactElement);
    expect(html).toContain("Web Control Plane");
    expect(html).toContain("saved");
  });

  test("handles absent search params", async () => {
    const element = await Page({});
    const html = renderToString(element as React.ReactElement);
    expect(html).toContain("AIAgent");
  });
});
