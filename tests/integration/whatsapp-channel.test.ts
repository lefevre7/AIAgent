import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";
import { afterEach, describe, expect, test } from "vitest";

import {
  DEFAULT_APPROVAL_SETTINGS,
  ChannelService,
  FileSessionStore,
  ToolRegistryBuilder,
  ToolRuntime,
  WhatsAppChannelAdapter,
  createDefaultAppConfig,
  createToolApprovalDecider,
  sessionRecordSchema,
  whatsappBridgeInboundEntrySchema,
  whatsappBridgeOutboundEntrySchema,
  type ApprovalSettings,
  type JsonValue,
  type LanguageModelRequest,
  type LanguageModelResponse,
  type Message,
  type RuntimeTool,
  type SessionRecord
} from "@/core";
import { GatewayRuntime } from "@/gateway";

const tempRoots: string[] = [];
const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map(async (callback) => callback()));
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

describe("WhatsApp channel integration", () => {
  test("auto-creates routed sessions, persists inbound media, and relays assistant replies", async () => {
    const harness = await createWhatsAppHarness(async (request) => {
      const inboundText = request.messages.flatMap(extractText).join("\n");
      expect(inboundText).toContain("Hello from WhatsApp");
      return buildAssistantResponse({
        sessionId: requireSessionId(request.sessionId),
        text: "WhatsApp reply ready.",
        toolCalls: [buildAttemptCompleteCall("tool.complete.whatsapp.1")]
      });
    });

    const imagePath = path.join(harness.root, "sample.png");
    const documentPath = path.join(harness.root, "sample.txt");
    await fs.writeFile(imagePath, "fake-image", "utf8");
    await fs.writeFile(documentPath, "fake-document", "utf8");

    await writeInboundEntry(harness.sessionDirectory, {
      accountId: "whatsapp-account",
      createdAt: "2026-03-31T12:00:00.000Z",
      displayName: "Ada",
      id: "channel-message.whatsapp.inbound.1",
      media: [
        {
          filePath: imagePath,
          kind: "image",
          mediaType: "image/png",
          name: "sample.png"
        },
        {
          filePath: documentPath,
          kind: "document",
          mediaType: "text/plain",
          name: "sample.txt"
        }
      ],
      metadata: {},
      text: "Hello from WhatsApp",
      userId: "user-42"
    });

    await waitFor(async () => {
      const entries = await readOutboundEntries(harness.sessionDirectory);
      return entries.some((entry) => entry.text?.includes("WhatsApp reply ready."));
    });

    const sessions = await harness.sessions.listSessions();
    expect(sessions).toHaveLength(1);
    const session = sessions[0] as SessionRecord;
    expect(session.title).toBe("WhatsApp Ada");
    expect(session.metadata.channelAutoCreated).toBe(true);

    const route = await harness.channelService.getRouteForSession(session.id);
    expect(route?.identity.channel).toBe("whatsapp");
    expect(route?.identity.userId).toBe("user-42");

    const deliveries = await harness.channelService.listDeliveries({
      channel: "whatsapp"
    });
    const inbound = deliveries.find((delivery) => delivery.direction === "inbound");
    expect(inbound?.message.attachments.map((artifact) => artifact.kind).sort()).toEqual(["document", "image"]);
    for (const artifact of inbound?.message.attachments ?? []) {
      await expect(fs.access(fileURLToPath(artifact.uri))).resolves.toBeUndefined();
      expect(fileURLToPath(artifact.uri)).toContain(path.join("media", "inbound"));
    }

    const snapshot = await harness.sessions.getSessionSnapshot(session.id);
    expect(snapshot?.messages.some((message) => message.source === "channel")).toBe(true);
    expect(snapshot?.messages.some((message) => extractText(message).join("\n").includes("WhatsApp reply ready."))).toBe(true);
  });

  test("relays approval prompts and continues the session after a WhatsApp-side approval command", async () => {
    const harness = await createWhatsAppHarness(async (request) => {
      const toolMessages = request.messages.filter((message) => message.role === "tool");
      if (toolMessages.length > 0) {
        return buildAssistantResponse({
          sessionId: requireSessionId(request.sessionId),
          text: "Approved action applied.",
          toolCalls: [buildAttemptCompleteCall("tool.complete.whatsapp.2")]
        });
      }

      return buildAssistantResponse({
        sessionId: requireSessionId(request.sessionId),
        text: "I need approval before I can apply that change.",
        toolCalls: [
          {
            arguments: {
              action: "apply-change"
            },
            callId: "tool.pending.whatsapp.1",
            toolName: "test_mutation"
          }
        ]
      });
    });

    await writeInboundEntry(harness.sessionDirectory, {
      accountId: "whatsapp-account",
      createdAt: "2026-03-31T12:10:00.000Z",
      displayName: "Ada",
      id: "channel-message.whatsapp.inbound.2",
      media: [],
      metadata: {},
      text: "Please make the change.",
      userId: "user-42"
    });

    await waitFor(async () => {
      const entries = await readOutboundEntries(harness.sessionDirectory);
      return entries.some((entry) => entry.text?.includes('Reply "/approve'));
    });

    const session = (await harness.sessions.listSessions())[0] as SessionRecord;
    await writeInboundEntry(harness.sessionDirectory, {
      accountId: "whatsapp-account",
      createdAt: "2026-03-31T12:11:00.000Z",
      displayName: "Ada",
      id: "channel-message.whatsapp.inbound.3",
      media: [],
      metadata: {},
      text: "/approve",
      userId: "user-42"
    });

    await waitFor(async () => {
      const entries = await readOutboundEntries(harness.sessionDirectory);
      return entries.some((entry) => entry.text?.includes("Approved action applied."));
    });

    const snapshot = await harness.sessions.getSessionSnapshot(session.id);
    expect(snapshot?.approvalResolutions.some((resolution) => resolution.actor === "channel" && resolution.decision === "approved")).toBe(
      true
    );
    expect(snapshot?.toolCalls.some((toolCall) => toolCall.toolName === "test_mutation" && toolCall.status === "succeeded")).toBe(true);

    const outboundTexts = (await readOutboundEntries(harness.sessionDirectory)).map((entry) => entry.text ?? "");
    expect(outboundTexts.some((text) => text.includes('Reply "/approve'))).toBe(true);
    expect(outboundTexts.some((text) => text.includes('Approved approval for "Test Mutation".'))).toBe(true);
    expect(outboundTexts.some((text) => text.includes("Approved action applied."))).toBe(true);
  });

  test("accepts steering commands from WhatsApp and resumes the bound session", async () => {
    const harness = await createWhatsAppHarness(async (request) => {
      const visibleText = request.messages.flatMap(extractText).join("\n");
      if (visibleText.includes("Focus on tests first.")) {
        return buildAssistantResponse({
          sessionId: requireSessionId(request.sessionId),
          text: "Steering applied.",
          toolCalls: [buildAttemptCompleteCall("tool.complete.whatsapp.3")]
        });
      }

      return buildAssistantResponse({
        sessionId: requireSessionId(request.sessionId),
        text: "Initial WhatsApp reply.",
        toolCalls: [buildAttemptCompleteCall("tool.complete.whatsapp.4")]
      });
    });

    const session = sessionRecordSchema.parse({
      createdAt: "2026-03-31T12:20:00.000Z",
      cwd: "/workspace",
      goal: "Respond to the WhatsApp thread",
      id: "session.whatsapp.steering.1",
      lastActiveAt: "2026-03-31T12:20:00.000Z",
      metadata: {},
      status: "idle",
      tags: ["channel:whatsapp"],
      title: "WhatsApp Steering Session",
      updatedAt: "2026-03-31T12:20:00.000Z"
    });
    await harness.sessions.saveSession(session);
    await harness.channelService.ensureRoute({
      identity: {
        accountId: "whatsapp-account",
        channel: "whatsapp",
        displayName: "Ada",
        userId: "user-42"
      },
      sessionId: session.id
    });

    await writeInboundEntry(harness.sessionDirectory, {
      accountId: "whatsapp-account",
      createdAt: "2026-03-31T12:21:00.000Z",
      displayName: "Ada",
      id: "channel-message.whatsapp.inbound.4",
      media: [],
      metadata: {},
      text: "/steer Focus on tests first.",
      userId: "user-42"
    });

    await waitFor(async () => {
      const entries = await readOutboundEntries(harness.sessionDirectory);
      return entries.some((entry) => entry.text?.includes("Steering applied."));
    });

    const snapshot = await harness.sessions.getSessionSnapshot(session.id);
    expect(snapshot?.steeringInjections.some((entry) => entry.source === "channel" && entry.message === "Focus on tests first.")).toBe(
      true
    );

    const outboundTexts = (await readOutboundEntries(harness.sessionDirectory)).map((entry) => entry.text ?? "");
    expect(outboundTexts.some((text) => text.includes('Queued steering for "WhatsApp Steering Session".'))).toBe(true);
    expect(outboundTexts.some((text) => text.includes("Steering applied."))).toBe(true);
  });
});

