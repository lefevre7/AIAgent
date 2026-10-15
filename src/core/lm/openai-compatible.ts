import type {
  JsonValue,
  LanguageModelAdapter,
  LanguageModelCallOptions,
  LanguageModelDescriptor,
  LanguageModelProvider,
  LanguageModelRequest,
  LanguageModelResponse,
  LanguageModelStreamEvent,
  ProviderHealth,
  StructuredError
} from "@/core/contracts";
import { RESERVED_REQUEST_EXTRAS_KEYS } from "@/core/config/schema";
import { buildStreamedProviderError, fetchJson, fetchStream, providerMaxAttempts } from "@/core/lm/http";
import { classifyContextOverflow, classifyThrownContextOverflow } from "@/core/lm/overflow";
import {
  buildAssistantMessageText,
  buildStreamAbortError,
  compactRecord,
  createStreamGuard,
  finishLanguageModelResponse,
  healthFromModelListing,
  joinUrl,
  readBodyLines,
  serializeOpenAICompatibleMessages,
  serializeOpenAICompatibleResponseFormat,
  serializeToolDefinitions
} from "@/core/lm/shared";

export type OpenAICompatibleAdapterOptions = {
  baseUrl: string;
  /** How to give the model a larger window, put on a context-overflow error (see classifyContextOverflow). */
  contextWindowRemedy?: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  /**
   * Retries after the first attempt of a model request (408/429/5xx/network,
   * with backoff). A server still loading its model is waited on within the
   * request's own budget on top of these. Default 3.
   */
  maxRetries?: number;
  providerId?: string;
  /**
   * Extra top-level fields merged into every chat request, for server
   * parameters the runtime has no setting for (llama.cpp's
   * `chat_template_kwargs`, `reasoning_format`, `samplers`, …). They may
   * override the sampling fields the runtime sends, but never the protocol
   * fields it owns: model, messages, tools, tool_choice, stream,
   * stream_options.
   */
  requestExtras?: Record<string, JsonValue>;
  /** The provider's config section (`providers.lmStudio`), named in timeout errors. */
  settingsPath?: string;
  streamFirstTokenTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  timeoutMs: number;
};

const STREAM_REPETITION_THRESHOLD = 6;

type ChatCompletionResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | Array<{ text?: string; type?: string }>;
      tool_calls?: unknown[];
    };
  }>;
  id?: string;
  model?: string;
  usage?: {
    completion_tokens?: number;
    prompt_tokens?: number;
    total_tokens?: number;
  };
};

type ChatCompletionChunk = {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        function?: { arguments?: string; name?: string };
        id?: string;
        index?: number;
      }>;
    };
    finish_reason?: string | null;
  }>;
  error?: unknown;
  id?: string;
  model?: string;
  usage?: {
    completion_tokens?: number;
    prompt_tokens?: number;
    total_tokens?: number;
  };
};

type ModelsResponse = {
  data?: Array<{
    id: string;
  }>;
};

/**
 * One implementation of the OpenAI Chat Completions protocol (payload, SSE
 * streaming, tool-call accumulation, response normalization) shared by every
 * server that speaks it. A provider subclass supplies only what genuinely
 * differs: how it reports health, lists models, and knows its loaded context
 * window, plus any request defaults of its own.
 */
export abstract class OpenAICompatibleChatAdapter implements LanguageModelAdapter {
  abstract readonly provider: LanguageModelProvider;
  readonly providerId: string;
  /** How the server is named in messages the operator reads. */
  protected abstract readonly displayName: string;

  constructor(
    protected readonly options: OpenAICompatibleAdapterOptions,
    defaultProviderId: string
  ) {
    this.providerId = options.providerId ?? defaultProviderId;
  }

  async generate(
    request: LanguageModelRequest,
    options: LanguageModelCallOptions = {}
  ): Promise<LanguageModelResponse> {
    const response = await fetchJson<ChatCompletionResponse>({
      body: await this.buildPayload(request, false),
      ...(options.signal ? { cancelSignal: options.signal } : {}),
      fetchImpl: this.options.fetchImpl,
      headers: this.options.headers,
      maxAttempts: providerMaxAttempts(this.options.maxRetries),
      retryUnavailableForMs: this.options.timeoutMs,
      timeoutMs: this.options.timeoutMs,
      url: this.buildUrl("chat/completions")
    }).catch((error: unknown) => {
      throw classifyThrownContextOverflow(error, this.options.contextWindowRemedy);
    });

    return this.buildResponse(request, response.data);
  }

  async health(): Promise<ProviderHealth> {
    return healthFromModelListing(this.providerId, () => this.listModels());
  }

