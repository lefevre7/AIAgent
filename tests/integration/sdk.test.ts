import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  DEFAULT_APPROVAL_SETTINGS,
  createDefaultAppConfig,
  type EmbeddingAdapter,
  type EmbeddingAdapterRegistration,
  type LanguageModelAdapter,
  type LanguageModelAdapterRegistration,
  type LoadedAIAgentConfig,
  type ProviderHealth
} from "@/core";
import {
  type GatewayRuntimeLike,
  type GatewayRuntimeProviderRegistrationHost
} from "@/gateway";
import { createAIAgentSdk, createAIAgentSdkFromConfig } from "@/sdk";
import {
  approvalRequestSchema,
  gatewayEventSchema,
  gatewayRequestSchema,
  gatewayResponseSchema,
  gatewaySessionSnapshotSchema,
  sessionRecordSchema,
  toolDefinitionSchema,
  type GatewayApprovalRecord,
  type GatewayEvent,
  type GatewayRequest,
  type GatewayResponse,
  type SessionRecord
} from "@/core/contracts";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

describe("node sdk", () => {
  test("wraps session control, approvals, steering, and live event streaming over the shared control plane", async () => {
    const runtime = createControlPlaneStub();
    const sdk = createAIAgentSdk({
      controlPlane: runtime
    });

    const created = await sdk.sessions.create({
      cwd: "/workspace",
      goal: "Implement the next task",
      initialMessage: {
        text: "Start"
      },
      metadata: {},
      title: "SDK Session"
    });

    expect(created.session.id).toBe("session.sdk.1");
    expect(created.handle.sessionId).toBe("session.sdk.1");
    expect(created.run?.run.status).toBe("queued");

    const messageIterator = created.handle.events({
      topics: ["message.created"]
    })[Symbol.asyncIterator]();
    runtime.emitEvent(
      buildMessageEvent({
        id: "message.other.1",
        sessionId: "session.other.1",
        text: "ignore"
      })
    );

    const matchingMessage = buildMessageEvent({
      id: "message.sdk.1",
      sessionId: created.handle.sessionId,
      text: "session-specific"
    });
    setTimeout(() => {
      runtime.emitEvent(matchingMessage);
    }, 0);

    await expect(messageIterator.next()).resolves.toMatchObject({
      value: matchingMessage
    });
    await messageIterator.return?.();

    setTimeout(() => {
      runtime.emitEvent(
        buildRunUpdatedEvent({
          runId: created.run!.runId,
          sessionId: created.handle.sessionId,
          status: "completed"
        })
      );
    }, 0);
    await expect(created.run!.wait()).resolves.toMatchObject({
      id: created.run!.runId,
      status: "completed"
    });

    const pendingApprovals = await created.handle.listPendingApprovals();
    expect(pendingApprovals).toHaveLength(1);
    expect(pendingApprovals[0]?.request.id).toBe("approval.sdk.1");

    const resolution = await created.handle.resolveApproval({
      decision: "approved",
      requestId: "approval.sdk.1"
    });
    expect(resolution.approval.resolution?.actor).toBe("sdk");

    const steering = await created.handle.injectSteering({
      message: "Prefer the safer path."
    });
    expect(steering.source).toBe("sdk");
    expect(steering.state).toBe("queued");

    const health = await sdk.gateway.health();
    expect(health).toEqual({
      ok: true,
      status: "ready"
    });

    const tools = await sdk.tools.list();
    expect(tools.map((tool) => tool.invocationName)).toContain("attempt_complete");
  });

  test("exposes raw gateway access and provider registration on the class instance", async () => {
    const runtime = createControlPlaneStub();
    const constructionTimeLanguageModel = createLanguageModelRegistration("registered_lm");
    const constructionTimeEmbedding = createEmbeddingRegistration("registered_embed");
    const sdk = createAIAgentSdk({
      controlPlane: runtime,
      providers: {
        embeddingAdapters: [constructionTimeEmbedding],
        languageModelAdapters: [constructionTimeLanguageModel]
      }
    });

    expect(runtime.embeddingRegistrations.map((entry) => entry.adapter.providerId)).toEqual(["registered_embed"]);
    expect(runtime.languageModelRegistrations.map((entry) => entry.adapter.providerId)).toEqual(["registered_lm"]);

    const gatewayEvents: GatewayEvent[] = [];
    const unsubscribe = await sdk.gateway.client.subscribe((event) => {
      gatewayEvents.push(event);
    });
    const liveEvent = buildMessageEvent({
      id: "message.gateway.1",
      sessionId: "session.sdk.1",
      text: "gateway"
    });
    runtime.emitEvent(liveEvent);
    unsubscribe();

    expect(gatewayEvents).toEqual([liveEvent]);

    const response = await sdk.gateway.client.request(
      buildGatewayRequest("gateway.health", {})
    );
    expect(response.ok).toBe(true);
    expect(response.topic).toBe("gateway.health");

    sdk.providers.registerLanguageModel(createLanguageModelRegistration("late_lm"));
    sdk.providers.registerEmbedding(createEmbeddingRegistration("late_embed"));

    expect(runtime.languageModelRegistrations.map((entry) => entry.adapter.providerId)).toEqual([
      "registered_lm",
      "late_lm"
    ]);
    expect(runtime.embeddingRegistrations.map((entry) => entry.adapter.providerId)).toEqual([
      "registered_embed",
      "late_embed"
    ]);
  });

  test("creates the sdk from loaded config with registered providers", async () => {
    const root = await createTempRoot();
    const workspaceRoot = path.join(root, "workspace");
    const userStateDirectory = path.join(root, "home", ".aia");
    const config = createDefaultAppConfig({
      userStateDirectory
    });
    config.browser.artifactRoot = path.join(root, "artifacts");
    config.memory.chatSessionRoot = path.join(workspaceRoot, "chat-session-memory");
    config.memory.embeddingProvider = "factory_embed";
    config.memory.sqlitePath = path.join(workspaceRoot, ".aia", "memory.sqlite");
    config.memory.stateRoot = path.join(workspaceRoot, ".aia");
    config.memory.userGlobalRoot = path.join(userStateDirectory, "memory");
    config.memory.workspaceRoot = path.join(workspaceRoot, "memory");
    config.providers.lmStudio.enabled = false;
    config.providers.ollama.enabled = false;
    config.runtime.defaultProvider = "factory_lm";

    const loaded: LoadedAIAgentConfig = {
      approvals: DEFAULT_APPROVAL_SETTINGS,
      config,
      paths: {
        globalApprovalsPath: path.join(root, "approvals.global.json"),
        globalConfigPath: path.join(root, "config.global.json"),
        userStateDirectory,
        workspaceApprovalsPath: path.join(workspaceRoot, "approvals.json"),
        workspaceConfigPath: path.join(workspaceRoot, "aiagent.config.json"),
        workspaceRoot
      },
      resolvedConfig: config,
      sources: {
        approvals: {
          env: false,
          global: null,
          workspace: null
        },
        config: {
          env: false,
          global: null,
          workspace: null
        }
      }
    };

    const sdk = await createAIAgentSdkFromConfig({
      cwd: workspaceRoot,
      loaded,
      providers: {
        embeddingAdapters: [createEmbeddingRegistration("factory_embed")],
        languageModelAdapters: [createLanguageModelRegistration("factory_lm")]
      }
    });

    await expect(sdk.gateway.health()).resolves.toEqual({
      ok: true,
      status: "ready"
    });

    await sdk.close();
  });
});

