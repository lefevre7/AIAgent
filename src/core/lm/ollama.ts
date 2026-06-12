import type {
  LanguageModelAdapter,
  LanguageModelDescriptor,
  LanguageModelRequest,
  LanguageModelResponse,
  LanguageModelStreamEvent,
  ProviderHealth
} from "@/core/contracts";
import { languageModelResponseSchema } from "@/core/contracts";
import {
  fetchJson,
  fetchStream,
  normalizeUnknownProviderError
} from "@/core/lm/http";
import {
  buildRejectedToolCallMetadata,
  buildStreamAbortError,
  compactRecord,
  createStreamGuard,
  mapStopReason,
  resolveToolCallProposals,
  serializeOllamaMessages,
  serializeOllamaResponseFormat,
  serializeToolDefinitions
} from "@/core/lm/shared";

type OllamaAdapterOptions = {
  baseUrl: string;
  contextLength?: number;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  keepAlive?: string;
  providerId?: string;
  streamFirstTokenTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  timeoutMs: number;
};

const STREAM_REPETITION_THRESHOLD = 6;

type OllamaChatResponse = {
  created_at?: string;
  done?: boolean;
  done_reason?: string;
  eval_count?: number;
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: unknown[];
  };
  model?: string;
  prompt_eval_count?: number;
};

type OllamaTagsResponse = {
  models?: Array<{
    model?: string;
    name?: string;
  }>;
};

export class OllamaLanguageModelAdapter implements LanguageModelAdapter {
  readonly provider = "ollama" as const;
  readonly providerId: string;

  constructor(private readonly options: OllamaAdapterOptions) {
    this.providerId = options.providerId ?? "ollama";
  }

  async generate(
    request: LanguageModelRequest
  ): Promise<LanguageModelResponse> {
    const response = await fetchJson<OllamaChatResponse>({
      body: await this.buildPayload(request, false),
      fetchImpl: this.options.fetchImpl,
      headers: this.options.headers,
      maxAttempts: 2,
      timeoutMs: this.options.timeoutMs,
      url: this.buildUrl("api/chat")
    });

    return this.buildResponse(request, response.data);
  }

  async health(): Promise<ProviderHealth> {
    try {
      const models = await this.listModels();
      return {
        checkedAt: new Date().toISOString(),
        details: {
          modelCount: models.length
        },
        providerId: this.providerId,
        status: "healthy"
      };
    } catch (error) {
      return {
        checkedAt: new Date().toISOString(),
        details: {
          error: normalizeUnknownProviderError(error).message
        },
        providerId: this.providerId,
        status: "unavailable"
      };
    }
  }

  async listModels(): Promise<LanguageModelDescriptor[]> {
    const response = await fetchJson<OllamaTagsResponse>({
      fetchImpl: this.options.fetchImpl,
      headers: this.options.headers,
      maxAttempts: 2,
      timeoutMs: this.options.timeoutMs,
      url: this.buildUrl("api/tags")
    });

    return (response.data.models ?? []).map((model) => ({
      displayName: model.name ?? model.model ?? "unknown",
      modelId: model.model ?? model.name ?? "unknown",
      provider: this.provider,
      toolCalling: true
    }));
  }

  // Ollama reports context length in /api/show under model_info as an
  // architecture-prefixed key (e.g. "qwen3.context_length"). Best effort.
  async getModelContextWindow(modelId: string): Promise<number | undefined> {
    try {
      const response = await fetchJson<{
        model_info?: Record<string, unknown>;
      }>({
        body: { model: modelId },
        fetchImpl: this.options.fetchImpl,
        headers: this.options.headers,
        maxAttempts: 1,
        timeoutMs: Math.min(this.options.timeoutMs, 5_000),
        url: this.buildUrl("api/show")
      });
      const info = response.data.model_info ?? {};
      for (const [key, value] of Object.entries(info)) {
        if (
          key.endsWith(".context_length") &&
          typeof value === "number" &&
          value > 0
        ) {
          return value;
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  async *stream(
    request: LanguageModelRequest
  ): AsyncIterable<LanguageModelStreamEvent> {
    const guard = createStreamGuard({
      firstTokenTimeoutMs: this.options.streamFirstTokenTimeoutMs,
      idleTimeoutMs: this.options.streamIdleTimeoutMs,
      repetitionThreshold: STREAM_REPETITION_THRESHOLD
    });
    const response = await fetchStream({
      body: await this.buildPayload(request, true),
      fetchImpl: this.options.fetchImpl,
      headers: this.options.headers,
      maxAttempts: 1,
      signal: guard.signal,
      timeoutMs: this.options.timeoutMs,
      url: this.buildUrl("api/chat")
    });

    const reader = response.body?.getReader();
    if (!reader) {
      yield {
        error: {
          code: "provider_stream_unavailable",
          details: {
            provider: this.providerId
          },
          message: "Ollama did not provide a readable stream body.",
          retriable: false
        },
        kind: "response.error"
      };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let modelId = request.modelId;
    let stopReason = "end_turn";
    let usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    };
    const toolCalls: unknown[] = [];

    try {
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          if (guard.abortReason()) {
            break;
          }
          throw error;
        }
        const { done, value } = chunk;
        if (done) {
          break;
        }
        guard.touch();

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }

          const parsed = JSON.parse(trimmed) as OllamaChatResponse;
          modelId = parsed.model ?? modelId;
          if (
            typeof parsed.message?.thinking === "string" &&
            parsed.message.thinking.length > 0
          ) {
            guard.observe(parsed.message.thinking);
            yield {
              delta: parsed.message.thinking,
              kind: "response.reasoning"
            };
          }
          if (parsed.message?.content) {
            content += parsed.message.content;
            guard.observe(parsed.message.content);
            yield {
              delta: parsed.message.content,
              kind: "response.delta"
            };
          }
          if (parsed.message?.tool_calls) {
            toolCalls.push(...parsed.message.tool_calls);
          }
          if (parsed.done_reason) {
            stopReason = parsed.done_reason;
          }
          usage = {
            inputTokens: parsed.prompt_eval_count ?? usage.inputTokens,
            outputTokens: parsed.eval_count ?? usage.outputTokens,
            totalTokens:
              (parsed.prompt_eval_count ?? usage.inputTokens) +
              (parsed.eval_count ?? usage.outputTokens)
          };
        }
      }
    } finally {
      guard.dispose();
    }

    const abortReason = guard.abortReason();
    if (abortReason) {
      yield {
        error: buildStreamAbortError(this.providerId, abortReason),
        kind: "response.error"
      };
      return;
    }

    const resolved = resolveToolCallProposals({
      content,
      definitions: request.availableTools,
      fallbackPrefix: `${request.id}.tool`,
      nativeToolCalls: toolCalls
    });
    for (const toolCall of resolved.proposals) {
      yield {
        kind: "response.tool_call",
        toolCall
      };
    }

    yield {
      kind: "response.completed",
      response: this.buildParsedResponse({
        content: resolved.content,
        metadata: {
          ...buildRejectedToolCallMetadata(resolved.rejected),
          ...(resolved.recoveredFromText
            ? { toolCallsRecoveredFromText: true }
            : {})
        },
        modelId,
        request,
        stopReason: resolved.proposals.length > 0 ? "tool_calls" : stopReason,
        toolCalls: resolved.proposals,
        usage
      })
    };
  }

