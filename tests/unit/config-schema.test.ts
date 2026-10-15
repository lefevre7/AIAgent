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

    expect(appConfigSchema.parse(config).memory.userGlobalRoot).toBe("/tmp/test-home/.aia/memory");
    expect(config.providers.lmStudio.model).toBe("qwen3.8-27b-mlx");
    expect(config.browser.artifactRoot).toBe("./.aia/browser");
    expect(config.browser.headless).toBe(true);
    expect(config.externalAgents.enabled).toBe(true);
    expect(config.externalAgents.agents.codex.command).toBe("codex");
    expect(config.externalAgents.agents.codex.enabled).toBe(true);
    const claudeAgent = config.externalAgents.agents.claude;
    expect(claudeAgent.command).toBe("claude");
    expect(claudeAgent.enabled).toBe(true);
    expect(claudeAgent.kind === "claude" ? claudeAgent.printFlag : null).toBe("--print");
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
      activeSkillsChars: 16_000,
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
    expect(overrides.config.externalAgents?.stateRoot).toBe("./.aia/external-agent-tests");
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

    expect(() => appConfigSchema.parse(config)).toThrow("image.defaultProviderId");
  });

  test("accepts only http(s) URLs for an MCP server", () => {
    const withServerUrl = (url: string) => {
      const config = createDefaultAppConfig({ userStateDirectory: "/tmp/test-home/.aia" });
      config.mcp.servers.docs = { enabled: true, headers: {}, required: false, tags: [], type: "streamable-http", url };
      return appConfigSchema.safeParse(config);
    };

    expect(withServerUrl("https://mcp.example.com/mcp").success).toBe(true);
    expect(withServerUrl("http://127.0.0.1:8931/mcp").success).toBe(true);
    for (const url of ["file:///etc/passwd", "ws://mcp.example.com", "javascript:alert(1)", "not a url"]) {
      const parsed = withServerUrl(url);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toBe("must be an http:// or https:// URL");
    }
  });

  test("accepts any server name that a status can report: not empty, at most 128 characters", () => {
    const withServerName = (name: string) => {
      const config = createDefaultAppConfig({ userStateDirectory: "/tmp/test-home/.aia" });
      config.mcp.servers[name] = {
        enabled: false,
        headers: {},
        required: false,
        tags: [],
        type: "streamable-http",
        url: "https://mcp.example.com/mcp"
      };
      return appConfigSchema.safeParse(config).success;
    };

    expect(withServerName("brave search")).toBe(true);
    expect(withServerName("@playwright/mcp")).toBe(true);
    expect(withServerName("x".repeat(128))).toBe(true);
    // A name past these used to fail every status report it appeared in.
    expect(withServerName("")).toBe(false);
    expect(withServerName("x".repeat(129))).toBe(false);
  });

  test("refuses requestExtras that would set a protocol field", () => {
    const withExtras = (requestExtras: Record<string, unknown>) => {
      const config = createDefaultAppConfig({ userStateDirectory: "/tmp/test-home/.aia" });
      config.providers.llamaCpp.requestExtras = requestExtras as never;
      return appConfigSchema.safeParse(config);
    };

    expect(withExtras({ chat_template_kwargs: { enable_thinking: false }, temperature: 0.2 }).success).toBe(true);
    const refused = withExtras({ tools: [] });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toBe(
      '"tools" is set by aia on every request and cannot be given in requestExtras'
    );
  });

  test("checks that every passEnv entry is an environment variable name", () => {
    const parse = (mutate: (config: ReturnType<typeof createDefaultAppConfig>) => void) => {
      const config = createDefaultAppConfig({ userStateDirectory: "/tmp/test-home/.aia" });
      mutate(config);
      return appConfigSchema.safeParse(config).success;
    };

    // Lowercase proxy and CA names are real variables.
    expect(parse((config) => (config.externalAgents.passEnv = ["http_proxy", "GITHUB_TOKEN"]))).toBe(true);
    expect(parse((config) => (config.mcp.passEnv = ["npm_config_cafile"]))).toBe(true);
    // A typo is caught when the config loads, not by a child missing a variable.
    expect(parse((config) => (config.externalAgents.passEnv = ["GITHUB TOKEN"]))).toBe(false);
    expect(parse((config) => (config.mcp.passEnv = ["=x"]))).toBe(false);
    expect(parse((config) => (config.mcp.passEnv = ["1PASSWORD"]))).toBe(false);
  });
});
