import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  buildProviderHeaders,
  createBuiltInLanguageModelAdapters,
  createDefaultAppConfig,
  getBuiltInProviderConfig,
  LanguageModelRuntime,
  resolveConfiguredModelId,
  type LanguageModelAdapter
} from "@/core";

function config() {
  return createDefaultAppConfig({ userStateDirectory: "/tmp/aia-providers-test" });
}

describe("built-in language-model providers", () => {
  test("ship LM Studio, llama.cpp, and Ollama adapters under their provider ids", () => {
    const registrations = createBuiltInLanguageModelAdapters(config());
    expect(registrations.map((registration) => [registration.adapter.providerId, registration.enabled])).toEqual([
      ["lm_studio", true],
      ["llama_cpp", true],
      ["ollama", true]
    ]);
    expect(getBuiltInProviderConfig(config(), "llama_cpp")?.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(getBuiltInProviderConfig(config(), "custom_provider")).toBeUndefined();
  });

  // One definition, shared by the runtime, the CLI's provenance line, and the
  // context-window lookup (which used to hand every non-Ollama provider LM
  // Studio's model).
  test("resolve the model a turn gets: the provider's own model, else runtime.defaultModel for the default provider", () => {
    const appConfig = config();
    appConfig.runtime.defaultProvider = "llama_cpp";
    appConfig.runtime.defaultModel = "runtime-default";

    expect(resolveConfiguredModelId(appConfig, "llama_cpp")).toBe("runtime-default");
    appConfig.providers.llamaCpp.model = "gemma-4-e4b";
    expect(resolveConfiguredModelId(appConfig, "llama_cpp")).toBe("gemma-4-e4b");
    // Not the default provider, and no model of its own: nothing to ask for.
    expect(resolveConfiguredModelId(appConfig, "ollama")).toBeUndefined();
    // A registered adapter's own default wins.
    expect(resolveConfiguredModelId(appConfig, "custom", "custom-model")).toBe("custom-model");
  });

  test("each adapter puts its own provider's remedy on a context overflow", async () => {
    // The agent loop used to name every provider's setting, whichever failed.
    const overflowBody = JSON.stringify({
      error: {
        code: 400,
        message: "request (9000 tokens) exceeds the available context size",
        n_ctx: 8192,
        type: "exceed_context_size_error"
      }
    });
    const fetchImpl = (async () =>
      new Response(overflowBody, { headers: { "content-type": "application/json" }, status: 400 })) as typeof fetch;
    const registrations = createBuiltInLanguageModelAdapters(config(), fetchImpl);
    const remedies: Record<string, unknown> = {};
    for (const { adapter } of registrations) {
      const failure = await adapter
        .generate({
          availableTools: [],
          id: "request.overflow",
          instructions: "Be brief.",
          messages: [],
          metadata: {},
          modelId: "m",
          provider: adapter.providerId,
          responseFormat: { kind: "text" },
          sessionId: "session.overflow",
          settings: { stopSequences: [], toolChoice: "auto" },
          turnId: "turn.overflow"
        } as never)
        .catch((error: { structuredError?: { code: string; details: Record<string, unknown> } }) => error);
      expect((failure as { structuredError: { code: string } }).structuredError.code).toBe("context_window_exceeded");
      remedies[adapter.providerId] = (
        failure as { structuredError: { details: Record<string, unknown> } }
      ).structuredError.details.remedy;
    }
    expect(remedies).toEqual({
      llama_cpp: "Start llama-server with a larger context (-c)",
      lm_studio: "Load the model in LM Studio with a larger context length",
      ollama: "Raise providers.ollama.contextLength (Ollama's num_ctx)"
    });
  });

  test("send llama.cpp's apiKey as a bearer token unless an Authorization header is configured", () => {
    const appConfig = config();
    appConfig.providers.llamaCpp.apiKey = "sk-local";
    appConfig.providers.llamaCpp.headers = { "x-extra": "1" };
    expect(buildProviderHeaders(appConfig, "llama_cpp")).toEqual({ Authorization: "Bearer sk-local", "x-extra": "1" });

    appConfig.providers.llamaCpp.headers = { authorization: "Bearer from-header" };
    expect(buildProviderHeaders(appConfig, "llama_cpp")).toEqual({ authorization: "Bearer from-header" });

    appConfig.providers.llamaCpp.headers = {};
    appConfig.providers.llamaCpp.apiKey = { id: "LLAMA_API_KEY", source: "env" };
    expect(() => buildProviderHeaders(appConfig, "llama_cpp")).toThrow(/unresolved secret-backed apiKey/u);
  });

  test("list models from every running provider when one of them is down", async () => {
    const appConfig = config();
    // The runtime's disk queue lives under the state root; keep it out of the repo.
    const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aia-providers-"));
    appConfig.memory.stateRoot = stateRoot;
    appConfig.providers.llamaCpp.enabled = false;
    appConfig.providers.lmStudio.enabled = false;
    appConfig.providers.ollama.enabled = false;
    const adapter = (providerId: string, models: string[] | Error): LanguageModelAdapter => ({
      generate: async () => {
        throw new Error("not used");
      },
      health: async () => ({ checkedAt: new Date().toISOString(), details: {}, providerId, status: "healthy" }),
      listModels: async () => {
        if (models instanceof Error) {
          throw models;
        }
        return models.map((modelId) => ({ displayName: modelId, modelId, provider: providerId, toolCalling: true }));
      },
      provider: providerId,
      providerId
    });
    const runtime = new LanguageModelRuntime({
      adapters: [
        { adapter: adapter("up_one", ["a"]) },
        { adapter: adapter("down_one", new Error("ECONNREFUSED")) },
        { adapter: adapter("up_two", ["b"]) }
      ],
      config: appConfig
    });

    await expect(runtime.listModels()).resolves.toEqual([
      expect.objectContaining({ modelId: "a" }),
      expect.objectContaining({ modelId: "b" })
    ]);
    // Asking the one that is down still says so.
    await expect(runtime.listModels("down_one")).rejects.toThrow("ECONNREFUSED");
    await runtime.close();
    await fs.rm(stateRoot, { force: true, recursive: true });
  });
});