  private buildResponse(
    request: LanguageModelRequest,
    response: OllamaChatResponse
  ): LanguageModelResponse {
    const resolved = resolveToolCallProposals({
      content: response.message?.content ?? "",
      definitions: request.availableTools,
      fallbackPrefix: `${request.id}.tool`,
      nativeToolCalls: response.message?.tool_calls ?? []
    });
    return this.buildParsedResponse({
      content: resolved.content,
      metadata: {
        ...buildRejectedToolCallMetadata(resolved.rejected),
        ...(resolved.recoveredFromText
          ? { toolCallsRecoveredFromText: true }
          : {})
      },
      modelId: response.model ?? request.modelId,
      request,
      stopReason:
        resolved.proposals.length > 0
          ? "tool_calls"
          : (response.done_reason ?? "end_turn"),
      toolCalls: resolved.proposals,
      usage: {
        inputTokens: response.prompt_eval_count ?? 0,
        outputTokens: response.eval_count ?? 0,
        totalTokens:
          (response.prompt_eval_count ?? 0) + (response.eval_count ?? 0)
      }
    });
  }

  private buildParsedResponse(params: {
    content: string;
    metadata?: Record<string, unknown>;
    modelId: string;
    request: LanguageModelRequest;
    stopReason: unknown;
    toolCalls: LanguageModelResponse["toolCalls"];
    usage: LanguageModelResponse["usage"];
  }): LanguageModelResponse {
    const responseId = `ollama-response.${params.request.id}`;
    return languageModelResponseSchema.parse({
      id: responseId,
      message:
        params.content.trim().length === 0
          ? undefined
          : {
              createdAt: new Date().toISOString(),
              id: `message.${responseId}`,
              metadata: {},
              parts: [{ kind: "text", text: params.content }],
              role: "assistant",
              sessionId: params.request.sessionId ?? params.request.id,
              source: "assistant",
              tags: [],
              turnId: params.request.turnId,
              visibility: "default"
            },
      metadata: params.metadata ?? {},
      modelId: params.modelId,
      provider: this.provider,
      stopReason: mapStopReason(params.stopReason),
      toolCalls: params.toolCalls,
      usage: params.usage
    });
  }

  private async buildPayload(
    request: LanguageModelRequest,
    stream: boolean
  ): Promise<Record<string, unknown>> {
    const tools =
      request.settings.toolChoice === "none"
        ? []
        : serializeToolDefinitions(request.availableTools);
    return compactRecord({
      format: serializeOllamaResponseFormat(request.responseFormat),
      keep_alive: this.options.keepAlive,
      messages: await serializeOllamaMessages(request),
      model: request.modelId,
      options: compactRecord({
        frequency_penalty: request.settings.frequencyPenalty,
        min_p: request.settings.minP,
        num_ctx: this.options.contextLength,
        num_predict: request.settings.maxOutputTokens,
        presence_penalty: request.settings.presencePenalty,
        repeat_penalty: request.settings.repetitionPenalty,
        stop:
          request.settings.stopSequences.length > 0
            ? request.settings.stopSequences
            : undefined,
        temperature: request.settings.temperature,
        top_k: request.settings.topK,
        top_p: request.settings.topP
      }),
      stream,
      tools: tools.length === 0 ? undefined : tools
    });
  }

  private buildUrl(pathname: string): string {
    return `${this.options.baseUrl.replace(/\/+$/u, "")}/${pathname.replace(/^\/+/u, "")}`;
  }
}
