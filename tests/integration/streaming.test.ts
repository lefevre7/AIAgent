import { describe, expect, test } from "vitest";

import type { GatewayEvent } from "@/core/contracts";

import { ScriptedLanguageModelAdapter, buildScriptedResponse, withExampleSdk } from "../../examples/shared";

describe("assistant token streaming", () => {
  test("delivers message.delta events to a session-filtered subscription (the CLI path)", async () => {
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "example-stream-1",
      providerId: "example_lm",
      responses: [
        (request) =>
          buildScriptedResponse({
            request,
            text: "Streaming hello from the agent loop.",
            toolCalls: [{ arguments: { summary: "done" }, callId: "tool.complete.stream", toolName: "attempt_complete" }]
          })
      ]
    });

    await withExampleSdk({
      name: "streaming",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "example-stream-1", enabled: true }] },
      run: async ({ sdk, workspaceRoot }) => {
        // Create the session first, then subscribe through the SESSION HANDLE
        // (which filters by sessionId) exactly like the CLI does. A regression
        // in deriveGatewayEventSessionId would drop these deltas.
        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Stream a response",
          metadata: { surface: "example" },
          title: "Streaming"
        });

        const deltas: string[] = [];
        const unsubscribe = created.handle.subscribe(
          (event: GatewayEvent) => {
            if (event.topic === "message.delta") {
              deltas.push(event.payload.delta);
            }
          },
          { topics: ["message.delta"] }
        );

        try {
          const run = await created.handle.sendMessage({ text: "Say hello." });
          await run.wait();
        } finally {
          unsubscribe();
        }

        expect(deltas.length).toBeGreaterThan(1);
        expect(deltas.join("")).toBe("Streaming hello from the agent loop.");
      }
    });
  });

  test("streams model reasoning as message.reasoning events, separate from the answer", async () => {
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "example-reasoning-1",
      providerId: "example_lm",
      responses: [
        (request) =>
          buildScriptedResponse({
            reasoning: "I should create the folder, then the file.",
            request,
            text: "Created the folder and index page.",
            toolCalls: [{ arguments: { summary: "done" }, callId: "tool.complete.r", toolName: "attempt_complete" }]
          })
      ]
    });

    await withExampleSdk({
      name: "reasoning",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "example-reasoning-1", enabled: true }] },
      run: async ({ sdk, workspaceRoot }) => {
        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Reasoning",
          metadata: { surface: "example" },
          title: "Reasoning"
        });

        const reasoning: string[] = [];
        const reasoningFinals: string[] = [];
        const answer: string[] = [];
        const unsubscribe = created.handle.subscribe(
          (event: GatewayEvent) => {
            if (event.topic === "message.reasoning") {
              if (event.payload.final === true) {
                reasoningFinals.push(event.payload.delta);
              } else {
                reasoning.push(event.payload.delta);
              }
            } else if (event.topic === "message.delta") {
              answer.push(event.payload.delta);
            }
          },
          { topics: ["message.reasoning", "message.delta"] }
        );

        try {
          const run = await created.handle.sendMessage({ text: "Make the site." });
          await run.wait();
        } finally {
          unsubscribe();
        }

        expect(reasoning.join("")).toBe("I should create the folder, then the file.");
        expect(answer.join("")).toBe("Created the folder and index page.");

        // Provider-native reasoning is archived as exactly one persisted event
        // per turn. It never enters the transcript, so the events log is the
        // only place an operator can read it back later.
        expect(reasoningFinals).toEqual(["I should create the folder, then the file."]);
      }
    });
  });

  test("archives a turn's reasoning even when the run fails afterwards", async () => {
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "example-reasoning-2",
      providerId: "example_lm",
      responses: [
        (request) =>
          buildScriptedResponse({
            reasoning: "First I will look around.",
            request,
            text: "Looking around.",
            toolCalls: [{ arguments: { path: "." }, callId: "tool.list.r2", toolName: "list_files" }]
          }),
        () => {
          throw new Error("the provider fell over mid-run");
        }
      ]
    });

    await withExampleSdk({
      name: "reasoning-failure",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "example-reasoning-2", enabled: true }] },
      run: async ({ sdk, workspaceRoot }) => {
        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Reasoning failure",
          metadata: { surface: "example" },
          title: "Reasoning failure"
        });

        const reasoningFinals: string[] = [];
        const unsubscribe = created.handle.subscribe(
          (event: GatewayEvent) => {
            if (event.topic === "message.reasoning" && event.payload.final === true) {
              reasoningFinals.push(event.payload.delta);
            }
          },
          { topics: ["message.reasoning"] }
        );

        try {
          const run = await created.handle.sendMessage({ text: "Make the site." });
          const terminal = await run.wait({ timeoutMs: 20_000 });
          expect(terminal.status).toBe("failed");
        } finally {
          unsubscribe();
        }

        // A provider error is handled inside the loop, so this run still ends
        // through the normal return path and the per-turn flush. That is worth
        // pinning: reasoning must survive a failed run, which is exactly when
        // an operator wants to read it back.
        //
        // Note this does NOT cover the case `guardRun`'s catch-all flush was
        // added for — a throw that escapes the loop entirely (event emission
        // or session persistence failing), which skips emitSessionRunEvents
        // and leaves the buffer populated. That path has no harness to inject
        // a post-run failure from out here.
        expect(reasoningFinals).toEqual(["First I will look around."]);
      }
    });
  });

  test("a session-filtered subscription ignores deltas from other sessions", async () => {
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "example-stream-2",
      providerId: "example_lm",
      responses: [
        (request) =>
          buildScriptedResponse({
            request,
            text: "Hello there.",
            toolCalls: [{ arguments: { summary: "done" }, callId: "tool.complete.2", toolName: "attempt_complete" }]
          })
      ]
    });

    await withExampleSdk({
      name: "streaming-filter",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "example-stream-2", enabled: true }] },
      run: async ({ sdk, workspaceRoot }) => {
        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Stream",
          metadata: { surface: "example" },
          title: "Streaming"
        });

        const received: string[] = [];
        const unsubscribe = sdk.subscribe(
          (event: GatewayEvent) => {
            if (event.topic === "message.delta") {
              received.push(event.payload.delta);
            }
          },
          { sessionId: "session.does-not-exist", topics: ["message.delta"] }
        );

        try {
          const run = await created.handle.sendMessage({ text: "Hi." });
          await run.wait();
        } finally {
          unsubscribe();
        }

        expect(received).toEqual([]);
      }
    });
  });
});
