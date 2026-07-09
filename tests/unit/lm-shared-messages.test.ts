import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { serializeOllamaMessages, serializeOpenAICompatibleMessages } from "@/core/lm/shared";
import type { LanguageModelRequest, Message } from "@/core";

const tempRoots: string[] = [];
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9pQhR7QAAAAASUVORK5CYII=";

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function pngUri(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-lm-img-"));
  tempRoots.push(root);
  const filePath = path.join(root, "shot.png");
  await fs.writeFile(filePath, Buffer.from(TINY_PNG, "base64"));
  return pathToFileURL(filePath).href;
}

function message(parts: Message["parts"], role: Message["role"] = "user"): Message {
  return {
    createdAt: "2026-06-11T00:00:00.000Z",
    id: `message.${role}.1`,
    metadata: {},
    parts,
    role,
    sessionId: "session.1",
    source: role === "user" ? "user" : "model",
    tags: [],
    turnId: "turn.1",
    visibility: "default"
  } as Message;
}

function buildRequest(messages: Message[]): LanguageModelRequest {
  return {
    availableTools: [],
    id: "lm.shared.msg.1",
    instructions: "be concise",
    messages,
    metadata: {},
    modelId: "m",
    provider: "lm_studio",
    responseFormat: { kind: "text" },
    sessionId: "session.1",
    settings: { stopSequences: [], toolChoice: "auto" },
    turnId: "turn.1"
  };
}

