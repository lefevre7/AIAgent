import type {
  LanguageModelAdapter,
  LanguageModelCallOptions,
  LanguageModelDescriptor,
  LanguageModelRequest,
  LanguageModelResponse,
  LanguageModelStreamEvent,
  ProviderHealth
} from "@/core/contracts";
import { buildStreamedProviderError, fetchJson, fetchStream, providerMaxAttempts } from "@/core/lm/http";
import { classifyContextOverflow, classifyThrownContextOverflow } from "@/core/lm/overflow";
import {
  buildStreamAbortError,
  compactRecord,
  createStreamGuard,
  finishLanguageModelResponse,
  healthFromModelListing,
  joinUrl,
  readBodyLines,
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
  /** How to give the model a larger window, put on a context-overflow error (see classifyContextOverflow). */
  contextWindowRemedy?: string;
  /** Retries after the first attempt of a model request. Default 3. */
  maxRetries?: number;
  providerId?: string;
  /** The provider's config section (`providers.ollama`), named in timeout errors. */
  settingsPath?: string;
  streamFirstTokenTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  timeoutMs: number;
};

const STREAM_REPETITION_THRESHOLD = 6;

type OllamaChatResponse = {
  created_at?: string;
  done?: boolean;
  // Mid-generation failures arrive as a record of their own: {"error": "…"}.
  error?: unknown;
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
    request: LanguageModelRequest,
    options: LanguageModelCallOptions = {}
  ): Promise<LanguageModelResponse> {
    const response = await fetchJson<OllamaChatResponse>({
      body: await this.buildPayload(request, false),
      ...(options.signal ? { cancelSignal: options.signal } : {}),
      fetchImpl: this.options.fetchImpl,
      headers: this.options.headers,
      maxAttempts: providerMaxAttempts(this.options.maxRetries),
      timeoutMs: this.options.timeoutMs,
      url: this.buildUrl("api/chat")
    }).catch((error: unknown) => {
      throw classifyThrownContextOverflow(error, this.options.contextWindowRemedy);
    });

    return this.buildResponse(request, response.data);
  }

  async health(): Promise<ProviderHealth> {
    return healthFromModelListing(this.providerId, () => this.listModels());
  }

  async listModels(): Promise<LanguageModelDescriptor[]> {
    const response = await fetchJson<OllamaTagsResponse>({
      fetchImpl: this.options.fetchImpl,
      headers: this.options.headers,
      maxAttempts: 2,
      timeoutMs: this.options.timeoutMs,
      url: this.buildUrl("api/tags")
    });

    // An empty body parses as null, and a proxy may answer with anything:
    // `models` was read off whatever came back, and threw.
    const models = Array.isArray(response.data?.models) ? response.data.models : [];
    return models
      .filter((model): model is NonNullable<typeof model> => typeof model === "object" && model !== null)
      .map((model) => ({
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
      const info = response.data?.model_info ?? {};
      for (const [key, value] of Object.entries(info)) {
        if (key.endsWith(".context_length") && typeof value === "number" && value > 0) {
          return value;
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  async *stream(
    request: LanguageModelRequest,
    options: LanguageModelCallOptions = {}
  ): AsyncIterable<LanguageModelStreamEvent> {
    const guard = createStreamGuard({
      firstTokenTimeoutMs: this.options.streamFirstTokenTimeoutMs,
      idleTimeoutMs: this.options.streamIdleTimeoutMs,
      repetitionThreshold: STREAM_REPETITION_THRESHOLD
    });
    let response: Response;
    try {
      response = await fetchStream({
        body: await this.buildPayload(request, true),
        fetchImpl: this.options.fetchImpl,
        headers: this.options.headers,
        ...(options.signal ? { cancelSignal: options.signal } : {}),
        // Safe only before the stream starts: nothing has been generated yet.
        maxAttempts: providerMaxAttempts(this.options.maxRetries),
        signal: guard.signal,
        timeoutMs: this.options.timeoutMs,
        url: this.buildUrl("api/chat")
      });
    } catch (error) {
      // As in the OpenAI-compatible adapter: the first-token timer is armed,
      // and a request that never started must not keep the process open.
      guard.dispose();
      throw classifyThrownContextOverflow(error, this.options.contextWindowRemedy);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      guard.dispose();
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

    let content = "";
    let modelId = request.modelId;
    let stopReason = "end_turn";
    let usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    };
    const toolCalls: unknown[] = [];

    let finished = false;
    try {
      for await (const line of readBodyLines(reader, guard)) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        let parsed: OllamaChatResponse;
        try {
          parsed = JSON.parse(trimmed) as OllamaChatResponse;
        } catch {
          // Not a record (a proxy's notice): one such line used to throw out
          // of the whole stream.
          continue;
        }
        // Ollama ends a failed generation with {"error": "…"}. Read as a
        // record without a message, it became an empty answer.
        if (parsed.error !== undefined && parsed.error !== null) {
          yield {
            error: classifyContextOverflow(
              buildStreamedProviderError(parsed.error, this.providerId),
              this.options.contextWindowRemedy
            ),
            kind: "response.error"
          };
          return;
        }
        modelId = parsed.model ?? modelId;
        if (typeof parsed.message?.thinking === "string" && parsed.message.thinking.length > 0) {
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
          totalTokens: (parsed.prompt_eval_count ?? usage.inputTokens) + (parsed.eval_count ?? usage.outputTokens)
        };
      }
      finished = guard.abortReason() === null;
    } finally {
      guard.dispose();
      if (!finished) {
        // Stopped early: close the response, or the server keeps generating.
        await reader.cancel().catch(() => undefined);
      }
    }

    const abortReason = guard.abortReason();
    if (abortReason) {
      yield {
        error: buildStreamAbortError(this.providerId, abortReason, {
          firstTokenTimeoutMs: this.options.streamFirstTokenTimeoutMs,
          idleTimeoutMs: this.options.streamIdleTimeoutMs,
          settingsPath: this.options.settingsPath
        }),
        kind: "response.error"
      };
      return;
    }

    const completed = finishLanguageModelResponse({
      content,
      fallbackPrefix: `${request.id}.tool`,
      id: `ollama-response.${request.id}`,
      modelId,
      nativeToolCalls: toolCalls,
      provider: this.provider,
      request,
      stopReason,
      usage
    });
    for (const toolCall of completed.toolCalls) {
      yield {
        kind: "response.tool_call",
        toolCall
      };
    }

    yield {
      kind: "response.completed",
      response: completed
    };
  }

  private buildResponse(request: LanguageModelRequest, response: OllamaChatResponse): LanguageModelResponse {
    return finishLanguageModelResponse({
      content: response.message?.content ?? "",
      fallbackPrefix: `${request.id}.tool`,
      id: `ollama-response.${request.id}`,
      modelId: response.model ?? request.modelId,
      nativeToolCalls: response.message?.tool_calls ?? [],
      provider: this.provider,
      request,
      stopReason: response.done_reason ?? "end_turn",
      usage: {
        inputTokens: response.prompt_eval_count ?? 0,
        outputTokens: response.eval_count ?? 0,
        totalTokens: (response.prompt_eval_count ?? 0) + (response.eval_count ?? 0)
      }
    });
  }

  private async buildPayload(request: LanguageModelRequest, stream: boolean): Promise<Record<string, unknown>> {
    const tools = request.settings.toolChoice === "none" ? [] : serializeToolDefinitions(request.availableTools);
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
        stop: request.settings.stopSequences.length > 0 ? request.settings.stopSequences : undefined,
        temperature: request.settings.temperature,
        top_k: request.settings.topK,
        top_p: request.settings.topP
      }),
      stream,
      tools: tools.length === 0 ? undefined : tools
    });
  }

  private buildUrl(pathname: string): string {
    return joinUrl(this.options.baseUrl, pathname);
  }
}
