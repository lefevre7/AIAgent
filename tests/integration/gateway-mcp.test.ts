import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { ScriptedLanguageModelAdapter, buildScriptedResponse, withExampleSdk } from "../../examples/shared";
import { sanitizeMcpInvocationName } from "@/core";
import type { GatewayEvent } from "@/core/contracts";

const FIXTURE = path.resolve("tests/fixtures/mcp/stdio-lifecycle-server.mjs");

function withFixtureServer(
  run: Parameters<typeof withExampleSdk>[0]["run"],
  adapter?: ScriptedLanguageModelAdapter,
  serverName = "tools"
) {
  const model =
    adapter ?? new ScriptedLanguageModelAdapter({ modelId: "example-mcp-1", providerId: "example_lm", responses: [] });
  return withExampleSdk({
    configureConfig: (config) => {
      // The model calls the MCP tool directly; under the lean profile it would
      // first have to find it with tool_search.
      config.tools.profile = "full";
      config.mcp.servers[serverName] = {
        args: [FIXTURE],
        command: process.execPath,
        enabled: true,
        env: { MCP_TEST_INSTRUCTIONS: "Ask before deploying." },
        required: true,
        stderr: "pipe",
        tags: [],
        trust: "trusted",
        type: "stdio"
      };
    },
    name: "gateway-mcp",
    providers: { languageModelAdapters: [{ adapter: model, defaultModel: "example-mcp-1", enabled: true }] },
    run
  });
}

// A model that calls the fixture's `ask` tool once, then completes.
function askingModel(): ScriptedLanguageModelAdapter {
  return new ScriptedLanguageModelAdapter({
    modelId: "example-mcp-1",
    providerId: "example_lm",
    responses: [
      (request) =>
        buildScriptedResponse({
          request,
          text: "Asking.",
          toolCalls: [{ arguments: {}, callId: "call.ask", toolName: sanitizeMcpInvocationName("tools", "ask") }]
        }),
      (request) =>
        buildScriptedResponse({
          request,
          text: "Done.",
          toolCalls: [{ arguments: { summary: "done" }, callId: "call.done", toolName: "attempt_complete" }]
        })
    ]
  });
}

describe("gateway MCP surfaces", () => {
  test("mcp.list shows instructions, mcp.reconnect reconnects, and mcp.updated reaches a session's subscriber", async () => {
    await withFixtureServer(async ({ sdk }) => {
      const events: GatewayEvent[] = [];
      // Session-filtered, as the CLI's is: MCP updates still arrive.
      const stop = sdk.subscribe((event) => events.push(event), {
        sessionId: "session.unrelated",
        topics: ["mcp.updated"]
      });

      const { servers } = await sdk.request("mcp.list", {});
      expect(servers[0]).toMatchObject({
        instructions: "Ask before deploying.",
        serverName: "tools",
        state: "connected"
      });

      expect((await sdk.request("mcp.list", { serverNames: ["another"] })).servers).toEqual([]);

      const { server } = await sdk.request("mcp.reconnect", { serverName: "tools" });
      expect(server.state).toBe("connected");
      expect(server.tools.length).toBeGreaterThan(0);
      stop();

      const transitions = events.flatMap((event) =>
        event.topic === "mcp.updated" ? [`${event.payload.previousState}->${event.payload.server.state}`] : []
      );
      expect(transitions).toContain("connecting->connected");
      // The state only: every transition reaches every subscriber, so the
      // tools and instructions stay with mcp.list.
      for (const event of events) {
        expect(event.topic === "mcp.updated" && event.payload.server).not.toHaveProperty("tools");
        expect(event.topic === "mcp.updated" && event.payload.server).not.toHaveProperty("instructions");
      }
    });
  });

  test("an MCP server's question becomes a question approval, and the answer goes back to its tool call", async () => {
    await withFixtureServer(async ({ sdk, workspaceRoot }) => {
      const answers = ["2", "Ada", "yes"];
      const asked: string[] = [];
      const stop = sdk.subscribe(
        (event) => {
          if (event.topic === "approval.requested" && event.payload.metadata.interaction === "elicitation") {
            asked.push(event.payload.justification);
            void sdk.request("approval.resolve", {
              comment: answers.shift()!,
              decision: "approved",
              requestId: event.payload.id
            });
          }
        },
        { topics: ["approval.requested"] }
      );

      const created = await sdk.sessions.create({
        cwd: workspaceRoot,
        goal: "Deploy",
        initialMessage: { text: "deploy it" },
        metadata: {},
        title: "Elicitation"
      });
      await created.run!.wait({ timeoutMs: 10_000 });
      stop();

      expect(asked).toHaveLength(3);
      expect(asked[0]).toContain('The MCP server "tools" asks: Who is deploying?');
      const snapshot = (await created.handle.snapshot()).snapshot;
      const call = snapshot.toolCalls.find((entry) => entry.toolName === sanitizeMcpInvocationName("tools", "ask"));
      expect(JSON.stringify(call?.result)).toContain(
        '{\\"action\\":\\"accept\\",\\"content\\":{\\"count\\":2,\\"name\\":\\"Ada\\",\\"ok\\":true}}'
      );
    }, askingModel());
  });

  test("a subscriber to every event is not someone who answers questions", async () => {
    await withFixtureServer(async ({ sdk, workspaceRoot }) => {
      // A logger: subscribed to everything, showing nothing to anyone.
      const stop = sdk.subscribe(() => undefined);
      const created = await sdk.sessions.create({
        cwd: workspaceRoot,
        goal: "Deploy",
        initialMessage: { text: "deploy it" },
        metadata: {},
        title: "Logger only"
      });
      // Within the wait's timeout: asked, the question would have held the
      // call for the 600 s elicitation timeout.
      await created.run!.wait({ timeoutMs: 10_000 });
      stop();

      const snapshot = (await created.handle.snapshot()).snapshot;
      const call = snapshot.toolCalls.find((entry) => entry.toolName === sanitizeMcpInvocationName("tools", "ask"));
      expect(JSON.stringify(call?.result)).toContain('{\\"action\\":\\"decline\\"}');
    }, askingModel());
  });

  test("with no one watching for approvals, the server's question is declined at once", async () => {
    await withFixtureServer(async ({ sdk, workspaceRoot }) => {
      const created = await sdk.sessions.create({
        cwd: workspaceRoot,
        goal: "Deploy",
        initialMessage: { text: "deploy it" },
        metadata: {},
        title: "No operator"
      });
      // run.wait() subscribes too, but only to run updates: it cannot answer.
      // Within the wait's timeout: asked, the question would have held the
      // call for the 600 s elicitation timeout.
      await created.run!.wait({ timeoutMs: 10_000 });

      const snapshot = (await created.handle.snapshot()).snapshot;
      const call = snapshot.toolCalls.find((entry) => entry.toolName === sanitizeMcpInvocationName("tools", "ask"));
      expect(JSON.stringify(call?.result)).toContain('{\\"action\\":\\"decline\\"}');
      expect(Object.keys(await readPending(sdk))).toEqual([]);
    }, askingModel());
  });
});

