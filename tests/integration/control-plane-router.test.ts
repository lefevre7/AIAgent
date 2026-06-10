import { EventEmitter } from "node:events";

import httpMocks from "node-mocks-http";
import { describe, expect, test, vi } from "vitest";

import { createControlPlaneRouter } from "@/server/control-plane/router";
import type { ControlPlaneService } from "@/server/control-plane/service";

describe("control-plane router", () => {
  test("serves the aggregated dashboard snapshot on loopback", async () => {
    const service = createServiceStub();
    const router = createControlPlaneRouter({
      service
    });
    const response = await invoke(router, httpMocks.createRequest({
      method: "GET",
      url: "/dashboard"
    }));

    expect(response.statusCode).toBe(200);
    expect(response._getJSONData()).toMatchObject({
      gateway: {
        status: {
          status: "ready"
        }
      },
      sessions: {
        items: []
      }
    });
    expect(service.getDashboard).toHaveBeenCalledOnce();
  });

  test("redirects form submissions back to the dashboard with flash state", async () => {
    const service = createServiceStub();
    const router = createControlPlaneRouter({
      service
    });
    const request = httpMocks.createRequest({
      body: {
        cwd: "/workspace",
        goal: "Test redirect handling",
        redirectTo: "/?sessionId=session.old.1",
        title: "Router Session"
      },
      method: "POST",
      url: "/sessions"
    });
    request.originalUrl = "/sessions";

    const response = await invoke(router, request);

    expect(response.statusCode).toBe(303);
    expect(response._getRedirectUrl()).toBe("/?sessionId=session.router.1&flash=Session+created.");
    expect(service.createSession).toHaveBeenCalledWith({
      cwd: "/workspace",
      goal: "Test redirect handling",
      initialMessage: undefined,
      title: "Router Session"
    });
  });
});

function createServiceStub() {
  return {
    createSession: vi.fn(async () => ({
      session: {
        id: "session.router.1"
      }
    })),
    getChannels: vi.fn(async () => ({
      deliveries: [],
      routes: [],
      statuses: [],
      webhookEndpoints: []
    })),
    getDashboard: vi.fn(async () => ({
      approvals: [],
      bootstrap: {
        directories: [],
        name: "AIAgent",
        providers: [],
        surfaces: []
      },
      channels: {
        deliveries: [],
        routes: [],
        statuses: [],
        webhookEndpoints: []
      },
      gateway: {
        authMode: "loopback_only",
        health: {
          ok: true,
          phase: "bootstrap",
          surface: "gateway"
        },
        status: {
          ok: true,
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
        ready: false,
        warnings: []
      }
    })),
    getGatewaySummary: vi.fn(async () => ({
      authMode: "loopback_only",
      health: {
        ok: true,
        phase: "bootstrap",
        surface: "gateway"
      },
      status: {
        ok: true,
        status: "ready"
      },
      websocketPath: "/api/gateway/ws"
    })),
    getLogs: vi.fn(async () => ({
      events: []
    })),
    getMemory: vi.fn(async () => ({
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
    })),
    getSessionView: vi.fn(async () => null),
    getSettingsSummary: vi.fn(async () => ({
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
    })),
    injectSteering: vi.fn(),
    listApprovals: vi.fn(async () => []),
    listSessions: vi.fn(async () => []),
    resolveApproval: vi.fn(),
    sendSessionMessage: vi.fn()
  } as unknown as ControlPlaneService;
}

async function invoke(
  router: ReturnType<typeof createControlPlaneRouter>,
  request: ReturnType<typeof httpMocks.createRequest>
) {
  Object.defineProperty(request.socket, "remoteAddress", {
    value: "127.0.0.1"
  });
  const response = httpMocks.createResponse({
    eventEmitter: EventEmitter
  });
  const handler = router as unknown as {
    handle: (request: unknown, response: unknown, next: (error?: unknown) => void) => void;
  };

  await new Promise<void>((resolve, reject) => {
    response.on("end", resolve);
    response.on("finish", resolve);

    handler.handle(request, response, (error: unknown) => {
      reject(error);
    });
  });

  return response;
}
