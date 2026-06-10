import { z } from "zod";

import { approvalPolicyModeSchema, approvalPolicyRuleSchema, providerIdSchema } from "@/core/contracts";
import {
  APP_CONFIG_VERSION,
  APPROVALS_CONFIG_VERSION,
  DEFAULT_COMFYUI_BASE_URL,
  DEFAULT_GATEWAY_HOSTNAME,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_GATEWAY_WEBSOCKET_PATH,
  DEFAULT_IMAGE_DEFAULT_PROVIDER_ID,
  DEFAULT_IMAGE_POLL_INTERVAL_MS,
  DEFAULT_LM_STUDIO_BASE_URL,
  DEFAULT_LM_STUDIO_MODEL,
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_USER_STATE_DIRECTORY,
  DEFAULT_VOICE_DEFAULT_PROVIDER_ID,
  DEFAULT_VOICE_LOCALE,
  DEFAULT_VOICE_MAX_CAPTURE_MS,
  DEFAULT_VOICE_SILENCE_TIMEOUT_MS,
  DEFAULT_VOICE_SYNTHESIS_PROVIDER_ID,
  DEFAULT_VOICE_TRANSCRIPTION_PROVIDER_ID
} from "@/core/config/constants";

const secretProviderAliasSchema = z.string().min(1).max(64).regex(/^[a-z][a-z0-9_-]{0,63}$/);
const envSecretIdSchema = z.string().min(1).max(128).regex(/^[A-Z][A-Z0-9_]{0,127}$/);
const jsonPointerSchema = z
  .string()
  .min(1)
  .refine((value) => value === "value" || value.startsWith("/"), 'Expected "value" or a JSON pointer beginning with "/".');

export const secretRefSchema = z.discriminatedUnion("source", [
  z
    .object({
      id: envSecretIdSchema,
      provider: secretProviderAliasSchema.optional(),
      source: z.literal("env")
    })
    .strict(),
  z
    .object({
      id: jsonPointerSchema,
      provider: secretProviderAliasSchema.optional(),
      source: z.literal("file")
    })
    .strict(),
  z
    .object({
      id: jsonPointerSchema,
      provider: secretProviderAliasSchema.optional(),
      source: z.literal("exec")
    })
    .strict()
]);

export const secretInputSchema = z.union([z.string().min(1), secretRefSchema]);

const logLevelSchema = z.enum(["debug", "error", "info", "warn"]);
const urlLikeStringSchema = z.string().min(1).max(4096);
const positivePortSchema = z.number().int().min(1).max(65535);
const positiveTimeoutSchema = z.number().int().positive().max(600_000);

const imageWorkflowPathsSchema = z
  .object({
    imageToImage: z.string().min(1).optional(),
    inpaint: z.string().min(1).optional(),
    textToImage: z.string().min(1).optional()
  })
  .strict();

const lmStudioProviderConfigSchema = z
  .object({
    baseUrl: urlLikeStringSchema,
    enabled: z.boolean(),
    headers: z.record(z.string(), secretInputSchema),
    model: z.string().min(1).max(256),
    timeoutMs: positiveTimeoutSchema
  })
  .strict();

const ollamaProviderConfigSchema = z
  .object({
    baseUrl: urlLikeStringSchema,
    enabled: z.boolean(),
    headers: z.record(z.string(), secretInputSchema),
    model: z.string().min(1).max(256).optional(),
    timeoutMs: positiveTimeoutSchema
  })
  .strict();

const imageProviderConfigSchema = z
  .object({
    apiKey: secretInputSchema.optional(),
    baseUrl: urlLikeStringSchema,
    enabled: z.boolean(),
    headers: z.record(z.string(), secretInputSchema).default({}),
    kind: z.enum(["comfyui_compatible", "custom", "lm_studio", "mcp", "sd_webui"]),
    model: z.string().min(1).max(256).optional(),
    timeoutMs: positiveTimeoutSchema,
    workflowPath: z.string().min(1).optional(),
    workflowPaths: imageWorkflowPathsSchema.optional()
  })
  .strict();

const voiceProviderConfigSchema = z
  .object({
    apiKey: secretInputSchema.optional(),
    baseUrl: urlLikeStringSchema.optional(),
    enabled: z.boolean(),
    inputDevice: z.string().min(1).max(256).optional(),
    kind: z.enum(["apple_native", "custom", "local_system", "whisper_compatible"]),
    locale: z.string().min(1).max(32).optional(),
    model: z.string().min(1).max(256).optional(),
    outputDevice: z.string().min(1).max(256).optional(),
    voice: z.string().min(1).max(128).optional()
  })
  .strict();

