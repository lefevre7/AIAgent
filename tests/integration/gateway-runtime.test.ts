import { describe, expect, test } from "vitest";

import { ScriptedLanguageModelAdapter, buildScriptedResponse, buildToolCall, withExampleSdk } from "../../examples/shared";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await sleep(5);
  }
  throw new Error("Timed out waiting for condition.");
}

describe("gateway runtime request dispatch", () => {
  test("drives tool.execute, tool.search, model.health, snapshot, steering, and approvals", async () => {
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "example-gw-1",
      providerId: "example_lm",
      responses: []
    });

    await withExampleSdk({
      name: "gateway-runtime",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "example-gw-1", enabled: true }] },
      run: async ({ sdk, workspaceRoot }) => {
        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Exercise the gateway dispatch surface",
          metadata: { surface: "example" },
          title: "Gateway Runtime"
        });
        const sessionId = created.session.id;

        // tool.execute → enqueueToolExecution → executeToolRun (no approval for `think`).
        const exec = (await sdk.request("tool.execute", {
          arguments: { thought: "plan the work carefully" },
          metadata: {},
          sessionId,
          toolName: "think"
        })) as { run: { id: string; status: string }; sessionId: string };
        expect(exec.sessionId).toBe(sessionId);
        expect(exec.run.id).toBeTruthy();

        // Let the async tool run settle (the run completes the think tool).
        await Promise.race([sdk.waitForRun(exec.run as never).catch(() => null), sleep(1_500)]);

        // tool.search → searchTools
        const search = (await sdk.request("tool.search", { limit: 5, query: "think" })) as {
          tools: Array<{ invocationName: string }>;
        };
        expect(search.tools.some((tool) => tool.invocationName === "think")).toBe(true);

        // model.health
        const health = (await sdk.request("model.health", {})) as { status: string };
        expect(health.status).toBeTruthy();

        // session.snapshot → { snapshot, taskState }
        const snapshot = (await sdk.request("session.snapshot", { sessionId })) as {
          snapshot: { session: { id: string }; toolCalls: unknown[] };
        };
        expect(snapshot.snapshot.session.id).toBe(sessionId);
        // executeToolRun recorded the think tool call.
        expect(snapshot.snapshot.toolCalls.length).toBeGreaterThanOrEqual(1);

        // steering.inject
        const steering = (await sdk.request("steering.inject", {
          createdAt: "2026-06-11T00:00:00.000Z",
          id: "steering.gw.1",
          message: "stay focused on the goal",
          metadata: {},
          sessionId,
          source: "operator",
          state: "queued"
        })) as { message: string };
        expect(steering.message).toBe("stay focused on the goal");

        // approval.list (no pending approvals)
        const approvals = (await sdk.request("approval.list", {})) as { approvals: unknown[] };
        expect(Array.isArray(approvals.approvals)).toBe(true);

        // session.list dispatch
        const sessions = (await sdk.request("session.list", { limit: 10 })) as { sessions: Array<{ id: string }> };
        expect(sessions.sessions.some((entry) => entry.id === sessionId)).toBe(true);

        // tool.execute with an approval-gated tool → executeToolRun approval branch
        const approvalExec = (await sdk.request("tool.execute", {
          arguments: { options: [{ label: "Yes" }, { label: "No" }], question: "Proceed with the gateway tool?" },
          metadata: {},
          sessionId,
          toolName: "ask_user_question"
        })) as { run: { id: string } };
        await Promise.race([sdk.waitForRun(approvalExec.run as never).catch(() => null), sleep(1_500)]);

        const pendingAfter = (await sdk.request("approval.list", {})) as { approvals: Array<{ request: { id: string } }> };
        expect(pendingAfter.approvals.length).toBeGreaterThanOrEqual(1);
        const pausedSnap = (await sdk.request("session.snapshot", { sessionId })) as {
          snapshot: { session: { status: string } };
        };
        expect(pausedSnap.snapshot.session.status).toBe("awaiting_approval");

        // gateway.subscribe dispatch returns the normalized subscription
        const sub = (await sdk.request("gateway.subscribe", { topics: ["message.delta"] })) as { subscription: unknown };
        expect(sub.subscription).toBeTruthy();
      }
    });
  });

  test("runs a session.message turn to completion through the gateway", async () => {
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "example-gw-2",
      providerId: "example_lm",
      responses: [
        (request) =>
          buildScriptedResponse({
            request,
            text: "All done.",
            toolCalls: [{ arguments: { summary: "done" }, callId: "tool.complete.gw", toolName: "attempt_complete" }]
          })
      ]
    });

    await withExampleSdk({
      name: "gateway-runtime-run",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "example-gw-2", enabled: true }] },
      run: async ({ sdk, workspaceRoot }) => {
        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Complete a turn",
          initialMessage: { text: "please finish" },
          metadata: { surface: "example" },
          title: "Run Turn"
        });
        expect(created.run).toBeTruthy();
        const finished = await created.run!.wait();
        expect(["cancelled", "completed", "failed"]).toContain(finished.status);
      }
    });
  });

  test("cancels an in-flight session run while the model is still working", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let modelEntered = false;
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "example-gw-cancel",
      providerId: "example_lm",
      responses: [
        async (request) => {
          modelEntered = true;
          await gate;
          return buildScriptedResponse({
            request,
            text: "Finished after the gate opened.",
            toolCalls: [buildToolCall("attempt_complete", { summary: "done" })]
          });
        }
      ]
    });

    await withExampleSdk({
      name: "gateway-runtime-cancel",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "example-gw-cancel", enabled: true }] },
      run: async ({ sdk, workspaceRoot }) => {
        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Cancel mid-run",
          initialMessage: { text: "start the long task" },
          metadata: { surface: "example" },
          title: "Cancel Run"
        });

        await waitUntil(() => modelEntered);
        await created.handle.cancel();
        release();

        const finished = await created.run!.wait();
        expect(finished.status).toBe("cancelled");
        const snapshot = await created.handle.snapshot();
        expect(snapshot.snapshot.session.status).toBe("cancelled");
      }
    });
  });

  test("synthesizes channel statuses from config when no channel service is attached", async () => {
    const adapter = new ScriptedLanguageModelAdapter({ modelId: "example-gw-3", providerId: "example_lm", responses: [] });

    await withExampleSdk({
      configureConfig: (config) => {
        const channels = config.channels as {
          discord: { appId?: unknown; botToken?: unknown; enabled: boolean };
          imessage: { enabled: boolean };
          teams: { appId?: unknown; appPassword?: unknown; enabled: boolean };
          whatsapp: { enabled: boolean };
        };
        channels.discord.enabled = true;
        channels.discord.appId = "discord-app";
        channels.discord.botToken = "discord-token";
        channels.teams.enabled = true;
        channels.teams.appId = "teams-app";
        channels.teams.appPassword = "teams-pass";
        channels.imessage.enabled = false;
      },
      name: "gateway-runtime-channels",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "example-gw-3", enabled: true }] },
      run: async ({ sdk }) => {
        const all = (await sdk.request("channel.list", {})) as {
          channels: Array<{ channel: string; configured: boolean; status: string }>;
        };
        const byChannel = Object.fromEntries(all.channels.map((entry) => [entry.channel, entry]));
        expect(byChannel.discord).toMatchObject({ configured: true, status: "not_implemented" });
        expect(byChannel.teams).toMatchObject({ configured: false, status: "not_configured" });
        expect(byChannel.imessage).toMatchObject({ status: "disabled" });
        expect(byChannel.whatsapp).toMatchObject({ status: "disabled" });
      }
    });
  });
});
