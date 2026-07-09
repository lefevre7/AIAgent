import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  JsonValue,
  LanguageModelRequest,
  LanguageModelResponseFormat,
  LanguageModelStopReason,
  Message,
  MessagePart,
  ModelToolCallProposal,
  StructuredError,
  ToolDefinition
} from "@/core/contracts";

type OpenAIContentPart =
  | {
      text: string;
      type: "text";
    }
  | {
      image_url: {
        url: string;
      };
      type: "image_url";
    };

export type OpenAICompatibleToolCall = {
  function: {
    arguments: string;
    name: string;
  };
  id: string;
  type: "function";
};

export type OpenAICompatibleMessage =
  | {
      content: string | OpenAIContentPart[];
      role: "assistant" | "system" | "user";
      tool_calls?: OpenAICompatibleToolCall[];
    }
  | {
      content: string;
      role: "tool";
      tool_call_id: string;
    };

export type OpenAICompatibleToolDefinition = {
  function: {
    description: string;
    name: string;
    parameters: Record<string, unknown>;
  };
  type: "function";
};

export type OllamaToolCall = {
  function: {
    arguments: Record<string, JsonValue>;
    name: string;
  };
};

export type OllamaChatMessage = {
  content: string;
  images?: string[];
  role: "assistant" | "system" | "tool" | "user";
  tool_call_id?: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
};

export type RejectedToolCallProposal = {
  reason: string;
};

export type NormalizedToolCallProposals = {
  proposals: ModelToolCallProposal[];
  rejected: RejectedToolCallProposal[];
};

export function buildAssistantMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (
          isPlainObject(item) &&
          item.type === "text" &&
          typeof item.text === "string"
        ) {
          return item.text;
        }
        return "";
      })
      .filter((value) => value.trim().length > 0)
      .join("\n")
      .trim();
  }

  return "";
}

export async function serializeOpenAICompatibleMessages(
  request: LanguageModelRequest
): Promise<OpenAICompatibleMessage[]> {
  const messages: OpenAICompatibleMessage[] = [
    { content: request.instructions, role: "system" }
  ];
  const emittedToolCallIds = new Set<string>();
  // Tool-role messages cannot carry images in the OpenAI-compatible schema, so
  // image output is forwarded (when the model supports vision) as a follow-up
  // user message. Buffer it and flush only once the run of tool-result messages
  // ends, so the inserted user message never splits a parallel tool_calls/tool
  // sequence (which the schema rejects with a 400).
  const pendingToolImages: Array<Extract<MessagePart, { kind: "image" }>> = [];
  const flushPendingToolImages = async () => {
    if (pendingToolImages.length === 0) {
      return;
    }
    const parts: OpenAIContentPart[] = [
      { text: "Image output from the preceding tool result(s).", type: "text" }
    ];
    for (const imagePart of pendingToolImages) {
      parts.push({
        image_url: { url: await resolveImageDataUrl(imagePart.uri) },
        type: "image_url"
      });
    }
    messages.push({ content: parts, role: "user" });
    pendingToolImages.length = 0;
  };

  for (const message of request.messages) {
    const toolCallParts = extractToolCallParts(message);
    if (message.role === "assistant" && toolCallParts.length > 0) {
      await flushPendingToolImages();
      for (const part of toolCallParts) {
        emittedToolCallIds.add(part.callId);
      }
      messages.push({
        content: renderMessagePartsToText(
          stripToolCallParts(message.parts)
        ).trim(),
        role: "assistant",
        tool_calls: toolCallParts.map((part) => ({
          function: {
            arguments: JSON.stringify(part.arguments ?? {}),
            name: part.toolName
          },
          id: part.callId,
          type: "function"
        }))
      });
      continue;
    }

    const pairedToolCallId = resolvePairedToolCallId(
      message,
      emittedToolCallIds
    );
    if (pairedToolCallId) {
      messages.push({
        content:
          renderMessagePartsToText(message.parts).trim() ||
          "(empty tool result)",
        role: "tool",
        tool_call_id: pairedToolCallId
      });
      if (shouldForwardImages(request)) {
        pendingToolImages.push(...extractImageParts(message.parts));
      }
      continue;
    }

    await flushPendingToolImages();
    const role = resolveProviderRole(message);
    const text = renderMessagePartsToText(message.parts).trim();
    const imageUris = message.parts.filter(
      (part): part is Extract<MessagePart, { kind: "image" }> =>
        part.kind === "image"
    );

    if (imageUris.length === 0) {
      messages.push({
        content: prefixRoleIfNeeded(message, text),
        role
      });
      continue;
    }

    const parts: OpenAIContentPart[] = [];
    const messageText = prefixRoleIfNeeded(
      message,
      text || "Attached image input."
    );
    parts.push({
      text: messageText,
      type: "text"
    });

    for (const imagePart of imageUris) {
      parts.push({
        image_url: {
          url: await resolveImageDataUrl(imagePart.uri)
        },
        type: "image_url"
      });
    }

    messages.push({
      content: parts,
      role
    });
  }

  await flushPendingToolImages();
  return messages;
}

