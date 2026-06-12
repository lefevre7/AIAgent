import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_APPROVAL_SETTINGS,
  createDefaultAppConfig,
  type LanguageModelAdapter,
  type LanguageModelDescriptor,
  type LanguageModelProvider,
  type LanguageModelRequest,
  type LanguageModelResponse,
  type LoadedAIAgentConfig,
  type ProviderHealth
} from "@/core";
import { createAIAgentSdkFromConfig, type AIAgentProviderRegistrations, type AIAgentSdk } from "@/sdk";
import type { GatewaySessionSnapshot, JsonValue, LanguageModelStreamEvent, Message, ModelToolCallProposal } from "@/core/contracts";

type ScriptedLanguageModelTurn =
  | LanguageModelResponse
  | ((request: LanguageModelRequest, turnIndex: number) => LanguageModelResponse | Promise<LanguageModelResponse>);

export type ExampleContext = {
  loaded: LoadedAIAgentConfig;
  root: string;
  sdk: AIAgentSdk;
  userHomeDirectory: string;
  workspaceRoot: string;
};

export class ScriptedLanguageModelAdapter implements LanguageModelAdapter {
  readonly provider: LanguageModelProvider;
  readonly providerId: string;
  readonly requests: LanguageModelRequest[] = [];

  private turnIndex = 0;

  constructor(
    private readonly options: {
      modelId: string;
      providerId: LanguageModelProvider;
      responses: ScriptedLanguageModelTurn[];
    }
  ) {
    this.provider = options.providerId;
    this.providerId = options.providerId;
  }

  async generate(request: LanguageModelRequest): Promise<LanguageModelResponse> {
    this.requests.push(request);
    const response = this.options.responses[this.turnIndex];
    if (!response) {
      throw new Error(`Unexpected scripted model turn ${this.turnIndex + 1}.`);
    }

    this.turnIndex += 1;
    return typeof response === "function" ? await response(request, this.turnIndex - 1) : response;
  }

  async *stream(request: LanguageModelRequest): AsyncIterable<LanguageModelStreamEvent> {
    const response = await this.generate(request);
    const reasoning = typeof response.metadata.reasoning === "string" ? response.metadata.reasoning : "";
    if (reasoning.length > 0) {
      yield { delta: reasoning, kind: "response.reasoning" };
    }
    const text = response.message ? extractMessageText(response.message) : "";
    if (text.length > 0) {
      // Emit a couple of chunks so consumers exercise multi-delta streaming.
      const midpoint = Math.ceil(text.length / 2);
      yield { delta: text.slice(0, midpoint), kind: "response.delta" };
      if (midpoint < text.length) {
        yield { delta: text.slice(midpoint), kind: "response.delta" };
      }
    }
    yield { kind: "response.completed", response };
  }

  async health(): Promise<ProviderHealth> {
    return {
      checkedAt: new Date().toISOString(),
      details: {
        mode: "scripted"
      },
      providerId: this.providerId,
      status: "healthy"
    };
  }

  async listModels(): Promise<LanguageModelDescriptor[]> {
    return [
      {
        displayName: this.options.modelId,
        modelId: this.options.modelId,
        provider: this.provider,
        toolCalling: true
      }
    ];
  }
}

export async function withExampleSdk<T>(
  options: {
    configureConfig?: (config: LoadedAIAgentConfig["resolvedConfig"]) => void;
    fetchImpl?: typeof fetch;
    name: string;
    providers: AIAgentProviderRegistrations;
    run: (context: ExampleContext) => Promise<T>;
    setupWorkspace?: (context: Omit<ExampleContext, "sdk">) => Promise<void>;
  }
): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `aiagent-example-${sanitizeSegment(options.name)}-`));
  const userHomeDirectory = path.join(root, "home");
  const userStateDirectory = path.join(userHomeDirectory, ".aia");
  const workspaceRoot = path.join(root, "workspace");

  await Promise.all([
    fs.mkdir(path.join(workspaceRoot, ".git"), { recursive: true }),
    fs.mkdir(userStateDirectory, { recursive: true }),
    fs.mkdir(workspaceRoot, { recursive: true })
  ]);

  const loaded = createExampleLoadedConfig({
    root,
    userStateDirectory,
    workspaceRoot,
    defaultModel: options.providers.languageModelAdapters?.[0]?.defaultModel ?? "example-model",
    defaultProvider: options.providers.languageModelAdapters?.[0]?.adapter.providerId ?? "example_lm"
  });

  options.configureConfig?.(loaded.resolvedConfig);
  await options.setupWorkspace?.({
    loaded,
    root,
    userHomeDirectory,
    workspaceRoot
  });

  const sdk = await createAIAgentSdkFromConfig({
    cwd: workspaceRoot,
    fetchImpl: options.fetchImpl,
    loaded,
    providers: options.providers,
    userHomeDirectory
  });

  try {
    return await options.run({
      loaded,
      root,
      sdk,
      userHomeDirectory,
      workspaceRoot
    });
  } finally {
    await sdk.close().catch(() => undefined);
    if (process.env.AIA_KEEP_EXAMPLE_STATE !== "1") {
      await fs.rm(root, { force: true, recursive: true }).catch(() => undefined);
    }
  }
}

