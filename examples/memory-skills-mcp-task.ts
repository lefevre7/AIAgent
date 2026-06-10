import fs from "node:fs/promises";
import path from "node:path";

import { sanitizeMcpInvocationName } from "@/core";
import { type GatewaySessionSnapshot } from "@/core/contracts";

import {
  ScriptedLanguageModelAdapter,
  buildScriptedResponse,
  buildToolCall,
  extractAssistantTexts,
  isDirectExecution,
  previewPromptSection,
  withExampleSdk
} from "./shared";

const STDIO_FIXTURE_PATH = path.resolve("tests/fixtures/mcp/stdio-server.mjs");

export type MemorySkillsMcpTaskExampleResult = {
  assistantSummaries: string[];
  memoryHitPath: string | null;
  promptPreview: string;
  runStatus: string;
  sessionId: string;
  toolCalls: string[];
};

export async function runMemorySkillsMcpTaskExample(): Promise<MemorySkillsMcpTaskExampleResult> {
  const mcpToolName = sanitizeMcpInvocationName("docs", "docs.lookup");
  const adapter = new ScriptedLanguageModelAdapter({
    modelId: "example-memory-1",
    providerId: "example_lm",
    responses: [
      (request) =>
        buildScriptedResponse({
          request,
          text: "I need to recall the stored note first.",
          toolCalls: [
            buildToolCall("memory_search", {
              limit: 5,
              scopes: ["workspace"],
              text: "Which note mentions the shared gateway runtime?"
            })
          ]
        }),
      (request) =>
        buildScriptedResponse({
          request,
          text: "Now I want to inspect the MCP capability catalog.",
          toolCalls: [
            buildToolCall("mcp_search", {
              kinds: ["tool", "resource", "resource_template"],
              limit: 8,
              query: "docs"
            })
          ]
        }),
      (request) =>
        buildScriptedResponse({
          request,
          text: "The connected docs tool should confirm the topic directly.",
          toolCalls: [
            buildToolCall(mcpToolName, {
              topic: "shared runtime"
            })
          ]
        }),
      (request) =>
        buildScriptedResponse({
          request,
          text: "The memory/skills/MCP example is complete: prompt-pack skill discovery, durable memory recall, and MCP catalog/tool execution all ran through one session.",
          toolCalls: [buildToolCall("attempt_complete")]
        })
    ]
  });

  return withExampleSdk({
    configureConfig: (config) => {
      config.mcp.servers.docs = {
        args: [STDIO_FIXTURE_PATH],
        command: process.execPath,
        description: "Fixture docs server",
        enabled: true,
        env: {},
        required: true,
        stderr: "pipe",
        tags: ["docs", "fixture"],
        type: "stdio"
      };
    },
    name: "memory-skills-mcp-task",
    providers: {
      languageModelAdapters: [
        {
          adapter,
          defaultModel: "example-memory-1",
          enabled: true
        }
      ]
    },
    setupWorkspace: async ({ workspaceRoot }) => {
      await fs.mkdir(path.join(workspaceRoot, "skills", "release-readiness"), { recursive: true });
      await Promise.all([
        fs.writeFile(
          path.join(workspaceRoot, "AGENTS.md"),
          "# Example Memory Instructions\nSearch durable memory before answering questions about prior work.\n",
          "utf8"
        ),
        fs.writeFile(
          path.join(workspaceRoot, "MEMORY.md"),
          "# Durable Memory\nThe shared gateway runtime keeps CLI, SDK, web, and gateway entry points aligned.\n",
          "utf8"
        ),
        fs.writeFile(
          path.join(workspaceRoot, "skills", "release-readiness", "SKILL.md"),
          "---\nname: release-readiness\ndescription: Verify shared runtime paths before release.\n---\nCheck the prompt pack, task state, and runtime surfaces before closing the task.\n",
          "utf8"
        )
      ]);
    },
    run: async ({ sdk, workspaceRoot }) => {
      const created = await sdk.sessions.create({
        cwd: workspaceRoot,
        goal: "Recall a stored note, inspect available MCP capabilities, and consult the docs tool.",
        initialMessage: {
          text: "Use durable memory and MCP to confirm how the shared runtime is described."
        },
        metadata: {
          surface: "example"
        },
        title: "Memory + Skills + MCP Example"
      });

      const run = await created.run?.wait();
      const snapshot = await created.handle.snapshot();
      return summarizeMemoryExample({
        adapter,
        runStatus: run?.status ?? "completed",
        snapshot
      });
    }
  });
}

function summarizeMemoryExample(params: {
  adapter: ScriptedLanguageModelAdapter;
  runStatus: string;
  snapshot: GatewaySessionSnapshot;
}): MemorySkillsMcpTaskExampleResult {
  const memoryResult = params.snapshot.snapshot.toolCalls.find((toolCall) => toolCall.toolName === "memory_search")?.result as
    | {
        hits?: Array<{ path?: string | null }>;
      }
    | undefined;

  return {
    assistantSummaries: extractAssistantTexts(params.snapshot),
    memoryHitPath: typeof memoryResult?.hits?.[0]?.path === "string" ? memoryResult.hits[0].path : null,
    promptPreview: previewPromptSection(params.adapter.requests[0]?.instructions ?? "", "Available Skills"),
    runStatus: params.runStatus,
    sessionId: params.snapshot.snapshot.session.id,
    toolCalls: params.snapshot.snapshot.toolCalls.map((toolCall) => toolCall.toolName)
  };
}

async function main(): Promise<void> {
  const result = await runMemorySkillsMcpTaskExample();
  console.log(
    [
      "Memory + Skills + MCP Task Example",
      `Session: ${result.sessionId}`,
      `Run status: ${result.runStatus}`,
      `Top memory hit: ${result.memoryHitPath ?? "none"}`,
      `Tool calls: ${result.toolCalls.join(", ")}`,
      "",
      "Prompt preview:",
      result.promptPreview,
      "",
      "Assistant summaries:",
      ...result.assistantSummaries.map((summary) => `- ${summary}`)
    ].join("\n")
  );
}

if (isDirectExecution(import.meta.url)) {
  void main();
}