const providersConfigSchema = z
  .object({
    imageProviders: z.record(z.string(), imageProviderConfigSchema),
    lmStudio: lmStudioProviderConfigSchema,
    ollama: ollamaProviderConfigSchema,
    voiceProviders: z.record(z.string(), voiceProviderConfigSchema)
  })
  .strict();

const gatewayConfigSchema = z
  .object({
    auth: z
      .object({
        token: secretInputSchema.optional()
      })
      .strict(),
    hostname: z.string().min(1).max(256),
    port: positivePortSchema,
    requestTimeoutMs: positiveTimeoutSchema,
    websocketPath: z.string().min(1)
  })
  .strict();

const browserConfigSchema = z
  .object({
    actionTimeoutMs: positiveTimeoutSchema,
    artifactRoot: z.string().min(1),
    headless: z.boolean(),
    launchTimeoutMs: positiveTimeoutSchema,
    navigationTimeoutMs: positiveTimeoutSchema,
    snapshotMaxElements: z.number().int().positive().max(1000),
    snapshotTextChars: z.number().int().positive().max(100_000),
    viewport: z
      .object({
        height: z.number().int().positive().max(10_000),
        width: z.number().int().positive().max(10_000)
      })
      .strict()
  })
  .strict();

const imageConfigSchema = z
  .object({
    artifactRoot: z.string().min(1),
    defaultProviderId: providerIdSchema,
    pollIntervalMs: z.number().int().positive().max(60_000)
  })
  .strict();

const voiceConfigSchema = z
  .object({
    artifactRoot: z.string().min(1),
    defaultLocale: z.string().min(1).max(32),
    defaultProviderId: z.string().min(1).max(128),
    defaultSynthesisProviderId: z.string().min(1).max(128),
    defaultTranscriptionProviderId: z.string().min(1).max(128),
    defaultVoice: z.string().min(1).max(128).optional(),
    inputDevice: z.string().min(1).max(256).optional(),
    maxCaptureMs: positiveTimeoutSchema,
    outputDevice: z.string().min(1).max(256).optional(),
    requireOnDeviceRecognition: z.boolean(),
    retainAudio: z.boolean(),
    silenceTimeoutMs: positiveTimeoutSchema
  })
  .strict();

const tunnelConfigSchema = z
  .object({
    enabled: z.boolean(),
    hostname: z.string().min(1).max(256).optional(),
    provider: z.enum(["none", "tailscale"]),
    publicBaseUrl: urlLikeStringSchema.optional()
  })
  .strict();

const memoryConfigSchema = z
  .object({
    candidateLimit: z.number().int().positive().max(1000),
    chatSessionRoot: z.string().min(1),
    chunkOverlapChars: z.number().int().min(0).max(20_000),
    chunkTargetChars: z.number().int().positive().max(100_000),
    embeddingModel: z.string().min(1).max(256).optional(),
    embeddingProvider: providerIdSchema,
    embeddingsEnabled: z.boolean(),
    extraPaths: z.array(z.string().min(1)).max(256),
    ftsEnabled: z.boolean(),
    hardFailOnStartup: z.boolean(),
    includeSessionSummaries: z.boolean(),
    mmrLambda: z.number().min(0).max(1),
    retrievalLimit: z.number().int().positive().max(1000),
    sqlitePath: z.string().min(1),
    stateRoot: z.string().min(1),
    userGlobalRoot: z.string().min(1),
    workspaceRoot: z.string().min(1)
  })
  .strict();

const runtimeConfigSchema = z
  .object({
    defaultModel: z.string().min(1).max(256),
    defaultProvider: providerIdSchema,
    logLevel: logLevelSchema,
    statusUpdates: z.boolean(),
    verboseEvents: z.boolean()
  })
  .strict();

const externalAgentInstructionModeSchema = z.enum(["arg", "stdin"]);
export const externalAgentConfigKindSchema = z.enum(["claude", "codex", "mistral_vibe"]);

const externalAgentBaseConfigSchema = z
  .object({
    args: z.array(z.string().min(1)).max(128),
    command: z.string().min(1),
    cwd: z.string().min(1).optional(),
    displayName: z.string().min(1).max(128),
    enabled: z.boolean(),
    env: z.record(z.string(), secretInputSchema),
    instructionMode: externalAgentInstructionModeSchema,
    passEnv: z.array(envSecretIdSchema).max(128),
    timeoutMs: positiveTimeoutSchema.optional()
  })
  .strict();

