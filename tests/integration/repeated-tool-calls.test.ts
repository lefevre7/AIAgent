import { describe, expect, test } from "vitest";

import {
  ScriptedLanguageModelAdapter,
  buildScriptedResponse,
  buildToolCall,
  withExampleSdk
} from "../../examples/shared";

// A small local model that cannot tell an empty result from a failed one will
// reissue the same read forever, and the no-progress nudge counter never fires
// because each call "succeeds". runtime.maxIdenticalToolCalls bounds that.

function scriptedAdapter(calls: Array<{ args: Record<string, unknown>; name: string }>): ScriptedLanguageModelAdapter {
  return new ScriptedLanguageModelAdapter({
    modelId: "repeat-model",
    providerId: "example_lm",
    responses: calls.map(
      (call) => (request: never) =>
        buildScriptedResponse({
          request,
          text: `Calling ${call.name}.`,
          toolCalls: [buildToolCall(call.name, call.args as never)]
        })
    ) as never
  });
}

describe("identical tool call guard", () => {
  test("refuses the same tool with the same arguments past the configured cap", async () => {
    const adapter = scriptedAdapter([
      { args: { path: "." }, name: "list_files" },
      { args: { path: "." }, name: "list_files" },
      { args: { path: "." }, name: "list_files" },
      { args: { path: "." }, name: "list_files" },
      { args: { summary: "Nothing left to read." }, name: "attempt_complete" }
    ]);

    await withExampleSdk({
      name: "repeated-tool-calls",
      providers: {
        languageModelAdapters: [{ adapter, defaultModel: "repeat-model", enabled: true }]
      },
      run: async ({ sdk, workspaceRoot }) => {
        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Repeat one read",
          metadata: { surface: "example" },
          title: "Repeats"
        });

        const run = await created.handle.sendMessage({ text: "look around" });
        await run.wait({ timeoutMs: 20_000 });

        const listCalls = (await created.handle.snapshot()).snapshot.toolCalls
          .filter((call) => call.toolName === "list_files")
          .map((call) => call.status);

        // Three executions allowed by the default cap, then a refusal.
        expect(listCalls).toEqual(["succeeded", "succeeded", "succeeded", "failed"]);

        const refused = (await created.handle.snapshot()).snapshot.toolCalls.at(3);
        expect(refused?.error?.code).toBe("repeated_tool_call");
        expect(refused?.error?.message).toContain("Do not repeat it");
      }
    });
  });

  test("different arguments to the same tool are not treated as repeats", async () => {
    const adapter = scriptedAdapter([
      { args: { path: "." }, name: "list_files" },
      { args: { path: ".", recursive: true }, name: "list_files" },
      { args: { recursive: true, path: "." }, name: "list_files" },
      { args: { path: "." }, name: "list_files" },
      { args: { summary: "Looked from a few angles." }, name: "attempt_complete" }
    ]);

    await withExampleSdk({
      name: "repeated-tool-calls-distinct",
      providers: {
        languageModelAdapters: [{ adapter, defaultModel: "repeat-model", enabled: true }]
      },
      run: async ({ sdk, workspaceRoot }) => {
        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Vary the arguments",
          metadata: { surface: "example" },
          title: "Distinct"
        });

        const run = await created.handle.sendMessage({ text: "look around" });
        await run.wait({ timeoutMs: 20_000 });

        const statuses = (await created.handle.snapshot()).snapshot.toolCalls
          .filter((call) => call.toolName === "list_files")
          .map((call) => call.status);

        // Two distinct argument sets, each well under the cap. Calls 2 and 3
        // are the same arguments in a different key order, which the identity
        // key normalizes — but that is still only two of the three allowed.
        expect(statuses).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
      }
    });
  });
});
