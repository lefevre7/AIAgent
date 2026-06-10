import type { ApprovalSettingsFragment, AppConfigFragment } from "@/core/config/schema";
import { parseJsoncText } from "@/core/config/jsonc";

export function buildEnvironmentOverrides(environment: Record<string, string | undefined>): {
  approvals: ApprovalSettingsFragment;
  config: AppConfigFragment;
} {
  const config: AppConfigFragment = {};
  const approvals: ApprovalSettingsFragment = {};

  assign(config, ["runtime", "defaultProvider"], environment.AIA_DEFAULT_PROVIDER);
  assign(config, ["runtime", "defaultModel"], environment.AIA_DEFAULT_MODEL);
  assign(config, ["runtime", "logLevel"], parseEnum(environment.AIA_LOG_LEVEL, ["debug", "error", "info", "warn"]));
  assign(config, ["runtime", "statusUpdates"], parseBoolean(environment.AIA_STATUS_UPDATES, "AIA_STATUS_UPDATES"));
  assign(config, ["runtime", "verboseEvents"], parseBoolean(environment.AIA_VERBOSE_EVENTS, "AIA_VERBOSE_EVENTS"));

  assign(
    config,
    ["externalAgents", "enabled"],
    parseBoolean(environment.AIA_EXTERNAL_AGENTS_ENABLED, "AIA_EXTERNAL_AGENTS_ENABLED")
  );
  assign(config, ["externalAgents", "stateRoot"], environment.AIA_EXTERNAL_AGENTS_STATE_ROOT);
  assign(
    config,
    ["externalAgents", "pollIntervalMs"],
    parseInteger(environment.AIA_EXTERNAL_AGENTS_POLL_INTERVAL_MS, "AIA_EXTERNAL_AGENTS_POLL_INTERVAL_MS")
  );

  assign(config, ["providers", "lmStudio", "baseUrl"], environment.AIA_LM_STUDIO_BASE_URL);
  assign(config, ["providers", "lmStudio", "model"], environment.AIA_LM_STUDIO_MODEL);
  assign(config, ["providers", "ollama", "baseUrl"], environment.AIA_OLLAMA_BASE_URL);
  assign(config, ["providers", "ollama", "model"], environment.AIA_OLLAMA_MODEL);

  assign(config, ["gateway", "hostname"], environment.AIA_GATEWAY_HOST);
  assign(config, ["gateway", "port"], parseInteger(environment.AIA_GATEWAY_PORT, "AIA_GATEWAY_PORT"));
  assign(config, ["gateway", "auth", "token"], environment.AIA_GATEWAY_TOKEN);

  assign(config, ["browser", "headless"], parseBoolean(environment.AIA_BROWSER_HEADLESS, "AIA_BROWSER_HEADLESS"));
  assign(config, ["browser", "artifactRoot"], environment.AIA_BROWSER_ARTIFACT_ROOT);
  assign(
    config,
    ["browser", "actionTimeoutMs"],
    parseInteger(environment.AIA_BROWSER_ACTION_TIMEOUT_MS, "AIA_BROWSER_ACTION_TIMEOUT_MS")
  );
  assign(
    config,
    ["browser", "navigationTimeoutMs"],
    parseInteger(environment.AIA_BROWSER_NAVIGATION_TIMEOUT_MS, "AIA_BROWSER_NAVIGATION_TIMEOUT_MS")
  );

  assign(config, ["tunnel", "enabled"], parseBoolean(environment.AIA_TUNNEL_ENABLED, "AIA_TUNNEL_ENABLED"));
  assign(config, ["tunnel", "provider"], parseEnum(environment.AIA_TUNNEL_PROVIDER, ["none", "tailscale"]));
  assign(config, ["tunnel", "publicBaseUrl"], environment.AIA_TUNNEL_PUBLIC_URL);

  assign(config, ["voice", "artifactRoot"], environment.AIA_VOICE_ARTIFACT_ROOT);
  assign(config, ["voice", "defaultProviderId"], environment.AIA_VOICE_DEFAULT_PROVIDER);
  assign(config, ["voice", "defaultSynthesisProviderId"], environment.AIA_VOICE_DEFAULT_SYNTHESIS_PROVIDER);
  assign(config, ["voice", "defaultTranscriptionProviderId"], environment.AIA_VOICE_DEFAULT_TRANSCRIPTION_PROVIDER);
  assign(config, ["voice", "defaultLocale"], environment.AIA_VOICE_DEFAULT_LOCALE);
  assign(config, ["voice", "defaultVoice"], environment.AIA_VOICE_DEFAULT_VOICE);
  assign(config, ["voice", "inputDevice"], environment.AIA_VOICE_INPUT_DEVICE);
  assign(config, ["voice", "outputDevice"], environment.AIA_VOICE_OUTPUT_DEVICE);
  assign(config, ["voice", "maxCaptureMs"], parseInteger(environment.AIA_VOICE_MAX_CAPTURE_MS, "AIA_VOICE_MAX_CAPTURE_MS"));
  assign(
    config,
    ["voice", "silenceTimeoutMs"],
    parseInteger(environment.AIA_VOICE_SILENCE_TIMEOUT_MS, "AIA_VOICE_SILENCE_TIMEOUT_MS")
  );
  assign(
    config,
    ["voice", "requireOnDeviceRecognition"],
    parseBoolean(environment.AIA_VOICE_REQUIRE_ON_DEVICE, "AIA_VOICE_REQUIRE_ON_DEVICE")
  );
  assign(config, ["voice", "retainAudio"], parseBoolean(environment.AIA_VOICE_RETAIN_AUDIO, "AIA_VOICE_RETAIN_AUDIO"));

  assign(config, ["memory", "workspaceRoot"], environment.AIA_MEMORY_WORKSPACE_ROOT);
  assign(config, ["memory", "userGlobalRoot"], environment.AIA_MEMORY_USER_GLOBAL_ROOT);
  assign(config, ["memory", "stateRoot"], environment.AIA_MEMORY_STATE_ROOT);
  assign(config, ["memory", "chatSessionRoot"], environment.AIA_MEMORY_CHAT_SESSION_ROOT);
  assign(config, ["memory", "sqlitePath"], environment.AIA_MEMORY_SQLITE_PATH);
  assign(config, ["memory", "embeddingProvider"], environment.AIA_MEMORY_EMBEDDING_PROVIDER);
  assign(config, ["memory", "embeddingModel"], environment.AIA_MEMORY_EMBEDDING_MODEL);
  assign(config, ["memory", "retrievalLimit"], parseInteger(environment.AIA_MEMORY_RETRIEVAL_LIMIT, "AIA_MEMORY_RETRIEVAL_LIMIT"));
  assign(config, ["memory", "candidateLimit"], parseInteger(environment.AIA_MEMORY_CANDIDATE_LIMIT, "AIA_MEMORY_CANDIDATE_LIMIT"));
  assign(config, ["memory", "chunkTargetChars"], parseInteger(environment.AIA_MEMORY_CHUNK_TARGET_CHARS, "AIA_MEMORY_CHUNK_TARGET_CHARS"));
  assign(config, ["memory", "chunkOverlapChars"], parseInteger(environment.AIA_MEMORY_CHUNK_OVERLAP_CHARS, "AIA_MEMORY_CHUNK_OVERLAP_CHARS"));
  assign(config, ["memory", "mmrLambda"], parseNumber(environment.AIA_MEMORY_MMR_LAMBDA, "AIA_MEMORY_MMR_LAMBDA"));
  assign(config, ["memory", "embeddingsEnabled"], parseBoolean(environment.AIA_MEMORY_EMBEDDINGS_ENABLED, "AIA_MEMORY_EMBEDDINGS_ENABLED"));
  assign(config, ["memory", "ftsEnabled"], parseBoolean(environment.AIA_MEMORY_FTS_ENABLED, "AIA_MEMORY_FTS_ENABLED"));
  assign(config, ["memory", "hardFailOnStartup"], parseBoolean(environment.AIA_MEMORY_HARD_FAIL_ON_STARTUP, "AIA_MEMORY_HARD_FAIL_ON_STARTUP"));
  assign(
    config,
    ["memory", "includeSessionSummaries"],
    parseBoolean(environment.AIA_MEMORY_INCLUDE_SESSION_SUMMARIES, "AIA_MEMORY_INCLUDE_SESSION_SUMMARIES")
  );
  assign(config, ["memory", "extraPaths"], parseCsv(environment.AIA_MEMORY_EXTRA_PATHS));

  assign(config, ["channels", "discord", "botToken"], environment.AIA_DISCORD_BOT_TOKEN);
  assign(config, ["channels", "discord", "appId"], environment.AIA_DISCORD_APP_ID);
  assign(config, ["channels", "teams", "appId"], environment.AIA_TEAMS_APP_ID);
  assign(config, ["channels", "teams", "appPassword"], environment.AIA_TEAMS_APP_PASSWORD);
  assign(config, ["channels", "teams", "tenantId"], environment.AIA_TEAMS_TENANT_ID);
  assign(config, ["channels", "teams", "publicBaseUrl"], environment.AIA_TEAMS_PUBLIC_BASE_URL);
  assign(config, ["channels", "whatsapp", "sessionDirectory"], environment.AIA_WHATSAPP_SESSION_DIRECTORY);
  assign(config, ["channels", "imessage", "blueBubblesUrl"], environment.AIA_IMESSAGE_BLUEBUBBLES_URL);
  assign(config, ["channels", "imessage", "blueBubblesPassword"], environment.AIA_IMESSAGE_BLUEBUBBLES_PASSWORD);
  assign(config, ["mcp"], parseMcpConfigOverride(environment.AIA_MCP_CONFIG_JSON));

  assign(approvals, ["defaultMode"], parseEnum(environment.AIA_APPROVAL_DEFAULT_MODE, ["allow", "ask", "deny"]));

  return {
    approvals,
    config
  };
}