function buildGatewayRequest(requestTopic: GatewayRequest["topic"], payload: unknown): GatewayRequest {
  return gatewayRequestSchema.parse({
    createdAt: "2026-03-31T12:00:00.000Z",
    id: `gateway-request.${requestTopic}.1`,
    metadata: {},
    payload,
    topic: requestTopic
  });
}

function buildGatewayResponse(request: GatewayRequest, payload: unknown): GatewayResponse {
  return gatewayResponseSchema.parse({
    createdAt: "2026-03-31T12:00:00.000Z",
    id: `gateway-response.${request.topic}.1`,
    metadata: {},
    ok: true,
    payload,
    requestId: request.id,
    topic: request.topic
  });
}

function buildMessageEvent(params: { id: string; sessionId: string; text: string }): GatewayEvent {
  return gatewayEventSchema.parse({
    createdAt: "2026-03-31T12:00:00.000Z",
    cursor: `cursor.${params.id}`,
    id: `message-created.${params.id}`,
    metadata: {},
    payload: {
      createdAt: "2026-03-31T12:00:00.000Z",
      id: params.id,
      metadata: {},
      parts: [{ kind: "text", text: params.text }],
      role: "assistant",
      sessionId: params.sessionId,
      source: "assistant",
      tags: [],
      visibility: "default"
    },
    topic: "message.created"
  });
}

function buildRunUpdatedEvent(params: {
  runId: string;
  sessionId: string;
  status: "cancelled" | "completed" | "failed" | "queued" | "running";
}): GatewayEvent {
  return gatewayEventSchema.parse({
    createdAt: "2026-03-31T12:00:01.000Z",
    cursor: `cursor.${params.runId}.${params.status}`,
    id: `run-updated.${params.runId}`,
    metadata: {},
    payload: {
      createdAt: "2026-03-31T12:00:00.000Z",
      id: params.runId,
      kind: "session_create",
      metadata: {},
      sessionId: params.sessionId,
      status: params.status,
      updatedAt: "2026-03-31T12:00:01.000Z"
    },
    topic: "run.updated"
  });
}

