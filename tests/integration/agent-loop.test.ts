import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  AgentLoop,
  ApprovalCoordinator,
  FileSessionStore,
  type AgentLoopCompletionDecision,
  type AgentLoopModel,
  type AgentLoopToolExecutionResult,
  type ApprovalRequest,
  type ApprovalResolution,
  type LanguageModelRequest,
  type LanguageModelResponse,
  type Message,
  type SessionRecord,
  type SteeringInjection,
  type ToolCallRecord,
  type ToolDefinition,
  type TurnRecord
} from "@/core";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

describe("agent loop", () => {
  test("accepts explicit attempt_complete and marks the session completed", async () => {
    const { loop, store } = await createLoop([
      buildModelResponse({
        messageText: "The requested work is complete.",
        sessionId: "session.loop.1",
        toolCalls: [{ arguments: {}, callId: "tool.complete.1", toolName: "attempt_complete" }]
      })
    ]);

    const result = await loop.run({
      availableTools: [buildAttemptCompleteTool()],
      session: buildSession(),
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).toBe("completed");
    expect(result.session.status).toBe("completed");
    expect(result.turns).toHaveLength(1);
    expect((await store.getSessionSnapshot(result.session.id))?.messages.some((message) => message.role === "assistant")).toBe(true);
  });

  test("nudges the model when it replies without attempt_complete, and the model sees the nudge", async () => {
    const { loop, model, store } = await createLoop([
      buildModelResponse({
        messageText: "I inspected the file and updated the plan.",
        sessionId: "session.loop.1",
        toolCalls: []
      }),
      buildModelResponse({
        messageText: "The work is now complete.",
        sessionId: "session.loop.1",
        toolCalls: [{ arguments: {}, callId: "tool.complete.2", toolName: "attempt_complete" }]
      })
    ]);

    const result = await loop.run({
      availableTools: [buildAttemptCompleteTool()],
      maxTurns: 4,
      session: buildSession(),
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).toBe("completed");
    expect(result.turns).toHaveLength(2);
    const snapshot = await store.getSessionSnapshot(result.session.id);
    expect(snapshot?.messages.some((message) => message.source === "system" && message.visibility === "compact")).toBe(true);
    expect(result.turns[1]?.trigger).toBe("system_nudge");
    const secondRequest = model.requests[1];
    expect(
      secondRequest?.messages.some(
        (message) =>
          message.source === "system" &&
          message.parts.some((part) => part.kind === "text" && part.text.includes("You must keep working"))
      )
    ).toBe(true);
  });

  test("stops with completion_blocked after too many consecutive no-tool turns", async () => {
    const noToolResponse = () =>
      buildModelResponse({ messageText: "Acknowledged.", sessionId: "session.loop.1", toolCalls: [] });
    const { loop } = await createLoop([noToolResponse(), noToolResponse(), noToolResponse(), noToolResponse()]);

    const result = await loop.run({
      availableTools: [buildAttemptCompleteTool()],
      session: buildSession(),
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).toBe("completion_blocked");
    expect(result.session.status).toBe("completion_blocked");
    expect(result.turns).toHaveLength(4);
  });

  test("surfaces rejected malformed tool calls to the model in the continuation nudge", async () => {
    const malformedResponse = buildModelResponse({
      messageText: "Calling a tool.",
      sessionId: "session.loop.1",
      toolCalls: []
    });
    malformedResponse.metadata = {
      rejectedToolCalls: [{ reason: "Tool call 1 was missing a function name." }]
    };
    const { loop, model } = await createLoop([
      malformedResponse,
      buildModelResponse({
        messageText: "Retrying correctly and completing.",
        sessionId: "session.loop.1",
        toolCalls: [{ arguments: {}, callId: "tool.complete.rejected", toolName: "attempt_complete" }]
      })
    ]);

    const result = await loop.run({
      availableTools: [buildAttemptCompleteTool()],
      maxTurns: 4,
      session: buildSession(),
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).toBe("completed");
    const secondRequest = model.requests[1];
    expect(
      secondRequest?.messages.some(
        (message) =>
          message.parts.some(
            (part) => part.kind === "text" && part.text.includes("Tool call 1 was missing a function name.")
          )
      )
    ).toBe(true);
  });

  test("rejects a turn that mixes attempt_complete with other tool calls", async () => {
    const { loop, store } = await createLoop([
      buildModelResponse({
        messageText: "Finishing up while also thinking.",
        sessionId: "session.loop.1",
        toolCalls: [
          { arguments: {}, callId: "tool.think.mix", toolName: "think" },
          { arguments: {}, callId: "tool.complete.mix", toolName: "attempt_complete" }
        ]
      }),
      buildModelResponse({
        messageText: "Now completing on its own.",
        sessionId: "session.loop.1",
        toolCalls: [{ arguments: {}, callId: "tool.complete.mixdone", toolName: "attempt_complete" }]
      })
    ]);

    const result = await loop.run({
      availableTools: [buildAttemptCompleteTool()],
      maxTurns: 4,
      session: buildSession(),
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).toBe("completed");
    expect(result.turns.some((turn) => turn.summary === "The runtime rejected a mixed completion/tool turn.")).toBe(true);
    expect(result.turns.some((turn) => turn.trigger === "system_nudge")).toBe(true);
    const snapshot = await store.getSessionSnapshot(result.session.id);
    expect(snapshot?.messages.some((message) => message.source === "system" && message.visibility === "compact")).toBe(true);
  });

  test("stops with completion_blocked when the turn limit is reached without completion", async () => {
    const { loop } = await createLoop([
      buildModelResponse({ messageText: "Still working (1).", sessionId: "session.loop.1", toolCalls: [] }),
      buildModelResponse({ messageText: "Still working (2).", sessionId: "session.loop.1", toolCalls: [] })
    ]);

    const result = await loop.run({
      availableTools: [buildAttemptCompleteTool()],
      maxTurns: 2,
      session: buildSession(),
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).toBe("completion_blocked");
    expect(result.session.status).toBe("completion_blocked");
    expect(result.turns).toHaveLength(2);
  });

  test("rejects completion once, returns structured reasons, then accepts on retry", async () => {
    let attempts = 0;
    const { loop, store } = await createLoop(
      [
        buildModelResponse({
          messageText: "I think this is done.",
          sessionId: "session.loop.1",
          toolCalls: [{ arguments: {}, callId: "tool.complete.3", toolName: "attempt_complete" }]
        }),
        buildModelResponse({
          messageText: "I addressed the remaining issue and this is now done.",
          sessionId: "session.loop.1",
          toolCalls: [{ arguments: {}, callId: "tool.complete.4", toolName: "attempt_complete" }]
        })
      ],
      {
        completionGate: async (): Promise<AgentLoopCompletionDecision> => {
          attempts += 1;
          if (attempts === 1) {
            return {
              accepted: false,
              reasons: ["A required verification step is still unresolved."]
            };
          }

          return {
            accepted: true
          };
        }
      }
    );

    const result = await loop.run({
      availableTools: [buildAttemptCompleteTool()],
      maxTurns: 4,
      session: buildSession(),
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).toBe("completed");
    expect(result.turns).toHaveLength(2);
    const snapshot = await store.getSessionSnapshot(result.session.id);
    expect(
      snapshot?.messages.some(
        (message) =>
          message.source === "system" &&
          message.parts.some((part) => part.kind === "text" && part.text.includes("A required verification step is still unresolved."))
      )
    ).toBe(true);
  });

  test("feeds successful tool results back into the next turn", async () => {
    const { loop } = await createLoop(
      [
        buildModelResponse({
          messageText: "I need to inspect the file first.",
          sessionId: "session.loop.1",
          toolCalls: [{ arguments: { path: "AGENTS.md" }, callId: "tool.read.1", toolName: "read_file" }]
        }),
        buildModelResponse({
          messageText: "I used the tool output and the work is complete.",
          sessionId: "session.loop.1",
          toolCalls: [{ arguments: {}, callId: "tool.complete.5", toolName: "attempt_complete" }]
        })
      ],
      {
        toolExecutor: {
          async execute(call): Promise<AgentLoopToolExecutionResult> {
            const completedCall: ToolCallRecord = {
              ...call,
              completedAt: new Date().toISOString(),
              result: {
                content: "AGENTS.md contents"
              },
              status: "succeeded"
            };

            return {
              resultMessage: {
                createdAt: new Date().toISOString(),
                id: `message.tool.${call.id}`,
                metadata: {},
                parts: [{ kind: "json", value: { content: "AGENTS.md contents", status: "succeeded" } }],
                role: "tool",
                sessionId: call.sessionId,
                source: "tool_runtime",
                tags: [],
                turnId: call.turnId,
                visibility: "default"
              },
              toolCall: completedCall
            };
          }
        }
      }
    );

    const result = await loop.run({
      availableTools: [buildAttemptCompleteTool(), buildReadFileTool()],
      maxTurns: 4,
      session: buildSession(),
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).toBe("completed");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.status).toBe("succeeded");
    expect(result.turns[1]?.trigger).toBe("tool_result");
  });

  test("waits for pending approvals before applying steering, then resumes with steering after resolution", async () => {
    const root = await createTempRoot();
    const store = new FileSessionStore(path.join(root, ".aia"));
    const session = buildSession();
    await store.saveSession(session);

    const approvalRequest = buildApprovalRequest(session.id);
    await store.appendApprovalRequest(approvalRequest);

    const model = new FakeModel([
      buildModelResponse({
        messageText: "The operator approved the risky action and the task is complete.",
        sessionId: session.id,
        toolCalls: [{ arguments: {}, callId: "tool.complete.6", toolName: "attempt_complete" }]
      })
    ]);
    const loop = new AgentLoop({
      model,
      sessions: store
    });
    const steering = buildSteering(session.id);

    const paused = await loop.run({
      availableTools: [buildAttemptCompleteTool()],
      session,
      steeringInjections: [steering]
    });

    expect(paused.stopReason).toBe("awaiting_approval");
    expect(paused.turns).toHaveLength(0);

    const resumed = await loop.run({
      approvalResolutions: [
        {
          resolution: buildApprovalResolution(approvalRequest.id),
          sessionId: session.id
        }
      ],
      availableTools: [buildAttemptCompleteTool()],
      session: paused.session,
      steeringInjections: [steering]
    });

    expect(resumed.stopReason).toBe("completed");
    expect(resumed.turns[0]?.trigger).toBe("steering");
  });

  test('resumes with queued steering generated from a denied approval comment', async () => {
    const root = await createTempRoot();
    const store = new FileSessionStore(path.join(root, ".aia"));
    const session = buildSession();
    await store.saveSession(session);
    await store.appendApprovalRequest(buildApprovalRequest(session.id));

    const coordinator = new ApprovalCoordinator(store);
    await coordinator.resolveApproval({
      autoQueueDeniedCommentAsSteering: true,
      resolution: buildApprovalResolution("approval.loop.1", {
        actor: "web",
        comment: "Do not write yet. Read the file, explain the risk, and propose a patch instead.",
        decision: "denied",
        id: "approval-resolution.loop.denied"
      }),
      sessionId: session.id
    });

    const model = new FakeModel([
      buildModelResponse({
        messageText: "I followed the updated direction and the task is complete.",
        sessionId: session.id,
        toolCalls: [{ arguments: {}, callId: "tool.complete.7", toolName: "attempt_complete" }]
      })
    ]);
    const loop = new AgentLoop({
      model,
      sessions: store
    });

    const resumed = await loop.run({
      availableTools: [buildAttemptCompleteTool()],
      session
    });

    expect(resumed.stopReason).toBe("completed");
    expect(resumed.turns[0]?.trigger).toBe("steering");
    expect(resumed.messages.some((message) => message.role === "user" && message.source === "operator")).toBe(true);
  });

  test("initializes memory placeholders and compacts on accepted completion when a memory lifecycle is configured", async () => {
    const initializeCalls: string[] = [];
    const compactCalls: string[] = [];
    const { loop } = await createLoop(
      [
        buildModelResponse({
          messageText: "The work is complete.",
          sessionId: "session.loop.1",
          toolCalls: [{ arguments: {}, callId: "tool.complete.8", toolName: "attempt_complete" }]
        })
      ],
      {
        memoryLifecycle: {
          async compactSession(params) {
            compactCalls.push(`${params.sessionId}:${params.trigger}`);
          },
          async initializeSessionMemory(session) {
            initializeCalls.push(session.id);
          }
        }
      }
    );

    const result = await loop.run({
      availableTools: [buildAttemptCompleteTool()],
      session: buildSession(),
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).toBe("completed");
    expect(initializeCalls).toEqual(["session.loop.1"]);
    expect(compactCalls).toEqual(["session.loop.1:completion"]);
  });

  test("falls back to a failing default tool executor when none is configured", async () => {
    const { loop } = await createLoop([
      buildModelResponse({
        messageText: "Reading the file.",
        sessionId: "session.loop.1",
        toolCalls: [{ arguments: { path: "AGENTS.md" }, callId: "tool.read.default", toolName: "read_file" }]
      }),
      buildModelResponse({
        messageText: "Giving up after the tool failed.",
        sessionId: "session.loop.1",
        toolCalls: [{ arguments: {}, callId: "tool.complete.default", toolName: "attempt_complete" }]
      })
    ]);

    const result = await loop.run({
      availableTools: [buildReadFileTool(), buildAttemptCompleteTool()],
      maxTurns: 4,
      session: buildSession(),
      userMessages: [buildUserMessage()]
    });

    expect(result.toolCalls[0]?.status).toBe("failed");
    expect(result.toolCalls[0]?.error?.code).toBe("tool_runtime_unavailable");
  });

  test("records assistant tool calls as tool_call message parts", async () => {
    const { loop, store } = await createLoop([
      buildModelResponse({
        messageText: "Reading the file first.",
        sessionId: "session.loop.1",
        toolCalls: [{ arguments: { path: "AGENTS.md" }, callId: "tool.read.native", toolName: "read_file" }]
      }),
      buildModelResponse({
        messageText: "Done.",
        sessionId: "session.loop.1",
        toolCalls: [{ arguments: {}, callId: "tool.complete.native", toolName: "attempt_complete" }]
      })
    ]);

    const result = await loop.run({
      availableTools: [buildAttemptCompleteTool(), buildReadFileTool()],
      maxTurns: 4,
      session: buildSession(),
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).toBe("completed");
    const snapshot = await store.getSessionSnapshot(result.session.id);
    const assistantToolCallMessage = snapshot?.messages.find(
      (message) => message.role === "assistant" && message.parts.some((part) => part.kind === "tool_call")
    );
    expect(assistantToolCallMessage).toBeDefined();
    const toolCallPart = assistantToolCallMessage?.parts.find((part) => part.kind === "tool_call");
    expect(toolCallPart && toolCallPart.kind === "tool_call" ? toolCallPart.toolName : undefined).toBe("read_file");
    expect(toolCallPart && toolCallPart.kind === "tool_call" ? toolCallPart.callId : undefined).toBe("tool.read.native");
  });

  test("activates tools discovered through tool_search on the next turn", async () => {
    const browserTool = buildReadFileTool();
    browserTool.invocationName = "browser_open";
    browserTool.name = "browser_open";
    browserTool.toolId = "tool.builtin.browser_open";

    const toolSearchDefinition = buildReadFileTool();
    toolSearchDefinition.invocationName = "tool_search";
    toolSearchDefinition.name = "tool_search";
    toolSearchDefinition.toolId = "tool.builtin.tool_search";

    const catalog = new Map<string, ToolDefinition>([
      ["browser_open", browserTool],
      ["tool_search", toolSearchDefinition]
    ]);

    const { loop, model } = await createLoop(
      [
        buildModelResponse({
          messageText: "Searching for a browser tool.",
          sessionId: "session.loop.1",
          toolCalls: [{ arguments: { query: "browser" }, callId: "tool.search.1", toolName: "tool_search" }]
        }),
        buildModelResponse({
          messageText: "Done.",
          sessionId: "session.loop.1",
          toolCalls: [{ arguments: {}, callId: "tool.complete.activate", toolName: "attempt_complete" }]
        })
      ],
      {
        toolCatalog: {
          getDefinition: (toolName) => catalog.get(toolName) ?? null
        },
        toolExecutor: {
          async execute(call): Promise<AgentLoopToolExecutionResult> {
            return {
              toolCall: {
                ...call,
                completedAt: new Date().toISOString(),
                result: {
                  matches: [{ invocationName: "browser_open" }]
                },
                status: "succeeded"
              }
            };
          }
        }
      }
    );

    const result = await loop.run({
      availableTools: [buildAttemptCompleteTool(), toolSearchDefinition],
      maxTurns: 4,
      session: buildSession(),
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).toBe("completed");
    const secondRequest = model.requests[1];
    expect(secondRequest?.availableTools.some((tool) => tool.invocationName === "browser_open")).toBe(true);
    expect(model.requests[0]?.availableTools.some((tool) => tool.invocationName === "browser_open")).toBe(false);
  });

  test("compacts the session and stops replaying pre-compaction history once the token threshold is crossed", async () => {
    const compactCalls: Array<{ sessionId: string; trigger: string }> = [];
    const overThresholdResponse = buildModelResponse({
      messageText: "Reading the file.",
      sessionId: "session.loop.1",
      toolCalls: [{ arguments: { path: "AGENTS.md" }, callId: "tool.read.compact", toolName: "read_file" }]
    });
    overThresholdResponse.usage = { inputTokens: 5_000, outputTokens: 10, totalTokens: 5_010 };

    const { loop, model } = await createLoop(
      [
        overThresholdResponse,
        buildModelResponse({
          messageText: "Done.",
          sessionId: "session.loop.1",
          toolCalls: [{ arguments: {}, callId: "tool.complete.compact", toolName: "attempt_complete" }]
        })
      ],
      {
        autoCompactThresholdTokens: 1_000,
        memoryLifecycle: {
          async compactSession(params) {
            compactCalls.push({ sessionId: params.sessionId, trigger: params.trigger });
          },
          async initializeSessionMemory() {
            // no-op
          }
        },
        toolExecutor: {
          async execute(call): Promise<AgentLoopToolExecutionResult> {
            return {
              toolCall: {
                ...call,
                completedAt: new Date().toISOString(),
                result: { content: "file contents" },
                status: "succeeded"
              }
            };
          }
        }
      }
    );

    const result = await loop.run({
      availableTools: [buildAttemptCompleteTool(), buildReadFileTool()],
      maxTurns: 4,
      session: buildSession(),
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).toBe("completed");
    expect(compactCalls).toContainEqual({ sessionId: "session.loop.1", trigger: "threshold" });
    // After compaction the original user message must no longer be replayed;
    // the post-compaction request should start from the compaction watermark.
    const secondRequest = model.requests[1];
    expect(secondRequest?.messages.some((message) => message.id === "message.user.loop.1")).toBe(false);
    expect(secondRequest?.messages.some((message) => message.role === "tool")).toBe(true);
  });

  test("persists a failed session when the model throws an unexpected error", async () => {
    const { loop, store } = await createLoop([]);

    const result = await loop.run({
      availableTools: [buildAttemptCompleteTool()],
      session: buildSession(),
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).not.toBe("completed");
    const snapshot = await store.getSessionSnapshot("session.loop.1");
    expect(snapshot?.session.status).toBe("failed");
  });
});

async function createLoop(
  responses: LanguageModelResponse[],
  overrides: {
    autoCompactThresholdTokens?: number;
    completionGate?: (params: {
      latestResponse: LanguageModelResponse;
      session: SessionRecord;
      snapshot: Awaited<ReturnType<FileSessionStore["getSessionSnapshot"]>>;
    }) => Promise<AgentLoopCompletionDecision>;
    memoryLifecycle?: {
      compactSession(params: { sessionId: string; trigger: "completion" | "threshold"; sourceTokenCount?: number; threshold?: number }): Promise<void>;
      initializeSessionMemory(session: SessionRecord): Promise<void>;
    };
    toolCatalog?: {
      getDefinition(toolName: string): ToolDefinition | null;
    };
    toolExecutor?: {
      execute(call: ToolCallRecord, context: { session: SessionRecord; turn: TurnRecord }): Promise<AgentLoopToolExecutionResult>;
    };
  } = {}
) {
  const root = await createTempRoot();
  const store = new FileSessionStore(path.join(root, ".aia"));
  const session = buildSession();
  await store.saveSession(session);
  const model = new FakeModel(responses);

  return {
    loop: new AgentLoop({
      autoCompactThresholdTokens: overrides.autoCompactThresholdTokens,
      completionGate: overrides.completionGate,
      memoryLifecycle: overrides.memoryLifecycle,
      model,
      sessions: store,
      toolCatalog: overrides.toolCatalog,
      toolExecutor: overrides.toolExecutor
    }),
    model,
    session,
    store
  };
}

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-agent-loop-"));
  tempRoots.push(root);
  return root;
}

class FakeModel implements AgentLoopModel {
  readonly requests: Array<Omit<LanguageModelRequest, "modelId" | "provider"> & { modelId?: string; provider?: LanguageModelRequest["provider"] }> = [];
  private index = 0;

  constructor(private readonly responses: LanguageModelResponse[]) {}

  async generate(request: Omit<LanguageModelRequest, "modelId" | "provider"> & { modelId?: string; provider?: LanguageModelRequest["provider"] }) {
    this.requests.push(request);
    const response = this.responses[this.index];
    if (!response) {
      throw new Error(`Unexpected model turn ${this.index + 1}.`);
    }
    this.index += 1;
    return response;
  }
}

function buildSession(): SessionRecord {
  const now = "2026-03-27T12:00:00.000Z";
  return {
    createdAt: now,
    cwd: "/workspace",
    goal: "Finish the current task.",
    id: "session.loop.1",
    lastActiveAt: now,
    metadata: {},
    status: "idle",
    tags: [],
    title: "Loop Session",
    updatedAt: now
  };
}

function buildUserMessage(): Message {
  return {
    createdAt: "2026-03-27T12:00:01.000Z",
    id: "message.user.loop.1",
    metadata: {},
    parts: [{ kind: "text", text: "Please finish the task." }],
    role: "user",
    sessionId: "session.loop.1",
    source: "user",
    tags: [],
    turnId: "turn.user.loop.1",
    visibility: "default"
  };
}

function buildModelResponse(params: {
  messageText: string;
  sessionId: string;
  toolCalls: LanguageModelResponse["toolCalls"];
}): LanguageModelResponse {
  return {
    id: `response.${cryptoId()}`,
    message: {
      createdAt: new Date().toISOString(),
      id: `message.assistant.${cryptoId()}`,
      metadata: {},
      parts: [{ kind: "text", text: params.messageText }],
      role: "assistant",
      sessionId: params.sessionId,
      source: "assistant",
      tags: [],
      turnId: "turn.model.loop.1",
      visibility: "default"
    },
    metadata: {},
    modelId: "google/gemma-4-26b-a4b-qat",
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

function buildAttemptCompleteTool(): ToolDefinition {
  return {
    aliases: ["task_complete"],
    annotations: {
      meta: {},
      readOnlyHint: true,
      title: "Attempt Complete"
    },
    approvalMode: "never",
    descriptor: {
      approvalNotes: "The runtime will validate completion before ending the task.",
      examples: ["Use after the requested work is fully done."],
      purpose: "Finish the task through the runtime completion gate.",
      sideEffectSummary: "No side effects.",
      whenNotToUse: ["Do not use it together with other tool calls."],
      whenToUse: ["Use only when the task is complete."]
    },
    description: "Request task completion once all required work is done.",
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
    usageGuidance: "Use only when the task is actually complete and ready for runtime validation.",
    version: "1.0.0"
  };
}

function buildReadFileTool(): ToolDefinition {
  return {
    aliases: [],
    annotations: {
      meta: {},
      readOnlyHint: true,
      title: "Read File"
    },
    approvalMode: "never",
    descriptor: {
      approvalNotes: "No operator approval is required for this test fixture.",
      examples: ["Use before editing a file."],
      purpose: "Read a file from the workspace.",
      sideEffectSummary: "Reads workspace files without changing them.",
      whenNotToUse: ["Do not use to modify files."],
      whenToUse: ["Use when you need exact file contents before editing."]
    },
    description: "Read a file from the workspace.",
    displayName: "Read File",
    execution: {
      inputMode: "json",
      resumable: false,
      taskSupport: "forbidden"
    },
    idempotent: true,
    inputSchema: {
      type: "object"
    },
    invocationName: "read_file",
    kind: "built_in",
    metadata: {},
    name: "read_file",
    outputKind: "text",
    retryable: true,
    searchTags: ["files"],
    sideEffects: ["workspace_read"],
    source: {
      displayName: "Built-in Tools",
      kind: "built_in"
    },
    streamingMode: "none",
    toolId: "tool.builtin.read_file",
    usageGuidance: "Use when you need to inspect file contents before editing.",
    version: "1.0.0"
  };
}

function buildApprovalRequest(sessionId: string): ApprovalRequest {
  return {
    createdAt: "2026-03-27T12:00:02.000Z",
    id: "approval.loop.1",
    justification: "This action needs approval.",
    metadata: {},
    riskSummary: "Workspace mutation",
    sessionId,
    status: "pending",
    target: {
      kind: "tool",
      label: "write_file",
      value: "write_file"
    },
    turnId: "turn.approval.loop.1"
  };
}

function buildApprovalResolution(
  requestId: string,
  overrides: Partial<ApprovalResolution> = {}
): ApprovalResolution {
  return {
    actor: "cli",
    decidedAt: "2026-03-27T12:00:03.000Z",
    decision: "approved",
    id: "approval-resolution.loop.1",
    metadata: {},
    requestId,
    ...overrides
  };
}

function buildSteering(sessionId: string): SteeringInjection {
  return {
    createdAt: "2026-03-27T12:00:04.000Z",
    id: "steering.loop.1",
    message: "Use the safer path and continue.",
    metadata: {},
    sessionId,
    source: "user",
    state: "queued"
  };
}

function cryptoId() {
  return Math.random().toString(16).slice(2, 10);
}