async function createWhatsAppHarness(
  modelHandler: (request: Omit<LanguageModelRequest, "modelId" | "provider"> & { modelId?: string; provider?: LanguageModelRequest["provider"] }) => Promise<LanguageModelResponse>
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aia-whatsapp-channel-"));
  tempRoots.push(root);

  const sessionDirectory = path.join(root, "whatsapp-session");
  const config = createDefaultAppConfig({
    userStateDirectory: path.join(root, "home", ".aia")
  });
  config.channels.whatsapp.enabled = true;
  config.channels.whatsapp.sessionDirectory = sessionDirectory;
  config.memory.stateRoot = path.join(root, ".aia");

  const sessions = new FileSessionStore(config.memory.stateRoot);
  const channelService = new ChannelService({
    adapters: [
      new WhatsAppChannelAdapter({
        pollIntervalMs: 10,
        sessionDirectory
      })
    ],
    channelsConfig: config.channels,
    sessions,
    stateRoot: config.memory.stateRoot
  });
  const runtime = new GatewayRuntime({
    approvals: DEFAULT_APPROVAL_SETTINGS,
    channelService,
    config,
    mcpManager: {
      close: async () => undefined
    },
    memoryService: createMemoryServiceStub(),
    modelRuntime: new FakeGatewayModelRuntime(modelHandler),
    sessions,
    taskStateService: {
      getTaskState: async () => null
    },
    toolRuntime: createHarnessToolRuntime(DEFAULT_APPROVAL_SETTINGS),
    workspaceRoot: "/workspace"
  } as never);

  await runtime.initialize();
  channelService.setInboundMessageListener(async (message) => {
    await runtime.acceptChannelMessage(message);
  });
  await channelService.start();

  closeCallbacks.push(async () => {
    await channelService.close().catch(() => undefined);
    await runtime.close().catch(() => undefined);
  });

  return {
    channelService,
    root,
    runtime,
    sessionDirectory,
    sessions
  };
}