function buildSession(sessionId = "session.sdk.1"): SessionRecord {
  return sessionRecordSchema.parse({
    createdAt: "2026-03-31T12:00:00.000Z",
    cwd: "/workspace",
    goal: "Implement the next task",
    id: sessionId,
    lastActiveAt: "2026-03-31T12:00:00.000Z",
    metadata: {},
    status: "idle",
    tags: [],
    title: "SDK Session",
    updatedAt: "2026-03-31T12:00:00.000Z"
  });
}

function createControlPlaneStub(): GatewayRuntimeLike &
  GatewayRuntimeProviderRegistrationHost & {
    embeddingRegistrations: EmbeddingAdapterRegistration[];
    emitEvent(event: GatewayEvent): void;
    languageModelRegistrations: LanguageModelAdapterRegistration[];
    requests: GatewayRequest[];
  } {
  const listeners = new Set<(event: GatewayEvent) => void>();
  const requests: GatewayRequest[] = [];
  const session = buildSession();
  const approval = approvalRequestSchema.parse({
    createdAt: "2026-03-31T12:00:00.000Z",
    id: "approval.sdk.1",
    justification: "Approval required for the risky action.",
    metadata: {},
    riskSummary: "Medium risk",
    sessionId: session.id,
    status: "pending",
    target: {
      kind: "tool",
      label: "write_file",
      value: "write_file"
    },
    turnId: "turn.sdk.1"
  });
  const toolDefinition = toolDefinitionSchema.parse({
    annotations: {
      meta: {},
      readOnlyHint: true,
      title: "Attempt Complete"
    },
    approvalMode: "never",
    descriptor: {
      approvalNotes: "No approval required.",
      examples: ["Use when the task is done."],
      purpose: "Signal task completion.",
      sideEffectSummary: "Marks the task as complete without modifying external systems.",
      whenNotToUse: ["Do not use before validation is complete."],
      whenToUse: ["Use after the work is complete."]
    },
    description: "Mark the current task as complete.",
    displayName: "Attempt Complete",
    execution: {
      inputMode: "json",
      resumable: false,
      taskSupport: "forbidden"
    },
    idempotent: true,
    inputSchema: {
      additionalProperties: false,
      type: "object"
    },
    invocationName: "attempt_complete",
    kind: "built_in",
    metadata: {},
    name: "attempt_complete",
    outputKind: "json",
    outputSchema: {
      additionalProperties: false,
      type: "object"
    },
    retryable: true,
    searchTags: ["complete"],
    sideEffects: ["none"],
    source: {
      displayName: "Built-in Tools",
      kind: "built_in"
    },
    streamingMode: "none",
    toolId: "tool.builtin.attempt_complete",
    usageGuidance: "Use after the task is fully complete.",
    version: "1.0.0"
  });

  const embeddingRegistrations: EmbeddingAdapterRegistration[] = [];
  const languageModelRegistrations: LanguageModelAdapterRegistration[] = [];

  return {
    embeddingRegistrations,
    emitEvent(event) {
      for (const listener of listeners) {
        listener(event);
      }
    },
    getApprovalRecord: async () => ({
      request: approval
    }),
    getSessionSnapshot: async () =>
      gatewaySessionSnapshotSchema.parse({
        snapshot: {
          approvalRequests: [approval],
          approvalResolutions: [],
          messages: [],
          resumeMetadata: null,
          session,
          steeringInjections: [],
          toolCalls: [],
          turns: [],
          voiceCaptures: [],
          voicePlaybacks: [],
          voiceTranscriptions: []
        },
        taskState: null
      }),
    languageModelRegistrations,
    listApprovalRecords: async () => [{ request: approval }] satisfies GatewayApprovalRecord[],
    registerEmbeddingAdapter(registration) {
      embeddingRegistrations.push(registration);
    },
    registerLanguageModelAdapter(registration) {
      languageModelRegistrations.push(registration);
    },
    replayEvents: async () => ({
      events: []
    }),
    request: async (request) => {
      requests.push(request);

      switch (request.topic) {
        case "approval.get":
          return buildGatewayResponse(request, {
            request: approval
          });
        case "approval.list":
          return buildGatewayResponse(request, {
            approvals: [{ request: approval }]
          });
        case "approval.resolve":
          return buildGatewayResponse(request, {
            approval: {
              request: approval,
              resolution: {
                actor: (request.payload as { actor?: string }).actor ?? "sdk",
                decidedAt: "2026-03-31T12:00:02.000Z",
                decision: (request.payload as { decision: string }).decision,
                id: "approval-resolution.sdk.1",
                metadata: {},
                requestId: approval.id
              }
            }
          });
        case "gateway.health":
          return buildGatewayResponse(request, {
            ok: true,
            status: "ready"
          });
        case "memory.query":
          return buildGatewayResponse(request, {
            hits: []
          });
        case "run.cancel":
        case "session.cancel":
          return buildGatewayResponse(request, {
            run: {
              createdAt: "2026-03-31T12:00:00.000Z",
              id: request.topic === "run.cancel" ? (request.payload as { runId: string }).runId : "run.cancelled.1",
              kind: "session_cancel",
              metadata: {},
              sessionId: session.id,
              status: "cancelled",
              updatedAt: "2026-03-31T12:00:03.000Z"
            }
          });
        case "session.create":
          return buildGatewayResponse(request, {
            run: {
              createdAt: "2026-03-31T12:00:00.000Z",
              id: "run.session.create.1",
              kind: "session_create",
              metadata: {},
              sessionId: session.id,
              status: "queued",
              updatedAt: "2026-03-31T12:00:00.000Z"
            },
            session
          });
        case "session.list":
          return buildGatewayResponse(request, {
            sessions: [session]
          });
        case "session.message":
          return buildGatewayResponse(request, {
            run: {
              createdAt: "2026-03-31T12:00:00.000Z",
              id: "run.session.message.1",
              kind: "session_message",
              metadata: {},
              sessionId: session.id,
              status: "queued",
              updatedAt: "2026-03-31T12:00:00.000Z"
            },
            sessionId: session.id
          });
        case "session.resume":
          return buildGatewayResponse(request, {
            run: {
              createdAt: "2026-03-31T12:00:00.000Z",
              id: "run.session.resume.1",
              kind: "session_resume",
              metadata: {},
              sessionId: session.id,
              status: "queued",
              updatedAt: "2026-03-31T12:00:00.000Z"
            },
            sessionId: session.id
          });
        case "session.snapshot":
          return buildGatewayResponse(
            request,
            gatewaySessionSnapshotSchema.parse({
              snapshot: {
                approvalRequests: [approval],
                approvalResolutions: [],
                messages: [],
                resumeMetadata: null,
                session,
                steeringInjections: [],
                toolCalls: [],
                turns: [],
                voiceCaptures: [],
                voicePlaybacks: [],
                voiceTranscriptions: []
              },
              taskState: null
            })
          );
        case "steering.inject":
          return buildGatewayResponse(request, request.payload);
        case "tool.search":
          return buildGatewayResponse(request, {
            tools: [toolDefinition]
          });
        default:
          throw new Error(`Unexpected gateway request topic: ${request.topic}`);
      }
    },
    requests,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}

function createEmbeddingRegistration(providerId: string): EmbeddingAdapterRegistration {
  const adapter: EmbeddingAdapter = {
    async createEmbeddings(request) {
      return {
        dimensions: 3,
        id: request.id,
        metadata: request.metadata,
        providerId,
        vectors: request.inputs.map(() => [1, 0, 0])
      };
    },
    async health(): Promise<ProviderHealth> {
      return {
        checkedAt: "2026-03-31T12:00:00.000Z",
        details: {},
        providerId,
        status: "healthy"
      };
    },
    async listModels() {
      return [
        {
          displayName: "Custom Embed",
          modelId: "custom-embed-model",
          providerId
        }
      ];
    },
    providerId
  };

  return {
    adapter,
    makeDefault: true
  };
}

function createLanguageModelRegistration(providerId: string): LanguageModelAdapterRegistration {
  const adapter: LanguageModelAdapter = {
    async generate(request) {
      return {
        id: `response.${request.id}`,
        message: {
          createdAt: "2026-03-31T12:00:00.000Z",
          id: `message.${request.id}`,
          metadata: {},
          parts: [{ kind: "text", text: "registered provider response" }],
          role: "assistant",
          sessionId: request.sessionId ?? "session.sdk.1",
          source: "assistant",
          tags: [],
          turnId: request.turnId,
          visibility: "default"
        },
        metadata: {},
        modelId: request.modelId,
        provider: request.provider,
        stopReason: "end_turn",
        toolCalls: [],
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2
        }
      };
    },
    async health(): Promise<ProviderHealth> {
      return {
        checkedAt: "2026-03-31T12:00:00.000Z",
        details: {},
        providerId,
        status: "healthy"
      };
    },
    async listModels() {
      return [
        {
          displayName: "Registered Model",
          modelId: "registered-model",
          provider: providerId,
          toolCalling: true
        }
      ];
    },
    provider: providerId,
    providerId
  };

  return {
    adapter,
    defaultModel: "registered-model"
  };
}

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-sdk-"));
  tempRoots.push(root);
  return root;
}