const externalAgentClaudeConfigSchema = externalAgentBaseConfigSchema
  .extend({
    kind: z.literal("claude"),
    outputFormatFlag: z.string().min(1).max(64),
    outputFormatValue: z.string().min(1).max(64),
    printFlag: z.string().min(1).max(64),
    resumeFlag: z.string().min(1).max(64)
  })
  .strict();

const externalAgentCodexConfigSchema = externalAgentBaseConfigSchema
  .extend({
    kind: z.literal("codex"),
    jsonFlag: z.string().min(1).max(64),
    outputLastMessageFlag: z.string().min(1).max(64),
    resumeSubcommand: z.array(z.string().min(1)).min(1).max(8),
    schemaFlag: z.string().min(1).max(64),
    skipGitRepoCheck: z.boolean(),
    skipGitRepoCheckFlag: z.string().min(1).max(64)
  })
  .strict();

const externalAgentMistralVibeConfigSchema = externalAgentBaseConfigSchema
  .extend({
    kind: z.literal("mistral_vibe"),
    outputFlag: z.string().min(1).max(64),
    outputJsonValue: z.string().min(1).max(64),
    promptFlag: z.string().min(1).max(64),
    resumeFlag: z.string().min(1).max(64),
    workdirFlag: z.string().min(1).max(64)
  })
  .strict();

const externalAgentConfigSchema = z.discriminatedUnion("kind", [
  externalAgentClaudeConfigSchema,
  externalAgentCodexConfigSchema,
  externalAgentMistralVibeConfigSchema
]);

const externalAgentsConfigSchema = z
  .object({
    agents: z.record(z.string().min(1), externalAgentConfigSchema),
    enabled: z.boolean(),
    pollIntervalMs: z.number().int().positive().max(60_000),
    stateRoot: z.string().min(1)
  })
  .strict();

const discordChannelConfigSchema = z
  .object({
    appId: secretInputSchema.optional(),
    botToken: secretInputSchema.optional(),
    defaultGuildId: z.string().min(1).max(256).optional(),
    enabled: z.boolean()
  })
  .strict();

const whatsappChannelConfigSchema = z
  .object({
    enabled: z.boolean(),
    sessionDirectory: z.string().min(1).optional()
  })
  .strict();

const teamsChannelConfigSchema = z
  .object({
    appId: secretInputSchema.optional(),
    appPassword: secretInputSchema.optional(),
    enabled: z.boolean(),
    publicBaseUrl: urlLikeStringSchema.optional(),
    tenantId: secretInputSchema.optional()
  })
  .strict();

const imessageChannelConfigSchema = z
  .object({
    blueBubblesPassword: secretInputSchema.optional(),
    blueBubblesUrl: urlLikeStringSchema.optional(),
    enabled: z.boolean()
  })
  .strict();

const channelsConfigSchema = z
  .object({
    discord: discordChannelConfigSchema,
    imessage: imessageChannelConfigSchema,
    teams: teamsChannelConfigSchema,
    whatsapp: whatsappChannelConfigSchema
  })
  .strict();

const mcpServerProvenanceSchema = z
  .object({
    importId: z.string().min(1).max(128).optional(),
    source: z.enum(["config", "import", "template"]),
    templateId: z.string().min(1).max(128).optional()
  })
  .strict();

const mcpServerBaseConfigSchema = z
  .object({
    description: z.string().min(1).max(2000).optional(),
    enabled: z.boolean(),
    provenance: mcpServerProvenanceSchema.optional(),
    required: z.boolean(),
    tags: z.array(z.string().min(1).max(128)).max(64),
    timeoutMs: positiveTimeoutSchema.optional()
  })
  .strict();

const mcpStdioServerConfigSchema = mcpServerBaseConfigSchema
  .extend({
    args: z.array(z.string().min(1)).max(128).default([]),
    command: z.string().min(1),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string(), secretInputSchema).default({}),
    stderr: z.enum(["ignore", "inherit", "pipe"]).default("pipe"),
    type: z.literal("stdio")
  })
  .strict();

const mcpHttpServerConfigSchema = mcpServerBaseConfigSchema
  .extend({
    headers: z.record(z.string(), secretInputSchema).default({}),
    type: z.enum(["auto", "sse", "streamable-http"]),
    url: urlLikeStringSchema
  })
  .strict();

const mcpServerConfigSchema = z.discriminatedUnion("type", [mcpHttpServerConfigSchema, mcpStdioServerConfigSchema]);

