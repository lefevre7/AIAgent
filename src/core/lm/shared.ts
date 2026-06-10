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

export type OpenAICompatibleMessage = {
  content: string | OpenAIContentPart[];
  role: "assistant" | "system" | "user";
};

export type OpenAICompatibleToolDefinition = {
  function: {
    description: string;
    name: string;
    parameters: Record<string, unknown>;
  };
  type: "function";
};

export type OllamaChatMessage = {
  content: string;
  images?: string[];
  role: "assistant" | "system" | "user";
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
        if (isPlainObject(item) && item.type === "text" && typeof item.text === "string") {
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
  const messages: OpenAICompatibleMessage[] = [{ content: request.instructions, role: "system" }];

  for (const message of request.messages) {
    const role = resolveProviderRole(message);
    const text = renderMessagePartsToText(message.parts).trim();
    const imageUris = message.parts.filter((part): part is Extract<MessagePart, { kind: "image" }> => part.kind === "image");

    if (imageUris.length === 0) {
      messages.push({
        content: prefixRoleIfNeeded(message, text),
        role
      });
      continue;
    }

    const parts: OpenAIContentPart[] = [];
    const messageText = prefixRoleIfNeeded(message, text || "Attached image input.");
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

  return messages;
}

export async function serializeOllamaMessages(request: LanguageModelRequest): Promise<OllamaChatMessage[]> {
  const messages: OllamaChatMessage[] = [{ content: request.instructions, role: "system" }];

  for (const message of request.messages) {
    const imageParts = message.parts.filter((part): part is Extract<MessagePart, { kind: "image" }> => part.kind === "image");
    const text = prefixRoleIfNeeded(message, renderMessagePartsToText(message.parts).trim() || "Attached image input.");
    const images =
      imageParts.length === 0 ? undefined : await Promise.all(imageParts.map((imagePart) => resolveOllamaImage(imagePart.uri)));

    messages.push({
      content: text,
      images,
      role: resolveProviderRole(message)
    });
  }

  return messages;
}

export function serializeToolDefinitions(definitions: ToolDefinition[]): OpenAICompatibleToolDefinition[] {
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

export function serializeOllamaResponseFormat(responseFormat: LanguageModelResponseFormat): Record<string, unknown> | string | undefined {
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
): ModelToolCallProposal[] {
  const definitionsByInvocationName = new Map(definitions.map((definition) => [definition.invocationName, definition]));

  return toolCalls.flatMap((toolCall, index) => {
    if (!isPlainObject(toolCall)) {
      return [];
    }

    const functionData = isPlainObject(toolCall.function) ? toolCall.function : null;
    const toolName = typeof functionData?.name === "string" ? functionData.name : null;
    if (!toolName || !functionData) {
      return [];
    }

    const rawArguments = functionData.arguments;
    const definition = definitionsByInvocationName.get(toolName);
    const normalizedInput = normalizeToolInput(rawArguments, definition);

    return [
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
    ];
  });
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

export function compactRecord<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function resolveProviderRole(message: Message): "assistant" | "system" | "user" {
  if (message.role === "assistant" || message.role === "system" || message.role === "user") {
    return message.role;
  }
  return "user";
}

function prefixRoleIfNeeded(message: Message, text: string): string {
  if (message.role === "assistant" || message.role === "system" || message.role === "user") {
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
      return JSON.stringify(part.value, null, 2);
    case "markdown":
      return part.markdown;
    case "status":
      return `[status:${part.state}] ${part.summary}`;
    case "text":
      return part.text;
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

  return {
    arguments: normalized.arguments
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

function buildProviderToolParameters(definition: ToolDefinition): Record<string, unknown> {
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

function ensureObjectSchema(schema: Record<string, unknown>): Record<string, unknown> {
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
    definition.descriptor.sideEffectSummary ? `Side effects: ${definition.descriptor.sideEffectSummary}` : undefined,
    definition.descriptor.approvalNotes ? `Approval: ${definition.descriptor.approvalNotes}` : undefined,
    definition.descriptor.examples.length > 0 ? `Examples: ${definition.descriptor.examples.join(" | ")}` : undefined,
    `Usage guidance: ${definition.usageGuidance}`
  ];

  return lines.filter((line): line is string => typeof line === "string" && line.trim().length > 0).join("\n");
}

function extractStringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  return undefined;
}

function sanitizeJsonRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeJsonValue(entry)])) as Record<
    string,
    JsonValue
  >;
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
