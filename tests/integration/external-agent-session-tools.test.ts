import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { ExternalAgentConfig } from "@/core/config";
import { FileExternalAgentSessionService } from "@/core/external-agents/sessions";
import { createExternalAgentTool } from "@/core/tools/builtins/external-agent";
import type { RuntimeToolContext } from "@/core/tools/runtime";
import type { ExternalAgentService } from "@/core/contracts";
import { ScriptedLanguageModelAdapter, withExampleSdk } from "../../examples/shared";

const MOCK_CLI = path.resolve("tests/fixtures/external-agents/mock-external-agent-cli.mjs");

const roots: string[] = [];
const services: FileExternalAgentSessionService[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.shutdown().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

// The one-shot job surface is exercised elsewhere; here it only needs to exist
// so the tool can be constructed.
const jobService = {
  cancel: async () => {
    throw new Error("not used");
  },
  getDefinition: async () => null,
  getJob: async () => null,
  listDefinitions: async () => [],
  listJobs: async () => [],
  resume: async () => {
    throw new Error("not used");
  },
  run: async () => {
    throw new Error("not used");
  }
} as unknown as ExternalAgentService;

async function createTool(): Promise<{
  attached: string[];
  context: RuntimeToolContext;
  tool: ReturnType<typeof createExternalAgentTool>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-ext-tool-"));
  roots.push(root);

  const agent: ExternalAgentConfig = {
    args: [MOCK_CLI, "interactive"],
    command: process.execPath,
    displayName: "Mock Interactive Agent",
    enabled: true,
    env: {},
    instructionMode: "arg",
    interactive: {
      args: [],
      idleMs: 250,
      readyPattern: "^>\\s*$",
      stabilityMs: 150,
      turnTimeoutMs: 15_000
    },
    kind: "claude",
    outputFormatFlag: "--output-format",
    outputFormatValue: "json",
    passEnv: [],
    printFlag: "--print",
    resumeFlag: "--resume"
  };

  const service = new FileExternalAgentSessionService({
    agents: { mock: agent },
    defaultCwd: root,
    stateRoot: path.join(root, "external-agents")
  });
  services.push(service);

  const attached: string[] = [];
  const tool = createExternalAgentTool({
    externalAgentService: jobService,
    sessionHost: {
      async attach(externalSessionId) {
        attached.push(externalSessionId);
        return { command: `aia attach ${externalSessionId}` };
      },
      service
    }
  });

  const context = {
    session: { cwd: root, id: "session.tool.1" }
  } as unknown as RuntimeToolContext;

  return { attached, context, tool };
}

function call(args: Record<string, unknown>) {
  return { arguments: args } as Parameters<ReturnType<typeof createExternalAgentTool>["execute"]>[0];
}

describe("external_agent interactive actions", () => {
  test("starts, sends, reads, lists, attaches, and stops a session", async () => {
    const { attached, context, tool } = await createTool();

    const started = await tool.execute(call({ action: "start", agentId: "mock" }), context);
    const externalSessionId = (started.result as { session: { id: string } }).session.id;
    expect(externalSessionId).toMatch(/^external-session\./u);

    const sent = await tool.execute(
      call({ action: "send", externalSessionId, text: "wire it up" }),
      context
    );
    // The rendered screen must reach the model as text, not just a status line.
    expect(sent.display?.some((part) => part.kind === "text" && part.text.includes("answer: wire it up"))).toBe(
      true
    );
    expect((sent.result as { turnEndReason?: string }).turnEndReason).toBe("ready_pattern");

    const read = await tool.execute(call({ action: "read", externalSessionId }), context);
    expect((read.result as { screen: string }).screen).toContain("answer: wire it up");

    const listed = await tool.execute(call({ action: "list" }), context);
    expect((listed.result as { sessions: Array<{ id: string }> }).sessions.map((entry) => entry.id)).toContain(
      externalSessionId
    );

    const attachResult = await tool.execute(call({ action: "attach", externalSessionId }), context);
    expect(attached).toEqual([externalSessionId]);
    expect((attachResult.result as { command: string }).command).toBe(`aia attach ${externalSessionId}`);

    const stopped = await tool.execute(call({ action: "stop", externalSessionId }), context);
    expect((stopped.result as { session: { status: string } }).session.status).toBe("stopped");
  });

  test("the tool is registered on a gateway built from config alone", async () => {
    // Regression: `createDefaultToolRegistry` registers `external_agent` only
    // when a one-shot job service exists, and that service used to be injected
    // exclusively by the server's runtime context. Every other surface — the
    // CLI, the in-process SDK — therefore had no external-agent tool at all,
    // interactive actions included, because the same tool carries both.
    const adapter = new ScriptedLanguageModelAdapter({
      modelId: "ext-wiring-model",
      providerId: "example_lm",
      responses: []
    });

    await withExampleSdk({
      name: "external-agent-wiring",
      providers: {
        languageModelAdapters: [{ adapter, defaultModel: "ext-wiring-model", enabled: true }]
      },
      run: async ({ sdk }) => {
        const found = (await sdk.request("tool.search", {
          limit: 50,
          query: "external agent"
        })) as { tools: Array<{ invocationName: string }> };

        expect(found.tools.map((entry) => entry.invocationName)).toContain("external_agent");
      }
    });
  });

  test("fails clearly when the runtime has no interactive session support", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-ext-tool-"));
    roots.push(root);
    const tool = createExternalAgentTool({ externalAgentService: jobService });
    const context = { session: { cwd: root, id: "session.tool.2" } } as unknown as RuntimeToolContext;

    await expect(tool.execute(call({ action: "start", agentId: "mock" }), context)).rejects.toMatchObject({
      code: "external_agent_sessions_unavailable"
    });
  });
});