function extractImageParts(
  parts: MessagePart[]
): Array<Extract<MessagePart, { kind: "image" }>> {
  return parts.filter(
    (part): part is Extract<MessagePart, { kind: "image" }> =>
      part.kind === "image"
  );
}

// Forward image content to the model unless the operator explicitly marked the
// model as non-vision (runtime.modelSettings.supportsVision === false). Omitted
// means true (opt-out), matching the config default.
function shouldForwardImages(request: LanguageModelRequest): boolean {
  return request.settings.supportsVision !== false;
}

export async function serializeOllamaMessages(
  request: LanguageModelRequest
): Promise<OllamaChatMessage[]> {
  const messages: OllamaChatMessage[] = [
    { content: request.instructions, role: "system" }
  ];
  const emittedToolCallIds = new Map<string, string>();
  // Buffer tool-result image output and flush it as a follow-up user message
  // only once the run of tool-result messages ends, keeping the tool-call/tool
  // sequence intact (see the OpenAI serializer for the rationale).
  const pendingToolImages: Array<Extract<MessagePart, { kind: "image" }>> = [];
  const flushPendingToolImages = async () => {
    if (pendingToolImages.length === 0) {
      return;
    }
    messages.push({
      content: "Image output from the preceding tool result(s).",
      images: await Promise.all(
        pendingToolImages.map((imagePart) => resolveOllamaImage(imagePart.uri))
      ),
      role: "user"
    });
    pendingToolImages.length = 0;
  };

  for (const message of request.messages) {
    const toolCallParts = extractToolCallParts(message);
    if (message.role === "assistant" && toolCallParts.length > 0) {
      await flushPendingToolImages();
      for (const part of toolCallParts) {
        emittedToolCallIds.set(part.callId, part.toolName);
      }
      messages.push({
        content: renderMessagePartsToText(
          stripToolCallParts(message.parts)
        ).trim(),
        role: "assistant",
        tool_calls: toolCallParts.map((part) => ({
          function: {
            arguments: part.arguments ?? {},
            name: part.toolName
          }
        }))
      });
      continue;
    }

    const pairedToolCallId = resolvePairedToolCallId(
      message,
      new Set(emittedToolCallIds.keys())
    );
    if (pairedToolCallId) {
      messages.push({
        content:
          renderMessagePartsToText(message.parts).trim() ||
          "(empty tool result)",
        role: "tool",
        tool_call_id: pairedToolCallId,
        tool_name: emittedToolCallIds.get(pairedToolCallId)
      });
      if (shouldForwardImages(request)) {
        pendingToolImages.push(...extractImageParts(message.parts));
      }
      continue;
    }

    await flushPendingToolImages();
    const imageParts = message.parts.filter(
      (part): part is Extract<MessagePart, { kind: "image" }> =>
        part.kind === "image"
    );
    const text = prefixRoleIfNeeded(
      message,
      renderMessagePartsToText(message.parts).trim() || "Attached image input."
    );
    const images =
      imageParts.length === 0
        ? undefined
        : await Promise.all(
            imageParts.map((imagePart) => resolveOllamaImage(imagePart.uri))
          );

    messages.push({
      content: text,
      images,
      role: resolveProviderRole(message)
    });
  }

  await flushPendingToolImages();
  return messages;
}