const mcpImportConfigSchema = z
  .object({
    description: z.string().min(1).max(2000).optional(),
    enabled: z.boolean(),
    format: z.enum(["claude_desktop", "generic_mcp_servers_json", "roo_project"]),
    path: z.string().min(1),
    watch: z.boolean()
  })
  .strict();

const mcpTemplateBootstrapStepSchema = z
  .object({
    args: z.array(z.string().min(1)).max(128).default([]),
    command: z.string().min(1),
    notes: z.string().min(1).max(2000).optional()
  })
  .strict();

const mcpServerTemplateSchema = z
  .object({
    bootstrap: z.array(mcpTemplateBootstrapStepSchema).max(32).default([]),
    description: z.string().min(1).max(2000),
    displayName: z.string().min(1).max(256),
    marketplace: z.boolean().default(false),
    prerequisites: z.array(z.string().min(1).max(500)).max(32).default([]),
    server: mcpServerConfigSchema,
    tags: z.array(z.string().min(1).max(128)).max(64).default([]),
    title: z.string().min(1).max(256).optional()
  })
  .strict();

const mcpConfigSchema = z
  .object({
    imports: z.record(z.string(), mcpImportConfigSchema),
    servers: z.record(z.string(), mcpServerConfigSchema),
    templates: z.record(z.string(), mcpServerTemplateSchema)
  })
  .strict();

const envSecretProviderSchema = z
  .object({
    allowlist: z.array(envSecretIdSchema).max(512).optional(),
    source: z.literal("env")
  })
  .strict();

const fileSecretProviderSchema = z
  .object({
    maxBytes: z.number().int().positive().max(10 * 1024 * 1024).optional(),
    mode: z.enum(["json", "singleValue"]),
    path: z.string().min(1),
    source: z.literal("file")
  })
  .strict();

const execSecretProviderSchema = z
  .object({
    args: z.array(z.string().min(1)).max(64).optional(),
    command: z.string().min(1),
    env: z.record(z.string(), z.string()).optional(),
    jsonOnly: z.boolean().optional(),
    maxOutputBytes: z.number().int().positive().max(1024 * 1024).optional(),
    passEnv: z.array(envSecretIdSchema).max(128).optional(),
    source: z.literal("exec"),
    timeoutMs: positiveTimeoutSchema.optional()
  })
  .strict();

const secretProviderConfigSchema = z.discriminatedUnion("source", [
  envSecretProviderSchema,
  execSecretProviderSchema,
  fileSecretProviderSchema
]);

const secretsConfigSchema = z
  .object({
    defaults: z
      .object({
        env: secretProviderAliasSchema,
        exec: secretProviderAliasSchema,
        file: secretProviderAliasSchema
      })
      .strict(),
    providers: z.record(z.string(), secretProviderConfigSchema)
  })
  .strict();

const appConfigObjectSchema = z
  .object({
    browser: browserConfigSchema,
    channels: channelsConfigSchema,
    configVersion: z.literal(APP_CONFIG_VERSION),
    externalAgents: externalAgentsConfigSchema,
    gateway: gatewayConfigSchema,
    image: imageConfigSchema,
    mcp: mcpConfigSchema,
    memory: memoryConfigSchema,
    providers: providersConfigSchema,
    runtime: runtimeConfigSchema,
    secrets: secretsConfigSchema,
    tunnel: tunnelConfigSchema,
    voice: voiceConfigSchema
  })
  .strict();

export const appConfigSchema = appConfigObjectSchema.superRefine((value, context) => {
  const enabledImageProviderIds = Object.entries(value.providers.imageProviders)
    .filter(([, providerConfig]) => providerConfig.enabled)
    .map(([providerId]) => providerId);

  if (
    enabledImageProviderIds.length > 0 &&
    !enabledImageProviderIds.includes(value.image.defaultProviderId)
  ) {
    context.addIssue({
      code: "custom",
      message:
        enabledImageProviderIds.length > 1
          ? `image.defaultProviderId must reference one of the enabled image providers: ${enabledImageProviderIds.join(", ")}.`
          : `image.defaultProviderId must reference the enabled image provider "${enabledImageProviderIds[0]}".`,
      path: ["image", "defaultProviderId"]
    });
  }
});

export const approvalSettingsSchema = z
  .object({
    configVersion: z.literal(APPROVALS_CONFIG_VERSION),
    defaultMode: approvalPolicyModeSchema,
    rules: z.array(approvalPolicyRuleSchema)
  })
  .strict();