  async listModels(): Promise<LanguageModelDescriptor[]> {
    const response = await fetchJson<ModelsResponse>({
      fetchImpl: this.options.fetchImpl,
      headers: this.options.headers,
      maxAttempts: 2,
      timeoutMs: this.options.timeoutMs,
      url: this.buildUrl("models")
    });

    return (response.data?.data ?? []).map((model) => ({
      displayName: model.id,
      modelId: model.id,
      provider: this.provider,
      toolCalling: true
    }));
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
        // Retrying is safe only before the stream starts: nothing has been
        // generated or shown yet. A server loading its model is waited on for as
        // long as the first token may take anyway.
        maxAttempts: providerMaxAttempts(this.options.maxRetries),
        retryUnavailableForMs: this.options.streamFirstTokenTimeoutMs ?? this.options.timeoutMs,
        signal: guard.signal,
        timeoutMs: this.options.timeoutMs,
        url: this.buildUrl("chat/completions")
      });
    } catch (error) {
      // The guard's first-token timer is armed already; a request that never
      // started (a refused connection, a 400 overflow) must not leave it
      // holding the process open for its whole budget.
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
          message: `${this.displayName} did not provide a readable stream body.`,
          retriable: false
        },
        kind: "response.error"
      };
      return;
    }

    let responseId = `lm-response.${request.id}`;
    let modelId = request.modelId;
    let stopReason = "end_turn";
    let content = "";
    let usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    };
    // Tool calls stream as deltas: the name (and id) arrive in the first
    // fragment for a given index, and `arguments` is concatenated across later
    // fragments (llama.cpp may already send an arguments fragment in the first
    // one, and a fragment can end mid-escape). Accumulate the raw strings by
    // index and parse only at the end, otherwise the argument JSON is split
    // into separate incomplete calls and lost.
    const toolCallAccumulator = new Map<number, { arguments: string; id?: string; name?: string }>();

    let finished = false;
    // The SSE event a data line belongs to: an `event: error` frame is a
    // failure whatever its data holds. Its data used to be read as an
    // ordinary chunk with no choices, and the failure as an empty answer.
    let eventName = "";
    try {
      for await (const line of readBodyLines(reader, guard)) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          eventName = "";
          continue;
        }
        if (trimmed.startsWith("event:")) {
          eventName = trimmed.slice(6).trim();
          continue;
        }
        if (!trimmed.startsWith("data:")) {
          continue;
        }

        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          continue;
        }

        const parsed = parseChunk(data);
        if (eventName === "error") {
          yield {
            error: this.classify(buildStreamedProviderError(parsed?.error ?? parsed ?? data, this.providerId)),
            kind: "response.error"
          };
          return;
        }
        if (!parsed) {
          // Not a JSON event (a keep-alive or a server's own notice).
          continue;
        }

        // A server that fails mid-generation says so in the stream and ends
        // it without [DONE]. Skipping this event (it has no `choices`) used
        // to turn a failed generation into an empty answer, and the model
        // was nudged for "not responding" instead of the operator being told.
        // `"error": null` is in every chunk some servers send: only a value is
        // a failure.
        if (parsed.error !== undefined && parsed.error !== null) {
          yield {
            error: this.classify(buildStreamedProviderError(parsed.error, this.providerId)),
            kind: "response.error"
          };
          return;
        }

        responseId = parsed.id ?? responseId;
        modelId = parsed.model ?? modelId;
        if (parsed.usage) {
          usage = {
            inputTokens: parsed.usage.prompt_tokens ?? usage.inputTokens,
            outputTokens: parsed.usage.completion_tokens ?? usage.outputTokens,
            totalTokens:
              parsed.usage.total_tokens ?? (parsed.usage.prompt_tokens ?? 0) + (parsed.usage.completion_tokens ?? 0)
          };
        }

        const choice = parsed.choices?.[0];
        if (!choice) {
          continue;
        }

        const reasoningDelta = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
        if (typeof reasoningDelta === "string" && reasoningDelta.length > 0) {
          guard.observe(reasoningDelta);
          yield {
            delta: reasoningDelta,
            kind: "response.reasoning"
          };
        }

        if (choice.delta?.content) {
          content += choice.delta.content;
          guard.observe(choice.delta.content);
          yield {
            delta: choice.delta.content,
            kind: "response.delta"
          };
        }

        if (choice.delta?.tool_calls) {
          for (const fragment of choice.delta.tool_calls) {
            const index = typeof fragment.index === "number" ? fragment.index : toolCallAccumulator.size;
            const existing = toolCallAccumulator.get(index) ?? {
              arguments: ""
            };
            if (typeof fragment.id === "string" && fragment.id.length > 0) {
              existing.id = fragment.id;
            }
            if (typeof fragment.function?.name === "string" && fragment.function.name.length > 0) {
              existing.name = fragment.function.name;
            }
            if (typeof fragment.function?.arguments === "string") {
              existing.arguments += fragment.function.arguments;
            }
            toolCallAccumulator.set(index, existing);
          }
        }

        if (choice.finish_reason) {
          stopReason = choice.finish_reason;
        }
      }
      finished = guard.abortReason() === null;
    } finally {
      guard.dispose();
      if (!finished) {
        // Stopped early (an error event, a consumer that stopped reading):
        // close the response, or the server keeps generating into it.
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

    const assembledToolCalls = Array.from(toolCallAccumulator.entries())
      .sort(([left], [right]) => left - right)
      .map(([, entry]) => ({
        function: { arguments: entry.arguments, name: entry.name },
        id: entry.id
      }));
    const completed = finishLanguageModelResponse({
      content,
      fallbackPrefix: `${responseId}.tool`,
      id: responseId,
      modelId,
      nativeToolCalls: assembledToolCalls,
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

  // What the server reported, as a context overflow when it is one.
  private classify(error: StructuredError): StructuredError {
    return classifyContextOverflow(error, this.options.contextWindowRemedy);
  }

  /** Request fields this server should always get, below everything else. */
  protected payloadDefaults(): Record<string, JsonValue> {
    return {};
  }

  /** The server's root, for native endpoints that sit beside the `/v1` API. */
  protected get origin(): string {
    return this.options.baseUrl.replace(/\/+$/u, "").replace(/\/v\d+$/u, "");
  }

  protected buildUrl(pathname: string): string {
    return joinUrl(this.options.baseUrl, pathname);
  }

  private buildResponse(request: LanguageModelRequest, response: ChatCompletionResponse): LanguageModelResponse {
    const choice = response.choices?.[0];
    return finishLanguageModelResponse({
      content: buildAssistantMessageText(choice?.message?.content),
      fallbackPrefix: `${request.id}.tool`,
      id: response.id ?? `lm-response.${request.id}`,
      modelId: response.model ?? request.modelId,
      nativeToolCalls: choice?.message?.tool_calls ?? [],
      provider: this.provider,
      request,
      stopReason: choice?.finish_reason ?? "end_turn",
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        totalTokens:
          response.usage?.total_tokens ??
          (response.usage?.prompt_tokens ?? 0) + (response.usage?.completion_tokens ?? 0)
      }
    });
  }

  private async buildPayload(request: LanguageModelRequest, stream: boolean): Promise<Record<string, unknown>> {
    const tools = request.settings.toolChoice === "none" ? [] : serializeToolDefinitions(request.availableTools);
    const sampling = compactRecord({
      frequency_penalty: request.settings.frequencyPenalty,
      max_tokens: request.settings.maxOutputTokens,
      min_p: request.settings.minP,
      presence_penalty: request.settings.presencePenalty,
      // llama.cpp's own name, honoured by LM Studio too.
      repeat_penalty: request.settings.repetitionPenalty,
      response_format: serializeOpenAICompatibleResponseFormat(request.responseFormat),
      stop: request.settings.stopSequences.length > 0 ? request.settings.stopSequences : undefined,
      temperature: request.settings.temperature,
      top_k: request.settings.topK,
      top_p: request.settings.topP
    });
    const protocol = compactRecord({
      messages: await serializeOpenAICompatibleMessages(request),
      model: request.modelId,
      stream,
      // Without this, servers omit token usage from streamed responses, so the
      // runtime would report 0 tokens / 0% context and never compact. The usage
      // arrives in a final chunk with empty choices.
      stream_options: stream ? { include_usage: true } : undefined,
      tool_choice: request.availableTools.length === 0 ? undefined : request.settings.toolChoice,
      tools: tools.length === 0 ? undefined : tools
    });
    // The protocol fields are aia's whatever requestExtras says (config
    // refuses them too): one left out above (no tools, so no `tools`) could
    // otherwise be put in by an extra.
    const extras = Object.fromEntries(
      Object.entries(this.options.requestExtras ?? {}).filter(([key]) => !RESERVED_REQUEST_EXTRAS_KEYS.includes(key))
    );
    return {
      ...this.payloadDefaults(),
      ...sampling,
      ...extras,
      ...protocol
    };
  }
}

function parseChunk(data: string): ChatCompletionChunk | null {
  try {
    const parsed = JSON.parse(data) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as ChatCompletionChunk)
      : null;
  } catch {
    return null;
  }
}
