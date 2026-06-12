import type {
  LanguageModelAdapter,
  LanguageModelDescriptor,
  LanguageModelRequest,
  LanguageModelResponse,
  LanguageModelStreamEvent,
  ProviderHealth
} from "@/core/contracts";
import { languageModelResponseSchema } from "@/core/contracts";
import { fetchJson, fetchStream, normalizeUnknownProviderError } from "@/core/lm/http";
import {
  buildRejectedToolCallMetadata,
  compactRecord,
  mapStopReason,
  normalizeToolCallProposals,
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
  timeoutMs: number;
};

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

  async generate(request: LanguageModelRequest): Promise<LanguageModelResponse> {
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

  async *stream(request: LanguageModelRequest): AsyncIterable<LanguageModelStreamEvent> {
    const response = await fetchStream({
      body: await this.buildPayload(request, true),
      fetchImpl: this.options.fetchImpl,
      headers: this.options.headers,
      maxAttempts: 2,
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

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

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
        if (typeof parsed.message?.thinking === "string" && parsed.message.thinking.length > 0) {
          yield {
            delta: parsed.message.thinking,
            kind: "response.reasoning"
          };
        }
        if (parsed.message?.content) {
          content += parsed.message.content;
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
    }

    const normalized = normalizeToolCallProposals(toolCalls, `${request.id}.tool`, request.availableTools);
    for (const toolCall of normalized.proposals) {
      yield {
        kind: "response.tool_call",
        toolCall
      };
    }

    yield {
      kind: "response.completed",
      response: this.buildParsedResponse({
        content,
        metadata: buildRejectedToolCallMetadata(normalized.rejected),
        modelId,
        request,
        stopReason,
        toolCalls: normalized.proposals,
        usage
      })
    };
  }

  private buildResponse(request: LanguageModelRequest, response: OllamaChatResponse): LanguageModelResponse {
    const normalized = normalizeToolCallProposals(response.message?.tool_calls ?? [], `${request.id}.tool`, request.availableTools);
    return this.buildParsedResponse({
      content: response.message?.content ?? "",
      metadata: buildRejectedToolCallMetadata(normalized.rejected),
      modelId: response.model ?? request.modelId,
      request,
      stopReason: response.done_reason ?? ((response.message?.tool_calls?.length ?? 0) > 0 ? "tool_calls" : "end_turn"),
      toolCalls: normalized.proposals,
      usage: {
        inputTokens: response.prompt_eval_count ?? 0,
        outputTokens: response.eval_count ?? 0,
        totalTokens: (response.prompt_eval_count ?? 0) + (response.eval_count ?? 0)
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

  private async buildPayload(request: LanguageModelRequest, stream: boolean): Promise<Record<string, unknown>> {
    const tools = request.settings.toolChoice === "none" ? [] : serializeToolDefinitions(request.availableTools);
    return compactRecord({
      format: serializeOllamaResponseFormat(request.responseFormat),
      keep_alive: this.options.keepAlive,
      messages: await serializeOllamaMessages(request),
      model: request.modelId,
      options: compactRecord({
        num_ctx: this.options.contextLength,
        num_predict: request.settings.maxOutputTokens,
        stop: request.settings.stopSequences.length > 0 ? request.settings.stopSequences : undefined,
        temperature: request.settings.temperature,
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
