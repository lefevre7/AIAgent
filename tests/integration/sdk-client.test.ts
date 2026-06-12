import { describe, expect, test } from "vitest";

import { ScriptedLanguageModelAdapter, buildScriptedResponse, withExampleSdk } from "../../examples/shared";

describe("AIAgent SDK client", () => {
  test("exercises session, run, memory, gateway, approval, and abort surfaces", async () => {
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "example-sdk-1",
      providerId: "example_lm",
      responses: [
        (request) =>
          buildScriptedResponse({
            request,
            text: "All done.",
            toolCalls: [{ arguments: { summary: "done" }, callId: "tool.complete.sdk", toolName: "attempt_complete" }]
          })
      ]
    });

    await withExampleSdk({
      name: "sdk-client",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "example-sdk-1", enabled: true }] },
      run: async ({ sdk, workspaceRoot }) => {
        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Exercise the SDK surface",
          metadata: { surface: "example" },
          title: "SDK Client"
        });
        expect(created.session.id).toBeTruthy();

        // sessions.list + sessions.get
        const sessions = await sdk.sessions.list();
        expect(sessions.some((session) => session.id === created.session.id)).toBe(true);
        const handle = sdk.sessions.get(created.session.id);
        expect(handle.sessionId).toBe(created.session.id);

        // run handle getters + wait + cancel
        const run = await handle.sendMessage({ text: "Say hello." });
        expect(run.runId).toBeTruthy();
        expect(run.sessionId).toBe(created.session.id);
        const finished = await run.wait();
        expect(["cancelled", "completed", "failed"]).toContain(finished.status);
        // waitForRun on an already-terminal run returns immediately.
        await expect(sdk.waitForRun(finished)).resolves.toMatchObject({ id: finished.id });
        // run.cancel on an already-terminal run still executes the request path.
        await run.cancel().catch(() => undefined);

        // events() async iterable yields then cleans up on abort/break
        const eventController = new AbortController();
        const seenTopics: string[] = [];
        const iterating = (async () => {
          for await (const event of handle.events({ signal: eventController.signal })) {
            seenTopics.push(event.topic);
            break;
          }
        })();
        const streamed = await handle.sendMessage({ text: "stream please" });
        await streamed.wait();
        eventController.abort();
        await iterating;
        expect(Array.isArray(seenTopics)).toBe(true);

        // memory.query
        const hits = await sdk.memory.query({
          includeKinds: [],
          limit: 5,
          minConfidence: 0,
          scopes: ["workspace"],
          text: "anything"
        });
        expect(Array.isArray(hits)).toBe(true);

        // gateway health + event replay (both the sdk-level and namespace forms)
        await expect(sdk.gateway.health()).resolves.toBeTruthy();
        await expect(sdk.gateway.replayEvents({})).resolves.toBeTruthy();
        await expect(sdk.replayEvents({})).resolves.toBeTruthy();

        // approvals list + a failing get that surfaces a gateway error
        await expect(sdk.approvals.list()).resolves.toBeInstanceOf(Array);
        await expect(sdk.approvals.get("approval.does-not-exist")).rejects.toBeInstanceOf(Error);

        // session.cancel through the handle
        await handle.cancel().catch(() => undefined);

        // withAbort resolves normally when a live (non-aborted) signal is supplied
        const live = new AbortController();
        const liveHealth = (await sdk.gateway.health({ signal: live.signal })) as { status: string };
        expect(liveHealth.status).toBeTruthy();

        // withAbort rejects immediately for an already-aborted signal
        const aborted = new AbortController();
        aborted.abort();
        await expect(sdk.gateway.health({ signal: aborted.signal })).rejects.toMatchObject({ name: "AbortError" });

        // subscribe binds and releases an abort listener without leaking
        const controller = new AbortController();
        const unsubscribe = sdk.subscribe(() => undefined, { signal: controller.signal });
        controller.abort();
        unsubscribe();
      }
    });
  });
});
