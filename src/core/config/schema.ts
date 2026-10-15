import { z } from "zod";

import {
  approvalPolicyModeSchema,
  approvalPolicyRuleSchema,
  jsonValueSchema,
  providerIdSchema
} from "@/core/contracts";
import {
  APP_CONFIG_VERSION,
  APPROVALS_CONFIG_VERSION,
  DEFAULT_COMFYUI_BASE_URL,
  DEFAULT_GATEWAY_HOSTNAME,
  DEFAULT_GATEWAY_PORT,
  DEFAULT_GATEWAY_WEBSOCKET_PATH,
  DEFAULT_IMAGE_DEFAULT_PROVIDER_ID,
  DEFAULT_IMAGE_POLL_INTERVAL_MS,
  DEFAULT_LLAMA_CPP_BASE_URL,
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

const secretProviderAliasSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]{0,63}$/);
const envSecretIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]{0,127}$/);
// Names of environment variables, as they are spelled (proxy and CA settings
// are often lowercase): a letter or underscore, then letters, digits, and
// underscores, so a typo such as `=x` or `FOO BAR` is caught at load.
const environmentVariableNameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, "must be an environment variable name");
const environmentVariableNamesSchema = z.array(environmentVariableNameSchema).max(256);
const jsonPointerSchema = z
  .string()
  .min(1)
  .refine(
    (value) => value === "value" || value.startsWith("/"),
    'Expected "value" or a JSON pointer beginning with "/".'
  );

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
// Time to a model's first token: a local model can read a long prompt for many
// minutes before it sends anything, far past the cap on other timeouts.
const firstTokenTimeoutSchema = z.number().int().positive().max(86_400_000);

const imageWorkflowPathsSchema = z
  .object({
    imageToImage: z.string().min(1).optional(),
    inpaint: z.string().min(1).optional(),
    textToImage: z.string().min(1).optional()
  })
  .strict();

// Retries after a model request's first attempt, for 408/429/5xx and network
// failures, with exponential backoff that honours Retry-After. Omitted: 3.
const providerMaxRetriesSchema = z.number().int().min(0).max(10);
// Extra top-level request fields for an OpenAI-compatible server, for
// parameters the runtime has no setting for. They may override sampling
// fields but never model/messages/tools/tool_choice/stream/stream_options.
export const RESERVED_REQUEST_EXTRAS_KEYS: readonly string[] = [
  "messages",
  "model",
  "stream",
  "stream_options",
  "tool_choice",
  "tools"
];
const providerRequestExtrasSchema = z
  .record(z.string().min(1).max(128), jsonValueSchema)
  .superRefine((extras, context) => {
    for (const key of Object.keys(extras)) {
      if (RESERVED_REQUEST_EXTRAS_KEYS.includes(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${key}" is set by aia on every request and cannot be given in requestExtras`,
          path: [key]
        });
      }
    }
  });

const lmStudioProviderConfigSchema = z
  .object({
    baseUrl: urlLikeStringSchema,
    enabled: z.boolean(),
    headers: z.record(z.string(), secretInputSchema),
    maxRetries: providerMaxRetriesSchema.optional(),
    model: z.string().min(1).max(256),
    requestExtras: providerRequestExtrasSchema.optional(),
    // Budget for the first streamed token (prompt evaluation can be slow on big
    // local models); separate from the inter-token idle window below.
    streamFirstTokenTimeoutMs: firstTokenTimeoutSchema.optional(),
    // Abort a streaming response only after this many ms with no new tokens
    // (inactivity), instead of an absolute deadline that kills healthy long
    // streams. `timeoutMs` still bounds non-streaming requests.
    streamIdleTimeoutMs: positiveTimeoutSchema.optional(),
    timeoutMs: positiveTimeoutSchema
  })
  .strict();

