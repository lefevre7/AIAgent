import fs from "node:fs/promises";
import path from "node:path";

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

const RESEARCH_URL = "https://example.com/aiagent-runtime-surfaces";

export type ResearchWebTaskExampleResult = {
  assistantSummaries: string[];
  fetchedTitle: string | null;
  promptPreview: string;
  runStatus: string;
  sessionId: string;
  toolCalls: string[];
};

export async function runResearchWebTaskExample(): Promise<ResearchWebTaskExampleResult> {
  const adapter = new ScriptedLanguageModelAdapter({
    modelId: "example-researcher-1",
    providerId: "example_lm",
    responses: [
      (request) =>
        buildScriptedResponse({
          request,
          text: "I need one fetch before I can finish the research summary.",
          toolCalls: [
            buildToolCall("web_fetch", {
              query: "shared runtime surfaces",
              url: RESEARCH_URL
            })
          ]
        }),
      (request) =>
        buildScriptedResponse({
          request,
          text: "The research example is complete: the fetched page confirms the shared runtime exposes CLI, SDK, web, and gateway control surfaces.",
          toolCalls: [buildToolCall("attempt_complete")]
        })
    ]
  });

  return withExampleSdk({
    fetchImpl: createExampleFetch(),
    name: "research-web-task",
    providers: {
      languageModelAdapters: [
        {
          adapter,
          defaultModel: "example-researcher-1",
          enabled: true
        }
      ]
    },
    setupWorkspace: async ({ workspaceRoot }) => {
      await fs.writeFile(
        path.join(workspaceRoot, "AGENTS.md"),
        "# Research Instructions\nUse web_fetch for public documentation before summarizing.\n",
        "utf8"
      );
    },
    run: async ({ sdk, workspaceRoot }) => {
      const created = await sdk.sessions.create({
        cwd: workspaceRoot,
        goal: "Research the runtime surfaces and summarize the result.",
        initialMessage: {
          text: "Confirm which runtime surfaces are called out in the fetched documentation."
        },
        metadata: {
          surface: "example"
        },
        title: "Research Web Example"
      });

      const run = await created.run?.wait();
      const snapshot = await created.handle.snapshot();
      return summarizeResearchExample({
        adapter,
        runStatus: run?.status ?? "completed",
        snapshot
      });
    }
  });
}

function summarizeResearchExample(params: {
  adapter: ScriptedLanguageModelAdapter;
  runStatus: string;
  snapshot: GatewaySessionSnapshot;
}): ResearchWebTaskExampleResult {
  const webFetchResult = params.snapshot.snapshot.toolCalls.find((toolCall) => toolCall.toolName === "web_fetch")?.result as
    | {
        title?: string | null;
      }
    | undefined;

  return {
    assistantSummaries: extractAssistantTexts(params.snapshot),
    fetchedTitle: typeof webFetchResult?.title === "string" ? webFetchResult.title : null,
    promptPreview: previewPromptSection(params.adapter.requests[0]?.instructions ?? "", "## Available Tools"),
    runStatus: params.runStatus,
    sessionId: params.snapshot.snapshot.session.id,
    toolCalls: params.snapshot.snapshot.toolCalls.map((toolCall) => toolCall.toolName)
  };
}

function createExampleFetch(): typeof fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url !== RESEARCH_URL) {
      return new Response("not found", {
        status: 404
      });
    }

    return new Response(
      `<!doctype html>
      <html>
        <head>
          <title>Runtime Surfaces</title>
        </head>
        <body>
          <h1>Shared Runtime Surfaces</h1>
          <p>The local product routes CLI, SDK, web control plane, and gateway requests through the same shared runtime.</p>
          <p>Examples can expose prompt and tool weaknesses without requiring live credentials.</p>
        </body>
      </html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8"
        },
        status: 200
      }
    );
  };
}

async function main(): Promise<void> {
  const result = await runResearchWebTaskExample();
  console.log(
    [
      "Research/Web Task Example",
      `Session: ${result.sessionId}`,
      `Run status: ${result.runStatus}`,
      `Fetched title: ${result.fetchedTitle ?? "none"}`,
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
