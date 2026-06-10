import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  LanguageModelRuntime,
  OllamaLanguageModelAdapter,
  createDefaultAppConfig,
  type LanguageModelAdapter,
  type LanguageModelRequest,
  type ProviderHealth,
  type ToolDefinition
} from "@/core";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

describe("language model runtime", () => {
  test("queues LM Studio requests, writes logs, and resolves default provider/model settings", async () => {
    const root = await createTempRoot();
    const stateRoot = path.join(root, ".aia");
    const observedCalls: Array<{ body: unknown; url: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/v1/models")) {
        return new Response(JSON.stringify({ data: [{ id: "google/gemma-4-26b-a4b-qat" }] }), {
          headers: {
            "content-type": "application/json"
          },
          status: 200
        });
      }

      if (url.endsWith("/v1/chat/completions")) {
        observedCalls.push({
          body: init?.body ? JSON.parse(String(init.body)) : null,
          url
        });

        return new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: "I will inspect the workspace first.",
                  tool_calls: [
                    {
                      function: {
                        arguments: '{"path":"AGENTS.md"}',
                        name: "read_file"
                      },
                      id: "tool.call.1"
                    }
                  ]
                }
              }
            ],
            id: "chatcmpl-123",
            model: "google/gemma-4-26b-a4b-qat",
            usage: {
              completion_tokens: 7,
              prompt_tokens: 13,
              total_tokens: 20
            }
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const config = createDefaultAppConfig({ userStateDirectory: path.join(root, "user") });
    config.memory.stateRoot = stateRoot;
    config.providers.lmStudio.baseUrl = "http://localhost:1234/v1";
    config.providers.ollama.enabled = false;
    config.runtime.defaultProvider = "lm_studio";
    config.runtime.defaultModel = "google/gemma-4-26b-a4b-qat";

    const runtime = new LanguageModelRuntime({ config, fetchImpl });
    const response = await runtime.generate({
      availableTools: [buildToolDefinition()],
      id: "lm-runtime.request.1",
      instructions: "Use tools when needed and explain the next action.",
      messages: [buildUserMessage()],
      metadata: {},
      responseFormat: {
        kind: "json_schema",
        name: "agent_turn",
        schema: {
          properties: {
            status: { type: "string" }
          },
          type: "object"
        }
      },
      settings: {
        stopSequences: [],
        toolChoice: "auto"
      },
      turnId: "turn.runtime.1"
    });

    expect(response.modelId).toBe("google/gemma-4-26b-a4b-qat");
    expect(response.provider).toBe("lm_studio");
    expect(response.stopReason).toBe("tool_calls");
    expect(response.toolCalls[0]?.toolName).toBe("read_file");
    expect(response.message?.parts[0]).toEqual({
      kind: "text",
      text: "I will inspect the workspace first."
    });

    expect(await runtime.health()).toMatchObject({
      providerId: "lm_studio",
      status: "healthy"
    });
    expect(await runtime.listModels()).toEqual([
      {
        displayName: "google/gemma-4-26b-a4b-qat",
        modelId: "google/gemma-4-26b-a4b-qat",
        provider: "lm_studio",
        toolCalling: true
      }
    ]);

    expect(observedCalls).toHaveLength(1);
    expect(observedCalls[0]?.body).toMatchObject({
      model: "google/gemma-4-26b-a4b-qat",
      response_format: {
        json_schema: {
          name: "agent_turn"
        },
        type: "json_schema"
      },
      tools: [
        {
          function: {
            name: "read_file"
          },
          type: "function"
        }
      ]
    });

    const queuedJobs = await runtime.listJobs();
    expect(queuedJobs).toHaveLength(1);
    expect(queuedJobs[0]?.status).toBe("completed");
    expect(await fs.readFile(path.join(stateRoot, "logs", "lm", "requests", "lm-runtime.request.1.json"), "utf8")).toContain(
      '"id": "lm-runtime.request.1"'
    );
    expect(
      await fs.readFile(path.join(stateRoot, "logs", "lm", "responses", "lm-runtime.request.1.json"), "utf8")
    ).toContain('"toolName": "read_file"');
  });

  test("calls Ollama chat and model-list endpoints", async () => {
    const observedCalls: Array<{ body: unknown; url: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ model: "qwen2.5:14b", name: "Qwen 2.5 14B" }] }), {
          headers: {
            "content-type": "application/json"
          },
          status: 200
        });
      }

      if (url.endsWith("/api/chat")) {
        observedCalls.push({
          body: init?.body ? JSON.parse(String(init.body)) : null,
          url
        });
        return new Response(
          JSON.stringify({
            done: true,
            done_reason: "stop",
            eval_count: 5,
            message: {
              content: "I inspected the files you mentioned."
            },
            model: "qwen2.5:14b",
            prompt_eval_count: 11
          }),
          {
            headers: {
              "content-type": "application/json"
            },
            status: 200
          }
        );
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    const adapter = new OllamaLanguageModelAdapter({
      baseUrl: "http://localhost:11434",
      fetchImpl,
      timeoutMs: 5_000
    });

    const response = await adapter.generate(
      buildRequest({
        modelId: "qwen2.5:14b",
        provider: "ollama",
        responseFormat: {
          kind: "json_object"
        }
      })
    );

    expect(response.provider).toBe("ollama");
    expect(response.message?.parts[0]).toEqual({
      kind: "text",
      text: "I inspected the files you mentioned."
    });
    expect(response.usage).toEqual({
      inputTokens: 11,
      outputTokens: 5,
      totalTokens: 16
    });
    expect(await adapter.listModels()).toEqual([
      {
        displayName: "Qwen 2.5 14B",
        modelId: "qwen2.5:14b",
        provider: "ollama",
        toolCalling: true
      }
    ]);

    expect(observedCalls[0]?.body).toMatchObject({
      format: "json",
      messages: expect.arrayContaining([{ content: "Use tools when needed and be concise.", role: "system" }]),
      model: "qwen2.5:14b"
    });
  });

  test("supports registered custom language-model providers at construction time and after runtime creation", async () => {
    const root = await createTempRoot();
    const config = createDefaultAppConfig({
      userStateDirectory: path.join(root, "user")
    });
    config.memory.stateRoot = path.join(root, ".aia");
    config.providers.lmStudio.enabled = false;
    config.providers.ollama.enabled = false;
    config.runtime.defaultProvider = "custom_provider";
    config.runtime.defaultModel = "config-default-model";

    const observedModelIds: string[] = [];
    const adapter: LanguageModelAdapter = {
      async generate(request) {
        observedModelIds.push(request.modelId);
        return {
          id: `response.${request.id}`,
          message: {
            createdAt: "2026-03-31T12:00:00.000Z",
            id: `message.${request.id}`,
            metadata: {},
            parts: [{ kind: "text", text: "custom provider response" }],
            role: "assistant",
            sessionId: request.sessionId ?? "session.custom-provider.1",
            source: "assistant",
            tags: [],
            turnId: request.turnId,
            visibility: "default"
          },
          metadata: {},
          modelId: request.modelId,
          provider: request.provider,
          stopReason: "end_turn",
          toolCalls: [],
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            totalTokens: 2
          }
        };
      },
      async health(): Promise<ProviderHealth> {
        return {
          checkedAt: "2026-03-31T12:00:00.000Z",
          details: {},
          providerId: "custom_provider",
          status: "healthy"
        };
      },
      async listModels() {
        return [
          {
            displayName: "Custom Model",
            modelId: "custom-model",
            provider: "custom_provider",
            toolCalling: true
          }
        ];
      },
      provider: "custom_provider",
      providerId: "custom_provider"
    };

    const runtime = new LanguageModelRuntime({
      adapters: [
        {
          adapter,
          defaultModel: "adapter-default-model"
        }
      ],
      config
    });

    const immediate = await runtime.generate({
      availableTools: [],
      id: "lm-runtime.custom.1",
      instructions: "Respond concisely.",
      messages: [buildUserMessage()],
      metadata: {},
      responseFormat: {
        kind: "text"
      },
      settings: {
        stopSequences: [],
        toolChoice: "auto"
      },
      turnId: "turn.custom.1"
    });

    expect(immediate.provider).toBe("custom_provider");
    expect(immediate.modelId).toBe("adapter-default-model");
    expect(observedModelIds).toContain("adapter-default-model");
    expect(await runtime.listModels()).toEqual([
      {
        displayName: "Custom Model",
        modelId: "custom-model",
        provider: "custom_provider",
        toolCalling: true
      }
    ]);

    const lateRuntime = new LanguageModelRuntime({
      config
    });
    lateRuntime.registerAdapter({
      adapter,
      defaultModel: "late-registered-model"
    });

    const late = await lateRuntime.generate({
      availableTools: [],
      id: "lm-runtime.custom.2",
      instructions: "Respond concisely.",
      messages: [buildUserMessage()],
      metadata: {},
      responseFormat: {
        kind: "text"
      },
      settings: {
        stopSequences: [],
        toolChoice: "auto"
      },
      turnId: "turn.custom.2"
    });

    expect(late.provider).toBe("custom_provider");
    expect(late.modelId).toBe("late-registered-model");
    expect(observedModelIds).toContain("late-registered-model");
  });
});

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-lm-runtime-"));
  tempRoots.push(root);
  return root;
}

