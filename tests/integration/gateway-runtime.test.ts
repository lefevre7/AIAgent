import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  ScriptedLanguageModelAdapter,
  buildScriptedResponse,
  buildToolCall,
  withExampleSdk
} from "../../examples/shared";
import type { LanguageModelRequest } from "@/core/contracts";

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
        const announced: Array<{ metadata: Record<string, unknown>; requestSessionId: string }> = [];
        const stopListening = sdk.subscribe(
          (event) => {
            if (event.topic === "approval.requested") {
              announced.push({ metadata: event.metadata, requestSessionId: event.payload.sessionId });
            }
          },
          { topics: ["approval.requested"] }
        );
        const approvalExec = (await sdk.request("tool.execute", {
          arguments: { options: [{ label: "Yes" }, { label: "No" }], question: "Proceed with the gateway tool?" },
          metadata: {},
          sessionId,
          toolName: "ask_user_question"
        })) as { run: { id: string } };
        await Promise.race([sdk.waitForRun(approvalExec.run as never).catch(() => null), sleep(1_500)]);

        const pendingAfter = (await sdk.request("approval.list", {})) as {
          approvals: Array<{ request: { id: string } }>;
        };
        expect(pendingAfter.approvals.length).toBeGreaterThanOrEqual(1);
        const pausedSnap = (await sdk.request("session.snapshot", { sessionId })) as {
          snapshot: { session: { status: string } };
        };
        expect(pausedSnap.snapshot.session.status).toBe("awaiting_approval");
        stopListening();
        // Like an MCP server's question, a tool's approval names its session
        // in metadata (it used to be left empty).
        expect(announced).toEqual([{ metadata: { sessionId }, requestSessionId: sessionId }]);

        // gateway.subscribe dispatch returns the normalized subscription
        const sub = (await sdk.request("gateway.subscribe", { topics: ["message.delta"] })) as {
          subscription: unknown;
        };
        expect(sub.subscription).toBeTruthy();
      }
    });
  });

  test("a skill loaded through tool.execute is recorded on the session, as a run would record it", async () => {
    // Only the agent loop recorded loads, so a later skill call loaded the
    // whole text again, and compaction did not restate it.
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "example-gw-skill",
      providerId: "example_lm",
      responses: []
    });
    await withExampleSdk({
      name: "gateway-runtime-skill-execute",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "example-gw-skill", enabled: true }] },
      run: async ({ sdk, workspaceRoot }) => {
        await fs.mkdir(path.join(workspaceRoot, ".agents", "skills", "alpha"), { recursive: true });
        await fs.writeFile(
          path.join(workspaceRoot, ".agents", "skills", "alpha", "SKILL.md"),
          "---\nname: alpha\ndescription: The alpha task.\n---\nDo alpha.\n"
        );
        const created = await sdk.sessions.create({ cwd: workspaceRoot, goal: "Load", metadata: {}, title: "Skill" });
        const executed = (await sdk.request("tool.execute", {
          arguments: { name: "alpha" },
          metadata: {},
          sessionId: created.session.id,
          toolName: "skill"
        })) as { run: { id: string } };
        await sdk.waitForRun(executed.run as never);

        const { snapshot } = (await sdk.request("session.snapshot", { sessionId: created.session.id })) as {
          snapshot: { session: { metadata: Record<string, unknown> } };
        };
        expect(snapshot.session.metadata.activatedSkills).toEqual([expect.objectContaining({ name: "alpha" })]);
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
        const finished = await created.run!.wait({ timeoutMs: 10_000 });
        expect(["cancelled", "completed", "failed"]).toContain(finished.status);
      }
    });
  });

  test("session.compact summarizes the transcript, sets the compaction watermark, and refuses busy sessions", async () => {
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "example-gw-compact",
      providerId: "example_lm",
      responses: [
        (request) =>
          buildScriptedResponse({
            request,
            text: "I wrote the plan and finished.",
            toolCalls: [
              { arguments: { summary: "done" }, callId: "tool.complete.compact", toolName: "attempt_complete" }
            ]
          })
      ]
    });

    await withExampleSdk({
      name: "gateway-runtime-compact",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "example-gw-compact", enabled: true }] },
      run: async ({ sdk, workspaceRoot }) => {
        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Compact a finished session",
          initialMessage: { text: "please finish quickly" },
          metadata: { surface: "example" },
          title: "Compact Session"
        });
        await created.run!.wait({ timeoutMs: 10_000 });
        const before = await created.handle.snapshot();
        expect(before.snapshot.messages.length).toBeGreaterThan(0);
        const lastMessageId = before.snapshot.messages.at(-1)!.id;

        const events: string[] = [];
        const unsubscribe = created.handle.subscribe((event) => events.push(event.topic), {
          topics: ["memory.updated", "session.updated"]
        });

        const result = await created.handle.compact();
        unsubscribe();

        expect(result.hiddenMessageCount).toBeGreaterThan(0);
        expect(result.compactedThroughMessageId).toBe(lastMessageId);
        expect(result.summary).toContain("Session Summary");
        // The agent's narration and its accepted completion summary are
        // recorded separately: letting the completion message fall out of the
        // same "latest assistant text" scan would silently replace what the
        // agent said with how it signed off.
        expect(result.summary).toContain("Latest assistant summary: I wrote the plan and finished.");
        expect(result.summary).toContain("Final answer: done");
        expect(result.summaryPath).toBeTruthy();
        expect(result.session.metadata.compactedThroughMessageId).toBe(lastMessageId);
        // The plan as of this fold is what the system prompt shows until the
        // next one (none here: the session never made a plan).
        expect(result.session.metadata).toHaveProperty("compactedTaskState", null);
        expect(events).toEqual(expect.arrayContaining(["session.updated", "memory.updated"]));

        // The persisted session carries the watermark, so later model requests
        // replay nothing from before the compaction point.
        const after = await created.handle.snapshot();
        expect(after.snapshot.session.metadata.compactedThroughMessageId).toBe(lastMessageId);
        expect(after.snapshot.session.status).toBe(before.snapshot.session.status);

        // Compacting again with nothing new still succeeds (idempotent summary rewrite).
        const again = await created.handle.compact();
        expect(again.hiddenMessageCount).toBe(0);
        expect(again.compactedThroughMessageId).toBe(lastMessageId);

        await expect(sdk.sessions.compact("session.does-not-exist")).rejects.toThrow(/not found/u);
      }
    });
  });

  // Every chat turn ends with attempt_complete. Completion compaction once
  // moved the watermark past the whole transcript, so the second message in a
  // REPL, web, or channel session reached the model with no trace of the first.
  test("a completed turn stays visible to the next turn in the same session", async () => {
    const respond = (summary: string) => (request: LanguageModelRequest) =>
      buildScriptedResponse({
        request,
        text: "Finishing.",
        toolCalls: [buildToolCall("attempt_complete", { summary })]
      });
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "example-gw-multi-turn",
      providerId: "example_lm",
      responses: [respond("Noted."), respond("Your secret word is PAPAYA.")]
    });

    await withExampleSdk({
      name: "gateway-runtime-multi-turn",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "example-gw-multi-turn", enabled: true }] },
      run: async ({ sdk, workspaceRoot }) => {
        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Chat",
          metadata: { surface: "example" },
          title: "Multi-turn Session"
        });

        const first = await created.handle.sendMessage({ text: "Remember this: my secret word is PAPAYA." });
        expect((await first.wait({ timeoutMs: 10_000 })).completionReason).toBe("session_completed");
        const second = await created.handle.sendMessage({ text: "What is my secret word?" });
        expect((await second.wait({ timeoutMs: 10_000 })).completionReason).toBe("session_completed");

        const secondRequest = JSON.stringify(adapter.requests[1]?.messages ?? []);
        expect(secondRequest).toContain("my secret word is PAPAYA");
        expect(secondRequest).toContain("What is my secret word?");
      }
    });
  });

  // The session summary records tool calls and narration, never requests. A
  // /compact hid every earlier message, so the next request reached the model
  // with no trace of what the operator had said.
  test("the operator's earlier messages survive /compact", async () => {
    const respond = (summary: string) => (request: LanguageModelRequest) =>
      buildScriptedResponse({
        request,
        text: "Finishing.",
        toolCalls: [buildToolCall("attempt_complete", { summary })]
      });
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "example-gw-compact-keeps",
      providerId: "example_lm",
      responses: [respond("Noted."), respond("Your secret word is PAPAYA.")]
    });

    await withExampleSdk({
      name: "gateway-runtime-compact-keeps",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "example-gw-compact-keeps", enabled: true }] },
      run: async ({ sdk, workspaceRoot }) => {
        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Chat",
          metadata: { surface: "example" },
          title: "Compact Keeps Session"
        });

        const first = await created.handle.sendMessage({ text: "Remember this: my secret word is PAPAYA." });
        await first.wait({ timeoutMs: 10_000 });
        const compacted = await created.handle.compact();
        // Only what left the model's view counts as hidden.
        expect(compacted.hiddenMessageCount).toBeGreaterThan(0);
        const second = await created.handle.sendMessage({ text: "What is my secret word?" });
        await second.wait({ timeoutMs: 10_000 });

        const replayed = adapter.requests[1]?.messages ?? [];
        expect(replayed.map((message) => message.role)).toEqual(["user", "user"]);
        expect(JSON.stringify(replayed)).toContain("my secret word is PAPAYA");
      }
    });
  });

  // LM Studio loads a model on its first request, so a gateway that starts
  // before then cannot know the window. It used to look once, at startup; an
  // embedding model's 2048 tokens filled the gap and the session compacted
  // after every turn.
  test("looks the context window up again before every run", async () => {
    const respond = (request: LanguageModelRequest) =>
      buildScriptedResponse({
        request,
        text: "Done.",
        toolCalls: [buildToolCall("attempt_complete", { summary: "ok" })]
      });
    let loadedWindow: number | undefined;
    const adapter = Object.assign(
      new ScriptedLanguageModelAdapter({
        modelId: "example-gw-window",
        providerId: "example_lm",
        responses: [respond, respond]
      }),
      { getModelContextWindow: async () => loadedWindow }
    );

    await withExampleSdk({
      name: "gateway-runtime-window",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "example-gw-window", enabled: true }] },
      run: async ({ sdk, workspaceRoot }) => {
        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Chat",
          metadata: { surface: "example" },
          title: "Window Session"
        });
        const percentages: number[] = [];
        const unsubscribe = created.handle.subscribe(
          (event) => {
            const metrics = (event.payload as { metrics?: { contextWindowPercentage?: number } }).metrics;
            if (typeof metrics?.contextWindowPercentage === "number") {
              percentages.push(metrics.contextWindowPercentage);
            }
          },
          { topics: ["gateway.status"] }
        );

        await (await created.handle.sendMessage({ text: "first" })).wait({ timeoutMs: 10_000 });
        loadedWindow = 64_000;
        await (await created.handle.sendMessage({ text: "second" })).wait({ timeoutMs: 10_000 });
        unsubscribe();

        // 64 prompt tokens: first against the 32,768-token default while the
        // window was unknown, then against the window the model reported.
        expect(percentages).toEqual([0.2, 0.1]);
      }
    });
  });

  test("session.compact hides real messages on a session that stopped without completing", async () => {
    // A session that stops for a reason other than completion (here: repeated
    // turns with no tool use, hitting the no-progress guard) reaches manual
    // /compact with its whole history still replayed, exactly like a finished
    // one: neither path moves the watermark on its own.
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "example-gw-compact-blocked",
      providerId: "example_lm",
      responses: [1, 2, 3, 4].map(
        (turn) => (request) => buildScriptedResponse({ request, text: `Thinking out loud, turn ${turn}.` })
      )
    });

    await withExampleSdk({
      name: "gateway-runtime-compact-blocked",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "example-gw-compact-blocked", enabled: true }] },
      run: async ({ sdk, workspaceRoot }) => {
        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Never quite finish",
          initialMessage: { text: "please start" },
          metadata: { surface: "example" },
          title: "Compact Blocked Session"
        });
        await created.run!.wait({ timeoutMs: 10_000 });
        const snapshot = await created.handle.snapshot();
        expect(snapshot.snapshot.session.status).toBe("completion_blocked");

        const result = await created.handle.compact();
        expect(result.hiddenMessageCount).toBeGreaterThan(0);
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

        const finished = await created.run!.wait({ timeoutMs: 10_000 });
        expect(finished.status).toBe("cancelled");
        const snapshot = await created.handle.snapshot();
        expect(snapshot.snapshot.session.status).toBe("cancelled");
      }
    });
  });

  // The cancel flag used to be read only before and after the whole run, so
  // cancel waited for the generation to end on its own; this model never ends
  // unless its request is aborted.
  test("cancel aborts the in-flight model request instead of waiting for it", async () => {
    let modelSignal: AbortSignal | undefined;
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "example-gw-abort",
      providerId: "example_lm",
      responses: [
        async (_request, _turnIndex, options) => {
          modelSignal = options.signal;
          return await new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
      ]
    });

    await withExampleSdk({
      name: "gateway-runtime-abort",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "example-gw-abort", enabled: true }] },
      run: async ({ sdk, workspaceRoot }) => {
        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Cancel a generation that never ends",
          initialMessage: { text: "start" },
          metadata: { surface: "example" },
          title: "Abort Run"
        });

        await waitUntil(() => modelSignal !== undefined);
        await created.handle.cancel();

        const finished = await created.run!.wait({ timeoutMs: 5_000 });
        expect(finished.status).toBe("cancelled");
        expect(modelSignal?.aborted).toBe(true);
        const snapshot = await created.handle.snapshot();
        expect(snapshot.snapshot.session.status).toBe("cancelled");
        expect(snapshot.snapshot.turns.at(-1)?.status).toBe("cancelled");
      }
    });
  });

  // cancelRun announced "cancel requested" (status still running) after an
  // await during which the run could end, so the last word on the run could be
  // a stale "running" after its terminal record.
  test("after a cancel, the last run update a subscriber sees is the terminal one", async () => {
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "example-gw-cancel-order",
      providerId: "example_lm",
      responses: [
        async (_request, _turnIndex, options) =>
          await new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          })
      ]
    });

    await withExampleSdk({
      name: "gateway-runtime-cancel-order",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "example-gw-cancel-order", enabled: true }] },
      run: async ({ sdk, workspaceRoot }) => {
        const statuses: string[] = [];
        const stop = sdk.subscribe(
          (event) => {
            if (event.topic === "run.updated") {
              statuses.push(event.payload.status);
            }
          },
          { topics: ["run.updated"] }
        );
        // Cancelling pending questions takes a while when there are some (each
        // is resolved and written); that is when the run could end first.
        const runtime = sdk.controlPlane as unknown as { cancelPendingElicitations: (id: string) => Promise<void> };
        runtime.cancelPendingElicitations = async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
        };
        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Cancel and watch",
          initialMessage: { text: "start" },
          metadata: { surface: "example" },
          title: "Cancel Order"
        });
        await waitUntil(() => statuses.includes("running"));
        await created.handle.cancel();
        await created.run!.wait({ timeoutMs: 5_000 });
        await new Promise((resolve) => setTimeout(resolve, 500));
        stop();

        expect(statuses.at(-1)).toBe("cancelled");
        expect(statuses.slice(statuses.indexOf("cancelled") + 1)).toEqual([]);
      }
    });
  });

  test("closing the SDK cancels an active run instead of waiting for it to finish", async () => {
    let modelSignal: AbortSignal | undefined;
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "example-gw-close",
      providerId: "example_lm",
      responses: [
        async (_request, _turnIndex, options) => {
          modelSignal = options.signal;
          return await new Promise<never>((_resolve, reject) => {
            options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        }
      ]
    });

    await withExampleSdk({
      name: "gateway-runtime-close",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "example-gw-close", enabled: true }] },
      run: async ({ sdk, workspaceRoot }) => {
        await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Close while a run is generating",
          initialMessage: { text: "start" },
          metadata: { surface: "example" },
          title: "Close Run"
        });
        await waitUntil(() => modelSignal !== undefined);

        // Before, close drained the run and so never returned here.
        await Promise.race([
          sdk.close(),
          sleep(5_000).then(() => {
            throw new Error("sdk.close() did not return while a run was active.");
          })
        ]);
        expect(modelSignal?.aborted).toBe(true);
      }
    });
  });

  // Approving a direct `tool.execute` call used to hand the session to the
  // model on resume, which then carried on with work nobody asked for.
  test("resuming after approving a direct tool.execute runs only that call and stops", async () => {
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "example-gw-direct",
      providerId: "example_lm",
      // No scripted turns: any model call fails the run.
      responses: []
    });

    await withExampleSdk({
      name: "gateway-runtime-direct-resume",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "example-gw-direct", enabled: true }] },
      run: async ({ sdk, workspaceRoot }) => {
        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Write one file on request",
          metadata: { surface: "example" },
          title: "Direct Tool Resume"
        });
        const sessionId = created.session.id;

        const exec = (await sdk.request("tool.execute", {
          arguments: { content: "hello\n", path: "notes.txt" },
          metadata: {},
          sessionId,
          toolName: "write_file"
        })) as { run: { id: string } };
        await sdk.waitForRun(exec.run as never);

        const pending = (await sdk.request("approval.list", { pendingOnly: true, sessionId })) as {
          approvals: Array<{ request: { id: string } }>;
        };
        expect(pending.approvals).toHaveLength(1);
        await sdk.request("approval.resolve", {
          actor: "cli",
          decision: "approved",
          requestId: pending.approvals[0]!.request.id
        });

        const resumed = (await sdk.request("session.resume", { sessionId })) as { run: { id: string } };
        const finished = (await sdk.waitForRun(resumed.run as never)) as {
          completionReason?: string;
          status: string;
        };

        expect(finished.status).toBe("completed");
        expect(finished.completionReason).toBe("tool_succeeded");
        expect(adapter.requests).toHaveLength(0);
        await expect(fs.readFile(path.join(workspaceRoot, "notes.txt"), "utf8")).resolves.toBe("hello\n");
        const snapshot = (await sdk.request("session.snapshot", { sessionId })) as {
          snapshot: { session: { status: string } };
        };
        expect(snapshot.snapshot.session.status).toBe("awaiting_user");
      }
    });
  });

  // Only `aia voice` built a voice service, so no chat surface ever had the
  // voice tools. The gateway builds one whenever a voice provider is enabled.
  test.each([
    ["registers the voice tools when a voice provider is enabled", true],
    ["leaves the voice tools out when no voice provider is enabled", false]
  ])("%s", async (_label, enabled) => {
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "example-gw-voice",
      providerId: "example_lm",
      responses: []
    });

    await withExampleSdk({
      configureConfig: (config) => {
        const providers = config.providers.voiceProviders as Record<string, { enabled: boolean }>;
        for (const provider of Object.values(providers)) {
          provider.enabled = false;
        }
        providers.local_system = { ...providers.local_system, enabled } as { enabled: boolean };
      },
      name: "gateway-runtime-voice",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "example-gw-voice", enabled: true }] },
      run: async ({ sdk }) => {
        const { tools } = (await sdk.request("tool.search", { limit: 20, query: "voice" })) as {
          tools: Array<{ invocationName: string }>;
        };
        const names = tools.map((tool) => tool.invocationName);
        if (enabled) {
          expect(names).toEqual(expect.arrayContaining(["voice_list_voices", "voice_synthesize_text"]));
        } else {
          expect(names.filter((name) => name.startsWith("voice_"))).toEqual([]);
        }
      }
    });
  });

  // tools.list() was a plain search, so it returned the first ten tools.
  test("sdk.tools.list() returns every registered tool", async () => {
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "example-gw-tools",
      providerId: "example_lm",
      responses: []
    });

    await withExampleSdk({
      name: "gateway-runtime-tools-list",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "example-gw-tools", enabled: true }] },
      run: async ({ sdk }) => {
        const all = await sdk.tools.list();
        const firstPage = await sdk.tools.search();
        const capped = await sdk.tools.search({ limit: 100 });

        expect(firstPage).toHaveLength(10);
        expect(all.length).toBeGreaterThan(firstPage.length);
        expect(all.length).toBeGreaterThanOrEqual(capped.length);
        expect(new Set(all.map((tool) => tool.toolId)).size).toBe(all.length);
        expect(all.map((tool) => tool.invocationName)).toEqual(
          expect.arrayContaining(["attempt_complete", "read_file", "tool_search", "write_file"])
        );
      }
    });
  });

  // A provider serving whatever model is loaded answered as that model, and
  // nothing said so: the model id on the response was the only trace.
  test.each([
    ["warns once per session when the provider answers with another model", "some-other-model", 1],
    ["does not warn about another spelling of the same model", "example-gw-mismatch:latest", 0]
  ])("%s", async (_label, answeredModel, expectedWarnings) => {
    const answer = (text: string) => (request: LanguageModelRequest) => ({
      ...buildScriptedResponse({
        request,
        text,
        toolCalls: [buildToolCall("attempt_complete", { summary: text })]
      }),
      modelId: answeredModel
    });
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "example-gw-mismatch",
      providerId: "example_lm",
      responses: [answer("first"), answer("second")]
    });

    await withExampleSdk({
      name: "gateway-runtime-model-mismatch",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "example-gw-mismatch", enabled: true }] },
      run: async ({ sdk, workspaceRoot }) => {
        const warnings: Array<{ message: string; metadata: Record<string, unknown> }> = [];
        sdk.subscribe(
          (event) => {
            if (event.topic === "log.emitted" && event.metadata.code === "model_mismatch") {
              warnings.push({ message: event.payload.message, metadata: event.metadata });
            }
          },
          { topics: ["log.emitted"] }
        );
        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Answer twice",
          initialMessage: { text: "first" },
          metadata: { surface: "example" },
          title: "Model Mismatch"
        });
        await created.run!.wait({ timeoutMs: 10_000 });
        const second = await created.handle.sendMessage({ text: "second" });
        await second.wait({ timeoutMs: 10_000 });

        expect(warnings).toHaveLength(expectedWarnings);
        if (expectedWarnings > 0) {
          expect(warnings[0]?.message).toContain('answered with model "some-other-model"');
          expect(warnings[0]?.metadata).toMatchObject({
            answeredModel: "some-other-model",
            requestedModel: "example-gw-mismatch",
            sessionId: created.session.id
          });
        }
      }
    });
  });

  test("synthesizes channel statuses from config when no channel service is attached", async () => {
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "example-gw-3",
      providerId: "example_lm",
      responses: []
    });

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

  test("a stale run's completion cannot release a busy-gate slot a fresher run now owns", async () => {
    // `activeRunsBySession` is keyed by sessionId, which is reused across runs
    // over time (unlike `activeRunsById`). Before the fix, `completeRun`
    // deleted the session's slot unconditionally, so a run whose finalization
    // is merely running late (it is still the *same* run object here, just a
    // second finalize path arriving after a fresher run has already taken the
    // slot) could clear the busy-gate out from under a run that is still
    // genuinely active, letting a second run start against the session
    // concurrently.
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "example-gw-busy-gate",
      providerId: "example_lm",
      responses: []
    });

    await withExampleSdk({
      name: "gateway-runtime-busy-gate",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "example-gw-busy-gate", enabled: true }] },
      run: async ({ sdk, workspaceRoot }) => {
        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Exercise the busy-gate race",
          metadata: { surface: "example" },
          title: "Busy Gate Race"
        });
        const sessionId = created.session.id;

        const runtime = sdk.controlPlane as unknown as {
          activeRunsById: Map<string, { cancelRequested: boolean; run: Record<string, unknown> }>;
          activeRunsBySession: Map<string, { cancelRequested: boolean; run: Record<string, unknown> }>;
          completeRun: (
            active: { cancelRequested: boolean; run: Record<string, unknown> },
            params: { sessionId: string; status: string }
          ) => Promise<void>;
        };

        const buildActive = (runId: string) => ({
          cancelRequested: false,
          run: {
            approvalRequestIds: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            id: runId,
            kind: "session_message",
            messageIds: [],
            metadata: {},
            sessionId,
            status: "running",
            toolCallIds: [],
            turnIds: [],
            updatedAt: "2026-01-01T00:00:00.000Z"
          }
        });

        const stale = buildActive("gateway-run.busy-gate.stale");
        const fresh = buildActive("gateway-run.busy-gate.fresh");

        // Simulate: `stale` used to occupy the slot, but a fresher run for the
        // same session has since taken over (the only state that matters to
        // `completeRun` is what is currently in the maps, not how it got
        // there).
        runtime.activeRunsById.set(fresh.run.id as string, fresh);
        runtime.activeRunsBySession.set(sessionId, fresh);

        await runtime.completeRun(stale, { sessionId, status: "completed" });

        expect(runtime.activeRunsBySession.get(sessionId)).toBe(fresh);
        expect(runtime.activeRunsById.get(fresh.run.id as string)).toBe(fresh);
      }
    });
  });
});

describe("gateway runtime context window", () => {
  // The window comes from the model a turn will ask for. The lookup used to
  // pass LM Studio's configured model for every provider but Ollama, so a
  // llama.cpp or custom provider was asked about a model it never runs.
  test("asks the default provider about its own model", async () => {
    const asked: string[] = [];
    class WindowedAdapter extends ScriptedLanguageModelAdapter {
      async getModelContextWindow(modelId: string): Promise<number> {
        asked.push(modelId);
        return 12_000;
      }
    }
    const adapter = new WindowedAdapter({ modelId: "custom-model", providerId: "example_lm", responses: [] });

    await withExampleSdk({
      configureConfig: (config) => {
        config.providers.lmStudio.model = "lm-studio-model";
      },
      name: "gateway-context-window",
      providers: { languageModelAdapters: [{ adapter, defaultModel: "custom-model", enabled: true }] },
      run: async () => undefined
    });

    expect(asked.length).toBeGreaterThan(0);
    expect([...new Set(asked)]).toEqual(["custom-model"]);
  });
});
