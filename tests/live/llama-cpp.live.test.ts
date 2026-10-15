import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect } from "vitest";

import {
  COMPACTION_WATERMARK_METADATA_KEY,
  CONTEXT_WINDOW_EXCEEDED_ERROR_CODE,
  FileSessionStore,
  LlamaCppLanguageModelAdapter,
  type LanguageModelStreamEvent
} from "@/core";
import { languageModelRequestSchema, messageSchema, type Message, type ToolDefinition } from "@/core/contracts";
import { createAIAgentSdkFromConfig } from "@/sdk";
import { createLiveTestHarness, envFlag } from "./helpers";

// Needs a running llama-server, e.g. (docs/PROVIDERS.md):
//   llama-server -m ~/.lmstudio/models/<publisher>/<repo>/<file>.gguf -c 8192 --port 8080
const baseUrl = process.env.AIA_LIVE_LLAMA_CPP_BASE_URL ?? "http://127.0.0.1:8080/v1";
const requestedModel = process.env.AIA_LIVE_LLAMA_CPP_MODEL;
// Room for a reasoning model to think before it answers.
const maxOutputTokens = Number(process.env.AIA_LIVE_LLAMA_CPP_MAX_OUTPUT_TOKENS ?? 2048);
const { createTempRoot, liveTest } = createLiveTestHarness({
  enabled: envFlag("AIA_RUN_LIVE_LLAMA_CPP_TESTS"),
  prefix: "aiagent-live-llama-cpp-"
});

function adapter() {
  return new LlamaCppLanguageModelAdapter({
    baseUrl,
    streamFirstTokenTimeoutMs: 300_000,
    streamIdleTimeoutMs: 60_000,
    timeoutMs: 300_000
  });
}

function request(params: { id: string; modelId: string; text: string; tools?: ToolDefinition[] }) {
  return languageModelRequestSchema.parse({
    availableTools: params.tools ?? [],
    id: params.id,
    instructions: "You are a terse assistant used in an automated test.",
    messages: [
      {
        createdAt: new Date().toISOString(),
        id: `message.user.${params.id}`,
        metadata: {},
        parts: [{ kind: "text", text: params.text }],
        role: "user",
        sessionId: "session.llama-cpp.live",
        source: "user",
        tags: [],
        visibility: "default"
      }
    ],
    metadata: {},
    modelId: params.modelId,
    provider: "llama_cpp",
    settings: {
      maxOutputTokens,
      stopSequences: [],
      temperature: 0,
      toolChoice: params.tools?.length ? "auto" : "none"
    }
  });
}

async function resolveModelId(llama: LlamaCppLanguageModelAdapter): Promise<string> {
  if (requestedModel) {
    return requestedModel;
  }
  const [first] = await llama.listModels();
  if (!first) {
    throw new Error(`llama-server at ${baseUrl} lists no models.`);
  }
  return first.modelId;
}

