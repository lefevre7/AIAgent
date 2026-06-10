import { describe, expect, test } from "vitest";

import type { ToolDefinition } from "@/core";
import {
  normalizeToolCallProposals,
  serializeToolDefinitions,
  serializeOllamaResponseFormat,
  serializeOpenAICompatibleResponseFormat
} from "@/core/lm/shared";

describe("language-model shared helpers", () => {
  test("serializes structured response formats for OpenAI-compatible and Ollama providers", () => {
    expect(serializeOpenAICompatibleResponseFormat({ kind: "text" })).toBeUndefined();
    expect(serializeOpenAICompatibleResponseFormat({ kind: "json_object" })).toEqual({
      type: "json_object"
    });
    expect(
      serializeOpenAICompatibleResponseFormat({
        kind: "json_schema",
        name: "agent_turn",
        schema: {
          properties: {
            status: { type: "string" }
          },
          type: "object"
        }
      })
    ).toEqual({
      json_schema: {
        name: "agent_turn",
        schema: {
          properties: {
            status: { type: "string" }
          },
          type: "object"
        }
      },
      type: "json_schema"
    });

    expect(serializeOllamaResponseFormat({ kind: "text" })).toBeUndefined();
    expect(serializeOllamaResponseFormat({ kind: "json_object" })).toBe("json");
    expect(
      serializeOllamaResponseFormat({
        kind: "json_schema",
        name: "agent_turn",
        schema: {
          properties: {
            status: { type: "string" }
          },
          type: "object"
        }
      })
    ).toEqual({
      properties: {
        status: { type: "string" }
      },
      type: "object"
    });
  });

  test("normalizes tool call proposals from stringified function arguments", () => {
    const proposals = normalizeToolCallProposals(
      [
        {
          function: {
            arguments: '{"path":"README.md"}',
            name: "read_file"
          }
        }
      ],
      "fallback.tool"
    );

    expect(proposals).toEqual([
      {
        arguments: {
          path: "README.md"
        },
        callId: "fallback.tool.1",
        toolName: "read_file"
      }
    ]);
  });

  test("serializes invocation names and wraps free-form text tools for provider function calling", () => {
    const definitions: ToolDefinition[] = [
      {
        aliases: [],
        annotations: {
          meta: {},
          openWorldHint: true,
          title: "Web Search"
        },
        approvalMode: "ask" as const,
        descriptor: {
          approvalNotes: "Approval may be required by policy because this tool reads from the network.",
          examples: ["Search the web for the latest SDK docs."],
          purpose: "Search the web through a provider-backed tool.",
          sideEffectSummary: "Performs network reads.",
          whenNotToUse: ["Do not use when you already have the exact URL."],
          whenToUse: ["Use when you need to discover relevant web resources."]
        },
        description: "Search the web.",
        displayName: "Web Search",
        execution: {
          inputMode: "text" as const,
          resumable: false,
          taskSupport: "optional" as const
        },
        idempotent: true,
        inputSchema: {
          type: "string"
        },
        invocationName: "web_search",
        kind: "built_in" as const,
        metadata: {},
        name: "web.search",
        outputKind: "json" as const,
        outputSchema: {
          type: "object"
        },
        retryable: true,
        searchTags: ["search", "web"],
        sideEffects: ["network_read"] as const,
        source: {
          displayName: "Built-in Tools",
          kind: "built_in" as const
        },
        streamingMode: "none" as const,
        toolId: "tool.builtin.web_search",
        usageGuidance: "Use to search the internet when a configured search backend is available.",
        version: "1.0.0"
      }
    ];

    expect(serializeToolDefinitions(definitions)).toEqual([
      {
        function: {
          description: expect.stringContaining("Purpose: Search the web through a provider-backed tool."),
          name: "web_search",
          parameters: {
            additionalProperties: false,
            properties: {
              input: {
                description: "Free-form text input for this tool.",
                type: "string"
              }
            },
            required: ["input"],
            type: "object"
          }
        },
        type: "function"
      }
    ]);

    const proposals = normalizeToolCallProposals(
      [
        {
          function: {
            arguments: "{\"input\":\"latest docs\"}",
            name: "web_search"
          }
        }
      ],
      "fallback.tool",
      definitions
    );

    expect(proposals).toEqual([
      {
        arguments: {},
        callId: "fallback.tool.1",
        inputText: "latest docs",
        toolId: "tool.builtin.web_search",
        toolName: "web_search"
      }
    ]);
  });
});