function extractToolCallParts(
  message: Message
): Array<Extract<MessagePart, { kind: "tool_call" }>> {
  return message.parts.filter(
    (part): part is Extract<MessagePart, { kind: "tool_call" }> =>
      part.kind === "tool_call"
  );
}

function stripToolCallParts(parts: MessagePart[]): MessagePart[] {
  return parts.filter((part) => part.kind !== "tool_call");
}

function resolvePairedToolCallId(
  message: Message,
  emittedToolCallIds: Set<string>
): string | null {
  if (message.role !== "tool") {
    return null;
  }

  const toolCallId = message.metadata.toolCallId;
  if (typeof toolCallId !== "string" || toolCallId.length === 0) {
    return null;
  }

  return emittedToolCallIds.has(toolCallId) ? toolCallId : null;
}

export function serializeToolDefinitions(
  definitions: ToolDefinition[]
): OpenAICompatibleToolDefinition[] {
  return definitions.map((definition) => ({
    function: {
      description: renderToolDescription(definition),
      name: definition.invocationName,
      parameters: buildProviderToolParameters(definition)
    },
    type: "function"
  }));
}

export function serializeOpenAICompatibleResponseFormat(
  responseFormat: LanguageModelResponseFormat
): Record<string, unknown> | undefined {
  switch (responseFormat.kind) {
    case "text":
      return undefined;
    case "json_object":
      return {
        type: "json_object"
      };
    case "json_schema":
      return {
        json_schema: {
          name: responseFormat.name,
          schema: responseFormat.schema
        },
        type: "json_schema"
      };
  }
}

export function serializeOllamaResponseFormat(
  responseFormat: LanguageModelResponseFormat
): Record<string, unknown> | string | undefined {
  switch (responseFormat.kind) {
    case "text":
      return undefined;
    case "json_object":
      return "json";
    case "json_schema":
      return responseFormat.schema;
  }
}

export function normalizeToolCallProposals(
  toolCalls: unknown[],
  fallbackPrefix: string,
  definitions: ToolDefinition[] = []
): NormalizedToolCallProposals {
  const definitionsByInvocationName = new Map(
    definitions.map((definition) => [definition.invocationName, definition])
  );
  const proposals: ModelToolCallProposal[] = [];
  const rejected: RejectedToolCallProposal[] = [];

  toolCalls.forEach((toolCall, index) => {
    if (!isPlainObject(toolCall)) {
      rejected.push({
        reason: `Tool call ${index + 1} was not a JSON object (received ${describeRawToolCall(toolCall)}).`
      });
      return;
    }

    const functionData = isPlainObject(toolCall.function)
      ? toolCall.function
      : null;
    const toolName =
      typeof functionData?.name === "string" &&
      functionData.name.trim().length > 0
        ? functionData.name
        : null;
    if (!toolName || !functionData) {
      rejected.push({
        reason: `Tool call ${index + 1} was missing a function name (received ${describeRawToolCall(toolCall)}).`
      });
      return;
    }

    const rawArguments = functionData.arguments;
    const definition = definitionsByInvocationName.get(toolName);
    const normalizedInput = normalizeToolInput(rawArguments, definition);

    proposals.push(
      compactRecord({
        arguments: normalizedInput.arguments,
        callId:
          typeof toolCall.id === "string" && toolCall.id.trim().length > 0
            ? toolCall.id
            : `${fallbackPrefix}.${index + 1}`,
        inputText: normalizedInput.inputText,
        toolId: definition?.toolId,
        toolName
      }) as ModelToolCallProposal
    );
  });

  return {
    proposals,
    rejected
  };
}