describe("llama.cpp adapter (live)", () => {
  liveTest("reports health, lists the loaded model, and knows its context window", async () => {
    const llama = adapter();

    const health = await llama.health();
    expect(health.status, JSON.stringify(health.details)).toBe("healthy");

    const modelId = await resolveModelId(llama);
    const window = await llama.getModelContextWindow(modelId);
    expect(window, "the per-slot n_ctx from /v1/models or /props").toBeGreaterThan(0);
  });

  liveTest("streams a non-empty answer", async () => {
    const llama = adapter();
    const modelId = await resolveModelId(llama);

    const events: LanguageModelStreamEvent[] = [];
    for await (const event of llama.stream(
      request({ id: "llama-cpp.live.stream", modelId, text: "Reply with the single word: ready." })
    )) {
      events.push(event);
    }

    const errors = events.filter((event) => event.kind === "response.error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
    const completed = events.find((event) => event.kind === "response.completed");
    const answer = (completed?.kind === "response.completed" ? completed.response.message?.parts : [])
      ?.flatMap((part) => (part.kind === "text" ? [part.text] : []))
      .join("");
    expect(answer?.trim().length, "no answer text").toBeGreaterThan(0);
    expect(completed?.kind === "response.completed" ? completed.response.usage.inputTokens : 0).toBeGreaterThan(0);
  });

  // The streamed tool-call deltas are where llama.cpp and the adapter have to
  // agree: the autoparser emits OpenAI-style fragments, the adapter
  // concatenates them by index and parses at the end.
  liveTest("calls a tool with parsed arguments through the streamed deltas", async () => {
    const llama = adapter();
    const modelId = await resolveModelId(llama);

    const toolCalls: Array<{ arguments: Record<string, unknown>; toolName: string }> = [];
    for await (const event of llama.stream(
      request({
        id: "llama-cpp.live.tools",
        modelId,
        text: "What is the weather in Paris? Use the get_weather tool.",
        tools: [getWeatherTool]
      })
    )) {
      if (event.kind === "response.error") {
        throw new Error(event.error.message);
      }
      if (event.kind === "response.tool_call") {
        toolCalls.push({ arguments: event.toolCall.arguments, toolName: event.toolCall.toolName });
      }
    }

    expect(toolCalls.map((call) => call.toolName)).toContain("get_weather");
    const call = toolCalls.find((entry) => entry.toolName === "get_weather");
    expect(String(call?.arguments.city ?? "").toLowerCase()).toContain("paris");
  });

  liveTest("reports a prompt larger than the context window as a context overflow", async () => {
    const llama = adapter();
    const modelId = await resolveModelId(llama);
    const window = (await llama.getModelContextWindow(modelId)) ?? 8192;
    // Several tokens per repetition, well past the window. The server refuses
    // it after tokenizing, before evaluating anything, so this is cheap.
    const oversized = "context overflow check ".repeat(window);

    const failure = await (async () => {
      for await (const _event of llama.stream(request({ id: "llama-cpp.live.overflow", modelId, text: oversized }))) {
        // drain
      }
    })().catch((error: unknown) => error);

    expect(failure).toMatchObject({
      structuredError: { code: CONTEXT_WINDOW_EXCEEDED_ERROR_CODE, details: { contextWindowTokens: window } }
    });
  });
});

// The tests above talk to llama-server directly. These go the way a REPL or
// server turn does: config, gateway runtime, the file-backed model queue, and
// the agent loop, so a break anywhere in between (the queue dropping the
// overflow's structured error, a retry reusing its queue id) fails here.
describe("llama.cpp through aia (live)", () => {
  async function startAia(options: { contextWindowTokens?: number } = {}) {
    const llama = adapter();
    const modelId = await resolveModelId(llama);
    const window = (await llama.getModelContextWindow(modelId)) ?? 8192;
    const root = await createTempRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const stateRoot = path.join(root, "state");
    await fs.mkdir(path.join(home, ".aia"), { recursive: true });
    await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
    if (options.contextWindowTokens) {
      await fs.writeFile(
        path.join(home, ".aia", "config.jsonc"),
        JSON.stringify({
          configVersion: 1,
          runtime: { modelSettings: { contextWindowTokens: options.contextWindowTokens } }
        }),
        "utf8"
      );
    }
    const sessions = new FileSessionStore(stateRoot);
    const sdk = await createAIAgentSdkFromConfig({
      cwd: workspace,
      env: {
        AIA_DEFAULT_MODEL: modelId,
        AIA_DEFAULT_PROVIDER: "llama_cpp",
        AIA_LLAMA_CPP_BASE_URL: baseUrl,
        AIA_MEMORY_EMBEDDINGS_ENABLED: "false",
        AIA_MEMORY_HARD_FAIL_ON_STARTUP: "false",
        AIA_MEMORY_STATE_ROOT: stateRoot
      },
      sessions,
      userHomeDirectory: home
    });
    return { sdk, sessions, stateRoot, window, workspace };
  }

  liveTest("a first message larger than the window fails the turn at once, with both sizes and the fix", async () => {
    const { sdk, window, workspace } = await startAia();
    try {
      const created = await sdk.sessions.create({
        cwd: workspace,
        goal: "Overflow",
        initialMessage: { text: "context overflow check ".repeat(window) },
        metadata: {},
        title: "Overflow"
      });
      await created.run!.wait({ timeoutMs: 240_000 });

      const { session } = (await created.handle.snapshot()).snapshot;
      expect(session.status).toBe("failed");
      expect(session.lastError?.code).toBe(CONTEXT_WINDOW_EXCEEDED_ERROR_CODE);
      // Nothing came before the task, so there was nothing to fold.
      expect(session.lastError?.message).toContain(`the model's context window (${window} tokens)`);
      expect(session.lastError?.message).toContain("nothing from before this task is left to fold");
      expect(session.lastError?.message).toContain("Start llama-server with a larger context (-c)");
    } finally {
      await sdk.close();
    }
  });

  liveTest("a refused prompt folds the earlier history and is retried under a new queue id", async () => {
    // Told the window is far larger than it is, aia does not compact on its own
    // estimate: the server's refusal is what has to fold the history.
    const { sdk, sessions, stateRoot, window, workspace } = await startAia({ contextWindowTokens: 1_000_000 });
    try {
      const created = await sdk.sessions.create({ cwd: workspace, goal: "Fold", metadata: {}, title: "Fold" });
      const sessionId = created.session.id;
      const message = (id: string, role: "assistant" | "user", text: string): Message =>
        messageSchema.parse({
          createdAt: new Date().toISOString(),
          id,
          metadata: {},
          parts: [{ kind: "text", text }],
          role,
          sessionId,
          source: role,
          tags: [],
          visibility: "default"
        });
      // An earlier exchange too long to send again: more than the window by
      // itself. It ends with a short reply, which is what a fold's summary keeps.
      await sessions.appendMessages([
        message("message.user.seed", "user", "Write out the full survey notes."),
        message("message.assistant.seed.notes", "assistant", "survey note entry ".repeat(Math.ceil(window / 2))),
        message("message.assistant.seed.done", "assistant", "Those are all the survey notes.")
      ]);

      const run = await created.handle.sendMessage({ text: "Reply with the single word: done." });
      await run.wait({ timeoutMs: 240_000 });

      const { session } = (await created.handle.snapshot()).snapshot;
      expect(session.lastError?.code).not.toBe(CONTEXT_WINDOW_EXCEEDED_ERROR_CODE);
      expect(session.metadata[COMPACTION_WATERMARK_METADATA_KEY]).toBe("message.assistant.seed.done");
      // The retry went through the queue as a job of its own, and finished.
      const jobsDirectory = path.join(stateRoot, "queues", "lm", "jobs");
      const retries = (await fs.readdir(jobsDirectory)).filter((name) => name.endsWith(".overflow-retry.json"));
      expect(retries).toHaveLength(1);
      const retry = JSON.parse(await fs.readFile(path.join(jobsDirectory, retries[0]!), "utf8")) as { status: string };
      expect(retry.status).toBe("completed");
    } finally {
      await sdk.close();
    }
  });
});

const getWeatherTool: ToolDefinition = {
  aliases: [],
  annotations: {
    destructiveHint: false,
    idempotentHint: true,
    meta: {},
    openWorldHint: false,
    readOnlyHint: true,
    title: "Get Weather"
  },
  approvalMode: "never",
  descriptor: {
    examples: ["get_weather({ city: 'Paris' })"],
    purpose: "Look up the current weather for a city.",
    whenNotToUse: [],
    whenToUse: ["The user asks about the weather somewhere."]
  },
  description: "Get the current weather for a city.",
  displayName: "Get Weather",
  execution: { inputMode: "json", resumable: false, taskSupport: "forbidden" },
  idempotent: true,
  inputSchema: {
    additionalProperties: false,
    properties: { city: { description: "The city name.", type: "string" } },
    required: ["city"],
    type: "object"
  },
  invocationName: "get_weather",
  kind: "built_in",
  metadata: {},
  name: "get_weather",
  outputKind: "json",
  outputSchema: { type: "object" },
  retryable: true,
  searchTags: [],
  sideEffects: ["none"],
  source: { displayName: "Live test", kind: "built_in" },
  streamingMode: "none",
  toolId: "tool.live.get_weather",
  usageGuidance: "Call it with the city the user named.",
  version: "1.0.0"
};