function createHarnessToolRuntime(settings: ApprovalSettings): ToolRuntime {
  const builder = new ToolRegistryBuilder();
  builder.register(createAttemptCompleteRuntimeTool());
  builder.register(createTestMutationTool());

  return new ToolRuntime({
    approvalDecider: createToolApprovalDecider({
      settings
    }),
    registry: builder.build()
  });
}

function createAttemptCompleteRuntimeTool(): RuntimeTool {
  return {
    definition: {
      aliases: [],
      annotations: {
        meta: {},
        readOnlyHint: true,
        title: "Attempt Complete"
      },
      approvalMode: "never",
      descriptor: {
        approvalNotes: "Completion is validated by the runtime.",
        examples: ["Use once the requested work is done."],
        purpose: "Ask the runtime to complete the task.",
        sideEffectSummary: "No side effects.",
        whenNotToUse: ["Do not mix it with other tool calls."],
        whenToUse: ["Use only when the task is complete."]
      },
      description: "Attempt completion through the runtime gate.",
      displayName: "Attempt Complete",
      execution: {
        inputMode: "json",
        resumable: false,
        taskSupport: "forbidden"
      },
      idempotent: false,
      inputSchema: {
        type: "object"
      },
      invocationName: "attempt_complete",
      kind: "built_in",
      metadata: {},
      name: "attempt_complete",
      outputKind: "json",
      retryable: true,
      searchTags: ["completion"],
      sideEffects: ["none"],
      source: {
        displayName: "Built-in Tools",
        kind: "built_in"
      },
      streamingMode: "none",
      toolId: "tool.builtin.attempt_complete",
      usageGuidance: "Use only when the task is complete.",
      version: "1.0.0"
    },
    async execute() {
      throw new Error("attempt_complete should not be executed directly in the harness.");
    }
  };
}