function assign(target: Record<string, unknown>, path: string[], value: unknown): void {
  if (value === undefined) {
    return;
  }

  let cursor = target;
  for (const segment of path.slice(0, -1)) {
    const existing = cursor[segment];
    if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]] = value;
}

function parseBoolean(value: string | undefined, key: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (/^(1|true|yes|on)$/i.test(value)) {
    return true;
  }
  if (/^(0|false|no|off)$/i.test(value)) {
    return false;
  }
  throw new Error(`${key} must be one of: true, false, 1, 0, yes, no, on, off.`);
}

function parseEnum<const T extends readonly string[]>(value: string | undefined, allowed: T): T[number] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if ((allowed as readonly string[]).includes(value)) {
    return value as T[number];
  }
  throw new Error(`Expected one of ${allowed.join(", ")}, received ${value}.`);
}

function parseInteger(value: string | undefined, key: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be an integer.`);
  }
  return parsed;
}

function parseNumber(value: string | undefined, key: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be a number.`);
  }
  return parsed;
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseMcpConfigOverride(value: string | undefined): AppConfigFragment["mcp"] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = parseJsoncText(value, "AIA_MCP_CONFIG_JSON");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("AIA_MCP_CONFIG_JSON must parse to an object.");
  }

  return parsed as AppConfigFragment["mcp"];
}