export function buildScriptedResponse(params: {
  reasoning?: string;
  request: LanguageModelRequest;
  text: string;
  toolCalls?: ModelToolCallProposal[];
}): LanguageModelResponse {
  const toolCalls = params.toolCalls ?? [];
  return {
    id: `response.example.${Math.random().toString(16).slice(2, 10)}`,
    message: {
      createdAt: new Date().toISOString(),
      id: `message.example.${Math.random().toString(16).slice(2, 10)}`,
      metadata: {},
      parts: [{ kind: "text", text: params.text }],
      role: "assistant",
      sessionId: params.request.sessionId ?? params.request.id,
      source: "assistant",
      tags: [],
      turnId: params.request.turnId,
      visibility: "default"
    },
    metadata: params.reasoning ? { reasoning: params.reasoning } : {},
    modelId: params.request.modelId,
    provider: params.request.provider,
    stopReason: toolCalls.length > 0 ? "tool_calls" : "end_turn",
    toolCalls,
    usage: {
      inputTokens: 64,
      outputTokens: 24,
      totalTokens: 88
    }
  };
}

export function buildToolCall(
  toolName: string,
  args: Record<string, JsonValue> = {},
  callId = `tool.${toolName}.${Math.random().toString(16).slice(2, 10)}`
): ModelToolCallProposal {
  return {
    arguments: args,
    callId,
    toolName
  };
}

export function extractAssistantTexts(snapshot: GatewaySessionSnapshot): string[] {
  return snapshot.snapshot.messages
    .filter((message) => message.role === "assistant")
    .map((message) => extractMessageText(message))
    .filter((text) => text.length > 0);
}

export function extractMessageText(message: Message): string {
  return message.parts
    .map((part) => {
      switch (part.kind) {
        case "markdown":
          return part.markdown;
        case "status":
          return part.summary;
        case "text":
          return part.text;
        default:
          return "";
      }
    })
    .filter((part) => part.trim().length > 0)
    .join("\n")
    .trim();
}

export function previewPromptSection(prompt: string, heading: string, lineCount = 8): string {
  const lines = prompt.split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === heading.trim());
  if (headingIndex === -1) {
    return prompt.split("\n").slice(0, lineCount).join("\n").trim();
  }

  return lines
    .slice(headingIndex, headingIndex + lineCount)
    .join("\n")
    .trim();
}

export function isDirectExecution(moduleUrl: string): boolean {
  return process.argv[1] !== undefined && moduleUrl === new URL(`file://${process.argv[1]}`).href;
}

function createExampleLoadedConfig(params: {
  defaultModel: string;
  defaultProvider: string;
  root: string;
  userStateDirectory: string;
  workspaceRoot: string;
}): LoadedAIAgentConfig {
  const config = createDefaultAppConfig({
    userStateDirectory: params.userStateDirectory
  });
  const stateRoot = path.join(params.root, ".aia");

  config.browser.artifactRoot = path.join(stateRoot, "browser");
  config.externalAgents.stateRoot = path.join(stateRoot, "external-agents");
  config.image.artifactRoot = path.join(stateRoot, "images");
  config.memory.chatSessionRoot = path.join(params.workspaceRoot, "chat-session-memory");
  config.memory.embeddingsEnabled = false;
  config.memory.hardFailOnStartup = false;
  config.memory.sqlitePath = path.join(stateRoot, "memory.sqlite");
  config.memory.stateRoot = path.join(stateRoot, "state");
  config.memory.userGlobalRoot = path.join(params.userStateDirectory, "memory");
  config.memory.workspaceRoot = path.join(params.workspaceRoot, "memory");
  config.providers.lmStudio.enabled = false;
  config.providers.ollama.enabled = false;
  config.providers.imageProviders.comfyui_local.enabled = false;
  config.runtime.defaultModel = params.defaultModel;
  config.runtime.defaultProvider = params.defaultProvider;

  return {
    approvals: DEFAULT_APPROVAL_SETTINGS,
    config,
    paths: {
      globalApprovalsPath: path.join(params.userStateDirectory, "approvals.global.jsonc"),
      globalConfigPath: path.join(params.userStateDirectory, "config.global.jsonc"),
      globalConfigPaths: [path.join(params.userStateDirectory, "config.global.jsonc")],
      userStateDirectory: params.userStateDirectory,
      workspaceApprovalsPath: path.join(params.workspaceRoot, "aia.approvals.jsonc"),
      workspaceConfigPath: path.join(params.workspaceRoot, "aia.config.jsonc"),
      workspaceRoot: params.workspaceRoot
    },
    resolvedConfig: config,
    sources: {
      approvals: {
        env: false,
        global: null,
        workspace: null
      },
      config: {
        env: false,
        global: [],
        workspace: null
      }
    }
  };
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-z0-9_-]+/giu, "-").replace(/-+/gu, "-").replace(/^-|-$/gu, "") || "example";
}