describe("language-model message serialization", () => {
  test("serializes mixed text + image parts into OpenAI-compatible content blocks", async () => {
    const uri = await pngUri();
    const request = buildRequest([
      message([
        { kind: "text", text: "what is in this picture?" },
        { alt: "a screenshot", kind: "image", uri }
      ])
    ]);

    const messages = await serializeOpenAICompatibleMessages(request);
    const content = JSON.stringify(messages);
    expect(content).toContain("what is in this picture?");
    expect(content).toContain("data:image/png;base64,");
  });

  test("serializes image parts as base64 image arrays for Ollama", async () => {
    const uri = await pngUri();
    const request = buildRequest([message([{ kind: "text", text: "describe" }, { kind: "image", uri }])]);
    const messages = await serializeOllamaMessages(request);
    const withImages = messages.find((entry) => Array.isArray((entry as { images?: unknown[] }).images));
    expect(withImages).toBeTruthy();
  });

  test("flattens assistant markdown/status/json parts into text", async () => {
    const request = buildRequest([
      message(
        [
          { kind: "markdown", markdown: "**bold answer**" },
          { kind: "status", state: "running", summary: "thinking" },
          { kind: "json", value: { ok: true } }
        ],
        "assistant"
      )
    ]);
    const messages = await serializeOpenAICompatibleMessages(request);
    expect(JSON.stringify(messages)).toContain("bold answer");
  });

  test("serializes assistant tool calls and paired tool results natively for OpenAI-compatible providers", async () => {
    const assistant: Message = {
      ...message(
        [
          { kind: "text", text: "Reading the file." },
          { arguments: { path: "README.md" }, callId: "call.1", kind: "tool_call", toolName: "read_file" }
        ],
        "assistant"
      ),
      id: "message.assistant.toolcall"
    };
    const toolResult: Message = {
      ...message([{ kind: "json", value: { content: "hello", status: "succeeded" } }], "tool"),
      id: "message.tool.call.1",
      metadata: { toolCallId: "call.1" }
    };

    const messages = await serializeOpenAICompatibleMessages(buildRequest([assistant, toolResult]));

    const assistantEntry = messages.find((entry) => entry.role === "assistant") as {
      content: string;
      tool_calls?: Array<{ function: { arguments: string; name: string }; id: string; type: string }>;
    };
    expect(assistantEntry.tool_calls).toEqual([
      {
        function: { arguments: '{"path":"README.md"}', name: "read_file" },
        id: "call.1",
        type: "function"
      }
    ]);

    const toolEntry = messages.find((entry) => entry.role === "tool") as {
      content: string;
      tool_call_id: string;
    };
    expect(toolEntry.tool_call_id).toBe("call.1");
    expect(toolEntry.content).toContain("hello");
    // Tool results must be compact JSON, not pretty-printed.
    expect(toolEntry.content).not.toContain("\n  ");
  });

  test("forwards tool-result images after the whole tool-call run, not between tool results", async () => {
    const uri = await pngUri();
    const assistant: Message = {
      ...message(
        [
          { arguments: {}, callId: "call.1", kind: "tool_call", toolName: "shot" },
          { arguments: {}, callId: "call.2", kind: "tool_call", toolName: "note" }
        ],
        "assistant"
      ),
      id: "message.assistant.multi"
    };
    const toolResult1: Message = {
      ...message([{ kind: "text", text: "first" }, { alt: "img", kind: "image", uri }], "tool"),
      id: "message.tool.1",
      metadata: { toolCallId: "call.1" }
    };
    const toolResult2: Message = {
      ...message([{ kind: "text", text: "second" }], "tool"),
      id: "message.tool.2",
      metadata: { toolCallId: "call.2" }
    };
    const request = buildRequest([assistant, toolResult1, toolResult2]);

    // The two tool messages must stay consecutive (OpenAI rejects a user message
    // splitting a tool_calls/tool run); the image is forwarded after the run.
    const openai = await serializeOpenAICompatibleMessages(request);
    expect(openai.map((m) => m.role)).toEqual([
      "system",
      "assistant",
      "tool",
      "tool",
      "user"
    ]);
    expect(JSON.stringify(openai[openai.length - 1])).toContain(
      "data:image/png;base64,"
    );

    const ollama = await serializeOllamaMessages(request);
    expect(ollama.map((m) => m.role)).toEqual([
      "system",
      "assistant",
      "tool",
      "tool",
      "user"
    ]);
    expect(
      Array.isArray((ollama[ollama.length - 1] as { images?: unknown[] }).images)
    ).toBe(true);
  });

  test("does not forward tool-result images when supportsVision is false", async () => {
    const uri = await pngUri();
    const assistant: Message = {
      ...message(
        [{ arguments: {}, callId: "call.1", kind: "tool_call", toolName: "shot" }],
        "assistant"
      ),
      id: "message.assistant.novision"
    };
    const toolResult: Message = {
      ...message([{ alt: "img", kind: "image", uri }], "tool"),
      id: "message.tool.novision",
      metadata: { toolCallId: "call.1" }
    };
    const request: LanguageModelRequest = {
      ...buildRequest([assistant, toolResult]),
      settings: { stopSequences: [], supportsVision: false, toolChoice: "auto" }
    };

    const messages = await serializeOpenAICompatibleMessages(request);
    expect(messages.map((m) => m.role)).toEqual(["system", "assistant", "tool"]);
    expect(JSON.stringify(messages)).not.toContain("data:image");
  });

  test("falls back to flattened text for orphan tool results with no matching assistant tool call", async () => {
    const orphanResult: Message = {
      ...message([{ kind: "json", value: { status: "succeeded" } }], "tool"),
      id: "message.tool.orphan",
      metadata: { toolCallId: "call.unknown" }
    };

    const messages = await serializeOpenAICompatibleMessages(buildRequest([orphanResult]));
    expect(messages.some((entry) => entry.role === "tool")).toBe(false);
    expect(JSON.stringify(messages)).toContain("[TOOL]");
  });

  test("serializes assistant tool calls and paired tool results natively for Ollama", async () => {
    const assistant: Message = {
      ...message([{ arguments: { path: "README.md" }, callId: "call.2", kind: "tool_call", toolName: "read_file" }], "assistant"),
      id: "message.assistant.toolcall.ollama"
    };
    const toolResult: Message = {
      ...message([{ kind: "json", value: { content: "hi" } }], "tool"),
      id: "message.tool.call.2",
      metadata: { toolCallId: "call.2" }
    };

    const messages = await serializeOllamaMessages(buildRequest([assistant, toolResult]));

    const assistantEntry = messages.find((entry) => entry.role === "assistant");
    expect(assistantEntry?.tool_calls).toEqual([
      {
        function: { arguments: { path: "README.md" }, name: "read_file" }
      }
    ]);

    const toolEntry = messages.find((entry) => entry.role === "tool");
    expect(toolEntry?.tool_call_id).toBe("call.2");
    expect(toolEntry?.tool_name).toBe("read_file");
    expect(toolEntry?.content).toContain("hi");
  });
});

describe("language-model image URI resolution", () => {
  test("passes data URLs through, reads absolute paths, and infers mime by extension", async () => {
    const dataReq = buildRequest([message([{ kind: "image", uri: "data:image/png;base64,QUJD" }])]);
    expect(JSON.stringify(await serializeOpenAICompatibleMessages(dataReq))).toContain("data:image/png;base64,QUJD");

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-lm-img2-"));
    tempRoots.push(root);
    const jpg = path.join(root, "shot.jpg");
    await fs.writeFile(jpg, Buffer.from(TINY_PNG, "base64"));
    const absMsgs = await serializeOpenAICompatibleMessages(buildRequest([message([{ kind: "image", uri: jpg }])]));
    expect(JSON.stringify(absMsgs)).toContain("data:image/jpeg;base64,");

    const gif = path.join(root, "anim.gif");
    await fs.writeFile(gif, Buffer.from(TINY_PNG, "base64"));
    expect(JSON.stringify(await serializeOllamaMessages(buildRequest([message([{ kind: "image", uri: gif }])])))).toContain("images");
  });

  test("rejects unsupported image URIs", async () => {
    const badReq = buildRequest([message([{ kind: "image", uri: "https://example.com/x.png" }])]);
    await expect(serializeOpenAICompatibleMessages(badReq)).rejects.toThrow(/Unsupported image URI/u);
  });
});