export const appConfigFragmentSchema = appConfigObjectSchema.deepPartial();
export const approvalSettingsFragmentSchema = approvalSettingsSchema.deepPartial();

export type AppConfig = z.infer<typeof appConfigSchema>;
export type AppConfigFragment = z.infer<typeof appConfigFragmentSchema>;
export type ApprovalSettings = z.infer<typeof approvalSettingsSchema>;
export type ApprovalSettingsFragment = z.infer<typeof approvalSettingsFragmentSchema>;
export type ExternalAgentConfig = z.infer<typeof externalAgentConfigSchema>;
export type ExternalAgentConfigKind = z.infer<typeof externalAgentConfigKindSchema>;
export type ExternalAgentsConfig = z.infer<typeof externalAgentsConfigSchema>;
export type ImageConfig = z.infer<typeof imageConfigSchema>;
export type ImageProviderConfig = z.infer<typeof imageProviderConfigSchema>;
export type SecretInput = z.infer<typeof secretInputSchema>;
export type SecretProviderConfig = z.infer<typeof secretProviderConfigSchema>;
export type SecretRef = z.infer<typeof secretRefSchema>;
export type VoiceConfig = z.infer<typeof voiceConfigSchema>;
export type VoiceProviderConfig = z.infer<typeof voiceProviderConfigSchema>;

export function createDefaultAppConfig(params: { userStateDirectory: string }): AppConfig {
  return {
    browser: {
      actionTimeoutMs: 15_000,
      artifactRoot: "./.aia/browser",
      headless: true,
      launchTimeoutMs: 30_000,
      navigationTimeoutMs: 30_000,
      snapshotMaxElements: 120,
      snapshotTextChars: 12_000,
      viewport: {
        height: 800,
        width: 1280
      }
    },
    channels: {
      discord: {
        enabled: false
      },
      imessage: {
        enabled: false
      },
      teams: {
        enabled: false
      },
      whatsapp: {
        enabled: false,
        sessionDirectory: "./.aia/channels/whatsapp"
      }
    },
    configVersion: APP_CONFIG_VERSION,
    externalAgents: {
      agents: {
        claude: {
          args: [],
          command: "claude",
          displayName: "Claude Code CLI",
          enabled: true,
          env: {},
          instructionMode: "arg",
          kind: "claude",
          outputFormatFlag: "--output-format",
          outputFormatValue: "json",
          passEnv: ["ANTHROPIC_API_KEY"],
          printFlag: "--print",
          resumeFlag: "--resume"
        },
        codex: {
          args: [],
          command: "codex",
          displayName: "Codex CLI",
          enabled: true,
          env: {},
          instructionMode: "arg",
          jsonFlag: "--json",
          kind: "codex",
          outputLastMessageFlag: "--output-last-message",
          passEnv: ["OPENAI_API_KEY"],
          resumeSubcommand: ["exec", "resume"],
          schemaFlag: "--output-schema",
          skipGitRepoCheck: true,
          skipGitRepoCheckFlag: "--skip-git-repo-check"
        },
        mistral_vibe: {
          args: [],
          command: "vibe",
          displayName: "Mistral Vibe CLI",
          enabled: false,
          env: {},
          instructionMode: "arg",
          kind: "mistral_vibe",
          outputFlag: "--output",
          outputJsonValue: "json",
          passEnv: ["MISTRAL_API_KEY", "VIBE_HOME"],
          promptFlag: "--prompt",
          resumeFlag: "--resume",
          workdirFlag: "--workdir"
        }
      },
      enabled: true,
      pollIntervalMs: 500,
      stateRoot: "./.aia/external-agents"
    },
    gateway: {
      auth: {},
      hostname: DEFAULT_GATEWAY_HOSTNAME,
      port: DEFAULT_GATEWAY_PORT,
      requestTimeoutMs: 120_000,
      websocketPath: DEFAULT_GATEWAY_WEBSOCKET_PATH
    },
    image: {
      artifactRoot: "./.aia/images",
      defaultProviderId: DEFAULT_IMAGE_DEFAULT_PROVIDER_ID,
      pollIntervalMs: DEFAULT_IMAGE_POLL_INTERVAL_MS
    },
    mcp: {
      imports: {},
      servers: {},
      templates: {}
    },
    memory: {
      candidateLimit: 48,
      chatSessionRoot: "./chat-session-memory",
      chunkOverlapChars: 400,
      chunkTargetChars: 2_000,
      embeddingProvider: "lm_studio",
      embeddingsEnabled: true,
      extraPaths: [],
      ftsEnabled: true,
      // Degrade to lexical retrieval (with a warning) when the embedding provider
      // is unavailable, so the runtime still boots. Set true to require it.
      hardFailOnStartup: false,
      includeSessionSummaries: true,
      mmrLambda: 0.7,
      retrievalLimit: 8,
      sqlitePath: "./.aia/memory.sqlite",
      stateRoot: "./.aia",
      userGlobalRoot: `${params.userStateDirectory}/memory`,
      workspaceRoot: "./memory"
    },
    providers: {
      imageProviders: {
        comfyui_local: {
          baseUrl: DEFAULT_COMFYUI_BASE_URL,
          enabled: false,
          headers: {},
          kind: "comfyui_compatible",
          timeoutMs: 300_000
        }
      },
      lmStudio: {
        baseUrl: DEFAULT_LM_STUDIO_BASE_URL,
        enabled: true,
        headers: {},
        model: DEFAULT_LM_STUDIO_MODEL,
        timeoutMs: 120_000
      },
      ollama: {
        baseUrl: DEFAULT_OLLAMA_BASE_URL,
        enabled: true,
        headers: {},
        timeoutMs: 120_000
      },
      voiceProviders: {
        apple_native: {
          enabled: process.platform === "darwin",
          kind: "apple_native"
        },
        local_system: {
          enabled: process.platform === "darwin",
          kind: "local_system"
        }
      }
    },
    runtime: {
      defaultModel: DEFAULT_LM_STUDIO_MODEL,
      defaultProvider: "lm_studio",
      logLevel: "info",
      statusUpdates: true,
      verboseEvents: true
    },
    secrets: {
      defaults: {
        env: "env",
        exec: "exec",
        file: "file"
      },
      providers: {
        env: {
          source: "env"
        }
      }
    },
    tunnel: {
      enabled: false,
      provider: "none"
    },
    voice: {
      artifactRoot: "./.aia/voice",
      defaultLocale: DEFAULT_VOICE_LOCALE,
      defaultProviderId: DEFAULT_VOICE_DEFAULT_PROVIDER_ID,
      defaultSynthesisProviderId: DEFAULT_VOICE_SYNTHESIS_PROVIDER_ID,
      defaultTranscriptionProviderId: DEFAULT_VOICE_TRANSCRIPTION_PROVIDER_ID,
      maxCaptureMs: DEFAULT_VOICE_MAX_CAPTURE_MS,
      requireOnDeviceRecognition: true,
      retainAudio: true,
      silenceTimeoutMs: DEFAULT_VOICE_SILENCE_TIMEOUT_MS
    }
  };
}