export type StreamGuardAbortReason = "idle" | "repetition";

export type StreamGuard = {
  readonly signal: AbortSignal;
  abortReason(): StreamGuardAbortReason | null;
  dispose(): void;
  observe(text: string): void;
  touch(): void;
};

export type StreamGuardOptions = {
  // Budget for time-to-first-token (prompt evaluation). Large local models with
  // a big context can take much longer than the inter-token idle window before
  // emitting anything, so the first token gets its own (generous) deadline.
  firstTokenTimeoutMs?: number;
  idleTimeoutMs?: number;
  minRepeatLineLength?: number;
  repetitionThreshold?: number;
};

// Guards a streamed generation against two local-model failure modes:
//   * idle: the connection stops delivering tokens (reset on every chunk, so a
//     healthy long stream is never killed — unlike an absolute deadline). A
//     separate, larger budget covers time-to-first-token (prompt eval) so a slow
//     prompt evaluation is not mistaken for a stall.
//   * repetition: the model emits the same line many times in a row (a decode
//     loop). Both abort the shared AbortController so the fetch unwinds.
export function createStreamGuard(
  options: StreamGuardOptions = {}
): StreamGuard {
  const controller = new AbortController();
  const idleMs = options.idleTimeoutMs ?? 0;
  const firstTokenMs = options.firstTokenTimeoutMs ?? idleMs;
  const threshold = options.repetitionThreshold ?? 0;
  const minLineLength = options.minRepeatLineLength ?? 4;
  let reason: StreamGuardAbortReason | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let pending = "";
  let lastLine: string | null = null;
  let repeatCount = 0;

  const arm = (): void => {
    const ms = started ? idleMs : firstTokenMs;
    if (ms <= 0) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      reason ??= "idle";
      controller.abort();
    }, ms);
  };

  const considerLine = (line: string): void => {
    const normalized = line.trim();
    if (normalized.length < minLineLength) {
      return;
    }
    if (normalized === lastLine) {
      repeatCount += 1;
    } else {
      lastLine = normalized;
      repeatCount = 1;
    }
    if (threshold > 0 && repeatCount >= threshold) {
      reason ??= "repetition";
      controller.abort();
    }
  };

  arm();

  return {
    signal: controller.signal,
    abortReason: () => reason,
    dispose: () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
    observe: (text: string) => {
      // The first non-empty token flips the guard from the first-token budget to
      // the tighter inter-token idle window.
      if (text.length > 0) {
        started = true;
      }
      arm();
      if (threshold <= 0 || text.length === 0) {
        return;
      }
      pending += text;
      let newlineIndex = pending.indexOf("\n");
      while (newlineIndex >= 0) {
        considerLine(pending.slice(0, newlineIndex));
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf("\n");
      }
    },
    touch: arm
  };
}

export function buildStreamAbortError(
  providerId: string,
  reason: StreamGuardAbortReason
): StructuredError {
  return {
    code: `provider_stream_${reason}`,
    details: { provider: providerId, reason },
    message:
      reason === "idle"
        ? `The ${providerId} stream stalled: no new tokens arrived within the idle timeout.`
        : `The ${providerId} stream was aborted after repeated identical output (likely a model loop).`,
    retriable: false
  };
}

export function buildRejectedToolCallMetadata(
  rejected: RejectedToolCallProposal[]
): Record<string, JsonValue> {
  if (rejected.length === 0) {
    return {};
  }

  return {
    rejectedToolCalls: rejected.map((entry) => ({ reason: entry.reason }))
  };
}

export type ResolvedToolCallProposals = NormalizedToolCallProposals & {
  content: string;
  recoveredFromText: boolean;
};