// Config accepts any server name. One with a space used to crash the REPL
// (an mcp.updated event id failed the id schema inside a voided emit), and a
// call to one of its tools left a toolId that made the session unreadable.
describe("an MCP server whose name is not an id", () => {
  const serverName = "brave search @v2/x";

  test("connects, reports its updates, and its tools can be called and read back", async () => {
    const echoName = sanitizeMcpInvocationName(serverName, "echo");
    const model = new ScriptedLanguageModelAdapter({
      modelId: "example-mcp-1",
      providerId: "example_lm",
      responses: [
        (request) =>
          buildScriptedResponse({
            request,
            text: "Echoing.",
            toolCalls: [{ arguments: { text: "hi" }, callId: "call.echo", toolName: echoName }]
          }),
        (request) =>
          buildScriptedResponse({
            request,
            text: "Done.",
            toolCalls: [{ arguments: { summary: "done" }, callId: "call.done", toolName: "attempt_complete" }]
          })
      ]
    });
    await withFixtureServer(
      async ({ sdk, workspaceRoot }) => {
        const events: GatewayEvent[] = [];
        const stop = sdk.subscribe((event) => events.push(event), { topics: ["mcp.updated"] });
        const { server } = await sdk.request("mcp.reconnect", { serverName });
        expect(server.state).toBe("connected");
        stop();
        const updates = events.filter((event) => event.topic === "mcp.updated");
        expect(updates.length).toBeGreaterThan(0);
        for (const event of updates) {
          expect(event.id).toMatch(/^mcp-updated\.brave-search-v2-x-[0-9a-f]{8}\./u);
        }

        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Echo",
          initialMessage: { text: "echo hi" },
          metadata: {},
          title: "Odd server name"
        });
        await created.run!.wait({ timeoutMs: 10_000 });
        const snapshot = (await created.handle.snapshot()).snapshot;
        const call = snapshot.toolCalls.find((entry) => entry.toolName === echoName);
        expect(call?.status).toBe("succeeded");
        expect(call?.toolId).toMatch(/^mcp\.tool\.brave-search-v2-x-[0-9a-f]{8}\.echo$/u);
      },
      model,
      serverName
    );
  });
});

// mcp_status was offered only when the startup config's own mcp.servers had
// an entry, so a model whose servers all came from an import (or were
// withheld as untrusted) could not say what was wrong with them.
describe("the mcp_status tool", () => {
  test("is offered when the only servers come from an import", async () => {
    const offered: string[][] = [];
    const model = new ScriptedLanguageModelAdapter({
      modelId: "example-mcp-1",
      providerId: "example_lm",
      responses: [
        (request) => {
          offered.push(request.availableTools.map((tool) => tool.invocationName));
          return buildScriptedResponse({
            request,
            text: "Done.",
            toolCalls: [{ arguments: { summary: "done" }, callId: "call.done", toolName: "attempt_complete" }]
          });
        }
      ]
    });
    const importDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-mcp-status-import-"));
    const importPath = path.join(importDirectory, "mcp.json");
    await fs.writeFile(
      importPath,
      JSON.stringify({ mcpServers: { imported: { args: [], command: path.join(importDirectory, "missing-binary") } } })
    );
    try {
      await withExampleSdk({
        configureConfig: (config) => {
          config.mcp.imports.vscode = { enabled: true, format: "claude_desktop", path: importPath, watch: false };
        },
        name: "gateway-mcp-status-import",
        providers: { languageModelAdapters: [{ adapter: model, defaultModel: "example-mcp-1", enabled: true }] },
        run: async ({ sdk, workspaceRoot }) => {
          const created = await sdk.sessions.create({
            cwd: workspaceRoot,
            goal: "Check",
            initialMessage: { text: "what MCP servers do you have?" },
            metadata: {},
            title: "Imported only"
          });
          await created.run!.wait({ timeoutMs: 10_000 });
        }
      });
    } finally {
      await fs.rm(importDirectory, { force: true, recursive: true });
    }
    expect(offered[0]).toContain("mcp_status");
  });
});

async function readPending(sdk: Parameters<Parameters<typeof withExampleSdk>[0]["run"]>[0]["sdk"]) {
  const approvals = await sdk.request("approval.list", { pendingOnly: true });
  return Object.fromEntries(approvals.approvals.map((approval) => [approval.request.id, approval]));
}