function createTestMutationTool(): RuntimeTool {
  return {
    definition: {
      aliases: ["test_change"],
      annotations: {
        destructiveHint: true,
        meta: {},
        title: "Test Mutation"
      },
      approvalMode: "always",
      descriptor: {
        approvalNotes: "This test tool always requires explicit approval.",
        examples: ["Use to simulate a protected change."],
        purpose: "Simulate a stateful change that needs approval during tests.",
        sideEffectSummary: "Writes simulated local state.",
        whenNotToUse: ["Do not use outside approval-flow tests."],
        whenToUse: ["Use when validating channel approval continuation."]
      },
      description: "Simulate a protected mutation.",
      displayName: "Test Mutation",
      execution: {
        inputMode: "json",
        resumable: false,
        taskSupport: "forbidden"
      },
      idempotent: false,
      inputSchema: {
        additionalProperties: false,
        properties: {
          action: {
            type: "string"
          }
        },
        required: ["action"],
        type: "object"
      },
      invocationName: "test_mutation",
      kind: "built_in",
      metadata: {},
      name: "test_mutation",
      outputKind: "json",
      retryable: false,
      searchTags: ["approval", "mutation", "test"],
      sideEffects: ["workspace_write"],
      source: {
        displayName: "Integration Test",
        kind: "built_in"
      },
      streamingMode: "none",
      toolId: "tool.test.mutation",
      usageGuidance: "Use only in integration tests.",
      version: "1.0.0"
    },
    async execute(call) {
      return {
        display: [
          {
            kind: "text",
            text: `Applied ${String(call.arguments.action ?? "change")}.`
          }
        ],
        result: {
          applied: call.arguments.action ?? "change"
        }
      };
    }
  };
}

function createMemoryServiceStub() {
  return {
    async compactSession() {
      return undefined;
    },
    async getMemoryStatus() {
      return {
        dirty: false,
        embeddings: {
          enabled: false,
          hardFailOnStartup: false,
          modelId: null,
          providerId: null,
          status: "disabled"
        },
        index: {
          chunkCount: 0,
          configFingerprint: null,
          documentCount: 0,
          embeddingDimensions: null,
          fileCount: 0,
          lastIndexedAt: null,
          schemaVersion: 1,
          sqlitePath: path.join(os.tmpdir(), "memory.sqlite")
        },
        lastCompaction: null,
        lexical: {
          enabled: false,
          ready: false
        },
        modes: ["lexical"],
        sources: {
          chatSessionRoot: path.join(os.tmpdir(), "chat-session-memory"),
          extraPaths: [],
          includeSessionSummaries: false,
          userGlobalRoot: path.join(os.tmpdir(), "user-memory"),
          workspaceRoot: path.join(os.tmpdir(), "workspace-memory")
        }
      };
    },
    async getPromptContext() {
      return null;
    },
    async initializeSessionMemory() {
      return undefined;
    },
    async query() {
      return [];
    },
    registerEmbeddingAdapter() {
      return undefined;
    },
    setDefaultEmbeddingProvider() {
      return undefined;
    }
  };
}