// LM Studio / Ollama only populate the native `tool_calls` field when the
// server-side chat template recognizes the model's tool-call syntax. Reasoning
// and coder models (Qwen3-Coder XML, GPT-OSS Harmony, Hermes <tool_call> JSON,
// LM Studio's [TOOL_REQUEST] default) frequently emit the call as plain text in
// `content` instead — see lmstudio-ai/lmstudio-bug-tracker#825. Without a text
// fallback the runtime sees a tool-less turn and nudges forever. This recovers
// those calls and strips their markup from the content so history is not
// double-fed.
export function resolveToolCallProposals(params: {
  content: string;
  definitions?: ToolDefinition[];
  fallbackPrefix: string;
  nativeToolCalls: unknown[];
}): ResolvedToolCallProposals {
  const definitions = params.definitions ?? [];
  const native = normalizeToolCallProposals(
    params.nativeToolCalls,
    params.fallbackPrefix,
    definitions
  );
  if (native.proposals.length > 0 || params.content.trim().length === 0) {
    return {
      content: params.content,
      proposals: native.proposals,
      recoveredFromText: false,
      rejected: native.rejected
    };
  }

  const matches = parseTextToolCalls(params.content, definitions);
  if (matches.length === 0) {
    return {
      content: params.content,
      proposals: native.proposals,
      recoveredFromText: false,
      rejected: native.rejected
    };
  }

  const asNative = matches.map((match, index) => ({
    function: {
      arguments:
        typeof match.arguments === "string"
          ? match.arguments
          : JSON.stringify(match.arguments),
      name: match.name
    },
    id: `${params.fallbackPrefix}.text.${index + 1}`
  }));
  const recovered = normalizeToolCallProposals(
    asNative,
    `${params.fallbackPrefix}.text`,
    definitions
  );

  return {
    content: stripSpans(
      params.content,
      matches.map((match) => match.span)
    ),
    proposals: recovered.proposals,
    recoveredFromText: recovered.proposals.length > 0,
    rejected: [...native.rejected, ...recovered.rejected]
  };
}

type TextToolCallMatch = {
  arguments: Record<string, JsonValue> | string;
  name: string;
  span: [number, number];
};

