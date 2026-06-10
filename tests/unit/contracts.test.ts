import { expectTypeOf, test, describe, expect } from "vitest";

import {
  approvalRequestSchema,
  approvalResolutionSchema,
  channelMessageSchema,
  embeddingRequestSchema,
  embeddingResponseSchema,
  externalAgentDefinitionSchema,
  externalAgentJobRecordSchema,
  externalAgentJobRequestSchema,
  gatewayEventSchema,
  gatewayRequestPayloadSchemas,
  gatewayRequestSchema,
  gatewayResponsePayloadSchemas,
  gatewayResponseSchema,
  imageGenerationRequestSchema,
  imageGenerationResultSchema,
  languageModelQueueJobSchema,
  languageModelRequestSchema,
  languageModelResponseSchema,
  languageModelStreamEventSchema,
  memoryEntrySchema,
  memoryHitSchema,
  memoryQuerySchema,
  messageSchema,
  planRecordSchema,
  taskStateSnapshotSchema,
  sessionRecordSchema,
  steeringInjectionSchema,
  synthesisRequestSchema,
  synthesisResultSchema,
  toolCallRecordSchema,
  toolDefinitionSchema,
  transcriptionRequestSchema,
  transcriptionResultSchema,
  turnRecordSchema,
  type ApprovalService,
  type ChannelAdapter,
  type EmbeddingAdapter,
  type ExternalAgentAdapter,
  type GatewayTransportClient,
  type ImageGenerationAdapter,
  type LanguageModelAdapter,
  type LanguageModelResponse,
  type MemoryStore,
  type ProviderHealth,
  type SessionRepository,
  type SynthesisResult,
  type ToolCallRecord,
  type ToolDefinition,
  type ToolRegistry,
  type TranscriptionResult,
  type VoiceAdapter
} from "@/core/contracts";

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("core contracts", () => {
  test("parse serialized session, tool, memory, provider, and transport payloads", () => {
    const now = "2026-03-27T12:00:00.000Z";
    const artifact = {
      id: "artifact.patch.1",
      kind: "patch" as const,
      mediaType: "text/x-diff",
      metadata: {},
      name: "change.diff",
      sha256: "a".repeat(64),
      uri: "file:///workspace/.aia/undo/change.diff"
    };

    const message = messageSchema.parse(
      roundTrip({
        createdAt: now,
        id: "message.1",
        metadata: { intent: "bootstrap" },
        parts: [{ kind: "text", text: "Inspect the repository and propose the next change." }],
        role: "user",
        sessionId: "session.1",
        source: "user",
        tags: ["bootstrap"],
        turnId: "turn.1",
        visibility: "default"
      })
    );

    const session = sessionRecordSchema.parse(
      roundTrip({
        createdAt: now,
        cwd: "/workspace",
        goal: "Build the first working AIAgent slice",
        id: "session.1",
        lastActiveAt: now,
        metadata: { source: "cli" },
        status: "running_model",
        tags: ["mvp"],
        title: "Bootstrap AIAgent",
        updatedAt: now
      })
    );

    const turn = turnRecordSchema.parse(
      roundTrip({
        approvalRequestIds: ["approval.1"],
        executedToolCallIds: ["tool-call.1"],
        id: "turn.1",
        inputMessageIds: [message.id],
        metadata: {},
        outputMessageIds: [],
        requestedToolCallIds: ["tool-call.1"],
        sequence: 0,
        sessionId: session.id,
        startedAt: now,
        status: "running",
        trigger: "user"
      })
    );

    const toolDefinition = toolDefinitionSchema.parse(
      roundTrip({
        annotations: {
          meta: {},
          readOnlyHint: true,
          title: "Read File"
        },
        approvalMode: "ask",
        descriptor: {
          approvalNotes: "Approval may be required depending on operator policy.",
          examples: ["Use before editing a file."],
          purpose: "Read file contents from the workspace.",
          sideEffectSummary: "Reads local workspace files without modifying them.",
          whenNotToUse: ["Do not use this to change files."],
          whenToUse: ["Use when you need exact file contents before acting."]
        },
        description: "Read a file from the current workspace.",
        displayName: "Read File",
        execution: {
          inputMode: "json",
          resumable: false,
          taskSupport: "forbidden"
        },
        idempotent: true,
        inputSchema: {
          properties: {
            path: { type: "string" }
          },
          required: ["path"],
          type: "object"
        },
        invocationName: "read_file",
        kind: "built_in",
        metadata: { category: "workspace" },
        name: "read_file",
        outputKind: "text",
        outputSchema: {
          properties: {
            content: { type: "string" }
          },
          type: "object"
        },
        retryable: true,
        searchTags: ["files", "workspace"],
        sideEffects: ["workspace_read"],
        source: {
          displayName: "Built-in Tools",
          kind: "built_in"
        },
        streamingMode: "none",
        toolId: "tool.builtin.read_file",
        usageGuidance: "Use this to inspect files before editing them.",
        version: "1.0.0"
      })
    );

    const toolCall = toolCallRecordSchema.parse(
      roundTrip({
        approvalRequestId: "approval.1",
        arguments: { path: "README.md" },
        id: "tool-call.1",
        metadata: {},
        sessionId: session.id,
        startedAt: now,
        status: "awaiting_approval",
        toolName: toolDefinition.name,
        turnId: turn.id
      })
    );

    const approvalRequest = approvalRequestSchema.parse(
      roundTrip({
        createdAt: now,
        id: "approval.1",
        justification: "Read access is safe, but approval metadata must still serialize cleanly.",
        metadata: {},
        riskSummary: "Low-risk workspace read",
        sessionId: session.id,
        status: "pending",
        target: {
          kind: "tool",
          label: "read_file",
          value: "read_file"
        },
        toolCallId: toolCall.id,
        turnId: turn.id
      })
    );

    const approvalResolution = approvalResolutionSchema.parse(
      roundTrip({
        actor: "cli",
        comment: "Proceed",
        decidedAt: now,
        decision: "approved",
        id: "approval-resolution.1",
        metadata: {},
        requestId: approvalRequest.id
      })
    );

    const steering = steeringInjectionSchema.parse(
      roundTrip({
        createdAt: now,
        id: "steering.1",
        message: "Use the safer patch path instead of writing directly.",
        metadata: {},
        sessionId: session.id,
        source: "user",
        state: "queued",
        turnId: turn.id
      })
    );

    const plan = planRecordSchema.parse(
      roundTrip({
        createdAt: now,
        id: "plan.1",
        items: [
          {
            id: "plan-item.1",
            metadata: {},
            order: 0,
            status: "in_progress",
            title: "Define stable contracts"
          }
        ],
        metadata: {},
        sessionId: session.id,
        tags: ["contracts"],
        title: "Bootstrap plan",
        updatedAt: now
      })
    );

    const taskState = taskStateSnapshotSchema.parse(
      roundTrip({
        activePlanId: plan.id,
        blockers: [],
        nextStep: {
          createdAt: now,
          id: "working-memory.next-step.1",
          kind: "next_step",
          metadata: {},
          priority: "high",
          sessionId: session.id,
          text: "Implement the plan tool."
        },
        plan,
        progress: {
          blocked: 0,
          cancelled: 0,
          completed: 0,
          inProgress: 1,
          pending: 0,
          total: 1
        },
        recentAttempts: [
          {
            createdAt: now,
            id: "working-memory.attempt.1",
            kind: "recent_attempt",
            metadata: {},
            priority: "medium",
            sessionId: session.id,
            text: "Defined the base contracts first."
          }
        ],
        sessionId: session.id,
        summary: "Bootstrap the first plan-aware runtime slice.",
        updatedAt: now,
        workingMemory: [
          {
            createdAt: now,
            id: "working-memory.status.1",
            kind: "status",
            metadata: {},
            priority: "medium",
            sessionId: session.id,
            text: "Plan state is initialized."
          }
        ]
      })
    );

    const memoryEntry = memoryEntrySchema.parse(
      roundTrip({
        confidence: 0.93,
        content: "This workspace uses Node 22 and TypeScript ESM.",
        createdAt: now,
        id: "memory.1",
        kind: "fact",
        metadata: {},
        provenance: {
          messageIds: [message.id],
          sourceLabel: "user-request",
          toolCallIds: [],
          uri: "file:///workspace/AGENTS.md"
        },
        recencyScore: 0.75,
        scope: "workspace",
        summary: "Workspace runtime baseline",
        tags: ["runtime"],
        updatedAt: now
      })
    );

    const memoryQuery = memoryQuerySchema.parse(
      roundTrip({
        includeKinds: ["fact", "summary"],
        limit: 5,
        minConfidence: 0.5,
        scopes: ["workspace", "session"],
        sessionId: session.id,
        text: "runtime baseline"
      })
    );

    const memoryHit = memoryHitSchema.parse(
      roundTrip({
        entry: memoryEntry,
        explanation: "Matches workspace runtime details",
        score: 0.89
      })
    );

    const lmRequest = languageModelRequestSchema.parse(
      roundTrip({
        availableTools: [toolDefinition],
        id: "lm-request.1",
        instructions: "You are AIAgent. Use tools carefully and finish with attempt_complete.",
        messages: [message],
        metadata: {},
        modelId: "mistralai/devstral-small-2-2512",
        provider: "lm_studio",
        responseFormat: {
          kind: "json_schema",
          name: "agent_turn",
          schema: {
            properties: {
              status: { type: "string" }
            },
            required: ["status"],
            type: "object"
          }
        },
        sessionId: session.id,
        settings: {
          stopSequences: [],
          temperature: 0.2,
          toolChoice: "auto"
        },
        turnId: turn.id
      })
    );

    const lmResponse = languageModelResponseSchema.parse(
      roundTrip({
        id: "lm-response.1",
        message: {
          createdAt: now,
          id: "message.2",
          metadata: {},
          parts: [{ kind: "text", text: "I will inspect the relevant files first." }],
          role: "assistant",
          sessionId: session.id,
          source: "assistant",
          tags: [],
          turnId: turn.id,
          visibility: "default"
        },
        metadata: {},
        modelId: lmRequest.modelId,
        provider: lmRequest.provider,
        stopReason: "tool_calls",
        toolCalls: [
          {
            arguments: { path: "AGENTS.md" },
            callId: "tool-proposal.1",
            toolName: "read_file"
          }
        ],
        usage: {
          inputTokens: 1200,
          outputTokens: 110,
          totalTokens: 1310
        }
      })
    );

    const lmQueueJob = languageModelQueueJobSchema.parse(
      roundTrip({
        attempts: 1,
        createdAt: now,
        id: "lm-job.1",
        logPaths: {
          request: "/workspace/.aia/logs/lm/requests/lm-job.1.json",
          response: "/workspace/.aia/logs/lm/responses/lm-job.1.json"
        },
        metadata: {},
        providerId: "lm_studio",
        queueKey: "default",
        request: lmRequest,
        response: lmResponse,
        startedAt: now,
        status: "completed",
        updatedAt: now
      })
    );

    const streamEvent = languageModelStreamEventSchema.parse(
      roundTrip({
        kind: "response.completed",
        response: lmResponse
      })
    );

    const embeddingRequest = embeddingRequestSchema.parse(
      roundTrip({
        id: "embedding-request.1",
        inputs: ["Node 22 ESM workspace"],
        metadata: {},
        modelId: "local-embedding-model",
        providerId: "memory-provider"
      })
    );

    const embeddingResponse = embeddingResponseSchema.parse(
      roundTrip({
        dimensions: 3,
        id: "embedding-response.1",
        metadata: {},
        providerId: embeddingRequest.providerId,
        vectors: [[0.1, 0.2, 0.3]]
      })
    );

    const channelMessage = channelMessageSchema.parse(
      roundTrip({
        attachments: [artifact],
        createdAt: now,
        direction: "inbound",
        id: "channel-message.1",
        identity: {
          accountId: "primary",
          channel: "discord",
          displayName: "Local Operator",
          roomId: "room.1",
          userId: "user.1"
        },
        metadata: {},
        parts: [{ kind: "text", text: "Please continue the implementation." }],
        sessionId: session.id
      })
    );

    const transcriptionRequest = transcriptionRequestSchema.parse(
      roundTrip({
        audio: {
          ...artifact,
          id: "artifact.audio.1",
          kind: "audio",
          mediaType: "audio/wav",
          name: "prompt.wav"
        },
        id: "transcription-request.1",
        metadata: {},
        providerId: "local-voice",
        sessionId: session.id
      })
    );

    const transcriptionResult = transcriptionResultSchema.parse(
      roundTrip({
        completedAt: now,
        id: "transcription-result.1",
        metadata: {},
        providerId: transcriptionRequest.providerId,
        text: "Inspect the config and then continue."
      })
    );

    const synthesisRequest = synthesisRequestSchema.parse(
      roundTrip({
        id: "synthesis-request.1",
        metadata: {},
        providerId: "local-voice",
        text: "Task complete.",
        voice: "system-default"
      })
    );

    const synthesisResult = synthesisResultSchema.parse(
      roundTrip({
        audio: {
          ...artifact,
          id: "artifact.audio.2",
          kind: "audio",
          mediaType: "audio/aiff",
          name: "completion.aiff"
        },
        completedAt: now,
        id: "synthesis-result.1",
        metadata: {},
        providerId: synthesisRequest.providerId
      })
    );

    const imageRequest = imageGenerationRequestSchema.parse(
      roundTrip({
        id: "image-request.1",
        metadata: {},
        parameters: {
          prompt: "A minimal workstation control plane dashboard",
          references: [],
          size: {
            height: 768,
            width: 1024
          },
          styleTags: ["clean", "diagrammatic"]
        },
        providerId: "comfyui_local",
        sessionId: session.id,
      })
    );

    const imageResult = imageGenerationResultSchema.parse(
      roundTrip({
        completedAt: now,
        id: "image-result.1",
        images: [
          {
            ...artifact,
            id: "artifact.image.1",
            kind: "image",
            mediaType: "image/png",
            name: "dashboard.png"
          }
        ],
        metadata: {},
        parameters: imageRequest.parameters,
        primaryImageIndex: 0,
        providerId: imageRequest.providerId
      })
    );

    const externalAgentDefinition = externalAgentDefinitionSchema.parse(
      roundTrip({
        command: "codex",
        defaultArgs: [],
        displayName: "Codex CLI",
        id: "external-agent.1",
        kind: "codex",
        metadata: {},
        resumeSupported: true,
        structuredOutputSupported: true
      })
    );

    const externalAgentRequest = externalAgentJobRequestSchema.parse(
      roundTrip({
        agentId: externalAgentDefinition.id,
        args: ["--prompt", "Summarize the current status."],
        cwd: "/workspace",
        id: "external-job-request.1",
        instructions: "Run the external agent and return its output.",
        metadata: {},
        sessionId: session.id
      })
    );

    const externalAgentJob = externalAgentJobRecordSchema.parse(
      roundTrip({
        createdAt: now,
        id: "external-job.1",
        metadata: {},
        request: externalAgentRequest,
        resultArtifact: {
          ...artifact,
          id: "artifact.transcript.1",
          kind: "transcript",
          mediaType: "text/plain",
          name: "external-agent.txt"
        },
        startedAt: now,
        status: "queued",
        updatedAt: now
      })
    );

    const gatewayRequest = gatewayRequestSchema.parse(
      roundTrip({
        createdAt: now,
        id: "gateway-request.1",
        metadata: {},
        payload: gatewayRequestPayloadSchemas["session.create"].parse({
          cwd: session.cwd,
          goal: session.goal,
          title: session.title
        }),
        topic: "session.create"
      })
    );

    const gatewayResponse = gatewayResponseSchema.parse(
      roundTrip({
        createdAt: now,
        id: "gateway-response.1",
        metadata: {},
        ok: true,
        payload: gatewayResponsePayloadSchemas["session.create"].parse({
          session
        }),
        requestId: gatewayRequest.id,
        topic: gatewayRequest.topic
      })
    );

    const gatewayEvent = gatewayEventSchema.parse(
      roundTrip({
        createdAt: now,
        id: "gateway-event.1",
        metadata: {},
        payload: channelMessage,
        topic: "channel.message"
      })
    );

    expect(session.id).toBe("session.1");
    expect(turn.sessionId).toBe(session.id);
    expect(toolCall.toolName).toBe(toolDefinition.name);
    expect(approvalResolution.requestId).toBe(approvalRequest.id);
    expect(steering.state).toBe("queued");
    expect(plan.items).toHaveLength(1);
    expect(taskState.nextStep?.kind).toBe("next_step");
    expect(memoryQuery.scopes).toContain("workspace");
    expect(memoryHit.entry.id).toBe(memoryEntry.id);
    expect(streamEvent.kind).toBe("response.completed");
    expect(lmQueueJob.request.responseFormat.kind).toBe("json_schema");
    expect(embeddingResponse.dimensions).toBe(3);
    expect(transcriptionResult.text).toContain("Inspect");
    expect(synthesisResult.audio.kind).toBe("audio");
    expect(imageResult.images[0]?.kind).toBe("image");
    expect(externalAgentJob.request.agentId).toBe(externalAgentDefinition.id);
    expect(gatewayResponse.ok).toBe(true);
    expect(gatewayEvent.topic).toBe("channel.message");
  });

  test("expose type-safe adapter interfaces for future implementations", async () => {
    const providerHealth: ProviderHealth = {
      checkedAt: "2026-03-27T12:00:00.000Z",
      details: {},
      providerId: "provider.1",
      status: "healthy"
    };

    const toolDefinition: ToolDefinition = toolDefinitionSchema.parse({
      annotations: {
        meta: {},
        readOnlyHint: true,
        title: "Echo"
      },
      approvalMode: "never",
      descriptor: {
        approvalNotes: "No operator approval is required.",
        examples: ["Use for contract tests."],
        purpose: "Return a static string for testing.",
        sideEffectSummary: "No side effects.",
        whenNotToUse: ["Do not use in production flows."],
        whenToUse: ["Use for tests and fixtures."]
      },
      description: "Return a static string for testing.",
      displayName: "Echo",
      execution: {
        inputMode: "json",
        resumable: false,
        taskSupport: "forbidden"
      },
      idempotent: true,
      inputSchema: { type: "object" },
      invocationName: "echo",
      kind: "built_in",
      metadata: {},
      name: "echo",
      outputKind: "text",
      retryable: true,
      searchTags: [],
      sideEffects: ["none"],
      source: {
        displayName: "Built-in Tools",
        kind: "built_in"
      },
      streamingMode: "none",
      toolId: "tool.builtin.echo",
      usageGuidance: "Use for testing.",
      version: "1.0.0"
    });

    const toolCall: ToolCallRecord = toolCallRecordSchema.parse({
      arguments: { text: "hello" },
      id: "tool-call.typed.1",
      metadata: {},
      sessionId: "session.typed.1",
      startedAt: "2026-03-27T12:00:00.000Z",
      status: "pending",
      toolName: "echo",
      turnId: "turn.typed.1"
    });

    const sessionRepository: SessionRepository = {
      appendTurn: async () => undefined,
      getSession: async () => null,
      listSessions: async () => [],
      saveSession: async () => undefined
    };

    const toolRegistry: ToolRegistry = {
      getDefinition: () => toolDefinition,
      listDefinitions: () => [toolDefinition],
      searchDefinitions: () => []
    };

    const approvalService: ApprovalService = {
      createRequest: async () => undefined,
      resolve: async () => undefined
    };

    const memoryStore: MemoryStore = {
      query: async () => [],
      remove: async () => undefined,
      upsert: async () => undefined
    };

    const modelAdapter: LanguageModelAdapter = {
      generate: async () =>
        languageModelResponseSchema.parse({
          id: "lm-response.typed.1",
          metadata: {},
          modelId: "mistralai/devstral-small-2-2512",
          provider: "lm_studio",
          stopReason: "end_turn",
          toolCalls: [],
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2
          }
        }),
      health: async () => providerHealth,
      listModels: async () => [],
      provider: "lm_studio",
      providerId: "lm-studio.local"
    };

    const embeddingAdapter: EmbeddingAdapter = {
      createEmbeddings: async () =>
        embeddingResponseSchema.parse({
          dimensions: 2,
          id: "embedding.typed.1",
          metadata: {},
          providerId: "memory-provider",
          vectors: [[0.1, 0.2]]
        }),
      health: async () => providerHealth,
      providerId: "memory-provider"
    };

    const gatewayTransport: GatewayTransportClient = {
      request: async (request) =>
        gatewayResponseSchema.parse({
          createdAt: "2026-03-27T12:00:00.000Z",
          id: "gateway-response.typed.1",
          metadata: {},
          ok: true,
          payload: request.payload,
          requestId: request.id,
          topic: request.topic
        }),
      subscribe: async () => () => undefined
    };

    const channelAdapter: ChannelAdapter = {
      capabilities: ["approvals", "steering"],
      channel: "discord",
      health: async () => ({ ok: true }),
      normalizeInboundMessage: async (message) => message,
      send: async () => undefined
    };

    const voiceAdapter = {
      capabilities: ["synthesis", "transcription"],
      health: async () => providerHealth,
      kind: "local_system",
      providerId: "voice.local",
      synthesize: async (request) => {
        void request;
        return synthesisResultSchema.parse({
          audio: {
            id: "artifact.audio.typed.1",
            kind: "audio",
            metadata: {},
            uri: "file:///tmp/audio.aiff"
          },
          completedAt: "2026-03-27T12:00:00.000Z",
          id: "synthesis.typed.1",
          metadata: {},
          providerId: "voice.local"
        });
      },
      transcribe: async (request) => {
        void request;
        return transcriptionResultSchema.parse({
          completedAt: "2026-03-27T12:00:00.000Z",
          id: "transcription.typed.1",
          metadata: {},
          providerId: "voice.local",
          text: "continue the task"
        });
      }
    } satisfies VoiceAdapter;

    const imageAdapter: ImageGenerationAdapter = {
      generate: async (request) =>
        imageGenerationResultSchema.parse({
          completedAt: "2026-03-31T12:00:00.000Z",
          id: "image.typed.1",
          images: [
            {
              id: "artifact.image.typed.1",
              kind: "image",
              metadata: {},
              uri: "file:///tmp/generated.png"
            }
          ],
          metadata: {},
          parameters: request.parameters,
          primaryImageIndex: 0,
          providerId: "comfyui_local"
        }),
      health: async () => providerHealth,
      kind: "comfyui_compatible",
      providerId: "comfyui_local"
    };

    const externalAgentAdapter: ExternalAgentAdapter = {
      getDefinition: async () => null,
      run: async (request) =>
        externalAgentJobRecordSchema.parse({
          createdAt: "2026-03-27T12:00:00.000Z",
          id: "external-job.typed.1",
          metadata: {},
          request,
          startedAt: "2026-03-27T12:00:00.000Z",
          status: "running",
          updatedAt: "2026-03-27T12:00:00.000Z"
        })
    };

    expect(toolRegistry.getDefinition("echo")?.name).toBe("echo");
    await approvalService.createRequest(
      approvalRequestSchema.parse({
        createdAt: "2026-03-27T12:00:00.000Z",
        id: "approval.typed.1",
        justification: "Test only",
        metadata: {},
        riskSummary: "none",
        sessionId: "session.typed.1",
        status: "pending",
        target: {
          kind: "tool",
          label: "echo",
          value: "echo"
        },
        turnId: "turn.typed.1"
      })
    );

    expect(await sessionRepository.getSession("session.typed.1")).toBeNull();
    expect(await modelAdapter.health()).toEqual(providerHealth);
    expect(await embeddingAdapter.health()).toEqual(providerHealth);
    expect(await gatewayTransport.request(gatewayRequestSchema.parse({
      createdAt: "2026-03-27T12:00:00.000Z",
      id: "gateway-request.typed.1",
      metadata: {},
      payload: gatewayRequestPayloadSchemas["gateway.health"].parse({}),
      topic: "gateway.health"
    }))).toMatchObject({ ok: true });
    expect((await channelAdapter.health()).ok).toBe(true);
    expect((await voiceAdapter.transcribe(transcriptionRequestSchema.parse({
      audio: {
        id: "artifact.audio.typed.2",
        kind: "audio",
        metadata: {},
        uri: "file:///tmp/input.wav"
      },
      id: "transcription-request.typed.1",
      metadata: {},
      providerId: "voice.local"
    }))).text).toContain("continue");
    expect((await imageAdapter.generate(imageGenerationRequestSchema.parse({
      id: "image-request.typed.1",
      metadata: {},
      parameters: {
        prompt: "Generate a status icon",
        references: [],
        styleTags: []
      },
      providerId: "comfyui_local"
    }))).providerId).toBe("comfyui_local");
    expect((await externalAgentAdapter.run(externalAgentJobRequestSchema.parse({
      agentId: "external-agent.typed.1",
      args: [],
      cwd: "/workspace",
      id: "external-job-request.typed.1",
      instructions: "Do work",
      metadata: {}
    }))).status).toBe("running");
    expect(await memoryStore.query(memoryQuerySchema.parse({
      includeKinds: [],
      limit: 1,
      minConfidence: 0,
      scopes: ["workspace"],
      text: "runtime"
    }))).toEqual([]);

    expectTypeOf(modelAdapter.generate).returns.resolves.toEqualTypeOf<LanguageModelResponse>();
    expectTypeOf(voiceAdapter.transcribe).returns.resolves.toEqualTypeOf<TranscriptionResult>();
    expectTypeOf(voiceAdapter.synthesize).returns.resolves.toEqualTypeOf<SynthesisResult>();
    expectTypeOf(toolRegistry.getDefinition("echo")).toEqualTypeOf<ToolDefinition | null>();
    expectTypeOf(toolCall).toEqualTypeOf<ToolCallRecord>();
  });

  test("enforces image mode-specific parameter requirements", () => {
    expect(() =>
      imageGenerationRequestSchema.parse({
        id: "image-request.invalid.1",
        metadata: {},
        parameters: {
          mode: "image_to_image",
          prompt: "Transform this icon",
          references: [],
          styleTags: []
        },
        providerId: "comfyui_local"
      })
    ).toThrow("sourceImage");

    expect(() =>
      imageGenerationRequestSchema.parse({
        id: "image-request.invalid.2",
        metadata: {},
        parameters: {
          maskImage: {
            id: "artifact.mask.1",
            kind: "image",
            metadata: {},
            uri: "file:///tmp/mask.png"
          },
          mode: "text_to_image",
          prompt: "Generate a fresh icon",
          references: [],
          styleTags: []
        },
        providerId: "comfyui_local"
      })
    ).toThrow("maskImage");

    expect(() =>
      imageGenerationResultSchema.parse({
        completedAt: "2026-03-31T12:00:00.000Z",
        id: "image-result.invalid.1",
        images: [
          {
            id: "artifact.image.invalid.1",
            kind: "image",
            metadata: {},
            uri: "file:///tmp/output.png"
          }
        ],
        metadata: {},
        parameters: {
          prompt: "Generate an icon",
          references: [],
          styleTags: []
        },
        primaryImageIndex: 2,
        providerId: "comfyui_local"
      })
    ).toThrow("primaryImageIndex");
  });
});
