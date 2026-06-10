import { describe, expect, test } from "vitest";

import { createDefaultToolRuntime, sessionRecordSchema, toolCallRecordSchema, turnRecordSchema } from "@/core";

import {
  ScriptedLanguageModelAdapter,
  buildScriptedResponse,
  buildToolCall,
  withExampleSdk
} from "../../examples/shared";

describe("ask_user_question tool runtime", () => {
  test("requests a question-kind approval instead of executing immediately", async () => {
    const runtime = createDefaultToolRuntime();
    const outcome = await runtime.execute(
      buildCall({
        options: [{ label: "REST" }, { label: "GraphQL" }],
        question: "Which API style should I use?"
      }),
      { session: buildSession(), turn: buildTurn() }
    );

    expect(outcome.toolCall.status).toBe("awaiting_approval");
    expect(outcome.approvalRequest?.target.kind).toBe("question");
    expect(outcome.approvalRequest?.justification).toBe("Which API style should I use?");
    expect((outcome.approvalRequest?.metadata.options as unknown[]).length).toBe(2);
  });

  test("returns the operator answer once resumed after approval", async () => {
    const runtime = createDefaultToolRuntime();
    const resumed = await runtime.executeApproved(
      toolCallRecordSchema.parse({
        arguments: { options: [{ label: "REST" }, { label: "GraphQL" }], question: "Which API style should I use?" },
        id: "tool-call.ask.resumed.1",
        metadata: { approvalResolutionComment: "REST" },
        sessionId: "session.ask.1",
        startedAt: "2026-06-10T12:00:00.000Z",
        status: "pending",
        toolName: "ask_user_question",
        turnId: "turn.ask.1"
      }),
      { session: buildSession(), turn: buildTurn() }
    );

    expect(resumed.toolCall.status).toBe("succeeded");
    expect(resumed.toolCall.result).toMatchObject({
      answer: "REST",
      answered: true,
      question: "Which API style should I use?",
      selectedOption: "REST"
    });
  });
});

describe("ask_user_question end-to-end through the gateway runtime", () => {
  test("pauses for the question, resumes with the answer, and finishes", async () => {
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "example-ask-1",
      providerId: "example_lm",
      responses: [
        (request) =>
          buildScriptedResponse({
            request,
            text: "I need to know which API style you want before continuing.",
            toolCalls: [
              buildToolCall("ask_user_question", {
                options: [{ label: "REST" }, { label: "GraphQL" }],
                question: "Which API style should I use?"
              })
            ]
          }),
        (request) =>
          buildScriptedResponse({
            request,
            text: "Using REST as requested; the task is complete.",
            toolCalls: [buildToolCall("attempt_complete", { summary: "Implemented the REST design per the operator's answer." })]
          })
      ]
    });

    await withExampleSdk({
      name: "ask-user-question",
      providers: {
        languageModelAdapters: [{ adapter, defaultModel: "example-ask-1", enabled: true }]
      },
      run: async ({ sdk, workspaceRoot }) => {
        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Ask the operator which API style to use.",
          initialMessage: { text: "Build the API; ask me if anything is ambiguous." },
          metadata: { surface: "example" },
          title: "Ask Example"
        });

        await created.run?.wait();
        const paused = await created.handle.snapshot();
        expect(paused.snapshot.session.status).toBe("awaiting_approval");

        const approvals = await created.handle.listPendingApprovals();
        expect(approvals).toHaveLength(1);
        expect(approvals[0]?.request.target.kind).toBe("question");
        expect(approvals[0]?.request.justification).toBe("Which API style should I use?");

        await created.handle.resolveApproval({
          decision: "approved",
          requestId: approvals[0]!.request.id,
          comment: "REST"
        });

        const resumeRun = await created.handle.resume();
        await resumeRun.wait();

        const finished = await created.handle.snapshot();
        expect(finished.snapshot.session.status).toBe("completed");

        const answered = finished.snapshot.toolCalls.find(
          (toolCall) => toolCall.toolName === "ask_user_question" && toolCall.status === "succeeded"
        );
        expect(answered?.result).toMatchObject({ answer: "REST", answered: true, selectedOption: "REST" });
      }
    });
  });
});

describe("model.health gateway topic", () => {
  test("reports the configured chat model provider health", async () => {
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "example-health-1",
      providerId: "example_lm",
      responses: []
    });

    await withExampleSdk({
      name: "model-health",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "example-health-1", enabled: true }] },
      run: async ({ sdk }) => {
        const health = await sdk.request("model.health", {});
        expect(health.status).toBe("healthy");
        expect(health.providerId).toBe("example_lm");
      }
    });
  });
});

function buildCall(args: Record<string, unknown>): ReturnType<typeof toolCallRecordSchema.parse> {
  return toolCallRecordSchema.parse({
    arguments: args,
    id: `tool-call.ask.${Math.random().toString(36).slice(2, 10)}`,
    metadata: {},
    sessionId: "session.ask.1",
    startedAt: "2026-06-10T12:00:00.000Z",
    status: "pending",
    toolName: "ask_user_question",
    turnId: "turn.ask.1"
  });
}

function buildSession() {
  return sessionRecordSchema.parse({
    createdAt: "2026-06-10T12:00:00.000Z",
    cwd: "/workspace",
    goal: "Exercise ask_user_question",
    id: "session.ask.1",
    lastActiveAt: "2026-06-10T12:00:00.000Z",
    metadata: {},
    status: "running_model",
    tags: [],
    title: "Ask User Question",
    updatedAt: "2026-06-10T12:00:00.000Z"
  });
}

function buildTurn() {
  return turnRecordSchema.parse({
    approvalRequestIds: [],
    executedToolCallIds: [],
    id: "turn.ask.1",
    inputMessageIds: [],
    metadata: {},
    outputMessageIds: [],
    requestedToolCallIds: [],
    sequence: 0,
    sessionId: "session.ask.1",
    startedAt: "2026-06-10T12:00:00.000Z",
    status: "running",
    trigger: "user"
  });
}