// Scans assistant content for tool calls emitted as text in the common local
// model formats. Each detector records the matched character span so the caller
// can remove only the tool-call markup while preserving surrounding prose and
// reasoning. Detectors are intentionally conservative: a candidate is only
// accepted when a tool name can be resolved.
export function parseTextToolCalls(
  content: string,
  definitions: ToolDefinition[] = []
): TextToolCallMatch[] {
  const matches: TextToolCallMatch[] = [];
  const claimed: Array<[number, number]> = [];

  const claim = (start: number, end: number): boolean => {
    if (claimed.some(([from, to]) => start < to && end > from)) {
      return false;
    }
    claimed.push([start, end]);
    return true;
  };

  const push = (
    rawName: string,
    args: Record<string, JsonValue> | string,
    start: number,
    end: number
  ): void => {
    const name = resolveKnownToolName(rawName, definitions) ?? rawName.trim();
    if (name.length === 0 || !claim(start, end)) {
      return;
    }
    matches.push({ arguments: args, name, span: [start, end] });
  };

  // Qwen3-Coder: <function=NAME><parameter=key>value</parameter>...</function>
  const functionBlock = /<function\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\/function>/gu;
  for (
    let match = functionBlock.exec(content);
    match;
    match = functionBlock.exec(content)
  ) {
    const args: Record<string, JsonValue> = {};
    const parameter = /<parameter\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\/parameter>/gu;
    for (
      let param = parameter.exec(match[2]);
      param;
      param = parameter.exec(match[2])
    ) {
      args[param[1].trim()] = coerceParameterValue(param[2]);
    }
    push(match[1], args, match.index, match.index + match[0].length);
  }

  // Hermes / generic: <tool_call>{ "name": "...", "arguments": {...} }</tool_call>
  const toolCallTag = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gu;
  for (
    let match = toolCallTag.exec(content);
    match;
    match = toolCallTag.exec(content)
  ) {
    const parsed = parseJsonToolCall(match[1], definitions);
    if (parsed) {
      push(
        parsed.name,
        parsed.arguments,
        match.index,
        match.index + match[0].length
      );
    }
  }

  // GPT-OSS Harmony: <|channel|>commentary to=functions.NAME ... <|message|>{...}<|call|>
  const harmony =
    /<\|channel\|>commentary[\s\S]*?to=functions\.([\w.-]+)[\s\S]*?<\|message\|>([\s\S]*?)(?:<\|call\|>|<\|end\|>|<\|return\|>|$)/gu;
  for (
    let match = harmony.exec(content);
    match;
    match = harmony.exec(content)
  ) {
    push(
      match[1],
      parseArgumentsBody(match[2]),
      match.index,
      match.index + match[0].length
    );
  }

  // LM Studio default fallback: [TOOL_REQUEST]{ "name": "...", "arguments": {...} }[END_TOOL_REQUEST]
  const toolRequest = /\[TOOL_REQUEST\]\s*([\s\S]*?)\s*\[END_TOOL_REQUEST\]/gu;
  for (
    let match = toolRequest.exec(content);
    match;
    match = toolRequest.exec(content)
  ) {
    const parsed = parseJsonToolCall(match[1], definitions);
    if (parsed) {
      push(
        parsed.name,
        parsed.arguments,
        match.index,
        match.index + match[0].length
      );
    }
  }

  return matches.sort((left, right) => left.span[0] - right.span[0]);
}

function parseJsonToolCall(
  body: string,
  definitions: ToolDefinition[]
): { arguments: Record<string, JsonValue> | string; name: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim());
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) {
    return null;
  }

  const explicitName =
    typeof parsed.name === "string"
      ? parsed.name
      : typeof parsed.tool === "string"
        ? parsed.tool
        : null;
  if (explicitName) {
    const args = parsed.arguments ?? parsed.parameters ?? {};
    return {
      arguments: isPlainObject(args)
        ? sanitizeJsonRecord(args)
        : typeof args === "string"
          ? args
          : {},
      name: explicitName
    };
  }

  // Tolerate idiosyncratic shapes such as {"status":"ok","attempt_complete":{}}
  // where the tool name is itself a key whose value is the arguments object.
  for (const [key, value] of Object.entries(parsed)) {
    if (resolveKnownToolName(key, definitions)) {
      return {
        arguments: isPlainObject(value) ? sanitizeJsonRecord(value) : {},
        name: key
      };
    }
  }

  return null;
}

function parseArgumentsBody(body: string): Record<string, JsonValue> | string {
  const trimmed = body.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isPlainObject(parsed)) {
      return sanitizeJsonRecord(parsed);
    }
  } catch {
    // fall through to raw text
  }
  return trimmed;
}

function coerceParameterValue(raw: string): JsonValue {
  const trimmed = raw.trim();
  if (trimmed === "True") {
    return true;
  }
  if (trimmed === "False") {
    return false;
  }
  if (trimmed === "None") {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      parsed === null ||
      typeof parsed === "boolean" ||
      typeof parsed === "number" ||
      isPlainObject(parsed) ||
      Array.isArray(parsed)
    ) {
      return sanitizeJsonValue(parsed);
    }
  } catch {
    // not JSON; treat as a plain string
  }
  return trimmed;
}

function resolveKnownToolName(
  rawName: string,
  definitions: ToolDefinition[]
): string | null {
  const name = rawName.trim();
  if (name.length === 0) {
    return null;
  }
  for (const definition of definitions) {
    if (definition.invocationName === name || definition.name === name) {
      return definition.invocationName;
    }
  }
  const lower = name.toLowerCase();
  for (const definition of definitions) {
    if (
      definition.invocationName.toLowerCase() === lower ||
      definition.name.toLowerCase() === lower ||
      definition.aliases.some((alias) => alias.toLowerCase() === lower)
    ) {
      return definition.invocationName;
    }
  }
  return null;
}

