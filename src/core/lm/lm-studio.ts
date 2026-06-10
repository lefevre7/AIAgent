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
  buildAssistantMessageText,
  compactRecord,
  mapStopReason,
  normalizeToolCallProposals,
  serializeOpenAICompatibleMessages,
  serializeOpenAICompatibleResponseFormat,
  serializeToolDefinitions
} from "@/core/lm/shared";

type LMStudioAdapterOptions = {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  providerId?: string;
  timeoutMs: number;
};

type LMStudioChatResponse = {
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

type LMStudioModelsResponse = {
  data?: Array<{
    id: string;
  }>;
};

export class LMStudioLanguageModelAdapter implements LanguageModelAdapter {
  readonly provider = "lm_studio" as const;
  readonly providerId: string;

  constructor(private readonly options: LMStudioAdapterOptions) {
    this.providerId = options.providerId ?? "lm_studio";
  }

  async generate(request: LanguageModelRequest): Promise<LanguageModelResponse> {
    const payload = await this.buildPayload(request, false);
    const response = await fetchJson<LMStudioChatResponse>({
      body: payload,
      fetchImpl: this.options.fetchImpl,
      headers: this.options.headers,
      maxAttempts: 2,
      timeoutMs: this.options.timeoutMs,
      url: this.buildUrl("chat/completions")
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
    const response = await fetchJson<LMStudioModelsResponse>({
      fetchImpl: this.options.fetchImpl,
      headers: this.options.headers,
      maxAttempts: 2,
      timeoutMs: this.options.timeoutMs,
      url: this.buildUrl("models")
    });

    return (response.data.data ?? []).map((model) => ({
      displayName: model.id,
      modelId: model.id,
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
      url: this.buildUrl("chat/completions")
    });

    const reader = response.body?.getReader();
    if (!reader) {
      yield {
        error: {
          code: "provider_stream_unavailable",
          details: {
            provider: this.providerId
          },
          message: "LM Studio did not provide a readable stream body.",
          retriable: false
        },
        kind: "response.error"
      };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let responseId = `lm-response.${request.id}`;
    let modelId = request.modelId;
    let stopReason = "end_turn";
    let content = "";
    let usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    };
    const toolCallFragments: unknown[] = [];

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
        if (!trimmed.startsWith("data:")) {
          continue;
        }

        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          continue;
        }

        const parsed = JSON.parse(payload) as {
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: unknown[];
            };
            finish_reason?: string | null;
          }>;
          id?: string;
          model?: string;
          usage?: {
            completion_tokens?: number;
            prompt_tokens?: number;
            total_tokens?: number;
          };
        };

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

        if (choice.delta?.content) {
          content += choice.delta.content;
          yield {
            delta: choice.delta.content,
            kind: "response.delta"
          };
        }

        if (choice.delta?.tool_calls) {
          toolCallFragments.push(...choice.delta.tool_calls);
        }

        if (choice.finish_reason) {
          stopReason = choice.finish_reason;
        }
      }
    }

    const toolCalls = normalizeToolCallProposals(toolCallFragments, `${responseId}.tool`, request.availableTools);
    for (const toolCall of toolCalls) {
      yield {
        kind: "response.tool_call",
        toolCall
      };
    }

    yield {
      kind: "response.completed",
      response: this.buildParsedResponse({
        content,
        id: responseId,
        modelId,
        request,
        stopReason,
        toolCalls,
        usage
      })
    };
  }

  private buildResponse(request: LanguageModelRequest, response: LMStudioChatResponse): LanguageModelResponse {
    const choice = response.choices?.[0];
    const content = buildAssistantMessageText(choice?.message?.content);
    const toolCalls = normalizeToolCallProposals(choice?.message?.tool_calls ?? [], `${request.id}.tool`, request.availableTools);

    return this.buildParsedResponse({
      content,
      id: response.id ?? `lm-response.${request.id}`,
      modelId: response.model ?? request.modelId,
      request,
      stopReason: choice?.finish_reason ?? (toolCalls.length > 0 ? "tool_calls" : "end_turn"),
      toolCalls,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        totalTokens:
          response.usage?.total_tokens ??
          (response.usage?.prompt_tokens ?? 0) + (response.usage?.completion_tokens ?? 0)
      }
    });
  }

  private buildParsedResponse(params: {
    content: string;
    id: string;
    modelId: string;
    request: LanguageModelRequest;
    stopReason: unknown;
    toolCalls: LanguageModelResponse["toolCalls"];
    usage: LanguageModelResponse["usage"];
  }): LanguageModelResponse {
    return languageModelResponseSchema.parse({
      id: params.id,
      message:
        params.content.trim().length === 0
          ? undefined
          : {
              createdAt: new Date().toISOString(),
              id: `message.${params.id}`,
              metadata: {},
              parts: [{ kind: "text", text: params.content }],
              role: "assistant",
              sessionId: params.request.sessionId ?? params.request.id,
              source: "assistant",
              tags: [],
              turnId: params.request.turnId,
              visibility: "default"
            },
      metadata: {},
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
      max_tokens: request.settings.maxOutputTokens,
      messages: await serializeOpenAICompatibleMessages(request),
      model: request.modelId,
      response_format: serializeOpenAICompatibleResponseFormat(request.responseFormat),
      stop: request.settings.stopSequences.length > 0 ? request.settings.stopSequences : undefined,
      stream,
      temperature: request.settings.temperature,
      tool_choice: request.availableTools.length === 0 ? undefined : request.settings.toolChoice,
      tools: tools.length === 0 ? undefined : tools,
      top_p: request.settings.topP
    });
  }

  private buildUrl(pathname: string): string {
    return `${this.options.baseUrl.replace(/\/+$/u, "")}/${pathname.replace(/^\/+/u, "")}`;
  }
}