class FakeGatewayModelRuntime {
  constructor(
    private readonly handler: (request: Omit<LanguageModelRequest, "modelId" | "provider"> & {
      modelId?: string;
      provider?: LanguageModelRequest["provider"];
    }) => Promise<LanguageModelResponse>
  ) {}

  async close(): Promise<void> {
    return undefined;
  }

  async generate(
    request: Omit<LanguageModelRequest, "modelId" | "provider"> & {
      modelId?: string;
      provider?: LanguageModelRequest["provider"];
    }
  ): Promise<LanguageModelResponse> {
    return this.handler(request);
  }

  registerAdapter(): void {
    return undefined;
  }
}

function buildAssistantResponse(params: {
  sessionId: string;
  text: string;
  toolCalls: Array<{ arguments: Record<string, JsonValue>; callId: string; toolName: string }>;
}): LanguageModelResponse {
  return {
    id: `response.${params.toolCalls[0]?.callId ?? "assistant"}`,
    message: {
      createdAt: new Date().toISOString(),
      id: `message.assistant.${params.toolCalls[0]?.callId ?? "assistant"}`,
      metadata: {},
      parts: [
        {
          kind: "text",
          text: params.text
        }
      ],
      role: "assistant",
      sessionId: params.sessionId,
      source: "assistant",
      tags: [],
      turnId: `turn.model.${params.toolCalls[0]?.callId ?? "assistant"}`,
      visibility: "default"
    },
    metadata: {},
    modelId: "test-model",
    provider: "lm_studio",
    stopReason: params.toolCalls.length > 0 ? "tool_calls" : "end_turn",
    toolCalls: params.toolCalls,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15
    }
  };
}

function buildAttemptCompleteCall(callId: string) {
  return {
    arguments: {} as Record<string, JsonValue>,
    callId,
    toolName: "attempt_complete"
  };
}

function requireSessionId(sessionId: string | undefined): string {
  if (!sessionId) {
    throw new Error("Expected the gateway to provide a session id.");
  }

  return sessionId;
}

function extractText(message: Message): string[] {
  return message.parts.flatMap((part) => {
    switch (part.kind) {
      case "json":
        return [JSON.stringify(part.value)];
      case "markdown":
        return [part.markdown];
      case "status":
        return [part.summary];
      case "text":
        return [part.text];
      default:
        return [];
    }
  });
}

async function readOutboundEntries(sessionDirectory: string) {
  const directory = path.join(sessionDirectory, "outbound");
  try {
    const entries = (await fs.readdir(directory)).filter((entry) => entry.endsWith(".json")).sort();
    return Promise.all(
      entries.map(async (entry) =>
        whatsappBridgeOutboundEntrySchema.parse(
          JSON.parse(await fs.readFile(path.join(directory, entry), "utf8")) as unknown
        )
      )
    );
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000,
  intervalMs = 25
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms.`);
}

async function writeInboundEntry(
  sessionDirectory: string,
  input: z.input<typeof whatsappBridgeInboundEntrySchema>
): Promise<void> {
  const entry = whatsappBridgeInboundEntrySchema.parse(input);
  const inboundDirectory = path.join(sessionDirectory, "inbound");
  await fs.mkdir(inboundDirectory, { recursive: true });
  await fs.writeFile(
    path.join(inboundDirectory, `${Date.now()}.${entry.id}.json`),
    `${JSON.stringify(entry)}\n`,
    "utf8"
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