function stripSpans(content: string, spans: Array<[number, number]>): string {
  const ordered = [...spans].sort((left, right) => right[0] - left[0]);
  let result = content;
  for (const [start, end] of ordered) {
    result = `${result.slice(0, start)}${result.slice(end)}`;
  }
  return result.replace(/\n{3,}/gu, "\n\n").trim();
}

function describeRawToolCall(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === "string") {
      return serialized.length > 200
        ? `${serialized.slice(0, 200)}…`
        : serialized;
    }
  } catch {
    // fall through to String()
  }
  return String(value).slice(0, 200);
}

export function mapStopReason(reason: unknown): LanguageModelStopReason {
  if (reason === "tool_calls") {
    return "tool_calls";
  }
  if (reason === "length") {
    return "length";
  }
  if (reason === "content_filter") {
    return "content_filter";
  }
  if (reason === "cancelled") {
    return "cancelled";
  }
  if (reason === "error") {
    return "error";
  }
  return "end_turn";
}

export function compactRecord<T extends Record<string, unknown>>(
  value: T
): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>;
}

function resolveProviderRole(
  message: Message
): "assistant" | "system" | "user" {
  if (
    message.role === "assistant" ||
    message.role === "system" ||
    message.role === "user"
  ) {
    return message.role;
  }
  return "user";
}

function prefixRoleIfNeeded(message: Message, text: string): string {
  if (
    message.role === "assistant" ||
    message.role === "system" ||
    message.role === "user"
  ) {
    return text;
  }

  return `[${message.role.toUpperCase()}]\n${text}`.trim();
}

function renderMessagePartsToText(parts: MessagePart[]): string {
  return parts
    .map((part) => renderMessagePart(part))
    .filter((part) => part.length > 0)
    .join("\n\n");
}

function renderMessagePart(part: MessagePart): string {
  switch (part.kind) {
    case "citation":
      return part.uri ? `${part.title} (${part.uri})` : part.title;
    case "file":
      return part.title ? `${part.title}: ${part.uri}` : part.uri;
    case "image":
      return part.alt ? `Image: ${part.alt}` : "";
    case "json":
      return JSON.stringify(part.value);
    case "markdown":
      return part.markdown;
    case "status":
      return `[status:${part.state}] ${part.summary}`;
    case "text":
      return part.text;
    case "tool_call":
      return `Tool call ${part.callId}: ${part.toolName}(${JSON.stringify(part.arguments)})`;
    default:
      return "";
  }
}

function normalizeToolInput(
  value: unknown,
  definition?: ToolDefinition
): {
  arguments: Record<string, JsonValue>;
  inputText?: string;
} {
  const normalized = normalizeToolArguments(value);
  const inputMode = definition?.execution.inputMode ?? "json";

  if (inputMode === "text") {
    return {
      arguments: {},
      inputText: normalized.inputText ?? extractStringValue(value)
    };
  }

  if (inputMode === "either") {
    return {
      arguments: normalized.arguments,
      inputText: normalized.inputText
    };
  }

  // Keep the raw text for json-mode tools too: when a model emits unparseable
  // JSON arguments, the original text is what makes the validation error
  // actionable on the model's retry turn.
  return {
    arguments: normalized.arguments,
    inputText: normalized.inputText
  };
}