// llama.cpp's llama-server, single-model or router mode. See docs/PROVIDERS.md.
const llamaCppProviderConfigSchema = z
  .object({
    // Sent as `Authorization: Bearer <key>` when the server runs with --api-key.
    apiKey: secretInputSchema.optional(),
    baseUrl: urlLikeStringSchema,
    // A separate server for memory embeddings: `/v1/embeddings` needs a
    // server started with --embeddings and an embedding model, which is
    // usually not the chat server. Omitted: baseUrl (a router that serves both).
    embeddingsBaseUrl: urlLikeStringSchema.optional(),
    enabled: z.boolean(),
    headers: z.record(z.string(), secretInputSchema),
    maxRetries: providerMaxRetriesSchema.optional(),
    // Required in router mode, where it selects (and auto-loads) the model; a
    // single-model server ignores it.
    model: z.string().min(1).max(256).optional(),
    requestExtras: providerRequestExtrasSchema.optional(),
    streamFirstTokenTimeoutMs: firstTokenTimeoutSchema.optional(),
    streamIdleTimeoutMs: positiveTimeoutSchema.optional(),
    timeoutMs: positiveTimeoutSchema
  })
  .strict();

const ollamaProviderConfigSchema = z
  .object({
    baseUrl: urlLikeStringSchema,
    // Sent as options.num_ctx on every request. Without it Ollama applies its own
    // (small) default context and silently truncates large agent prompts.
    contextLength: z.number().int().positive().max(10_000_000).optional(),
    enabled: z.boolean(),
    headers: z.record(z.string(), secretInputSchema),
    keepAlive: z.string().min(1).max(64).optional(),
    maxRetries: providerMaxRetriesSchema.optional(),
    model: z.string().min(1).max(256).optional(),
    streamFirstTokenTimeoutMs: firstTokenTimeoutSchema.optional(),
    streamIdleTimeoutMs: positiveTimeoutSchema.optional(),
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
    llamaCpp: llamaCppProviderConfigSchema,
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
    // Trigger threshold-based session compaction when the last model request used
    // at least this many input tokens. Unset: 80% of the context window
    // (runtime.modelSettings.contextWindowTokens, else the window the provider
    // reports) or a 100k fallback. 0 disables.
    autoCompactThresholdTokens: z.number().int().min(0).max(100_000_000).optional(),
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

const runtimeModelSettingsSchema = z
  .object({
    contextWindowTokens: z.number().int().positive().max(100_000_000).optional(),
    frequencyPenalty: z.number().min(-2).max(2).optional(),
    maxOutputTokens: z.number().int().positive().max(10_000_000).optional(),
    minP: z.number().min(0).max(1).optional(),
    presencePenalty: z.number().min(-2).max(2).optional(),
    // Anti-repetition penalty (llama.cpp/Ollama repeat_penalty). Sent to both
    // adapters so it applies even when a model preset did not set it.
    repetitionPenalty: z.number().min(0).max(2).optional(),
    // Whether the active model can accept image input. When omitted it is
    // treated as true (opt-out): image content returned by MCP tools is
    // forwarded to the model. Set false for text-only local models so such
    // content is summarized as a text placeholder instead. See docs/MCP.md and
    // docs/SMALL_MODELS.md.
    supportsVision: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    topK: z.number().int().min(0).max(1000).optional(),
    topP: z.number().min(0).max(1).optional()
  })
  .strict();

const runtimePromptBudgetsSchema = z
  .object({
    // All the skills the prompt restates after compaction folded their loads
    // away ("Active Skills"), together. Past it a skill is cut, or named with
    // its SKILL.md to read, rather than restated whole.
    activeSkillsChars: z.number().int().min(0).max(10_000_000),
    instructionDocChars: z.number().int().min(0).max(10_000_000),
    memorySummaryChars: z.number().int().min(0).max(10_000_000)
  })
  .strict();

const runtimeConfigSchema = z
  .object({
    defaultModel: z.string().min(1).max(256),
    defaultProvider: providerIdSchema,
    logLevel: logLevelSchema,
    maxConsecutiveNudges: z.number().int().positive().max(100),
    // How many times one run may execute the exact same tool with the exact
    // same arguments before the runtime refuses and tells the model to change
    // approach. Guards against a small model re-issuing an identical read in a
    // loop; legitimate repeats (re-reading a file after editing it) are well
    // under the default.
    maxIdenticalToolCalls: z.number().int().positive().max(100),
    maxTurnsPerRun: z.union([z.literal("unlimited"), z.number().int().positive().max(100_000)]),
    modelSettings: runtimeModelSettingsSchema,
    promptBudgets: runtimePromptBudgetsSchema,
    // How many of the most recent turns keep their reasoning (<think> blocks) in
    // the model request. 1 keeps only the current turn, so reasoning survives
    // across this turn's tool results while older deliberation stops consuming
    // the context window and stops reinforcing plan/re-plan loops. 0 drops it
    // entirely. The transcript on disk always keeps every reasoning part.
    reasoningContextTurns: z.number().int().min(0).max(100),
    statusUpdates: z.boolean(),
    verboseEvents: z.boolean()
  })
  .strict();

const toolsConfigSchema = z
  .object({
    // Extra invocation names always exposed to the model on top of the profile.
    include: z.array(z.string().min(1).max(128)).max(256),
    // Invocation names never exposed to the model (still executable via gateway).
    exclude: z.array(z.string().min(1).max(128)).max(256),
    // "lean" exposes a small high-value core set and relies on tool_search
    // activation for the rest; "full" exposes every registered tool.
    profile: z.enum(["full", "lean"])
  })
  .strict();

/**
 * Agent Skills (docs/SKILLS.md): where SKILL.md folders are found beyond the
 * project's `.aia/skills` and `.agents/skills` and the operator's
 * `~/.aia/skills` and `~/.agents/skills`, and which of them to leave out.
 */
const skillsConfigSchema = z
  .object({
    // Include the skills aia ships (bundled-skills/), such as skill-creator.
    bundled: z.boolean(),
    // Skill names, or SKILL.md paths, that are listed but never used.
    disabled: z.array(z.string().min(1).max(4096)).max(1024),
    // false turns skills off: no catalog, no `skill` tool, no `$name` mentions.
    enabled: z.boolean(),
    // More skill roots, searched after the project and user roots, in order.
    extraRoots: z.array(z.string().min(1).max(4096)).max(64),
    // The catalog's budget in characters. Unset: 2% of the model's context
    // window, or 8,000 characters when the window is unknown.
    maxCatalogChars: z.number().int().min(0).max(1_000_000).optional()
  })
  .strict();

/**
 * Per-agent settings for long-lived interactive sessions.
 *
 * `args` are appended when the agent is started interactively instead of as a
 * one-shot job. The shipped defaults include each vendor's approval-bypass flag
 * because an interactive agent that stops to ask its own permission question
 * deadlocks behind our approval gate. Keeping those flags as visible config
 * values (rather than hardcoding them in the spawn path) is deliberate: an
 * operator who disagrees can delete them without patching code.
 * See docs/EXTERNAL_AGENTS.md for the risk this accepts.
 */
const externalAgentInteractiveConfigSchema = z
  .object({
    args: z.array(z.string().min(1)).max(64),
    /** Milliseconds of byte silence before a turn is considered finished. */
    idleMs: z.number().int().positive().max(600_000),
    /**
     * Regex (source form) the bottom of the rendered screen must match before
     * the agent may send: the CLI's own input prompt. Without it, only a
     * consent or menu screen blocks a send.
     */
    inputPattern: z.string().min(1).max(512).optional(),
    /** Regex (source form) matched against the rendered screen to detect the input prompt. */
    readyPattern: z.string().min(1).max(512).optional(),
    /** Milliseconds the rendered screen must stay unchanged before the turn ends. */
    stabilityMs: z.number().int().positive().max(600_000),
    /**
     * How long `start` waits for the CLI to boot and settle at its prompt before
     * returning. Keystrokes sent to a TUI that has not painted yet are lost.
     */
    startupTimeoutMs: positiveTimeoutSchema.optional(),
    /** Hard ceiling on a single turn, so a never-settling TUI cannot hang a run. */
    turnTimeoutMs: positiveTimeoutSchema
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
    interactive: externalAgentInteractiveConfigSchema.optional(),
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

export const externalAgentConfigSchema = z.discriminatedUnion("kind", [
  externalAgentClaudeConfigSchema,
  externalAgentCodexConfigSchema,
  externalAgentMistralVibeConfigSchema
]);

const externalAgentsConfigSchema = z
  .object({
    agents: z.record(z.string().min(1), externalAgentConfigSchema),
    enabled: z.boolean(),
    /** Defaults for every interactive session; each agent may override them. */
    interactive: z
      .object({
        /**
         * Open a shared terminal window as soon as an interactive session
         * starts, so the operator and the agent drive the same PTY without
         * anyone having to run `attach` first. Set false to keep sessions
         * headless (the attach command is still printed).
         */
        autoAttachOnStart: z.boolean(),
        cols: z.number().int().min(20).max(500),
        /** Milliseconds after a human keystroke during which agent writes are refused. */
        humanLockMs: z.number().int().min(0).max(600_000),
        idleMs: z.number().int().positive().max(600_000),
        rows: z.number().int().min(5).max(200),
        /** Warn (never block) once this many interactive sessions are live at once. */
        sessionWarningThreshold: z.number().int().positive().max(1_000),
        stabilityMs: z.number().int().positive().max(600_000),
        /** macOS application used to open a shared terminal window on request. */
        terminalApp: z.string().min(1).max(128),
        turnTimeoutMs: positiveTimeoutSchema
      })
      .strict(),
    /**
     * Environment variables every agent may read, merged with each agent's own
     * `passEnv` (the agent's list wins on a conflict).
     *
     * Exists so a variable needed by several CLIs is named once instead of per
     * preset. It is still an allowlist: external agents run with their own
     * approvals bypassed, so they must not inherit the whole shell. Empty by
     * default — see docs/EXTERNAL_AGENTS.md for a starter list.
     */
    passEnv: environmentVariableNamesSchema.default([]),
    pollIntervalMs: z.number().int().positive().max(60_000),
    stateRoot: z.string().min(1)
  })
  .strict();

const discordChannelConfigSchema = z
  .object({
    appId: secretInputSchema.optional(),
    botToken: secretInputSchema.optional(),
    defaultGuildId: z.string().min(1).max(256).optional(),
    enabled: z.boolean(),
    // Sender ids allowed to issue channel control commands (/approve, /deny,
    // /cancel, /steer). Security review H6: without this, anyone who could
    // post into the bound conversation could approve a pending dangerous tool
    // call. Empty means no one — control commands fail closed.
    operatorIdentities: z.array(z.string().min(1).max(256)).max(64).default([])
  })
  .strict();

const whatsappChannelConfigSchema = z
  .object({
    enabled: z.boolean(),
    // Sender ids allowed to issue channel control commands (/approve, /deny,
    // /cancel, /steer). Security review H6: without this, anyone who could
    // post into the bound conversation could approve a pending dangerous tool
    // call. Empty means no one — control commands fail closed.
    operatorIdentities: z.array(z.string().min(1).max(256)).max(64).default([]),
    sessionDirectory: z.string().min(1).optional()
  })
  .strict();

const teamsChannelConfigSchema = z
  .object({
    appId: secretInputSchema.optional(),
    appPassword: secretInputSchema.optional(),
    enabled: z.boolean(),
    // Sender ids allowed to issue channel control commands (/approve, /deny,
    // /cancel, /steer). Security review H6: without this, anyone who could
    // post into the bound conversation could approve a pending dangerous tool
    // call. Empty means no one — control commands fail closed.
    operatorIdentities: z.array(z.string().min(1).max(256)).max(64).default([]),
    publicBaseUrl: urlLikeStringSchema.optional(),
    tenantId: secretInputSchema.optional()
  })
  .strict();

const imessageChannelConfigSchema = z
  .object({
    blueBubblesPassword: secretInputSchema.optional(),
    blueBubblesUrl: urlLikeStringSchema.optional(),
    enabled: z.boolean(),
    // Sender ids allowed to issue channel control commands (/approve, /deny,
    // /cancel, /steer). Security review H6: without this, anyone who could
    // post into the bound conversation could approve a pending dangerous tool
    // call. Empty means no one — control commands fail closed.
    operatorIdentities: z.array(z.string().min(1).max(256)).max(64).default([])
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

// Up to an hour: a tool that reports progress keeps resetting its timeout.
const mcpTimeoutSchema = z.number().int().positive().max(3_600_000);
// Exact tool names as the server lists them.
const mcpToolNamesSchema = z.array(z.string().min(1).max(512)).max(2048);

const mcpServerBaseConfigSchema = z
  .object({
    description: z.string().min(1).max(2000).optional(),
    // These tools are never listed or callable. Applied after enabledTools.
    disabledTools: mcpToolNamesSchema.optional(),
    enabled: z.boolean(),
    // Only these tools are listed and callable (even [] means none).
    enabledTools: mcpToolNamesSchema.optional(),
    provenance: mcpServerProvenanceSchema.optional(),
    required: z.boolean(),
    // Each phase of connecting (starting and the handshake, then each listing)
    // gets this long. Default 30 s.
    startupTimeoutMs: mcpTimeoutSchema.optional(),
    tags: z.array(z.string().min(1).max(128)).max(64),
    // The older single setting: used for startupTimeoutMs and toolTimeoutMs
    // when those are not set.
    timeoutMs: positiveTimeoutSchema.optional(),
    // How long a tool call may go without progress. Default 300 s.
    toolTimeoutMs: mcpTimeoutSchema.optional(),
    // Approval trust for this server's tools. "trusted" auto-approves them via a
    // synthesized mcp_server allow rule (an explicit operator deny rule still
    // wins); omitted/"prompt" means every tool call is gated by the approval
    // policy. MCP tools never carry the "never" approval mode regardless.
    trust: z.enum(["prompt", "trusted"]).optional()
  })
  .strict();

const mcpStdioServerConfigSchema = mcpServerBaseConfigSchema
  .extend({
    args: z.array(z.string().min(1)).max(128).default([]),
    command: z.string().min(1),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string(), secretInputSchema).default({}),
    // Variables copied from aia's own environment on top of the base allowlist
    // (see src/core/process/environment.ts); `env` still wins.
    passEnv: environmentVariableNamesSchema.optional(),
    stderr: z.enum(["ignore", "inherit", "pipe"]).default("pipe"),
    type: z.literal("stdio")
  })
  .strict();

// OAuth for a remote server (`aia mcp login <name>`). Only needed when the
// server's authorization server does not support dynamic client registration,
// or wants specific scopes or a fixed redirect port.
const mcpOAuthConfigSchema = z
  .object({
    callbackPort: positivePortSchema.optional(),
    clientId: z.string().min(1).max(512).optional(),
    clientSecret: secretInputSchema.optional(),
    scopes: z.array(z.string().min(1).max(256)).max(64).optional()
  })
  .strict();

// A server's (or template's) name: any characters, since names like
// "brave search" or "@playwright/mcp" are common, but not empty and no longer
// than a status can report. An id built from one goes through toMcpIdSegment.
const mcpServerNameSchema = z.string().min(1).max(128);

// An MCP server is reached over http(s) only (security review M11): a
// `file:` or custom-scheme URL is never a server, and plain http to another
// machine is warned about when it connects.
const mcpServerUrlSchema = urlLikeStringSchema.refine(
  (value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  },
  { message: "must be an http:// or https:// URL" }
);

const mcpHttpServerConfigSchema = mcpServerBaseConfigSchema
  .extend({
    headers: z.record(z.string(), secretInputSchema).default({}),
    oauth: mcpOAuthConfigSchema.optional(),
    type: z.enum(["auto", "sse", "streamable-http"]),
    url: mcpServerUrlSchema
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
    // How long an MCP server's question (elicitation) waits for an answer
    // before it is declined. Default 10 minutes.
    elicitationTimeoutMs: mcpTimeoutSchema.optional(),
    imports: z.record(z.string(), mcpImportConfigSchema),
    // How long a request waits, from startup, for optional servers still
    // connecting; later ones join once connected. Default 1000; 0 waits for
    // each server's full startup timeout.
    optionalStartupGraceMs: z.number().int().min(0).max(600_000).optional(),
    // Variables every stdio server gets from aia's environment on top of the
    // base allowlist. Needs workspace trust when a workspace config sets it.
    passEnv: environmentVariableNamesSchema.optional(),
    servers: z.record(mcpServerNameSchema, mcpServerConfigSchema),
    templates: z.record(mcpServerNameSchema, mcpServerTemplateSchema),
    // Hot-reload MCP servers when a config/import file changes. Omitted is
    // treated as true. Disable for long-lived server processes that should not
    // reconnect mid-session on unrelated config edits.
    watch: z.boolean().optional()
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
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 * 1024)
      .optional(),
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
    maxOutputBytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024)
      .optional(),
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
    skills: skillsConfigSchema,
    tools: toolsConfigSchema,
    tunnel: tunnelConfigSchema,
    voice: voiceConfigSchema
  })
  .strict();

export const appConfigSchema = appConfigObjectSchema.superRefine((value, context) => {
  const enabledImageProviderIds = Object.entries(value.providers.imageProviders)
    .filter(([, providerConfig]) => providerConfig.enabled)
    .map(([providerId]) => providerId);

  if (enabledImageProviderIds.length > 0 && !enabledImageProviderIds.includes(value.image.defaultProviderId)) {
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
// Rules are never merged field by field (a file's list replaces or extends
// another's), so each must be complete in its own file, where an error can
// name that file.
export const approvalSettingsFragmentSchema = approvalSettingsSchema.partial();

export type AppConfig = z.infer<typeof appConfigSchema>;
export type AppConfigFragment = z.infer<typeof appConfigFragmentSchema>;
export type ApprovalSettings = z.infer<typeof approvalSettingsSchema>;
export type ApprovalSettingsFragment = z.infer<typeof approvalSettingsFragmentSchema>;
export type ExternalAgentConfig = z.infer<typeof externalAgentConfigSchema>;
export type ExternalAgentConfigKind = z.infer<typeof externalAgentConfigKindSchema>;
export type ExternalAgentsConfig = z.infer<typeof externalAgentsConfigSchema>;
export type ImageConfig = z.infer<typeof imageConfigSchema>;
export type ImageProviderConfig = z.infer<typeof imageProviderConfigSchema>;
export type RuntimeModelSettings = z.infer<typeof runtimeModelSettingsSchema>;
export type SecretInput = z.infer<typeof secretInputSchema>;
export type SecretProviderConfig = z.infer<typeof secretProviderConfigSchema>;
export type SecretRef = z.infer<typeof secretRefSchema>;
export type SkillsConfig = z.infer<typeof skillsConfigSchema>;

/** The `skills` section's defaults: the default config's, and skill discovery's when it is given none. */
export const DEFAULT_SKILLS_CONFIG: SkillsConfig = { bundled: true, disabled: [], enabled: true, extraRoots: [] };
export type ToolsConfig = z.infer<typeof toolsConfigSchema>;
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
        enabled: false,
        operatorIdentities: []
      },
      imessage: {
        enabled: false,
        operatorIdentities: []
      },
      teams: {
        enabled: false,
        operatorIdentities: []
      },
      whatsapp: {
        enabled: false,
        operatorIdentities: [],
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
          interactive: {
            // Claude has no inline-mode flag on current builds, so it runs in the
            // alternate screen and relies on terminal-screen reconstruction.
            args: ["--dangerously-skip-permissions"],
            idleMs: 2_000,
            stabilityMs: 1_000,
            turnTimeoutMs: 600_000
          },
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
          interactive: {
            // `--no-alt-screen` keeps Codex in inline mode, preserving scrollback;
            // the alternate screen is the single biggest obstacle to reliable
            // capture, so avoiding it helps both the model and the human window.
            // `check_for_update_on_startup=false` keeps Codex from opening on
            // its "Update available" screen, where the first send chose
            // "Update now" and started `brew upgrade`.
            args: [
              "--no-alt-screen",
              "--dangerously-bypass-approvals-and-sandbox",
              "-c",
              "check_for_update_on_startup=false"
            ],
            idleMs: 2_000,
            // Codex's input box; nothing is sent until it is on screen.
            inputPattern: "Ask Codex to do anything",
            stabilityMs: 1_000,
            turnTimeoutMs: 600_000
          },
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
      interactive: {
        autoAttachOnStart: true,
        cols: 120,
        humanLockMs: 10_000,
        idleMs: 2_000,
        rows: 40,
        sessionWarningThreshold: 4,
        stabilityMs: 1_000,
        terminalApp: "Terminal",
        turnTimeoutMs: 600_000
      },
      passEnv: [],
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
      // Enabled like the others: an adapter costs nothing until a turn asks
      // for it with runtime.defaultProvider "llama_cpp".
      llamaCpp: {
        baseUrl: DEFAULT_LLAMA_CPP_BASE_URL,
        enabled: true,
        headers: {},
        streamFirstTokenTimeoutMs: 1_800_000,
        streamIdleTimeoutMs: 60_000,
        timeoutMs: 120_000
      },
      lmStudio: {
        baseUrl: DEFAULT_LM_STUDIO_BASE_URL,
        enabled: true,
        headers: {},
        model: DEFAULT_LM_STUDIO_MODEL,
        streamFirstTokenTimeoutMs: 1_800_000,
        streamIdleTimeoutMs: 60_000,
        timeoutMs: 120_000
      },
      ollama: {
        baseUrl: DEFAULT_OLLAMA_BASE_URL,
        enabled: true,
        headers: {},
        streamFirstTokenTimeoutMs: 1_800_000,
        streamIdleTimeoutMs: 60_000,
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
      maxConsecutiveNudges: 3,
      maxIdenticalToolCalls: 3,
      maxTurnsPerRun: "unlimited",
      // Cap a single generation so a looping/rambling local model cannot stream
      // unbounded until the request times out; repetitionPenalty is a mild,
      // vendor-default-aligned anti-loop guard sent explicitly to both adapters.
      modelSettings: {
        maxOutputTokens: 8192,
        repetitionPenalty: 1.1
      },
      promptBudgets: {
        activeSkillsChars: 16_000,
        instructionDocChars: 12_000,
        memorySummaryChars: 4_000
      },
      reasoningContextTurns: 1,
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
    skills: structuredClone(DEFAULT_SKILLS_CONFIG),
    tools: {
      exclude: [],
      include: [],
      profile: "lean"
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
  // Patterns are JS regex sources written as TS string literals, so a regex
  // escape needs exactly one doubled backslash here ("\\s" -> \s). A previous
  // revision quadrupled them, which turned `\s`/`\b` into literal characters
  // and silently disabled the destructive-command deny rule (security review
  // H1). tests/unit/approval-defaults.test.ts exercises the shipped rules.
  rules: [
    // These come before the read-only allow: the first matching allow/ask rule
    // decides, and each is an inspection command used in a way that writes
    // files or runs other programs. Commands are matched one at a time, so a
    // pattern anchored at ^ sees each command of a pipeline or `;` list.
    {
      id: "rule.command.read.sed-writes.ask",
      mode: "ask",
      notes: "sed that edits in place, runs a script file, or whose script writes files (w) or runs commands (e).",
      pattern: "^sed\\b.*(\\s-[A-Za-z]*[if]|\\s--(in-place|file)\\b|[\\s'\";{}0-9$/=!][ewW]\\b)",
      targetKind: "command"
    },
    {
      id: "rule.command.read.find-actions.ask",
      mode: "ask",
      notes:
        "find that runs commands (-exec, -execdir, -ok, -okdir), deletes (-delete), or writes files (-fprint, -fls).",
      pattern: "^find\\b.*\\s-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)\\b",
      targetKind: "command"
    },
    {
      id: "rule.command.read.rg-preprocessor.ask",
      mode: "ask",
      notes: "rg --pre runs a program on every file it searches.",
      pattern: "^rg\\b.*\\s--pre\\b",
      targetKind: "command"
    },
    {
      id: "rule.command.read.git-diff-writes.ask",
      mode: "ask",
      notes: "git diff that runs an external diff program (--ext-diff) or writes a file (--output).",
      pattern: "^git\\s+diff\\b.*\\s--(ext-diff|output)\\b",
      targetKind: "command"
    },
    {
      id: "rule.command.read.allow",
      mode: "allow",
      notes: "Common read-only shell inspection commands.",
      pattern: "^(pwd|ls|find|rg|grep|sed|cat|head|tail|wc|git status|git diff)(\\b|$)",
      targetKind: "command"
    },
    {
      id: "rule.command.build.ask",
      mode: "ask",
      notes: "Build, test, and package-manager commands should stay operator-visible.",
      pattern:
        "^(npm|pnpm|yarn|bun|node|tsx|vitest|playwright|python3?|pytest|cargo|go|java|javac|gradle|\\./gradlew)(\\b|$)",
      targetKind: "command"
    },
    {
      id: "rule.command.destructive.rm.deny",
      mode: "deny",
      notes:
        "Block recursive deletes of the filesystem root, home, the current directory, or a bare glob, and any --no-preserve-root use.",
      pattern:
        "(^|[\\s;&|])(sudo\\s+)?rm\\s+(-[A-Za-z]*[rR][A-Za-z]*\\s+(/|~|\\*|\\.|\\$HOME)/?\\*?(\\s|$)|.*--no-preserve-root)",
      targetKind: "command"
    },
    {
      id: "rule.command.destructive.disk.deny",
      mode: "deny",
      notes:
        "Block filesystem formatting and raw device writes (mkfs, dd/shred to /dev, redirecting output onto a disk device).",
      pattern:
        "(^|[\\s;&|])(sudo\\s+)?(mkfs(\\.[a-z0-9]+)?\\s|dd\\s.*\\bof=/dev/|shred\\s.*/dev/|>\\s*/dev/(sd|nvme|disk|hd|mmcblk))",
      targetKind: "command"
    },
    {
      id: "rule.command.destructive.system.deny",
      mode: "deny",
      notes:
        "Block host shutdown and reboot commands (as the command itself, not as a word inside another command's arguments).",
      pattern: "(^|[;&|]\\s*)(sudo\\s+)?(shutdown|reboot|halt|poweroff)(\\s|$)",
      targetKind: "command"
    },
    {
      id: "rule.command.destructive.permissions.deny",
      mode: "deny",
      notes: "Block recursive permission or ownership changes of the filesystem root.",
      pattern: "(^|[\\s;&|])(sudo\\s+)?ch(mod|own)\\s+-[A-Za-z]*R[A-Za-z]*\\s+\\S+\\s+/(\\s|$)",
      targetKind: "command"
    },
    {
      id: "rule.command.destructive.forkbomb.deny",
      mode: "deny",
      notes: "Block the classic shell fork bomb.",
      pattern: ":\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&\\s*\\}\\s*;\\s*:",
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
