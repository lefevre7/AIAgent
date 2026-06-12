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
