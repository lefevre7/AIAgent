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

export type CodingTaskExampleResult = {
  assistantSummaries: string[];
  promptPreview: string;
  runStatus: string;
  sessionId: string;
  taskSummary: string | null;
  toolCalls: string[];
};

export async function runCodingTaskExample(): Promise<CodingTaskExampleResult> {
  const adapter = new ScriptedLanguageModelAdapter({
    modelId: "example-coder-1",
    providerId: "example_lm",
    responses: [
      (request) =>
        buildScriptedResponse({
          request,
          text: "I reviewed the coding task, captured a concrete plan, and I am ready to close the example loop.",
          toolCalls: [
            buildToolCall("update_plan", {
              explanation: "Recording the current coding task before completing the example.",
              items: [
                {
                  status: "completed",
                  title: "Read AGENTS guidance and identify the current coding goal."
                },
                {
                  status: "completed",
                  title: "Capture one canonical plan entry for the session."
                }
              ],
              summary: "Model the shared runtime first, then validate the change path.",
              workingMemory: [
                {
                  kind: "next_step",
                  priority: "high",
                  text: "Confirm the prompt pack and tool search surfaces stay coherent."
                }
              ]
            })
          ]
        }),
      (request) =>
        buildScriptedResponse({
          request,
          text: "The example coding task is complete: the session has prompt-pack context, task-state updates, and a clean completion path.",
          toolCalls: [buildToolCall("attempt_complete")]
        })
    ]
  });

  return withExampleSdk({
    name: "coding-task",
    providers: {
      languageModelAdapters: [
        {
          adapter,
          defaultModel: "example-coder-1",
          enabled: true
        }
      ]
    },
    setupWorkspace: async ({ workspaceRoot }) => {
      await fs.mkdir(path.join(workspaceRoot, "src"), { recursive: true });
      await Promise.all([
        fs.writeFile(
          path.join(workspaceRoot, "AGENTS.md"),
          "# Example Instructions\nPrefer one shared runtime path over duplicate control flows.\n",
          "utf8"
        ),
        fs.writeFile(
          path.join(workspaceRoot, "src", "demo.ts"),
          "export function demoValue() {\n  return 'example';\n}\n",
          "utf8"
        )
      ]);
    },
    run: async ({ sdk, workspaceRoot }) => {
      const created = await sdk.sessions.create({
        cwd: workspaceRoot,
        goal: "Sketch the next coding step through the shared runtime.",
        initialMessage: {
          text: "Inspect the current coding task and capture the plan before finishing."
        },
        metadata: {
          surface: "example"
        },
        title: "Coding Task Example"
      });

      const run = await created.run?.wait();
      const snapshot = await created.handle.snapshot();

      return summarizeCodingExample({
        adapter,
        runStatus: run?.status ?? "completed",
        snapshot
      });
    }
  });
}

function summarizeCodingExample(params: {
  adapter: ScriptedLanguageModelAdapter;
  runStatus: string;
  snapshot: GatewaySessionSnapshot;
}): CodingTaskExampleResult {
  return {
    assistantSummaries: extractAssistantTexts(params.snapshot),
    promptPreview: previewPromptSection(params.adapter.requests[0]?.instructions ?? "", "AGENTS.md Instructions"),
    runStatus: params.runStatus,
    sessionId: params.snapshot.snapshot.session.id,
    taskSummary: params.snapshot.taskState?.summary ?? null,
    toolCalls: params.snapshot.snapshot.toolCalls.map((toolCall) => toolCall.toolName)
  };
}

async function main(): Promise<void> {
  const result = await runCodingTaskExample();
  console.log(
    [
      "Coding Task Example",
      `Session: ${result.sessionId}`,
      `Run status: ${result.runStatus}`,
      `Task summary: ${result.taskSummary ?? "none"}`,
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
