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
        const answer: string[] = [];
        const unsubscribe = created.handle.subscribe(
          (event: GatewayEvent) => {
            if (event.topic === "message.reasoning") {
              reasoning.push(event.payload.delta);
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
