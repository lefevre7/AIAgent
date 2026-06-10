import { describe, expect, test } from "vitest";

import { thinkToolDefinition } from "@/core";
import type { LanguageModelRequest, Message, MessagePart, ToolDefinition } from "@/core/contracts";
import {
  buildAssistantMessageText,
  compactRecord,
  mapStopReason,
  normalizeToolCallProposals,
  serializeOllamaMessages,
  serializeOllamaResponseFormat,
  serializeOpenAICompatibleMessages,
  serializeOpenAICompatibleResponseFormat,
  serializeToolDefinitions
} from "@/core/lm/shared";

function message(role: Message["role"], parts: MessagePart[]): Message {
  return {
    createdAt: "2026-06-10T12:00:00.000Z",
    id: `message.${role}.${Math.random().toString(16).slice(2, 8)}`,
    metadata: {},
    parts,
    role,
    sessionId: "session.lm.1",
    source: "system",
    tags: [],
    visibility: "default"
  };
}

function request(messages: Message[]): LanguageModelRequest {
  return { instructions: "system prompt", messages } as unknown as LanguageModelRequest;
}

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("lm shared transforms", () => {
  test("buildAssistantMessageText handles strings, arrays, and other values", () => {
    expect(buildAssistantMessageText("  hello  ")).toBe("hello");
    expect(buildAssistantMessageText(["a", { type: "text", text: "b" }, { type: "image" }, 5])).toBe("a\nb");
    expect(buildAssistantMessageText(42)).toBe("");
  });

  test("serializeOpenAICompatibleMessages renders text, prefixes non-standard roles, and embeds images", async () => {
    const messages = await serializeOpenAICompatibleMessages(
      request([
        message("user", [{ kind: "text", text: "hi" }]),
        message("tool", [{ kind: "json", value: { ok: true } }]),
        message("user", [
          { kind: "text", text: "look" },
          { alt: "diagram", kind: "image", uri: PNG_DATA_URL }
        ])
      ])
    );

    expect(messages[0]).toEqual({ content: "system prompt", role: "system" });
    expect(messages[1]).toEqual({ content: "hi", role: "user" });
    // Non-standard roles are mapped to user and prefixed with the original role.
    expect(messages[2].role).toBe("user");
    expect(messages[2].content).toContain("[TOOL]");
    const imageContent = messages[3].content;
    expect(Array.isArray(imageContent)).toBe(true);
    const parts = imageContent as Array<{ image_url?: { url: string }; text?: string; type: string }>;
    expect(parts[0].type).toBe("text");
    expect(parts[0].text).toContain("look");
    expect(parts[1]).toEqual({ image_url: { url: PNG_DATA_URL }, type: "image_url" });
  });

  test("serializeOllamaMessages attaches base64 image payloads", async () => {
    const messages = await serializeOllamaMessages(
      request([
        message("user", [{ kind: "text", text: "plain" }]),
        message("user", [{ alt: "x", kind: "image", uri: PNG_DATA_URL }])
      ])
    );

    expect(messages[0]).toEqual({ content: "system prompt", images: undefined, role: "system" });
    expect(messages[1].images).toBeUndefined();
    expect(messages[2].images?.[0]).toMatch(/^iVBOR/u);
  });

  test("serializeToolDefinitions reflects json, text, and either input modes", () => {
    const textTool: ToolDefinition = {
      ...thinkToolDefinition,
      execution: { ...thinkToolDefinition.execution, inputMode: "text" }
    };
    const eitherTool: ToolDefinition = {
      ...thinkToolDefinition,
      execution: { ...thinkToolDefinition.execution, inputMode: "either" },
      inputSchema: { type: "string" }
    };

    const [jsonDef, textDef, eitherDef] = serializeToolDefinitions([thinkToolDefinition, textTool, eitherTool]);

    expect(jsonDef.function.name).toBe("think");
    expect(jsonDef.function.parameters).toMatchObject({ additionalProperties: false, type: "object" });
    expect(textDef.function.parameters).toMatchObject({ required: ["input"] });
    expect(eitherDef.function.parameters.properties).toMatchObject({
      arguments: { required: ["arguments"], type: "object" },
      input: { type: "string" }
    });
    expect(jsonDef.function.description).toContain("Purpose:");
  });

  test("response-format serializers cover every format kind", () => {
    expect(serializeOpenAICompatibleResponseFormat({ kind: "text" })).toBeUndefined();
    expect(serializeOpenAICompatibleResponseFormat({ kind: "json_object" })).toEqual({ type: "json_object" });
    expect(
      serializeOpenAICompatibleResponseFormat({ kind: "json_schema", name: "S", schema: { type: "object" } })
    ).toMatchObject({ type: "json_schema", json_schema: { name: "S" } });

    expect(serializeOllamaResponseFormat({ kind: "text" })).toBeUndefined();
    expect(serializeOllamaResponseFormat({ kind: "json_object" })).toBe("json");
    expect(serializeOllamaResponseFormat({ kind: "json_schema", name: "S", schema: { type: "object" } })).toEqual({
      type: "object"
    });
  });

  test("normalizeToolCallProposals parses arguments, skips junk, and honors input modes", () => {
    const proposals = normalizeToolCallProposals(
      [
        { function: { arguments: '{"thought":"x"}', name: "think" }, id: "call-1" },
        { function: { arguments: { input: "free text", arguments: { a: 1 } }, name: "either_tool" } },
        "not-an-object",
        { function: { name: null } }
      ],
      "fallback",
      [
        thinkToolDefinition,
        { ...thinkToolDefinition, execution: { ...thinkToolDefinition.execution, inputMode: "either" }, invocationName: "either_tool" }
      ]
    );

    expect(proposals).toHaveLength(2);
    expect(proposals[0]).toMatchObject({ arguments: { thought: "x" }, callId: "call-1", toolName: "think" });
    expect(proposals[1]).toMatchObject({ arguments: { a: 1 }, inputText: "free text", toolName: "either_tool" });
  });

  test("normalizeToolCallProposals falls back to a generated call id", () => {
    const [proposal] = normalizeToolCallProposals([{ function: { arguments: "{}", name: "think" } }], "auto", [
      thinkToolDefinition
    ]);
    expect(proposal.callId).toBe("auto.1");
  });

  test("mapStopReason maps known reasons and defaults to end_turn", () => {
    expect(mapStopReason("tool_calls")).toBe("tool_calls");
    expect(mapStopReason("length")).toBe("length");
    expect(mapStopReason("content_filter")).toBe("content_filter");
    expect(mapStopReason("cancelled")).toBe("cancelled");
    expect(mapStopReason("error")).toBe("error");
    expect(mapStopReason("anything-else")).toBe("end_turn");
  });

  test("compactRecord drops undefined entries", () => {
    expect(compactRecord({ a: 1, b: undefined, c: "x" })).toEqual({ a: 1, c: "x" });
  });
});