export const DEFAULT_APP_CONFIG: AppConfig = createDefaultAppConfig({
  userStateDirectory: DEFAULT_USER_STATE_DIRECTORY
});

export const DEFAULT_APPROVAL_SETTINGS: ApprovalSettings = {
  configVersion: APPROVALS_CONFIG_VERSION,
  defaultMode: "ask",
  rules: [
    {
      id: "rule.command.read.allow",
      mode: "allow",
      notes: "Common read-only shell inspection commands.",
      pattern: "^(pwd|ls|find|rg|grep|sed|cat|head|tail|wc|git status|git diff)(\\\\b|$)",
      targetKind: "command"
    },
    {
      id: "rule.command.build.ask",
      mode: "ask",
      notes: "Build, test, and package-manager commands should stay operator-visible.",
      pattern: "^(npm|pnpm|yarn|bun|node|tsx|vitest|playwright|python3?|pytest|cargo|go|java|javac|gradle|\\\\./gradlew)(\\\\b|$)",
      targetKind: "command"
    },
    {
      id: "rule.command.destructive.deny",
      mode: "deny",
      notes: "Block obviously destructive shell patterns by default.",
      pattern: "(^|\\\\s)(rm\\\\s+-rf\\\\s+/|mkfs|shutdown|reboot|halt)(\\\\s|$)",
      targetKind: "command"
    },
    {
      id: "rule.tool.read.allow",
      mode: "allow",
      notes: "Allow read-oriented tool names without prompting.",
      pattern: "^(read_|list_|grep|search_|view_|fetch_)",
      targetKind: "tool"
    },
    {
      id: "rule.tool.write.ask",
      mode: "ask",
      notes: "Ask before file writes, command execution, browser mutation, or external side effects.",
      pattern: "^(write_|edit_|apply_|execute_|browser_|send_|generate_|undo_)",
      targetKind: "tool"
    }
  ]
};
