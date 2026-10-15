import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  AgentLoop,
  ApprovalCoordinator,
  COMPACTION_WATERMARK_METADATA_KEY,
  COMPLETION_SUMMARY_MESSAGE_TAG,
  CONTEXT_WINDOW_EXCEEDED_ERROR_CODE,
  FileSessionStore,
  LanguageModelRuntime,
  ProviderRequestError,
  createDefaultAppConfig,
  filterModelVisibleMessages,
  type AgentLoopCompletionDecision,
  type AgentLoopModel,
  type AgentLoopStatusMetrics,
  type AgentLoopToolExecutionResult,
  type AgentLoopToolExecutor,
  type ApprovalRequest,
  type ApprovalResolution,
  type LanguageModelAdapter,
  type LanguageModelCallOptions,
  type LanguageModelRequest,
  type LanguageModelResponse,
  type Message,
  type SessionRecord,
  type SteeringInjection,
  type TaskStateSnapshot,
  type ToolCallRecord,
  type ToolDefinition
} from "@/core";
import { serializeOpenAICompatibleMessages } from "@/core/lm/shared";

const tempRoots: string[] = [];

// Each loop gets an empty home of its own: left to default, it would discover
// skills from the operator's ~/.aia/skills and ~/.agents/skills.
let emptyHome = "";
beforeEach(async () => {
  emptyHome = await createTempRoot();
});

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
        toolCalls: [
          {
            arguments: {},
            callId: "tool.complete.1",
            toolName: "attempt_complete"
          }
        ]
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
    expect(
      (await store.getSessionSnapshot(result.session.id))?.messages.some((message) => message.role === "assistant")
    ).toBe(true);
  });

  // `attempt_complete` is a completion gate, not an executed tool, so its
  // `summary` produces no tool result and never streams. Before this was
  // persisted, a model that followed the prompt pack exactly (answer in the
  // argument, no chat message) finished a run with no visible answer anywhere.
  test("persists the accepted attempt_complete summary as a tagged assistant message", async () => {
    const { loop, store } = await createLoop([
      buildModelResponse({
        sessionId: "session.loop.completion-summary",
        toolCalls: [
          {
            arguments: { status: "success", summary: "17 * 23 = 391." },
            callId: "tool.complete.summary",
            toolName: "attempt_complete"
          }
        ]
      })
    ]);

    const result = await loop.run({
      availableTools: [buildAttemptCompleteTool()],
      session: buildSession(),
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).toBe("completed");

    const snapshot = await store.getSessionSnapshot(result.session.id);
    const summaryMessage = snapshot?.messages.find((message) =>
      (message.tags ?? []).includes(COMPLETION_SUMMARY_MESSAGE_TAG)
    );

    expect(summaryMessage).toBeDefined();
    expect(summaryMessage?.role).toBe("assistant");
    expect(summaryMessage?.visibility).toBe("default");
    expect(summaryMessage?.parts).toEqual([{ kind: "text", text: "17 * 23 = 391." }]);

    // The resume metadata is what the CLI reads for a stop notice, so the real
    // answer has to displace the generic "task completed successfully" literal.
    expect(snapshot?.resumeMetadata?.statusSummary).toBe("17 * 23 = 391.");
  });

  // `remainingCaveats` is declared on attempt_complete's schema and its own
  // usage guidance explicitly invites the model to report them, but nothing
  // ever read the argument back out of the intercepted completion call — an
  // honestly-reported caveat was silently discarded instead of reaching the
  // operator anywhere.
  test("appends remainingCaveats to the persisted completion summary", async () => {
    const { loop, store } = await createLoop([
      buildModelResponse({
        sessionId: "session.loop.caveats",
        toolCalls: [
          {
            arguments: {
              remainingCaveats: ["The migration script is untested against production data.", "", 42],
              status: "partial",
              summary: "Refactored the module."
            },
            callId: "tool.complete.caveats",
            toolName: "attempt_complete"
          }
        ]
      })
    ]);

    const result = await loop.run({
      availableTools: [buildAttemptCompleteTool()],
      session: buildSession(),
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).toBe("completed");

    const snapshot = await store.getSessionSnapshot(result.session.id);
    const summaryMessage = snapshot?.messages.find((message) =>
      (message.tags ?? []).includes(COMPLETION_SUMMARY_MESSAGE_TAG)
    );

    expect(summaryMessage?.parts).toEqual([
      {
        kind: "text",
        text: "Refactored the module.\n\nRemaining caveats:\n- The migration script is untested against production data."
      }
    ]);
  });

  test("falls back to the generic status when attempt_complete carries no usable summary", async () => {
    const { loop, store } = await createLoop([
      buildModelResponse({
        sessionId: "session.loop.blank-summary",
        toolCalls: [
          {
            arguments: { summary: "   " },
            callId: "tool.complete.blank",
            toolName: "attempt_complete"
          }
        ]
      })
    ]);

    const result = await loop.run({
      availableTools: [buildAttemptCompleteTool()],
      session: buildSession(),
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).toBe("completed");

    const snapshot = await store.getSessionSnapshot(result.session.id);
    expect(snapshot?.messages.some((message) => (message.tags ?? []).includes(COMPLETION_SUMMARY_MESSAGE_TAG))).toBe(
      false
    );

    expect(snapshot?.resumeMetadata?.statusSummary).toBe("The task completed successfully.");
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
        toolCalls: [
          {
            arguments: {},
            callId: "tool.complete.2",
            toolName: "attempt_complete"
          }
        ]
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
    expect(snapshot?.messages.some((message) => message.source === "system" && message.visibility === "compact")).toBe(
      true
    );
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
      buildModelResponse({
        messageText: "Acknowledged.",
        sessionId: "session.loop.1",
        toolCalls: []
      });
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
        toolCalls: [
          {
            arguments: {},
            callId: "tool.complete.rejected",
            toolName: "attempt_complete"
          }
        ]
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
      secondRequest?.messages.some((message) =>
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
          {
            arguments: {},
            callId: "tool.complete.mix",
            toolName: "attempt_complete"
          }
        ]
      }),
      buildModelResponse({
        messageText: "Now completing on its own.",
        sessionId: "session.loop.1",
        toolCalls: [
          {
            arguments: {},
            callId: "tool.complete.mixdone",
            toolName: "attempt_complete"
          }
        ]
      })
    ]);

    const result = await loop.run({
      availableTools: [buildAttemptCompleteTool()],
      maxTurns: 4,
      session: buildSession(),
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).toBe("completed");
    expect(result.turns.some((turn) => turn.summary === "The runtime rejected a mixed completion/tool turn.")).toBe(
      true
    );
    expect(result.turns.some((turn) => turn.trigger === "system_nudge")).toBe(true);
    const snapshot = await store.getSessionSnapshot(result.session.id);
    expect(snapshot?.messages.some((message) => message.source === "system" && message.visibility === "compact")).toBe(
      true
    );
  });

  test("stops with completion_blocked when the turn limit is reached without completion", async () => {
    const { loop } = await createLoop([
      buildModelResponse({
        messageText: "Still working (1).",
        sessionId: "session.loop.1",
        toolCalls: []
      }),
      buildModelResponse({
        messageText: "Still working (2).",
        sessionId: "session.loop.1",
        toolCalls: []
      })
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
          toolCalls: [
            {
              arguments: {},
              callId: "tool.complete.3",
              toolName: "attempt_complete"
            }
          ]
        }),
        buildModelResponse({
          messageText: "I addressed the remaining issue and this is now done.",
          sessionId: "session.loop.1",
          toolCalls: [
            {
              arguments: {},
              callId: "tool.complete.4",
              toolName: "attempt_complete"
            }
          ]
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
          message.parts.some(
            (part) => part.kind === "text" && part.text.includes("A required verification step is still unresolved.")
          )
      )
    ).toBe(true);
  });

  test("feeds successful tool results back into the next turn", async () => {
    const { loop } = await createLoop(
      [
        buildModelResponse({
          messageText: "I need to inspect the file first.",
          sessionId: "session.loop.1",
          toolCalls: [
            {
              arguments: { path: "AGENTS.md" },
              callId: "tool.read.1",
              toolName: "read_file"
            }
          ]
        }),
        buildModelResponse({
          messageText: "I used the tool output and the work is complete.",
          sessionId: "session.loop.1",
          toolCalls: [
            {
              arguments: {},
              callId: "tool.complete.5",
              toolName: "attempt_complete"
            }
          ]
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
                parts: [
                  {
                    kind: "json",
                    value: {
                      content: "AGENTS.md contents",
                      status: "succeeded"
                    }
                  }
                ],
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
        toolCalls: [
          {
            arguments: {},
            callId: "tool.complete.6",
            toolName: "attempt_complete"
          }
        ]
      })
    ]);
    const loop = new AgentLoop({ userHomeDirectory: emptyHome, model, sessions: store });
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

  test("resumes with queued steering generated from a denied approval comment", async () => {
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
        toolCalls: [
          {
            arguments: {},
            callId: "tool.complete.7",
            toolName: "attempt_complete"
          }
        ]
      })
    ]);
    const loop = new AgentLoop({ userHomeDirectory: emptyHome, model, sessions: store });

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
    const { loop, store } = await createLoop(
      [
        buildModelResponse({
          messageText: "The work is complete.",
          sessionId: "session.loop.1",
          toolCalls: [
            {
              arguments: {},
              callId: "tool.complete.8",
              toolName: "attempt_complete"
            }
          ]
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

    // Completion compaction must not hide the transcript: every chat turn ends
    // with attempt_complete, so moving the watermark here would make the next
    // turn in the same session start with no memory of the conversation.
    const persisted = await store.getSession(result.session.id);
    expect(result.session.metadata[COMPACTION_WATERMARK_METADATA_KEY]).toBeUndefined();
    expect(persisted?.metadata[COMPACTION_WATERMARK_METADATA_KEY]).toBeUndefined();
  });

  test("falls back to a failing default tool executor when none is configured", async () => {
    const { loop } = await createLoop([
      buildModelResponse({
        messageText: "Reading the file.",
        sessionId: "session.loop.1",
        toolCalls: [
          {
            arguments: { path: "AGENTS.md" },
            callId: "tool.read.default",
            toolName: "read_file"
          }
        ]
      }),
      buildModelResponse({
        messageText: "Giving up after the tool failed.",
        sessionId: "session.loop.1",
        toolCalls: [
          {
            arguments: {},
            callId: "tool.complete.default",
            toolName: "attempt_complete"
          }
        ]
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
        toolCalls: [
          {
            arguments: { path: "AGENTS.md" },
            callId: "tool.read.native",
            toolName: "read_file"
          }
        ]
      }),
      buildModelResponse({
        messageText: "Done.",
        sessionId: "session.loop.1",
        toolCalls: [
          {
            arguments: {},
            callId: "tool.complete.native",
            toolName: "attempt_complete"
          }
        ]
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
    expect(toolCallPart && toolCallPart.kind === "tool_call" ? toolCallPart.callId : undefined).toBe(
      "tool.read.native"
    );
  });

  test("activates tools discovered through tool_search on the next turn", async () => {
    const callable = new Map<string, string[]>();
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
          toolCalls: [
            {
              arguments: { query: "browser" },
              callId: "tool.search.1",
              toolName: "tool_search"
            }
          ]
        }),
        buildModelResponse({
          messageText: "Opening it.",
          sessionId: "session.loop.1",
          toolCalls: [{ arguments: {}, callId: "tool.browser.1", toolName: "browser_open" }]
        }),
        buildModelResponse({
          messageText: "Done.",
          sessionId: "session.loop.1",
          toolCalls: [
            {
              arguments: {},
              callId: "tool.complete.activate",
              toolName: "attempt_complete"
            }
          ]
        })
      ],
      {
        toolCatalog: {
          getDefinition: (toolName) => catalog.get(toolName) ?? null
        },
        toolExecutor: {
          async execute(call, context): Promise<AgentLoopToolExecutionResult> {
            // A tool is told what the model can call this turn (mcp_status
            // marks the rest).
            callable.set(call.toolName, [...(context.callableToolNames ?? [])].sort());
            return {
              toolCall: {
                ...call,
                completedAt: new Date().toISOString(),
                metadata: { ...call.metadata, activatesTools: ["browser_open"] },
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
    expect(callable.get("tool_search")).toEqual(["attempt_complete", "tool_search"]);
    expect(callable.get("browser_open")).toEqual(["attempt_complete", "browser_open", "tool_search"]);
  });

  test("compacts the session and stops replaying pre-compaction history once the token threshold is crossed", async () => {
    const compactCalls: Array<{ sessionId: string; trigger: string }> = [];
    const overThresholdResponse = buildModelResponse({
      messageText: "Reading the file.",
      sessionId: "session.loop.1",
      toolCalls: [
        {
          arguments: { path: "AGENTS.md" },
          callId: "tool.read.compact",
          toolName: "read_file"
        }
      ]
    });
    overThresholdResponse.usage = {
      inputTokens: 5_000,
      outputTokens: 10,
      totalTokens: 5_010
    };

    const { loop, model } = await createLoop(
      [
        overThresholdResponse,
        buildModelResponse({
          messageText: "Done.",
          sessionId: "session.loop.1",
          toolCalls: [
            {
              arguments: {},
              callId: "tool.complete.compact",
              toolName: "attempt_complete"
            }
          ]
        })
      ],
      {
        autoCompactThresholdTokens: 1_000,
        memoryLifecycle: {
          async compactSession(params) {
            compactCalls.push({
              sessionId: params.sessionId,
              trigger: params.trigger
            });
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
    expect(compactCalls).toContainEqual({
      sessionId: "session.loop.1",
      trigger: "threshold"
    });
    // Compaction folds the turn's history into the summary but keeps what the
    // operator asked: the summary records no requests, and a history that
    // opens with the assistant's tool call is refused by chat templates such
    // as Qwen 3.5's ("No user query found in messages."), which is how every
    // later request in a compacted LM Studio session failed (2026-10-02).
    const secondRequest = model.requests[1]!;
    expect(secondRequest.messages.map((message) => message.id)[0]).toBe("message.user.loop.1");
    expect(secondRequest.messages.some((message) => message.role === "tool")).toBe(true);
    const wire = await serializeOpenAICompatibleMessages({
      ...secondRequest,
      modelId: "qwen3.8-27b-mlx",
      provider: "lm_studio"
    });
    expect(wire.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool"]);
  });

  // The provider refused a prompt larger than its context window (llama.cpp's
  // exceed_context_size_error). The loop folds the history before the current
  // task into the session summary and asks once more, with the task intact.
  describe("context window overflow", () => {
    // As the llama.cpp adapter reports one: with the provider's own remedy.
    const overflow = (remedy: string | null = "Start llama-server with a larger context (-c)") =>
      new ProviderRequestError({
        code: CONTEXT_WINDOW_EXCEEDED_ERROR_CODE,
        details: { contextWindowTokens: 32_768, promptTokens: 40_000, ...(remedy ? { remedy } : {}) },
        message: "request (40000 tokens) exceeds the available context size (32768 tokens), try increasing it",
        retriable: false
      });
    const readTurn = () =>
      buildModelResponse({
        messageText: "Reading the file.",
        sessionId: "session.loop.1",
        toolCalls: [{ arguments: { path: "AGENTS.md" }, callId: "tool.read.overflow", toolName: "read_file" }]
      });
    const completeTurn = (callId = "tool.complete.overflow") =>
      buildModelResponse({
        messageText: "Done.",
        sessionId: "session.loop.1",
        toolCalls: [{ arguments: {}, callId, toolName: "attempt_complete" }]
      });
    const recordingLifecycle = (calls: Array<{ sourceTokenCount?: number; trigger: string }>) => ({
      async compactSession(params: { sourceTokenCount?: number; trigger: string }) {
        calls.push({ sourceTokenCount: params.sourceTokenCount, trigger: params.trigger });
      },
      async initializeSessionMemory() {
        // no-op
      }
    });
    const succeedingReads = {
      async execute(call: ToolCallRecord): Promise<AgentLoopToolExecutionResult> {
        return {
          toolCall: { ...call, completedAt: new Date().toISOString(), result: { content: "huge" }, status: "succeeded" }
        };
      }
    };
    const secondRequest: Message = {
      ...buildUserMessage(),
      createdAt: "2026-03-27T12:05:00.000Z",
      id: "message.user.loop.2",
      parts: [{ kind: "text", text: "Now read AGENTS.md." }],
      turnId: "turn.user.loop.2"
    };
    const tools = () => [buildAttemptCompleteTool(), buildReadFileTool()];

    test("folds the history before this task once, and retries with the task intact under a new id", async () => {
      const compactCalls: Array<{ sourceTokenCount?: number; trigger: string }> = [];
      const { loop, model } = await createLoop(
        [completeTurn("tool.complete.first"), readTurn(), overflow(), completeTurn()],
        { memoryLifecycle: recordingLifecycle(compactCalls), toolExecutor: succeedingReads }
      );
      const first = await loop.run({
        availableTools: tools(),
        session: buildSession(),
        userMessages: [buildUserMessage()]
      });
      expect(first.stopReason).toBe("completed");

      const result = await loop.run({
        availableTools: tools(),
        maxTurns: 4,
        session: first.session,
        userMessages: [secondRequest]
      });

      expect(result.stopReason).toBe("completed");
      expect(compactCalls).toContainEqual({ sourceTokenCount: 40_000, trigger: "overflow" });
      const [, , overflowed, retried] = model.requests;
      // A queue refuses a job id it has seen, so the retry needs its own.
      expect(retried?.id).toBe(`${overflowed?.id}.overflow-retry`);
      expect(new Set(model.requests.map((request) => request.id)).size).toBe(model.requests.length);
      // The earlier task is folded (only what its operator said is kept); this
      // task, its tool call and the result included, is not.
      const retriedIds = retried?.messages.map((message) => message.id) ?? [];
      expect(retriedIds.slice(0, 2)).toEqual(["message.user.loop.1", "message.user.loop.2"]);
      expect(retried?.messages.map((message) => message.role)).toEqual(["user", "user", "assistant", "tool"]);
      expect(retriedIds).not.toContain(first.messages.find((message) => message.role === "assistant")?.id);
    });

    test("reports both sizes and the fix when the prompt still does not fit after compacting", async () => {
      const compactCalls: Array<{ sourceTokenCount?: number; trigger: string }> = [];
      const { loop, store } = await createLoop(
        [completeTurn("tool.complete.first"), readTurn(), overflow(), overflow()],
        { memoryLifecycle: recordingLifecycle(compactCalls), toolExecutor: succeedingReads }
      );
      const first = await loop.run({
        availableTools: tools(),
        session: buildSession(),
        userMessages: [buildUserMessage()]
      });

      const result = await loop.run({
        availableTools: tools(),
        maxTurns: 4,
        session: first.session,
        userMessages: [secondRequest]
      });

      expect(result.stopReason).toBe("failed");
      expect(compactCalls.filter((call) => call.trigger === "overflow")).toHaveLength(1);
      const lastError = (await store.getSessionSnapshot("session.loop.1"))?.session.lastError;
      expect(lastError?.code).toBe(CONTEXT_WINDOW_EXCEEDED_ERROR_CODE);
      expect(lastError?.message).toContain(
        "The prompt (40000 tokens) is larger than the model's context window (32768 tokens), even after compacting the session."
      );
      // The failing provider's remedy, not every provider's settings.
      expect(lastError?.message).toContain("Start llama-server with a larger context (-c), or start a new session.");
      expect(lastError?.message).not.toContain("LM Studio");
    });

    test("does not fold the task's own work: with nothing before it, it fails at once and says why", async () => {
      // One run: its own tool result is what overflows. Folding it would hand
      // the model its request and nothing it had done; no output cap trims it.
      const compactCalls: Array<{ sourceTokenCount?: number; trigger: string }> = [];
      // A provider an SDK host registered gives no remedy: the advice is generic.
      const { loop, model, store } = await createLoop([readTurn(), overflow(null)], {
        memoryLifecycle: recordingLifecycle(compactCalls),
        toolExecutor: succeedingReads
      });

      const result = await loop.run({
        availableTools: tools(),
        maxTurns: 4,
        session: buildSession(),
        userMessages: [buildUserMessage()]
      });

      expect(result.stopReason).toBe("failed");
      expect(compactCalls).toEqual([]);
      expect(model.requests).toHaveLength(2);
      const lastError = (await store.getSessionSnapshot("session.loop.1"))?.session.lastError;
      expect(lastError?.message).toContain(
        "(32768 tokens), and nothing from before this task is left to fold: the task's own messages and tool results do not fit."
      );
      expect(lastError?.message).toContain("a line range, a narrower search");
      expect(lastError?.message).toContain("Load the model with a larger context window, or ask for less");
    });

    test("tells the host the window the refusal named, so later compaction uses it", async () => {
      const learned: Array<{ contextWindowTokens?: number; promptTokens?: number }> = [];
      const root = await createTempRoot();
      const store = new FileSessionStore(path.join(root, ".aia"));
      await store.saveSession(buildSession());
      const loop = new AgentLoop({
        userHomeDirectory: emptyHome,
        model: new FakeModel([overflow()]),
        onContextWindowExceeded: (details) => learned.push(details),
        sessions: store
      });

      await loop.run({ availableTools: tools(), session: buildSession(), userMessages: [buildUserMessage()] });

      expect(learned).toEqual([{ contextWindowTokens: 32_768, promptTokens: 40_000 }]);
    });

    test("retries through the real file-backed model queue", async () => {
      const root = await createTempRoot();
      const config = createDefaultAppConfig({ userStateDirectory: path.join(root, "home", ".aia") });
      config.memory.stateRoot = path.join(root, ".aia");
      const scripted: Array<Error | LanguageModelResponse> = [
        completeTurn("tool.complete.first"),
        overflow(),
        completeTurn()
      ];
      const seenIds: string[] = [];
      const adapter: LanguageModelAdapter = {
        async generate(request) {
          seenIds.push(request.id);
          const next = scripted.shift();
          if (!next || next instanceof Error) {
            throw next ?? new Error("Unexpected model turn.");
          }
          return { ...next, modelId: request.modelId, provider: request.provider };
        },
        async health() {
          return { checkedAt: new Date().toISOString(), details: {}, providerId: "lm_studio", status: "healthy" };
        },
        async listModels() {
          return [];
        },
        provider: "lm_studio",
        providerId: "lm_studio"
      };
      const runtime = new LanguageModelRuntime({ adapters: [{ adapter }], config });
      const store = new FileSessionStore(path.join(root, "sessions"));
      await store.saveSession(buildSession());
      const compactCalls: Array<{ sourceTokenCount?: number; trigger: string }> = [];
      const loop = new AgentLoop({
        userHomeDirectory: emptyHome,
        memoryLifecycle: recordingLifecycle(compactCalls),
        model: runtime,
        sessions: store
      });
      try {
        const first = await loop.run({
          availableTools: tools(),
          session: buildSession(),
          userMessages: [buildUserMessage()]
        });
        const result = await loop.run({
          availableTools: tools(),
          session: first.session,
          userMessages: [secondRequest]
        });

        // The queue used to refuse the retry: 'Language model queue job "…" already exists.'
        expect(result.stopReason).toBe("completed");
        expect(seenIds[2]).toBe(`${seenIds[1]}.overflow-retry`);
      } finally {
        await runtime.close();
      }
    });
  });

  // The session summary records tool calls and narration, never the requests,
  // so what people said is the one part of the folded history that is kept.
  describe("compaction keeps the conversation's own messages", () => {
    const message = (id: string, overrides: Partial<Message> = {}): Message => ({
      createdAt: "2026-10-02T15:00:00.000Z",
      id,
      metadata: {},
      parts: [{ kind: "text", text: id }],
      role: "user",
      sessionId: "session.loop.1",
      source: "user",
      tags: [],
      visibility: "default",
      ...overrides
    });
    const compactedThrough = (messageId: string): SessionRecord => ({
      ...buildSession(),
      metadata: { [COMPACTION_WATERMARK_METADATA_KEY]: messageId }
    });
    const textOf = (entry: Message | undefined) =>
      (entry?.parts ?? []).map((part) => (part.kind === "text" ? part.text : "")).join("");

    test("keeps operator, steering, and channel messages newest first within Codex's budget", () => {
      const history = [
        message("message.oldest"),
        message("message.long", { parts: [{ kind: "text", text: "A".repeat(50_000) }] }),
        message("message.reply", { role: "assistant", source: "assistant" }),
        message("message.skill", { source: "system", tags: ["skill"], visibility: "compact" }),
        message("message.channel", { parts: [{ kind: "text", text: "B".repeat(70_000) }], source: "channel" }),
        message("message.screenshot", {
          parts: [
            { kind: "text", text: "Look at this screenshot:" },
            { kind: "image", uri: "file:///tmp/shot.png" }
          ]
        }),
        message("message.steering", {
          parts: [{ kind: "text", text: "Also update the docs." }],
          source: "operator",
          tags: ["steering"]
        }),
        message("message.status", {
          parts: [{ kind: "status", state: "idle", summary: "Turn 1" }],
          role: "status",
          source: "system",
          visibility: "hidden"
        }),
        message("message.tool-call", {
          parts: [{ arguments: {}, callId: "call.1", kind: "tool_call", toolName: "read_file" }],
          role: "assistant",
          source: "assistant"
        }),
        message("message.tool-result", { metadata: { toolCallId: "call.1" }, role: "tool", source: "tool_runtime" })
      ];

      const visible = filterModelVisibleMessages(history, compactedThrough("message.status"));

      // The skill's instructions are restated by the prompt instead, and the
      // assistant's reply was folded into the summary.
      expect(visible.map((entry) => entry.id)).toEqual([
        "message.long",
        "message.channel",
        "message.screenshot",
        "message.steering",
        "message.tool-call",
        "message.tool-result"
      ]);
      // 80,000 characters: the newest three take 70,045, so the 50,000-character
      // message keeps 9,955 of its own (start and end) and the older one is dropped.
      const long = textOf(visible[0]);
      expect(
        long.startsWith(
          `${"A".repeat(4_978)}\n\n[40,045 characters of this message were dropped when the session was compacted]\n\nA`
        )
      ).toBe(true);
      expect(long.replace(/[^A]/gu, "")).toHaveLength(9_955);
      // Text only: an image in a folded message is not replayed.
      expect(visible[2]?.parts).toEqual([{ kind: "text", text: "Look at this screenshot:" }]);
      // A text message that fits whole is replayed as stored.
      expect(visible[3]).toBe(history[6]);
    });

    test("changes nothing for a session that has never been compacted", () => {
      const history = [message("message.user"), message("message.reply", { role: "assistant", source: "assistant" })];
      expect(filterModelVisibleMessages(history, buildSession())).toEqual(history);
    });
  });

  // A local server reuses what it has already read of a prompt only up to the
  // first change, and the whole conversation follows the system prompt. A plan
  // update between two runs once made LM Studio re-read 80k tokens: 13 minutes,
  // past the first-token budget (2026-10-02).
  describe("the system prompt between runs", () => {
    const taskStateWith = (completed: number, nextStep: string): TaskStateSnapshot => ({
      blockers: [],
      nextStep: {
        createdAt: "2026-10-02T23:50:00.000Z",
        id: `note.next.${completed}`,
        kind: "next_step",
        metadata: {},
        priority: "high",
        sessionId: "session.loop.1",
        text: nextStep
      },
      plan: null,
      progress: { blocked: 0, cancelled: 0, completed, inProgress: 1, pending: 5 - completed, total: 6 },
      recentAttempts: [],
      sessionId: "session.loop.1",
      summary: "Add the search MCP server",
      updatedAt: "2026-10-02T23:50:00.000Z",
      workingMemory: []
    });
    const completeTurn = (callId: string) =>
      buildModelResponse({
        sessionId: "session.loop.1",
        toolCalls: [{ arguments: { summary: "done" }, callId, toolName: "attempt_complete" }]
      });
    const followUp = (): Message => ({
      ...buildUserMessage(),
      id: "message.user.loop.2",
      parts: [{ kind: "text", text: "Carry on." }]
    });

    test("stays the same while the plan changes, before anything is folded", async () => {
      let state = taskStateWith(0, "Read the docs");
      const { loop, model } = await createLoop([completeTurn("tool.complete.a"), completeTurn("tool.complete.b")], {
        taskStateProvider: { getTaskState: async () => state }
      });

      const first = await loop.run({
        availableTools: [buildAttemptCompleteTool()],
        session: buildSession(),
        userMessages: [buildUserMessage()]
      });
      state = taskStateWith(1, "Write the config");
      await loop.run({
        availableTools: [buildAttemptCompleteTool()],
        session: first.session,
        userMessages: [followUp()]
      });

      expect(model.requests[1]?.instructions).toBe(model.requests[0]?.instructions);
      // The model sees its plan through its own plan-tool calls until a fold.
      expect(model.requests[0]?.instructions).not.toContain("Task State");
    });

    test("shows the task state as of the last fold, and keeps it until the next one", async () => {
      let state = taskStateWith(1, "Write the config");
      const readTurn = buildModelResponse({
        messageText: "Reading the file.",
        sessionId: "session.loop.1",
        toolCalls: [{ arguments: { path: "AGENTS.md" }, callId: "tool.read.fold", toolName: "read_file" }]
      });
      readTurn.usage = { inputTokens: 5_000, outputTokens: 10, totalTokens: 5_010 };
      const { loop, model } = await createLoop(
        [readTurn, completeTurn("tool.complete.fold"), completeTurn("tool.complete.later")],
        {
          autoCompactThresholdTokens: 1_000,
          memoryLifecycle: {
            async compactSession() {
              // no-op
            },
            async initializeSessionMemory() {
              // no-op
            }
          },
          taskStateProvider: { getTaskState: async () => state },
          toolExecutor: {
            async execute(call): Promise<AgentLoopToolExecutionResult> {
              return {
                toolCall: {
                  ...call,
                  completedAt: new Date().toISOString(),
                  result: { content: "x" },
                  status: "succeeded"
                }
              };
            }
          }
        }
      );

      const first = await loop.run({
        availableTools: [buildAttemptCompleteTool(), buildReadFileTool()],
        session: buildSession(),
        userMessages: [buildUserMessage()]
      });
      // Folded after the read: the next request shows the plan as of the fold.
      expect(model.requests[1]?.instructions).toContain("Progress: 1/6 completed");
      expect(model.requests[1]?.instructions).toContain("Next step: Write the config");

      state = taskStateWith(2, "Test the connection");
      await loop.run({
        availableTools: [buildAttemptCompleteTool(), buildReadFileTool()],
        session: first.session,
        userMessages: [followUp()]
      });
      expect(model.requests[2]?.instructions).toBe(model.requests[1]?.instructions);
    });
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

  test("allows a single planning turn between substantive turns without nudging", async () => {
    // "think, then act" is the pattern the prompt asks for, so one planning
    // turn must stay silent. Only a second consecutive one is a loop.
    const { loop, store } = await createLoop(
      [
        buildModelResponse({
          messageText: "Let me plan.",
          sessionId: "session.loop.1",
          toolCalls: [
            {
              arguments: { thought: "plan first" },
              callId: "tool.think.single",
              toolName: "think"
            }
          ]
        }),
        buildModelResponse({
          messageText: "Acting on the plan.",
          sessionId: "session.loop.1",
          toolCalls: [
            {
              arguments: { path: "AGENTS.md" },
              callId: "tool.read.single",
              toolName: "read_file"
            }
          ]
        }),
        buildModelResponse({
          messageText: "Done.",
          sessionId: "session.loop.1",
          toolCalls: [
            {
              arguments: {},
              callId: "tool.complete.single",
              toolName: "attempt_complete"
            }
          ]
        })
      ],
      {
        toolExecutor: {
          async execute(call): Promise<AgentLoopToolExecutionResult> {
            const completedCall: ToolCallRecord = {
              ...call,
              completedAt: new Date().toISOString(),
              result: { acknowledged: true },
              status: "succeeded"
            };
            return {
              resultMessage: {
                createdAt: new Date().toISOString(),
                id: `message.tool.${call.id}`,
                metadata: {},
                parts: [{ kind: "json", value: { acknowledged: true } }],
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
      availableTools: [buildAttemptCompleteTool(), buildThinkTool(), buildReadFileTool()],
      maxTurns: 6,
      session: buildSession(),
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).toBe("completed");
    const snapshot = await store.getSessionSnapshot("session.loop.1");
    expect(
      snapshot?.messages.some(
        (message) =>
          message.source === "system" &&
          message.parts.some((part) => part.kind === "text" && part.text.includes("Stop planning now"))
      )
    ).toBe(false);
  });

  test("stops with completion_blocked when the model only plans or reasons without acting", async () => {
    const { loop, store } = await createLoop(
      // The first planning turn is deliberately free ("think, then act"), so it
      // takes maxConsecutiveNudges + 2 planning turns to trip the guard.
      Array.from({ length: 6 }, (_unused, index) =>
        buildModelResponse({
          messageText: `Planning iteration ${index + 1}.`,
          sessionId: "session.loop.1",
          toolCalls: [
            {
              arguments: { thought: `still planning ${index + 1}` },
              callId: `tool.think.${index + 1}`,
              toolName: "think"
            }
          ]
        })
      ),
      {
        toolExecutor: {
          async execute(call): Promise<AgentLoopToolExecutionResult> {
            const completedCall: ToolCallRecord = {
              ...call,
              completedAt: new Date().toISOString(),
              result: { acknowledged: true },
              status: "succeeded"
            };
            return {
              resultMessage: {
                createdAt: new Date().toISOString(),
                id: `message.tool.${call.id}`,
                metadata: {},
                parts: [{ kind: "json", value: { acknowledged: true } }],
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
      availableTools: [buildAttemptCompleteTool(), buildThinkTool()],
      maxTurns: 10,
      session: buildSession(),
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).toBe("completion_blocked");
    expect(
      result.turns.some((turn) => turn.summary?.includes("planning or reasoning turns without taking action"))
    ).toBe(true);
    const snapshot = await store.getSessionSnapshot("session.loop.1");
    expect(
      snapshot?.messages.some(
        (message) =>
          message.source === "system" &&
          message.parts.some((part) => part.kind === "text" && part.text.includes("Stop planning now"))
      )
    ).toBe(true);
  });

  test("moves <think> reasoning into a reasoning part and ages it out of later model requests", async () => {
    const { loop, store } = await createLoop(
      [
        buildModelResponse({
          messageText: "<think>internal deliberation that should not persist</think>\nReading the file now.",
          sessionId: "session.loop.1",
          toolCalls: [
            {
              arguments: { path: "AGENTS.md" },
              callId: "tool.read.think",
              toolName: "read_file"
            }
          ]
        }),
        buildModelResponse({
          messageText: "Done.",
          sessionId: "session.loop.1",
          toolCalls: [
            {
              arguments: {},
              callId: "tool.complete.think",
              toolName: "attempt_complete"
            }
          ]
        })
      ],
      {
        toolExecutor: {
          async execute(call): Promise<AgentLoopToolExecutionResult> {
            const completedCall: ToolCallRecord = {
              ...call,
              completedAt: new Date().toISOString(),
              result: { content: "ok" },
              status: "succeeded"
            };
            return {
              resultMessage: {
                createdAt: new Date().toISOString(),
                id: `message.tool.${call.id}`,
                metadata: {},
                parts: [{ kind: "json", value: { content: "ok" } }],
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
    const snapshot = await store.getSessionSnapshot("session.loop.1");
    const assistantWithTool = snapshot?.messages.find(
      (message) =>
        message.role === "assistant" &&
        message.parts.some((part) => part.kind === "tool_call" && part.toolName === "read_file")
    );
    const text = (assistantWithTool?.parts ?? []).map((part) => (part.kind === "text" ? part.text : "")).join(" ");
    expect(text).not.toContain("internal deliberation");
    expect(text).not.toContain("<think>");
    expect(text).toContain("Reading the file now.");

    // The transcript keeps the reasoning as its own part rather than deleting
    // it: the operator wanted it readable, and the model still needs it within
    // the turn that produced it.
    const reasoning = (assistantWithTool?.parts ?? []).filter((part) => part.kind === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]).toMatchObject({
      text: "internal deliberation that should not persist"
    });

    // By the time a later turn runs, that reasoning is outside the retained
    // window and must not be replayed into the model's context.
    const laterVisible = filterModelVisibleMessages(snapshot?.messages ?? [], snapshot?.session ?? buildSession(), {
      reasoningContextTurns: 1
    });
    expect(
      laterVisible.some((message) =>
        message.parts.some((part) => part.kind === "reasoning" && part.text.includes("internal deliberation"))
      )
    ).toBe(false);
    // The answer itself survives the filter.
    expect(
      laterVisible.some((message) =>
        message.parts.some((part) => part.kind === "text" && part.text.includes("Reading the file now."))
      )
    ).toBe(true);
  });

  test("emits status metrics (tokens, context %, elapsed) after each model response", async () => {
    const root = await createTempRoot();
    const store = new FileSessionStore(path.join(root, ".aia"));
    const session = buildSession();
    await store.saveSession(session);

    const metricsSeen: AgentLoopStatusMetrics[] = [];
    const loop = new AgentLoop({
      userHomeDirectory: emptyHome,
      contextWindowTokens: 100,
      model: new FakeModel([
        buildModelResponse({
          messageText: "Done.",
          sessionId: session.id,
          toolCalls: [
            {
              arguments: {},
              callId: "tool.complete.metrics",
              toolName: "attempt_complete"
            }
          ]
        })
      ]),
      onStatus: ({ metrics }) => {
        if (metrics) {
          metricsSeen.push(metrics);
        }
      },
      sessions: store
    });

    const result = await loop.run({
      availableTools: [buildAttemptCompleteTool()],
      session,
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).toBe("completed");
    expect(metricsSeen.length).toBeGreaterThan(0);
    // tokensUsed reports generated (output) tokens, which include reasoning.
    expect(metricsSeen[0]?.tokensUsed).toBe(5);
    // context % uses prompt (input) tokens: 10 / 100 = 10%.
    expect(metricsSeen[0]?.contextWindowPercentage).toBe(10);
    expect(typeof metricsSeen[0]?.elapsedSeconds).toBe("number");
  });

  test("falls back to a default context window for the % metric when none is configured", async () => {
    const root = await createTempRoot();
    const store = new FileSessionStore(path.join(root, ".aia"));
    const session = buildSession();
    await store.saveSession(session);

    const metricsSeen: AgentLoopStatusMetrics[] = [];
    const loop = new AgentLoop({
      userHomeDirectory: emptyHome,
      model: new FakeModel([
        buildModelResponse({
          messageText: "Done.",
          sessionId: session.id,
          toolCalls: [
            {
              arguments: {},
              callId: "tool.complete.fallback",
              toolName: "attempt_complete"
            }
          ]
        })
      ]),
      onStatus: ({ metrics }) => {
        if (metrics) {
          metricsSeen.push(metrics);
        }
      },
      sessions: store
    });

    const result = await loop.run({
      availableTools: [buildAttemptCompleteTool()],
      session,
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).toBe("completed");
    // No contextWindowTokens configured → the % is still emitted using the
    // default window (32768): 10 / 32768 ≈ 0.0%.
    expect(metricsSeen[0]).toHaveProperty("contextWindowPercentage");
    expect(metricsSeen[0]?.contextWindowPercentage).toBe(0);
  });

  test("reports cumulative generated tokens across the turns in a run", async () => {
    const root = await createTempRoot();
    const store = new FileSessionStore(path.join(root, ".aia"));
    const session = buildSession();
    await store.saveSession(session);

    const metricsSeen: AgentLoopStatusMetrics[] = [];
    const loop = new AgentLoop({
      userHomeDirectory: emptyHome,
      model: new FakeModel([
        buildModelResponse({
          messageText: "Reading first.",
          sessionId: session.id,
          toolCalls: [
            {
              arguments: { path: "AGENTS.md" },
              callId: "tool.read.cum",
              toolName: "read_file"
            }
          ]
        }),
        buildModelResponse({
          messageText: "Done.",
          sessionId: session.id,
          toolCalls: [
            {
              arguments: {},
              callId: "tool.complete.cum",
              toolName: "attempt_complete"
            }
          ]
        })
      ]),
      onStatus: ({ metrics }) => {
        if (metrics) {
          metricsSeen.push(metrics);
        }
      },
      sessions: store,
      toolExecutor: {
        async execute(call): Promise<AgentLoopToolExecutionResult> {
          return {
            toolCall: {
              ...call,
              completedAt: new Date().toISOString(),
              result: { content: "ok" },
              status: "succeeded"
            }
          };
        }
      }
    });

    const result = await loop.run({
      availableTools: [buildAttemptCompleteTool(), buildReadFileTool()],
      maxTurns: 4,
      session,
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).toBe("completed");
    // Each FakeModel response reports outputTokens=5, so the running total is 5
    // after turn 1 and 10 after turn 2.
    expect(metricsSeen.map((metric) => metric.tokensUsed)).toEqual([5, 10]);
  });
});

// Cancel used to be a flag checked only before and after a whole run: a
// cancelled run kept generating and kept executing tools until it finished on
// its own, and steering sent mid-run waited for the next run.
describe("agent loop run control", () => {
  test("a run whose signal is already aborted starts no turn", async () => {
    const { loop, store } = await createLoop([]);
    const controller = new AbortController();
    controller.abort();

    const result = await loop.run({
      availableTools: [buildAttemptCompleteTool()],
      session: buildSession(),
      signal: controller.signal,
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).toBe("cancelled");
    expect(result.turns).toHaveLength(0);
    const snapshot = await store.getSessionSnapshot(result.session.id);
    expect(snapshot?.session.status).toBe("cancelled");
    expect(snapshot?.resumeMetadata?.statusSummary).toBe("Cancelled by the operator.");
  });

  test("cancelling during the model call aborts the request and ends the run as cancelled", async () => {
    const root = await createTempRoot();
    const store = new FileSessionStore(path.join(root, ".aia"));
    const session = buildSession();
    await store.saveSession(session);
    const controller = new AbortController();
    const seenSignals: Array<AbortSignal | undefined> = [];
    const model = new ScriptedModel(async (_index, _request, options) => {
      seenSignals.push(options?.signal);
      // Stands in for a provider that only returns when the request is aborted.
      return await new Promise<LanguageModelResponse>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          reject(new Error("The request was cancelled."));
        });
        controller.abort();
      });
    });
    const loop = new AgentLoop({ userHomeDirectory: emptyHome, model, sessions: store });

    const result = await loop.run({
      availableTools: [buildAttemptCompleteTool()],
      session,
      signal: controller.signal,
      userMessages: [buildUserMessage()]
    });

    expect(seenSignals).toEqual([controller.signal]);
    expect(result.stopReason).toBe("cancelled");
    expect(result.session.status).toBe("cancelled");
    expect(result.turns.map((turn) => turn.status)).toEqual(["cancelled"]);
    expect(result.turns[0]?.summary).toBe("Cancelled by the operator while the model was generating.");
  });

  test("a cancel while a tool runs lets that call finish and starts none of the rest", async () => {
    const controller = new AbortController();
    const executedPaths: string[] = [];
    const { loop, store } = await createLoop(
      [
        buildModelResponse({
          sessionId: "session.loop.1",
          toolCalls: [
            { arguments: { path: "a.md" }, callId: "tool.read.a", toolName: "read_file" },
            { arguments: { path: "b.md" }, callId: "tool.read.b", toolName: "read_file" }
          ]
        })
        // No second response: a second model turn would fail the run.
      ],
      {
        toolExecutor: {
          async execute(call): Promise<AgentLoopToolExecutionResult> {
            executedPaths.push(String(call.arguments.path));
            controller.abort();
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
      signal: controller.signal,
      userMessages: [buildUserMessage()]
    });

    expect(executedPaths).toEqual(["a.md"]);
    expect(result.stopReason).toBe("cancelled");
    expect(result.toolCalls.map((toolCall) => toolCall.status)).toEqual(["succeeded", "cancelled"]);
    expect(result.toolCalls[1]?.error?.code).toBe("tool_call_cancelled");
    // Every proposed call keeps a result in the transcript.
    const snapshot = await store.getSessionSnapshot(result.session.id);
    const toolResults = snapshot?.messages.filter((message) => message.role === "tool") ?? [];
    expect(toolResults).toHaveLength(2);
    expect(JSON.stringify(toolResults[1]?.parts)).toContain("tool_call_cancelled");
  });

  test("delivers steering that arrives while tools run at the next tool boundary", async () => {
    const root = await createTempRoot();
    const store = new FileSessionStore(path.join(root, ".aia"));
    const session = buildSession();
    await store.saveSession(session);
    const steering = buildSteering(session.id);
    const model = new ScriptedModel(async (index) =>
      index === 0
        ? buildModelResponse({
            sessionId: session.id,
            toolCalls: [{ arguments: { path: "a.md" }, callId: "tool.read.a", toolName: "read_file" }]
          })
        : buildModelResponse({
            sessionId: session.id,
            toolCalls: [{ arguments: {}, callId: "tool.complete.steered", toolName: "attempt_complete" }]
          })
    );
    const loop = new AgentLoop({
      userHomeDirectory: emptyHome,
      model,
      sessions: store,
      toolExecutor: {
        async execute(call): Promise<AgentLoopToolExecutionResult> {
          // The operator steers while this tool is running.
          await store.appendSteeringInjections([steering]);
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
    });

    const result = await loop.run({
      availableTools: [buildAttemptCompleteTool(), buildReadFileTool()],
      maxTurns: 4,
      session,
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).toBe("completed");
    expect(result.turns.map((turn) => turn.trigger)).toEqual(["user", "steering"]);
    expect(JSON.stringify(model.requests[1]?.messages)).toContain(steering.message);
    const snapshot = await store.getSessionSnapshot(session.id);
    expect(snapshot?.steeringInjections.at(-1)?.state).toBe("applied");
  });

  test("holds attempt_complete when steering arrived during the final model call", async () => {
    const root = await createTempRoot();
    const store = new FileSessionStore(path.join(root, ".aia"));
    const session = buildSession();
    await store.saveSession(session);
    const steering = buildSteering(session.id);
    const model = new ScriptedModel(async (index) => {
      if (index === 0) {
        // The operator steers while the model is producing its final answer.
        await store.appendSteeringInjections([steering]);
      }
      return buildModelResponse({
        sessionId: session.id,
        toolCalls: [{ arguments: {}, callId: `tool.complete.${index}`, toolName: "attempt_complete" }]
      });
    });
    const loop = new AgentLoop({ userHomeDirectory: emptyHome, model, sessions: store });

    const result = await loop.run({
      availableTools: [buildAttemptCompleteTool()],
      maxTurns: 4,
      session,
      userMessages: [buildUserMessage()]
    });

    expect(result.stopReason).toBe("completed");
    expect(result.turns).toHaveLength(2);
    expect(result.turns[0]?.summary).toBe("The runtime held `attempt_complete` because operator steering arrived.");
    expect(result.turns[1]?.trigger).toBe("steering");
    expect(JSON.stringify(model.requests[1]?.messages)).toContain(steering.message);
  });
});

class ScriptedModel implements AgentLoopModel {
  readonly requests: Parameters<AgentLoopModel["generate"]>[0][] = [];

  constructor(
    private readonly respond: (
      index: number,
      request: Parameters<AgentLoopModel["generate"]>[0],
      options: LanguageModelCallOptions | undefined
    ) => Promise<LanguageModelResponse>
  ) {}

  async generate(
    request: Parameters<AgentLoopModel["generate"]>[0],
    options?: LanguageModelCallOptions
  ): Promise<LanguageModelResponse> {
    this.requests.push(request);
    return this.respond(this.requests.length - 1, request, options);
  }
}

async function createLoop(
  responses: Array<Error | LanguageModelResponse>,
  overrides: {
    autoCompactThresholdTokens?: number;
    completionGate?: (params: {
      latestResponse: LanguageModelResponse;
      session: SessionRecord;
      snapshot: Awaited<ReturnType<FileSessionStore["getSessionSnapshot"]>>;
    }) => Promise<AgentLoopCompletionDecision>;
    memoryLifecycle?: {
      compactSession(params: {
        sessionId: string;
        trigger: "completion" | "overflow" | "threshold";
        sourceTokenCount?: number;
        threshold?: number;
      }): Promise<void>;
      initializeSessionMemory(session: SessionRecord): Promise<void>;
    };
    taskStateProvider?: { getTaskState(sessionId: string): Promise<TaskStateSnapshot | null> };
    toolCatalog?: {
      getDefinition(toolName: string): ToolDefinition | null;
    };
    toolExecutor?: AgentLoopToolExecutor;
  } = {}
) {
  const root = await createTempRoot();
  const store = new FileSessionStore(path.join(root, ".aia"));
  const session = buildSession();
  await store.saveSession(session);
  const model = new FakeModel(responses);

  return {
    loop: new AgentLoop({
      userHomeDirectory: emptyHome,
      autoCompactThresholdTokens: overrides.autoCompactThresholdTokens,
      completionGate: overrides.completionGate,
      memoryLifecycle: overrides.memoryLifecycle,
      model,
      sessions: store,
      taskStateProvider: overrides.taskStateProvider,
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
  readonly requests: Array<
    Omit<LanguageModelRequest, "modelId" | "provider"> & {
      modelId?: string;
      provider?: LanguageModelRequest["provider"];
    }
  > = [];
  private index = 0;

  // An Error entry is thrown for that call, as a provider failure would be.
  constructor(private readonly responses: Array<Error | LanguageModelResponse>) {}

  async generate(
    request: Omit<LanguageModelRequest, "modelId" | "provider"> & {
      modelId?: string;
      provider?: LanguageModelRequest["provider"];
    }
  ) {
    this.requests.push(request);
    const response = this.responses[this.index];
    if (!response) {
      throw new Error(`Unexpected model turn ${this.index + 1}.`);
    }
    this.index += 1;
    if (response instanceof Error) {
      throw response;
    }
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

// `messageText` is optional because a real provider omits the text part
// entirely when the model replies with nothing but a tool call — which is
// exactly what a prompt-compliant `attempt_complete` turn looks like.
function buildModelResponse(params: {
  messageText?: string;
  sessionId: string;
  toolCalls: LanguageModelResponse["toolCalls"];
}): LanguageModelResponse {
  return {
    id: `response.${cryptoId()}`,
    message: {
      createdAt: new Date().toISOString(),
      id: `message.assistant.${cryptoId()}`,
      metadata: {},
      parts: params.messageText === undefined ? [] : [{ kind: "text", text: params.messageText }],
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

function buildThinkTool(): ToolDefinition {
  return {
    aliases: ["reason"],
    annotations: {
      meta: { family: "reasoning" },
      readOnlyHint: true,
      title: "Think"
    },
    approvalMode: "never",
    descriptor: {
      approvalNotes: "Records a thought without acting.",
      examples: ["Plan before acting."],
      purpose: "Record reasoning without changing anything.",
      sideEffectSummary: "No side effects.",
      whenNotToUse: ["Do not use it to perform work."],
      whenToUse: ["Use to reason before acting."]
    },
    description: "Record a private reasoning note without taking any action.",
    displayName: "Think",
    execution: {
      inputMode: "json",
      resumable: false,
      taskSupport: "forbidden"
    },
    idempotent: true,
    inputSchema: {
      type: "object"
    },
    invocationName: "think",
    kind: "built_in",
    metadata: {},
    name: "think",
    outputKind: "json",
    retryable: true,
    searchTags: ["think"],
    sideEffects: ["none"],
    source: {
      displayName: "Built-in Tools",
      kind: "built_in"
    },
    streamingMode: "none",
    toolId: "tool.builtin.think",
    usageGuidance: "Use to reason without acting.",
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

function buildApprovalResolution(requestId: string, overrides: Partial<ApprovalResolution> = {}): ApprovalResolution {
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
