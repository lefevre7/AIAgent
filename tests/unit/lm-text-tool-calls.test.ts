import { describe, expect, test } from "vitest";

import type { ToolDefinition } from "@/core";
import { parseTextToolCalls, resolveToolCallProposals } from "@/core/lm/shared";

function makeTool(invocationName: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    aliases: [],
    annotations: { meta: {}, readOnlyHint: false, title: invocationName },
    approvalMode: "never",
    descriptor: {
      approvalNotes: "Test fixture tool.",
      examples: ["Example."],
      purpose: "Test fixture.",
      sideEffectSummary: "None.",
      whenNotToUse: [],
      whenToUse: ["When testing."]
    },
    description: `Test tool ${invocationName}.`,
    displayName: invocationName,
    execution: { inputMode: "json", resumable: false, taskSupport: "forbidden" },
    idempotent: false,
    inputSchema: { type: "object" },
    invocationName,
    kind: "built_in",
    metadata: {},
    name: invocationName,
    outputKind: "json",
    retryable: true,
    searchTags: [invocationName],
    sideEffects: ["none"],
    source: { displayName: "Built-in Tools", kind: "built_in" },
    streamingMode: "none",
    toolId: `tool.builtin.${invocationName}`,
    usageGuidance: "Use in tests.",
    version: "1.0.0",
    ...overrides
  };
}

const definitions = [
  makeTool("shell_command"),
  makeTool("attempt_complete"),
  makeTool("update_plan", { aliases: ["todo"] })
];

describe("text-embedded tool-call parsing", () => {
  test("recovers a Hermes <tool_call> JSON call", () => {
    const matches = parseTextToolCalls(
      'Sure.\n<tool_call>{"name":"shell_command","arguments":{"command":"ls"}}</tool_call>',
      definitions
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe("shell_command");
    expect(matches[0]?.arguments).toEqual({ command: "ls" });
  });

  test("recovers a Qwen3-Coder <function>/<parameter> XML call and coerces values", () => {
    const matches = parseTextToolCalls(
      "<function=shell_command>\n<parameter=command>\ngit status\n</parameter>\n<parameter=waitForCompletion>\nTrue\n</parameter>\n</function>\n</tool_call>",
      definitions
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe("shell_command");
    expect(matches[0]?.arguments).toEqual({ command: "git status", waitForCompletion: true });
  });

  test("recovers a GPT-OSS Harmony commentary tool call", () => {
    const matches = parseTextToolCalls(
      '<|channel|>commentary to=functions.shell_command <|constrain|>json<|message|>{"command":"pwd"}<|call|>',
      definitions
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe("shell_command");
    expect(matches[0]?.arguments).toEqual({ command: "pwd" });
  });

  test("recovers an LM Studio [TOOL_REQUEST] default-format call", () => {
    const matches = parseTextToolCalls(
      '[TOOL_REQUEST]{"name":"shell_command","arguments":{"command":"whoami"}}[END_TOOL_REQUEST]',
      definitions
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe("shell_command");
  });

  test("tolerates an idiosyncratic call where the tool name is a key", () => {
    const matches = parseTextToolCalls('<tool_call>{"status":"success","attempt_complete":{}}</tool_call>', definitions);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe("attempt_complete");
    expect(matches[0]?.arguments).toEqual({});
  });

  test("resolves a known tool name from an alias", () => {
    const matches = parseTextToolCalls('<tool_call>{"name":"todo","arguments":{"summary":"done"}}</tool_call>', definitions);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe("update_plan");
  });

  test("ignores content with no recognizable tool call", () => {
    expect(parseTextToolCalls("Just some prose, no tool calls here.", definitions)).toHaveLength(0);
  });
});

describe("resolveToolCallProposals", () => {
  test("prefers native tool calls and does not run the text fallback", () => {
    const resolved = resolveToolCallProposals({
      content: '<tool_call>{"name":"shell_command","arguments":{"command":"ls"}}</tool_call>',
      definitions,
      fallbackPrefix: "req.1",
      nativeToolCalls: [{ function: { arguments: '{"command":"pwd"}', name: "shell_command" }, id: "native.1", type: "function" }]
    });
    expect(resolved.recoveredFromText).toBe(false);
    expect(resolved.proposals).toHaveLength(1);
    expect(resolved.proposals[0]?.arguments).toEqual({ command: "pwd" });
    expect(resolved.content).toContain("<tool_call>");
  });

  test("recovers text tool calls and strips their markup while preserving prose", () => {
    const resolved = resolveToolCallProposals({
      content: 'Let me run it.\n<tool_call>{"name":"shell_command","arguments":{"command":"ls"}}</tool_call>\nDone.',
      definitions,
      fallbackPrefix: "req.2",
      nativeToolCalls: []
    });
    expect(resolved.recoveredFromText).toBe(true);
    expect(resolved.proposals).toHaveLength(1);
    expect(resolved.proposals[0]?.toolName).toBe("shell_command");
    expect(resolved.proposals[0]?.arguments).toEqual({ command: "ls" });
    expect(resolved.content).not.toContain("<tool_call>");
    expect(resolved.content).toContain("Let me run it.");
    expect(resolved.content).toContain("Done.");
  });

  test("leaves content untouched when nothing is recoverable", () => {
    const resolved = resolveToolCallProposals({
      content: "No tools, just thinking.",
      definitions,
      fallbackPrefix: "req.3",
      nativeToolCalls: []
    });
    expect(resolved.recoveredFromText).toBe(false);
    expect(resolved.proposals).toHaveLength(0);
    expect(resolved.content).toBe("No tools, just thinking.");
  });
});