function buildRequest(overrides: Partial<LanguageModelRequest> = {}): LanguageModelRequest {
  return {
    availableTools: [buildToolDefinition()],
    id: "ollama.request.1",
    instructions: "Use tools when needed and be concise.",
    messages: [buildUserMessage()],
    metadata: {},
    modelId: "google/gemma-4-26b-a4b-qat",
    provider: "lm_studio",
    responseFormat: {
      kind: "text"
    },
    sessionId: "session.runtime.1",
    settings: {
      stopSequences: [],
      toolChoice: "auto"
    },
    turnId: "turn.runtime.1",
    ...overrides
  };
}

function buildToolDefinition(): ToolDefinition {
  return {
    aliases: [],
    annotations: {
      meta: {},
      readOnlyHint: true,
      title: "Read File"
    },
    approvalMode: "ask",
    descriptor: {
      approvalNotes: "Approval may be required by runtime policy.",
      examples: ["Use before editing AGENTS.md."],
      purpose: "Read a file from the workspace.",
      sideEffectSummary: "Reads local files without modifying them.",
      whenNotToUse: ["Do not use to write or edit files."],
      whenToUse: ["Use when you need the exact contents of a file before acting."]
    },
    description: "Read a file from the workspace.",
    displayName: "Read File",
    execution: {
      inputMode: "json",
      resumable: false,
      taskSupport: "forbidden"
    },
    idempotent: true,
    inputSchema: {
      properties: {
        path: {
          type: "string"
        }
      },
      required: ["path"],
      type: "object"
    },
    invocationName: "read_file",
    kind: "built_in",
    metadata: {},
    name: "read_file",
    outputKind: "text",
    retryable: true,
    searchTags: ["files"],
    sideEffects: ["workspace_read"],
    source: {
      displayName: "Built-in Tools",
      kind: "built_in"
    },
    streamingMode: "none",
    toolId: "tool.builtin.read_file",
    usageGuidance: "Use when you need the exact contents of a file before editing it.",
    version: "1.0.0"
  };
}

function buildUserMessage() {
  return {
    createdAt: "2026-03-27T12:00:00.000Z",
    id: "message.runtime.1",
    metadata: {},
    parts: [{ kind: "text" as const, text: "Inspect AGENTS.md first." }],
    role: "user" as const,
    sessionId: "session.runtime.1",
    source: "user" as const,
    tags: [],
    turnId: "turn.runtime.1",
    visibility: "default" as const
  };
}
