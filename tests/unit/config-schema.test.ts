import { describe, expect, test } from "vitest";

import {
  appConfigSchema,
  buildEnvironmentOverrides,
  createDefaultAppConfig,
  DEFAULT_APPROVAL_SETTINGS
} from "@/core/config";

describe("config defaults and env overrides", () => {
  test("builds a valid default config for an arbitrary user state directory", () => {
    const config = createDefaultAppConfig({
      userStateDirectory: "/tmp/test-home/.aia"
    });

    expect(appConfigSchema.parse(config).memory.userGlobalRoot).toBe(
      "/tmp/test-home/.aia/memory"
    );
    expect(config.providers.lmStudio.model).toBe("google/gemma-4-26b-a4b-qat");
    expect(config.browser.artifactRoot).toBe("./.aia/browser");
    expect(config.browser.headless).toBe(true);
    expect(config.externalAgents.enabled).toBe(true);
    expect(config.externalAgents.agents.codex.command).toBe("codex");
    expect(config.externalAgents.agents.codex.enabled).toBe(true);
    const claudeAgent = config.externalAgents.agents.claude;
    expect(claudeAgent.command).toBe("claude");
    expect(claudeAgent.enabled).toBe(true);
    expect(claudeAgent.kind === "claude" ? claudeAgent.printFlag : null).toBe(
      "--print"
    );
    expect(config.externalAgents.stateRoot).toBe("./.aia/external-agents");
    expect(config.image.artifactRoot).toBe("./.aia/images");
    expect(config.image.defaultProviderId).toBe("comfyui_local");
    expect(config.memory.embeddingProvider).toBe("lm_studio");
    expect(config.memory.hardFailOnStartup).toBe(false);
    expect(config.memory.sqlitePath).toBe("./.aia/memory.sqlite");
    expect(config.providers.imageProviders.comfyui_local?.enabled).toBe(false);
    expect(config.runtime.maxTurnsPerRun).toBe("unlimited");
    expect(config.runtime.maxConsecutiveNudges).toBe(3);
    expect(config.runtime.modelSettings).toEqual({
      maxOutputTokens: 8192,
      repetitionPenalty: 1.1
    });
    expect(config.providers.lmStudio.streamIdleTimeoutMs).toBe(60_000);
    expect(config.providers.ollama.streamIdleTimeoutMs).toBe(60_000);
    expect(config.runtime.promptBudgets).toEqual({
      instructionDocChars: 12_000,
      memorySummaryChars: 4_000
    });
    expect(config.tools.profile).toBe("lean");
    expect(config.tools.include).toEqual([]);
    expect(config.tools.exclude).toEqual([]);
    expect(config.providers.ollama.contextLength).toBeUndefined();
    expect(DEFAULT_APPROVAL_SETTINGS.defaultMode).toBe("ask");
  });

  test("parses environment overrides and rejects invalid values", () => {
    const overrides = buildEnvironmentOverrides({
      AIA_GATEWAY_PORT: "4123",
      AIA_LOG_LEVEL: "debug",
      AIA_BROWSER_HEADLESS: "false",
      AIA_EXTERNAL_AGENTS_ENABLED: "true",
      AIA_EXTERNAL_AGENTS_POLL_INTERVAL_MS: "750",
      AIA_EXTERNAL_AGENTS_STATE_ROOT: "./.aia/external-agent-tests",
      AIA_MEMORY_MMR_LAMBDA: "0.65",
      AIA_STATUS_UPDATES: "true"
    });

    expect(overrides.config.gateway?.port).toBe(4123);
    expect(overrides.config.runtime?.logLevel).toBe("debug");
    expect(overrides.config.browser?.headless).toBe(false);
    expect(overrides.config.externalAgents?.enabled).toBe(true);
    expect(overrides.config.externalAgents?.pollIntervalMs).toBe(750);
    expect(overrides.config.externalAgents?.stateRoot).toBe(
      "./.aia/external-agent-tests"
    );
    expect(overrides.config.memory?.mmrLambda).toBe(0.65);
    expect(overrides.config.runtime?.statusUpdates).toBe(true);

    expect(() =>
      buildEnvironmentOverrides({
        AIA_STATUS_UPDATES: "maybe"
      })
    ).toThrow("AIA_STATUS_UPDATES");
  });

  test("rejects enabled image providers when image.defaultProviderId does not point at one of them", () => {
    const config = createDefaultAppConfig({
      userStateDirectory: "/tmp/test-home/.aia"
    });
    config.image.defaultProviderId = "missing_provider";
    config.providers.imageProviders.local_image = {
      baseUrl: "http://localhost:8188",
      enabled: true,
      headers: {},
      kind: "comfyui_compatible",
      timeoutMs: 120_000
    };

    expect(() => appConfigSchema.parse(config)).toThrow(
      "image.defaultProviderId"
    );
  });
});