function normalizeToolArguments(value: unknown): {
  arguments: Record<string, JsonValue>;
  inputText?: string;
} {
  if (isPlainObject(value)) {
    if (
      typeof value.input === "string" &&
      Object.keys(value).every((key) => key === "arguments" || key === "input")
    ) {
      return {
        arguments: isPlainObject(value.arguments)
          ? sanitizeJsonRecord(value.arguments)
          : {},
        inputText: value.input
      };
    }

    return {
      arguments: sanitizeJsonRecord(value)
    };
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isPlainObject(parsed)) {
        return normalizeToolArguments(parsed);
      }

      return {
        arguments: {},
        inputText: String(parsed)
      };
    } catch {
      return {
        arguments: {},
        inputText: value
      };
    }
  }

  return {
    arguments: {}
  };
}

function buildProviderToolParameters(
  definition: ToolDefinition
): Record<string, unknown> {
  if (definition.execution.inputMode === "text") {
    return {
      additionalProperties: false,
      properties: {
        input: {
          description: "Free-form text input for this tool.",
          type: "string"
        }
      },
      required: ["input"],
      type: "object"
    };
  }

  if (definition.execution.inputMode === "either") {
    return {
      additionalProperties: false,
      properties: {
        arguments: ensureObjectSchema(definition.inputSchema),
        input: {
          description: "Optional free-form text input for this tool.",
          type: "string"
        }
      },
      type: "object"
    };
  }

  return ensureObjectSchema(definition.inputSchema);
}

function ensureObjectSchema(
  schema: Record<string, unknown>
): Record<string, unknown> {
  if (schema.type === "object") {
    return {
      ...schema,
      additionalProperties: false
    };
  }

  return {
    additionalProperties: false,
    properties: {
      arguments: schema
    },
    required: ["arguments"],
    type: "object"
  };
}

function renderToolDescription(definition: ToolDefinition): string {
  const lines = [
    definition.description,
    `Purpose: ${definition.descriptor.purpose}`,
    `When to use: ${definition.descriptor.whenToUse.join(" | ")}`,
    definition.descriptor.whenNotToUse.length > 0
      ? `When not to use: ${definition.descriptor.whenNotToUse.join(" | ")}`
      : undefined,
    definition.descriptor.sideEffectSummary
      ? `Side effects: ${definition.descriptor.sideEffectSummary}`
      : undefined,
    definition.descriptor.approvalNotes
      ? `Approval: ${definition.descriptor.approvalNotes}`
      : undefined,
    definition.descriptor.examples.length > 0
      ? `Examples: ${definition.descriptor.examples.join(" | ")}`
      : undefined,
    `Usage guidance: ${definition.usageGuidance}`
  ];

  return lines
    .filter(
      (line): line is string =>
        typeof line === "string" && line.trim().length > 0
    )
    .join("\n");
}

function extractStringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  return undefined;
}

function sanitizeJsonRecord(
  value: Record<string, unknown>
): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, sanitizeJsonValue(entry)])
  ) as Record<string, JsonValue>;
}

function sanitizeJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJsonValue(entry));
  }

  if (isPlainObject(value)) {
    return sanitizeJsonRecord(value);
  }

  return String(value);
}

async function resolveImageDataUrl(uri: string): Promise<string> {
  if (uri.startsWith("data:")) {
    return uri;
  }

  const filePath = toLocalFilePath(uri);
  if (!filePath) {
    throw new Error(`Unsupported image URI: ${uri}`);
  }

  const buffer = await fs.readFile(filePath);
  return `data:${inferMimeType(filePath)};base64,${buffer.toString("base64")}`;
}

async function resolveOllamaImage(uri: string): Promise<string> {
  const dataUrl = await resolveImageDataUrl(uri);
  const match = /^data:[^;]+;base64,(.+)$/u.exec(dataUrl);
  if (!match) {
    throw new Error(`Unsupported image data format for Ollama: ${uri}`);
  }
  return match[1];
}

function toLocalFilePath(uri: string): string | null {
  if (uri.startsWith("file://")) {
    return fileURLToPath(uri);
  }

  if (path.isAbsolute(uri)) {
    return uri;
  }

  return null;
}

function inferMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".jpeg":
    case ".jpg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
