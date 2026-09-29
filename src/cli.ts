import { readFileSync, realpathSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  FileSessionStore,
  buildVoiceAudioArtifact,
  createVoiceServiceFromConfig,
  ensureStateRootWritable,
  loadAIAgentConfig,
  grantConfigTrust,
  revokeConfigTrust,
  stringifyArgv,
  APP_CONFIG_FILE_NAME,
  CLI_NAME,
  COMPLETION_SUMMARY_MESSAGE_TAG,
  DEFAULT_LM_STUDIO_MODEL,
  readApprovalTargets,
  repeatsShownText,
  type AppConfig,
  type ArtifactReference,
  type LoadedAIAgentConfig,
  type SecretProviderConfig,
  type SessionRecord,
  type StructuredError,
  type VoiceCaptureRecord,
  type VoiceService
} from "@/core";
import { createAIAgentSdkFromConfig, type AIAgentSdk, type AIAgentSessionHandle } from "@/sdk";
import { attachToExternalAgentSession } from "@/gateway/attach-client";
import { MODEL_MISMATCH_LOG_CODE } from "@/gateway/runtime";
import { readAttachEndpoint, serveAttachEndpoint, type ServedAttachEndpoint } from "@/gateway/attach-endpoint";
import type {
  GatewayApprovalRecord,
  GatewayEvent,
  GatewayRunCompletionReason,
  GatewayRunRecord,
  GatewaySessionCompactResult,
  GatewaySessionSnapshot,
  JsonValue,
  Message,
  SessionSnapshot,
  ToolCallRecord
} from "@/core/contracts";

type CliStream = Pick<NodeJS.WriteStream, "write">;

type CliStreams = {
  stderr: CliStream;
  stdout: CliStream;
};

/**
 * Interactive input, with an explicit distinction between "the next line of
 * the conversation" and "a line typed in answer to a question we just asked".
 *
 * The distinction exists because the stdin reader buffers from the moment it
 * is created, so anything typed while the agent was working — most commonly an
 * impatient Enter — is already queued when an approval prompt appears.
 * Consuming it as the answer silently denied the request, and the operator's
 * real keystroke then landed on the next prompt. An answer must be typed
 * *after* the question was asked.
 */
export type CliLineReader = {
  /** Releases the underlying input (e.g. the readline interface). */
  close?(): void | Promise<void>;
  /** Drops input that arrived before now. No-op unless stdin is a terminal. */
  discardBuffered(): void;
  /**
   * True when a person is typing at a terminal. Only then does the REPL take
   * input while it is still starting; piped or scripted lines wait for
   * startup, because their order (approval answers included) is deliberate.
   */
  interactive?: boolean;
  next(): Promise<string | null>;
};

/**
 * Where Ctrl-C comes from. The REPL takes SIGINT itself, so Ctrl-C cancels
 * the running turn instead of killing aia and everything it started.
 */
export type CliInterruptSource = {
  subscribe(listener: () => void): () => void;
};

type CliDependencies = {
  // Overrides the terminal relay used by `aia attach`, so tests never need a
  // real gateway socket.
  attachToExternalAgentSession?: typeof attachToExternalAgentSession;
  // Overrides how the SDK is created. Lets tests drive the loop without a full
  // runtime; defaults to createAIAgentSdkFromConfig. `loaded` is the config the
  // caller already read, when it read one.
  createSdk?: (options: { cwd: string; loaded?: LoadedAIAgentConfig }) => Promise<AIAgentSdk>;
  // Overrides how the voice context (voice service + session store) is built for
  // `aia voice` subcommands. Lets tests drive them without native voice adapters;
  // defaults to building from the loaded config.
  createVoiceContext?: () => Promise<VoiceCliContext>;
  // Overrides the interactive line source. When omitted, a readline interface
  // over process.stdin is used (only when stdin is a TTY).
  interactiveInput?: AsyncIterable<string> | CliLineReader;
  // Overrides where the REPL's Ctrl-C comes from. Defaults to the process's
  // SIGINT, but only when the REPL reads the real stdin: a test that injects
  // its input gets no interrupts unless it passes its own, so a test run never
  // swallows a real Ctrl-C.
  interrupts?: CliInterruptSource;
  // Overrides the loopback gateway listener the REPL publishes for `aia attach`.
  // Tests substitute a recorder so they never bind a real port.
  serveAttachEndpoint?: (sdk: AIAgentSdk) => Promise<ServedAttachEndpoint | null>;
  // Overrides the home directory whose `.aia/` holds the user-global config and
  // the trust store, so tests never read or write the developer's real one.
  userHomeDirectory?: string;
};

const CHAT_PROMPT = "› ";
const ANSI_DIM = "[2m";
const ANSI_RESET = "[0m";

// Per-REPL-session approval memory. `alwaysApprove` holds `${kind}:${value}`
// keys of approval targets the operator answered "a" (always) for; matching
// requests are auto-approved for the rest of this CLI session only. Nothing is
// persisted: every approval is still recorded as its own resolution.
type CliApprovalState = {
  alwaysApprove: Set<string>;
};

function createCliApprovalState(): CliApprovalState {
  return {
    alwaysApprove: new Set<string>()
  };
}

type VoiceCliContext = {
  sessions: FileSessionStore;
  voiceService: VoiceService;
};

function formatHelp(): string {
  return [
    "AIAgent CLI",
    "",
    "Available commands:",
    "  aia                  Start an interactive session (stays open until /exit or /quit)",
    "  aia info [--cwd <path>]",
    "                       Print the version, the config files in effect, and the chat model",
    "  aia attach <id>      Join a live interactive external-agent terminal (Ctrl-] to detach)",
    "  aia trust [--grant | --revoke] [--cwd <path>]",
    "                       Show, grant, or revoke trust for this workspace's config file",
    "  aia --help",
    "  aia --version        Print the version and exit",
    "  aia --prompt <text> [--cwd <path>] [--goal <text>] [--title <text>]",
    "  aia voice --help",
    "",
    "Voice subcommands:",
    "  aia voice list-voices [--provider <id>] [--locale <locale>]",
    "  aia voice list-devices [--provider <id>] [--kind input|output]",
    "  aia voice transcribe-file --file <path> [--provider <id>] [--locale <locale>] [--session <id>]",
    "  aia voice capture [--provider <id>] [--locale <locale>] [--session <id>] [--input-device <id>]",
    "  aia voice synthesize --text <text> [--provider <id>] [--voice <voice>] [--locale <locale>]",
    "  aia voice speak --text <text> [--provider <id>] [--voice <voice>] [--output-device <id>]"
  ].join("\n");
}

function formatVoiceHelp(): string {
  return [
    "AIAgent voice CLI",
    "",
    "Subcommands:",
    "  list-voices     List configured synthesis voices",
    "  list-devices    List configured input/output devices",
    "  transcribe-file Transcribe a local audio file and optionally append it to a session",
    "  capture         Record from the microphone until Ctrl+C, silence timeout, or max duration",
    "  synthesize      Generate a local speech artifact and print its URI",
    "  speak           Play synthesized speech through the local output device"
  ].join("\n");
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  streams: CliStreams = { stderr: process.stderr, stdout: process.stdout },
  deps: CliDependencies = {}
): Promise<number> {
  if (argv[0] === "voice") {
    return runVoiceCli(argv.slice(1), streams, deps);
  }

  if (argv[0] === "info") {
    return runInfoCli(argv.slice(1), streams, deps);
  }

  if (argv[0] === "attach") {
    return runAttachCli(argv.slice(1), streams, deps);
  }

  if (argv[0] === "trust") {
    return runTrustCli(argv.slice(1), streams, deps);
  }

  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      cwd: {
        type: "string"
      },
      goal: {
        type: "string"
      },
      help: {
        short: "h",
        type: "boolean"
      },
      prompt: {
        type: "string"
      },
      title: {
        type: "string"
      },
      version: {
        type: "boolean"
      }
    }
  });

  if (values.help) {
    writeLine(streams.stdout, formatHelp());
    return 0;
  }

  if (values.version) {
    writeLine(streams.stdout, `${CLI_NAME} ${readCliVersion()}`);
    return 0;
  }

  if (values.prompt) {
    return runPromptCli(
      {
        cwd: values.cwd ? path.resolve(values.cwd) : process.cwd(),
        goal: values.goal ?? values.prompt,
        prompt: values.prompt,
        title: values.title ?? "CLI Session"
      },
      streams,
      deps
    );
  }

  // No one-shot prompt: always enter the interactive REPL. On a TTY this is a
  // live session; when stdin is piped it reads lines until EOF. The loop ends on
  // /exit, /quit, or end-of-input.
  const lineSource = deps.interactiveInput ? toLineReader(deps.interactiveInput) : createStdinLineReader();
  return runChatCli(
    {
      cwd: values.cwd ? path.resolve(values.cwd) : process.cwd(),
      goal: values.goal ?? "Interactive CLI session",
      title: values.title ?? "CLI Session"
    },
    streams,
    lineSource,
    deps
  );
}

/**
 * The CLI's version, read from the package manifest rather than kept as a second constant that
 * could drift from it.
 *
 * Resolved from this module's own path, which works both for `src/cli.ts` under tsx and for the
 * bundled `dist/cli.js`: each sits one directory below `package.json`.
 */
function readCliVersion(): string {
  const manifestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
  return typeof manifest.version === "string" ? manifest.version : "unknown";
}

/**
 * Describes the configuration `aia` would run with here, without starting it.
 *
 * Secrets are left unresolved: describing the config must never run a secret
 * provider (a password-manager CLI, say) just to print a path.
 */
async function runInfoCli(args: string[], streams: CliStreams, deps: CliDependencies): Promise<number> {
  let parsed: { values: { cwd?: string; help?: boolean } };
  try {
    parsed = parseArgs({
      args,
      allowPositionals: false,
      options: {
        cwd: { type: "string" },
        help: { short: "h", type: "boolean" }
      }
    });
  } catch (error) {
    writeLine(streams.stderr, renderCliError(error));
    return 1;
  }

  if (parsed.values.help) {
    writeLine(
      streams.stdout,
      "aia info [--cwd <path>] — print the version, the config files in effect, and the chat model, without starting a session."
    );
    return 0;
  }

  writeLine(streams.stdout, `${CLI_NAME} ${readCliVersion()}`);
  try {
    const loaded = await loadAIAgentConfig({
      cwd: parsed.values.cwd ? path.resolve(parsed.values.cwd) : process.cwd(),
      resolveSecrets: false,
      userHomeDirectory: deps.userHomeDirectory
    });
    writeLine(streams.stdout, formatConfigInfo(loaded));
    return 0;
  } catch (error) {
    writeLine(streams.stderr, `The config could not be loaded: ${renderCliError(error)}`);
    return 1;
  }
}

export function formatConfigInfo(loaded: LoadedAIAgentConfig): string {
  const { config, sources, workspaceTrust } = loaded;
  const approvals = [sources.approvals.global, sources.approvals.workspace].filter((file) => file !== null);
  const gatewayHost = config.gateway.hostname.includes(":") ? `[${config.gateway.hostname}]` : config.gateway.hostname;
  const trust = !workspaceTrust.required
    ? "not needed (no exec/file secret providers in the workspace config)"
    : workspaceTrust.trusted
      ? "trusted"
      : `not trusted, so ${workspaceTrust.untrustedProviderNames.join(", ")} will not run (see \`aia trust\`)`;

  return [
    `Workspace:          ${loaded.paths.workspaceRoot}`,
    `Workspace config:   ${sources.config.workspace ?? `none (no ${APP_CONFIG_FILE_NAME} found from ${loaded.paths.workspaceRoot} upward)`}`,
    `User-global config: ${sources.config.global.join(", ") || "none"}`,
    `Approvals:          ${approvals.join(", ") || "built-in defaults"}`,
    `Env overrides:      ${sources.config.env || sources.approvals.env ? "applied (AIA_* variables)" : "none"}`,
    `Chat model:         ${describeDefaultChatModel(config)}`,
    `State directory:    ${config.memory.stateRoot}`,
    `Gateway:            ${gatewayHost}:${config.gateway.port}, WebSocket path ${config.gateway.websocketPath}`,
    `Config trust:       ${trust}`
  ].join("\n");
}

/**
 * The model a turn asks the default provider for when the session names none,
 * and where that provider is. Mirrors LanguageModelRuntime.resolveRequest for
 * the built-in adapters: the provider's own `model` wins over
 * `runtime.defaultModel`.
 */
function describeDefaultChatModel(config: AppConfig): string {
  const provider = config.runtime.defaultProvider;
  const settings =
    provider === "lm_studio" ? config.providers.lmStudio : provider === "ollama" ? config.providers.ollama : undefined;
  const model = settings?.model ?? config.runtime.defaultModel;
  return settings ? `${model} (${provider} at ${settings.baseUrl})` : `${model} (${provider})`;
}

async function runChatCli(
  input: {
    cwd: string;
    goal: string;
    title: string;
  },
  streams: CliStreams,
  lineSource: CliLineReader,
  deps: CliDependencies
): Promise<number> {
  let loaded: LoadedAIAgentConfig;
  try {
    // Read once for the whole REPL. The SDK, the attach listener and the
    // model-provenance hint each used to load it again, which resolved every
    // secret the config references three times per start: three runs of an
    // `exec` provider such as a password-manager CLI, each of which may prompt.
    loaded = await loadAIAgentConfig({ cwd: input.cwd, userHomeDirectory: deps.userHomeDirectory });
    // Quick and local, so a state directory aia cannot write stops it here,
    // before a prompt invites any typing.
    await ensureStateRootWritable(loaded);
  } catch (error) {
    writeLine(streams.stderr, `Failed to start AIAgent: ${renderCliError(error)}`);
    await lineSource.close?.();
    return 1;
  }

  // Everything slower (MCP servers, memory, the model check, the session)
  // starts behind the prompt, so a person can start typing at once.
  let stopRequested = false;
  const startup = settle(startChatRuntime({ deps, input, loaded, stopped: () => stopRequested }));
  const reader = new CliInput(lineSource);
  const screen = new ReplScreen(streams);
  const interrupts = new CliInterrupts(deps.interrupts ?? (deps.interactiveInput ? undefined : processInterrupts));
  // The outermost scope: a Ctrl-C that nothing more specific is waiting for
  // (at the prompt, or a second one while a turn is cancelling) leaves.
  const exitScope = interrupts.open();
  const restoreWarnings = routeProcessWarnings(screen, streams.stderr);

  try {
    return await runChatRepl({
      approvalState: createCliApprovalState(),
      exitSignal: exitScope.signal,
      input: reader,
      interrupts,
      screen,
      startup,
      stopStartup: () => {
        stopRequested = true;
      },
      streams
    });
  } catch (error) {
    screen.breakLine();
    writeLine(streams.stderr, `Failed to start AIAgent: ${renderCliError(error)}`);
    return 1;
  } finally {
    // Every exit path releases what this REPL opened. A readline over a TTY and
    // a bound listener each keep the process alive, so an early return (model
    // unreachable, session creation failing) left `aia` running after it had
    // already printed why it was stopping. A Ctrl-C from here on gets Node's
    // default: it ends the process without waiting for the cleanup.
    stopRequested = true;
    restoreWarnings();
    interrupts.dispose();
    await lineSource.close?.();
    const outcome = await startup;
    if (outcome.ok && outcome.value) {
      await outcome.value.attachEndpoint?.close().catch(() => undefined);
      await outcome.value.sdk.close().catch(() => undefined);
    }
  }
}

type ChatRuntime = {
  attachEndpoint: ServedAttachEndpoint | null;
  handle: AIAgentSessionHandle;
  // Formatted once, not per turn: it only changes if the config files do, and
  // a failing turn is the worst moment to start reading the filesystem.
  modelProvenance: string;
  sdk: AIAgentSdk;
  sessionId: string;
};

type ChatReplContext = {
  approvalState: CliApprovalState;
  // Aborted once the operator asked to leave with Ctrl-C.
  exitSignal: AbortSignal;
  input: CliInput;
  interrupts: CliInterrupts;
  screen: ReplScreen;
  startup: Promise<Settled<ChatRuntime | null>>;
  stopStartup: () => void;
  streams: CliStreams;
};

/** A startup failure whose message is already the whole explanation. */
class ChatStartupError extends Error {}

/**
 * Brings up what a chat needs, in order. Returns null, having closed what it
 * opened, when `stopped()` turns true on the way (the operator left during
 * startup); on a failure it closes what it opened and rethrows.
 */
async function startChatRuntime(params: {
  deps: CliDependencies;
  input: { cwd: string; goal: string; title: string };
  loaded: LoadedAIAgentConfig;
  stopped: () => boolean;
}): Promise<ChatRuntime | null> {
  const { deps, input, loaded } = params;
  const sdk = await resolveSdk(deps, input.cwd, loaded);
  let attachEndpoint: ServedAttachEndpoint | null = null;
  const release = async (): Promise<void> => {
    await attachEndpoint?.close().catch(() => undefined);
    await sdk.close().catch(() => undefined);
  };

  try {
    if (params.stopped()) {
      await release();
      return null;
    }
    // A REPL with no reachable chat model is useless, so this is a startup
    // failure rather than a session that errors on every turn.
    const model = await probeModelHealth(sdk);
    if (model.status !== "healthy") {
      throw new ChatStartupError(formatModelUnavailable(model));
    }
    if (params.stopped()) {
      await release();
      return null;
    }

    // Serve the gateway on loopback so a terminal window opened for an
    // interactive external-agent session has something to attach to. Only the
    // dev/prod server used to listen, so a window opened from here died on
    // ECONNREFUSED. A failure to listen is not fatal: the REPL is still
    // perfectly usable without a shared terminal.
    attachEndpoint = deps.serveAttachEndpoint
      ? await deps.serveAttachEndpoint(sdk)
      : await serveAttachEndpoint({
          requestTimeoutMs: loaded.resolvedConfig.gateway.requestTimeoutMs,
          runtime: sdk.controlPlane,
          stateRoot: loaded.resolvedConfig.memory.stateRoot,
          ...(typeof loaded.resolvedConfig.gateway.auth.token === "string"
            ? { token: loaded.resolvedConfig.gateway.auth.token }
            : {}),
          websocketPath: loaded.resolvedConfig.gateway.websocketPath
        });
    // Only now can an interactive external-agent session open a window that
    // reaches this process; without a listener no window is opened at all.
    if (attachEndpoint) {
      sdk.controlPlane.setAttachEndpoint?.(attachEndpoint.url);
    }
    if (params.stopped()) {
      await release();
      return null;
    }

    const created = await sdk.sessions.create({
      cwd: input.cwd,
      goal: input.goal,
      metadata: {
        surface: "cli"
      },
      title: input.title
    });
    return {
      attachEndpoint,
      handle: created.handle,
      modelProvenance: formatChatModelProvenance(loaded),
      sdk,
      sessionId: created.session.id
    };
  } catch (error) {
    await release();
    throw error;
  }
}

async function runChatRepl(context: ChatReplContext): Promise<number> {
  const started = context.input.interactive ? await startWhileTyping(context) : await startBeforeReading(context);
  if (typeof started === "number") {
    return started;
  }

  for (const line of started.held) {
    // Say which held line is going now: several may have piled up.
    writeLine(
      context.streams.stderr,
      `${ANSI_DIM}· ${parseChatCommand(line) === "message" ? "Sending" : "Running"}: ${line}${ANSI_RESET}`
    );
    const exitCode = await dispatchChatLine(line, started.runtime, context);
    if (exitCode !== undefined) {
      return exitCode;
    }
  }

  for (;;) {
    context.screen.prompt(CHAT_PROMPT);
    // The conversation prompt deliberately does *not* drain: lines typed
    // while the agent worked are the operator's next message, queued on
    // purpose. Only question prompts discard stale input.
    const raw = await context.input.read(context.exitSignal);
    if (raw === INTERRUPTED) {
      context.screen.breakLine();
      writeLine(context.streams.stdout, "Goodbye.");
      return 130;
    }
    context.screen.inputReceived();
    if (raw === null) {
      return 0;
    }
    const line = raw.trim();
    if (line.length === 0) {
      continue;
    }
    const exitCode = await dispatchChatLine(line, started.runtime, context);
    if (exitCode !== undefined) {
      return exitCode;
    }
  }
}

/**
 * Piped or scripted input: nothing is read until startup is done, so a
 * script's lines keep their order and meaning (an approval answer is still
 * read as the answer), exactly as before the prompt came up early.
 */
async function startBeforeReading(
  context: ChatReplContext
): Promise<number | { held: string[]; runtime: ChatRuntime }> {
  const outcome = await raceAbort(context.startup, context.exitSignal);
  if (outcome === INTERRUPTED) {
    context.stopStartup();
    writeLine(context.streams.stdout, "Goodbye.");
    return 130;
  }
  if (!outcome.ok) {
    writeStartupFailure(context.streams, outcome.error);
    return 1;
  }
  if (!outcome.value) {
    return 0;
  }
  writeLine(context.streams.stdout, formatChatWelcome(outcome.value.sessionId));
  return { held: [], runtime: outcome.value };
}

/**
 * A person at a terminal: the prompt is up while startup runs. Messages and
 * commands that need the session are held and run once it is ready; /help and
 * mistakes are answered at once; /exit, Ctrl-D and Ctrl-C stop startup and
 * leave, printing anything held so it is not silently lost.
 */
async function startWhileTyping(context: ChatReplContext): Promise<number | { held: string[]; runtime: ChatRuntime }> {
  const { screen, streams } = context;
  const held: string[] = [];
  const leave = (exitCode: number, farewell: boolean): number => {
    context.stopStartup();
    writeUnsent(streams, held);
    if (farewell) {
      writeLine(streams.stdout, "Goodbye.");
    }
    return exitCode;
  };
  // A read that loses to startup finishing stays pending for the next read.
  const startupDone = new AbortController();
  void context.startup.then(() => {
    startupDone.abort();
  });

  writeLine(streams.stdout, formatChatWelcome());
  screen.prompt(CHAT_PROMPT);
  for (;;) {
    const raw = await context.input.read(AbortSignal.any([context.exitSignal, startupDone.signal]));
    if (raw === INTERRUPTED) {
      screen.breakLine();
      if (context.exitSignal.aborted) {
        return leave(130, true);
      }
      const outcome = await context.startup;
      if (!outcome.ok) {
        writeStartupFailure(streams, outcome.error);
        writeUnsent(streams, held);
        return 1;
      }
      if (!outcome.value) {
        return 0;
      }
      writeLine(streams.stdout, `Session: ${outcome.value.sessionId}`);
      return { held, runtime: outcome.value };
    }

    screen.inputReceived();
    if (raw === null) {
      return leave(0, false);
    }
    const line = raw.trim();
    if (line.length > 0) {
      const command = parseChatCommand(line);
      if (command === "exit") {
        return leave(0, true);
      }
      if (command === "help") {
        writeLine(streams.stdout, formatChatHelp());
      } else if (command === "unknown") {
        writeLine(streams.stderr, formatUnknownChatCommand(line));
      } else {
        held.push(line);
        writeLine(
          streams.stderr,
          `${ANSI_DIM}· Still starting up. ${command === "message" ? "This is sent" : "This runs"} as soon as the session is ready.${ANSI_RESET}`
        );
      }
    }
    screen.prompt(CHAT_PROMPT);
  }
}

/** Runs one line from the prompt. Returns an exit code when the REPL should end. */
async function dispatchChatLine(
  line: string,
  runtime: ChatRuntime,
  context: ChatReplContext
): Promise<number | undefined> {
  const { sdk } = runtime;
  const { streams } = context;
  switch (parseChatCommand(line)) {
    case "exit":
      writeLine(streams.stdout, "Goodbye.");
      return 0;
    case "help":
      writeLine(streams.stdout, formatChatHelp());
      return undefined;
    case "mcp":
      try {
        const { servers } = await sdk.request("mcp.list", {});
        writeLine(streams.stdout, formatMcpServers(servers));
      } catch (error) {
        writeLine(streams.stderr, `Failed to list MCP servers: ${renderCliError(error)}`);
      }
      return undefined;
    case "compact":
      await runCompactCommand(runtime.handle, streams);
      return undefined;
    case "agents":
      try {
        const { sessions } = await sdk.request("external_agent.session.list", {});
        writeLine(streams.stdout, formatExternalAgentSessions(sessions));
      } catch (error) {
        writeLine(streams.stderr, `Failed to list interactive external-agent sessions: ${renderCliError(error)}`);
      }
      return undefined;
    case "attach": {
      const externalSessionId = line.slice(1).trim().split(/\s+/u)[1];
      if (!externalSessionId) {
        writeLine(streams.stderr, "Usage: /attach <external-session-id> (see /agents)");
        return undefined;
      }
      try {
        const result = await sdk.request("external_agent.session.attach", {
          externalSessionId
        });
        writeLine(streams.stdout, `Opened a terminal window running: ${result.command}`);
      } catch (error) {
        writeLine(streams.stderr, `Failed to attach to ${externalSessionId}: ${renderCliError(error)}`);
      }
      return undefined;
    }
    case "unknown":
      writeLine(streams.stderr, formatUnknownChatCommand(line));
      return undefined;
    case "message":
      await runChatTurn(runtime.handle, line, {
        approvalState: context.approvalState,
        exitSignal: context.exitSignal,
        input: context.input,
        interrupts: context.interrupts,
        modelProvenance: runtime.modelProvenance,
        screen: context.screen,
        streams
      });
      if (context.exitSignal.aborted) {
        writeLine(streams.stdout, "Goodbye.");
        return 130;
      }
      return undefined;
  }
}

function formatUnknownChatCommand(line: string): string {
  return `Unknown command "${line}". Type /help for options, or /exit to leave.`;
}

function writeStartupFailure(streams: CliStreams, error: unknown): void {
  writeLine(
    streams.stderr,
    error instanceof ChatStartupError ? error.message : `Failed to start AIAgent: ${renderCliError(error)}`
  );
}

// Held lines were typed but never reached the agent; print them so they can be
// copied into the next session instead of silently disappearing.
function writeUnsent(streams: CliStreams, held: string[]): void {
  if (held.length === 0) {
    return;
  }
  writeLine(streams.stderr, "Not sent:");
  for (const line of held) {
    writeLine(streams.stderr, `  ${line}`);
  }
}

type Settled<T> = { ok: true; value: T } | { error: unknown; ok: false };

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { error, ok: false };
  }
}

const INTERRUPTED = Symbol("interrupted");

/** Resolves with the promise's value, or with INTERRUPTED once `signal` aborts. */
async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof INTERRUPTED> {
  if (signal.aborted) {
    return INTERRUPTED;
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<typeof INTERRUPTED>((resolve) => {
    onAbort = () => {
      resolve(INTERRUPTED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort as () => void);
  }
}

const processInterrupts: CliInterruptSource = {
  subscribe(listener) {
    process.on("SIGINT", listener);
    return () => {
      process.off("SIGINT", listener);
    };
  }
};

/**
 * Hands each Ctrl-C to the innermost scope that is still listening. A turn
 * opens a scope that cancels it; once that has fired, the next Ctrl-C reaches
 * the REPL's own scope, which exits.
 */
class CliInterrupts {
  private readonly scopes: AbortController[] = [];
  private readonly unsubscribe: () => void;

  constructor(source: CliInterruptSource | undefined) {
    this.unsubscribe = source?.subscribe(() => this.deliver()) ?? (() => undefined);
  }

  open(): { close(): void; signal: AbortSignal } {
    const controller = new AbortController();
    this.scopes.push(controller);
    return {
      close: () => {
        const index = this.scopes.indexOf(controller);
        if (index !== -1) {
          this.scopes.splice(index, 1);
        }
      },
      signal: controller.signal
    };
  }

  dispose(): void {
    this.unsubscribe();
  }

  private deliver(): void {
    for (let index = this.scopes.length - 1; index >= 0; index -= 1) {
      const scope = this.scopes[index] as AbortController;
      if (!scope.signal.aborted) {
        scope.abort();
        return;
      }
    }
  }
}

/**
 * The REPL's one reader. A read that loses a race (to a Ctrl-C, or to startup
 * finishing) stays pending and goes to whoever reads next, so a typed line is
 * never swallowed by a read nobody is waiting on any more.
 */
class CliInput {
  private pending: { promise: Promise<string | null>; settled: boolean } | null = null;

  constructor(private readonly reader: CliLineReader) {}

  get interactive(): boolean {
    return this.reader.interactive === true;
  }

  async read(signal?: AbortSignal): Promise<string | null | typeof INTERRUPTED> {
    if (!this.pending) {
      const entry = { promise: Promise.resolve<string | null>(null), settled: false };
      entry.promise = this.reader.next().finally(() => {
        entry.settled = true;
      });
      this.pending = entry;
    }
    const pending = this.pending;
    const line = signal ? await raceAbort(pending.promise, signal) : await pending.promise;
    if (line !== INTERRUPTED && this.pending === pending) {
      this.pending = null;
    }
    return line;
  }

  /** Drops what was typed before now (at a terminal), a line already read ahead included. */
  discardBuffered(): void {
    this.reader.discardBuffered();
    if (this.interactive && this.pending?.settled) {
      this.pending = null;
    }
  }
}

/**
 * Knows whether a prompt is on screen, so output nobody typed for (startup
 * finishing, a warning, a Ctrl-C notice) starts on its own line. In line mode
 * the terminal echoes typing, not aia, so a half-typed line stays where it was
 * and is still sent whole on Enter.
 */
class ReplScreen {
  private shownPrompt: string | null = null;

  constructor(private readonly streams: CliStreams) {}

  prompt(text: string): void {
    this.streams.stdout.write(text);
    this.shownPrompt = text;
  }

  inputReceived(): void {
    this.shownPrompt = null;
  }

  /** Moves off a prompt line, if one is showing. */
  breakLine(): void {
    if (this.shownPrompt !== null) {
      this.streams.stdout.write("\n");
      this.shownPrompt = null;
    }
  }

  /** Writes a line on its own and puts back the prompt that was showing, if any. */
  notice(stream: CliStream, text: string): void {
    const prompt = this.shownPrompt;
    this.breakLine();
    writeLine(stream, text);
    if (prompt !== null) {
      this.prompt(prompt);
    }
  }
}

/**
 * Node prints process warnings wherever the cursor is, which in the REPL is
 * usually right after the prompt. While the REPL runs they go through the
 * screen instead. With warnings turned off (--no-warnings, NODE_NO_WARNINGS=1)
 * Node installs no printer, and none is added here.
 */
function routeProcessWarnings(screen: ReplScreen, stream: CliStream): () => void {
  const printers = process.rawListeners("warning");
  if (printers.length === 0) {
    return () => undefined;
  }
  process.removeAllListeners("warning");
  const print = (warning: Error & { code?: string }): void => {
    if (warning.name === "DeprecationWarning" && process.noDeprecation) {
      return;
    }
    screen.notice(
      stream,
      `(node:${process.pid}) ${warning.code ? `[${warning.code}] ` : ""}${warning.name}: ${warning.message}`
    );
  };
  process.on("warning", print);
  return () => {
    process.off("warning", print);
    for (const printer of printers) {
      process.on("warning", printer as (warning: Error) => void);
    }
  };
}

function formatStatusMetrics(metrics: {
  contextWindowPercentage?: number;
  elapsedSeconds: number;
  tokensUsed?: number;
}): string {
  const parts: string[] = [];
  if (typeof metrics.contextWindowPercentage === "number") {
    parts.push(`context ${metrics.contextWindowPercentage}%`);
  }
  if (typeof metrics.tokensUsed === "number") {
    parts.push(`${metrics.tokensUsed} tokens`);
  }
  parts.push(`${metrics.elapsedSeconds}s`);
  return `· ${parts.join(" · ")}`;
}

async function probeModelHealth(sdk: AIAgentSdk): Promise<{
  details: Record<string, unknown>;
  providerId: string;
  status: string;
}> {
  const health = await sdk.request("model.health", {});
  return {
    details: health.details,
    providerId: health.providerId,
    status: health.status
  };
}

/**
 * Explains which chat model was requested and where that id came from.
 *
 * The startup gate proves the *provider* is reachable, which is not the same as
 * the resolved *model* being loadable — and the id is the part most likely to be
 * wrong, because config is per-directory. Running `aia` outside a configured
 * workspace silently falls back to the built-in default, so the provider's error
 * names a model the operator never chose and looks like their config was
 * ignored. Observed exactly that: `aia` outside the repo asked LM Studio for the
 * default 26B model while the workspace config specified a different one.
 */
export function formatChatModelProvenance(loaded: LoadedAIAgentConfig): string {
  const model = loaded.resolvedConfig.runtime.defaultModel;
  const workspace = loaded.sources.config.workspace;
  const globals = loaded.sources.config.global;

  const lines = [`Chat model requested: "${model}".`];
  // Only claim "default" when no config file was read at all. Comparing the
  // value against DEFAULT_LM_STUDIO_MODEL is not provenance: the shipped
  // default can legitimately be the same id an operator configured, and
  // telling them their own setting was ignored is worse than saying nothing.
  if (!workspace && globals.length === 0 && model === DEFAULT_LM_STUDIO_MODEL) {
    lines.push("That is the built-in default — no config file was found, so this is probably not the model you meant.");
  }
  lines.push(
    workspace
      ? `  workspace config:   ${workspace}`
      : `  workspace config:   none (no ${APP_CONFIG_FILE_NAME} found from ${loaded.paths.workspaceRoot} upward)`
  );
  lines.push(globals.length > 0 ? `  user-global config: ${globals.join(", ")}` : "  user-global config: none");
  lines.push(
    `Set runtime.defaultModel and providers.lmStudio.model in whichever should apply; the user-global file applies in every directory.`
  );

  return lines.join("\n");
}

/**
 * True when a provider error is about the model rather than the transport.
 *
 * Deliberately a loose text match: every provider words this differently and
 * none of them expose a machine-readable "bad model" code, so the choice is
 * between a substring check and showing the hint on unrelated failures.
 */
export function mentionsChatModel(message: string): boolean {
  return /\bmodel\b/iu.test(message);
}

function formatModelUnavailable(model: {
  details: Record<string, unknown>;
  providerId: string;
  status: string;
}): string {
  const detail = typeof model.details.error === "string" ? ` (${model.details.error})` : "";
  return [
    `Cannot start an interactive session: the chat model provider "${model.providerId}" is ${model.status}${detail}.`,
    'Start the provider (for example launch LM Studio or Ollama), then run `aia` again. For a one-shot run use `aia --prompt "…"`.'
  ].join("\n");
}

// The tool call already carries its arguments, and printing them is what
// makes four different reads read as four different lines instead of four
// identical ones.
function formatToolActivity(toolCall: ToolCallRecord): string {
  const label = `${toolCall.toolName}${formatToolArguments(toolCall.arguments)}`;
  return toolCall.status === "failed" && toolCall.error
    ? `· ${label}: failed — ${toolCall.error.message}`
    : `· ${label}: ${toolCall.status}`;
}

// Tolerates a payload without arguments: rendering tool activity must never be
// able to throw, because that exception would travel back into the run that
// emitted the event.
function formatToolArguments(args: Record<string, JsonValue> | undefined): string {
  const entries = Object.entries(args ?? {});
  if (entries.length === 0) {
    return "";
  }

  const rendered = entries
    .map(([key, value]) => `${key}=${truncateForDisplay(formatArgumentValue(value), 48)}`)
    .join(", ");
  return `(${truncateForDisplay(rendered, 140)})`;
}

function formatArgumentValue(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

// Output-bearing tools agree on a small set of result keys, so the operator
// sees what a command actually printed rather than only that it succeeded.
// Keying on the result shape rather than on a tool-name table means a new
// output-producing tool is rendered correctly the day it is added.
function extractToolOutput(result: JsonValue | undefined): string | null {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return null;
  }

  const record = result as Record<string, JsonValue>;
  for (const key of ["combinedOutput", "output"]) {
    const value = record[key];
    if (typeof value === "string") {
      return value.trim().length > 0 ? value : null;
    }

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const streams = value as Record<string, JsonValue>;
      const sections = [
        typeof streams.stdout === "string" && streams.stdout.trim().length > 0 ? streams.stdout : undefined,
        typeof streams.stderr === "string" && streams.stderr.trim().length > 0
          ? `stderr:\n${streams.stderr}`
          : undefined
      ].filter((section): section is string => section !== undefined);
      return sections.length > 0 ? sections.join("\n") : null;
    }
  }

  return null;
}

function truncateForDisplay(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function describeCompletionReason(reason: GatewayRunCompletionReason | undefined): string {
  switch (reason) {
    case "session_awaiting_approval":
    case "tool_awaiting_approval":
      return "waiting for an approval decision";
    case "session_cancelled":
      return "the run was cancelled";
    case "session_completion_blocked":
      return "the agent stopped without completing the task";
    case "session_failed":
      return "the run failed";
    case "tool_failed":
      return "the tool call failed";
    case "session_completed":
    case "session_created":
    case "tool_succeeded":
      return "the run finished";
    default:
      return "the run ended without reporting a reason";
  }
}

// Anything other than a clean completion gets a line. A turn that ends for an
// unstated reason is indistinguishable from the agent quitting on you. A
// clean completion is only silent here when the caller already printed the
// attempt_complete summary above — otherwise (an empty/untagged summary) the
// operator would see nothing at all after "Thinking...".
function formatTurnStopNotice(
  run: GatewayRunRecord | null,
  snapshot: SessionSnapshot,
  hadCompletionSummary: boolean
): string | null {
  if (run?.completionReason === "session_completed" && hadCompletionSummary) {
    return null;
  }

  const summary = snapshot.resumeMetadata?.statusSummary;
  const detail = summary ? ` ${summary}` : "";
  return `${ANSI_DIM}Turn ended: ${describeCompletionReason(run?.completionReason)} (session ${snapshot.session.status}).${detail}${ANSI_RESET}`;
}

type ChatTurnContext = {
  approvalState: CliApprovalState;
  // Aborted once the operator asked to leave: stop waiting and return.
  exitSignal: AbortSignal;
  input: CliInput;
  interrupts: CliInterrupts;
  modelProvenance?: string;
  screen: ReplScreen;
  streams: CliStreams;
};

async function runChatTurn(handle: AIAgentSessionHandle, text: string, context: ChatTurnContext): Promise<void> {
  const { streams } = context;
  const DIM = "\x1b[2m";
  const RESET = "\x1b[0m";
  let streamedText = false;
  let streamedContent = "";
  let reasoningOpen = false;
  const closeReasoning = (): void => {
    if (reasoningOpen) {
      streams.stdout.write(`${RESET}\n`);
      reasoningOpen = false;
    }
  };
  const onEvent = (event: GatewayEvent): void => {
    if (event.topic === "message.reasoning") {
      // The aggregated end-of-turn event repeats what already streamed; it
      // exists for the events log, not the live view.
      if (event.payload.final === true) {
        return;
      }
      // Stream the model's reasoning dimmed, above the answer.
      if (!reasoningOpen) {
        streams.stdout.write(DIM);
        reasoningOpen = true;
      }
      streams.stdout.write(event.payload.delta);
    } else if (event.topic === "message.delta") {
      closeReasoning();
      streamedText = true;
      streamedContent += event.payload.delta;
      streams.stdout.write(event.payload.delta);
    } else if (event.topic === "tool.updated") {
      // Tool activity goes to stderr so it never corrupts streamed stdout text.
      closeReasoning();
      writeLine(streams.stderr, formatToolActivity(event.payload));
      const output = extractToolOutput(event.payload.result);
      if (output) {
        writeLine(streams.stderr, `${DIM}${output.replace(/\n$/u, "")}${RESET}`);
      }
    } else if (event.topic === "tool.output.delta") {
      // Live output from a still-running process. Written raw (no newline) so a
      // PTY's own line breaks and progress rewrites survive intact.
      closeReasoning();
      streams.stderr.write(event.payload.chunk);
    } else if (event.topic === "approval.requested") {
      // Announce the pause the moment it happens. The prompt itself only
      // appears once the run yields, which can be a while on a long turn, and
      // until then an unannounced pause is indistinguishable from the agent
      // having quietly stopped.
      closeReasoning();
      const target = event.payload.target;
      writeLine(streams.stderr, `${DIM}· paused for approval: ${target.label} → ${target.value}${RESET}`);
    } else if (event.topic === "gateway.status") {
      const metrics = event.payload.metrics;
      if (metrics) {
        closeReasoning();
        writeLine(streams.stderr, `${DIM}${formatStatusMetrics(metrics)}${RESET}`);
      }
    } else if (event.topic === "log.emitted" && event.metadata.code === MODEL_MISMATCH_LOG_CODE) {
      // Once per session: the provider answered with another model than the
      // one asked for. Where the requested id came from is the likely fix.
      closeReasoning();
      writeLine(streams.stderr, `${DIM}· ${event.payload.message}${RESET}`);
      if (context.modelProvenance) {
        writeLine(streams.stderr, `${DIM}  ${context.modelProvenance}${RESET}`);
      }
    }
  };
  const unsubscribe = handle.subscribe(onEvent, {
    topics: [
      "approval.requested",
      "log.emitted",
      "message.delta",
      "message.reasoning",
      "tool.output.delta",
      "tool.updated",
      "gateway.status"
    ]
  });

  // The first Ctrl-C during a turn cancels it: the gateway aborts the model
  // request and starts no further tool call or turn. A second one reaches the
  // REPL's own scope and exits.
  const turnScope = context.interrupts.open();
  const cancelTurn = (): void => {
    closeReasoning();
    context.screen.breakLine();
    writeLine(streams.stderr, `${DIM}· Cancelling the turn. Press Ctrl-C again to exit.${RESET}`);
    // No run is active while an approval prompt waits; that path cancels the
    // approvals instead, so "nothing to cancel" is expected here.
    void Promise.resolve()
      .then(async () => handle.cancel())
      .catch(() => undefined);
  };
  turnScope.signal.addEventListener("abort", cancelTurn, { once: true });

  try {
    // Thinking line is terminated so streamed tokens / tool lines start cleanly.
    writeLine(streams.stdout, "Thinking…");
    const run = await handle.sendMessage({ text });
    const firstRun = await raceAbort(run.wait(), context.exitSignal);
    if (firstRun === INTERRUPTED) {
      return;
    }
    let finalRun = firstRun;

    closeReasoning();
    if (streamedText) {
      streams.stdout.write("\n");
    }

    const approvals = await resolvePendingApprovals(handle, { ...context, turnSignal: turnScope.signal });
    if (approvals.outcome === "exit") {
      return;
    }
    if (approvals.outcome === "cancelled") {
      writeLine(
        streams.stderr,
        `${DIM}Turn cancelled. ${approvals.cancelledCount === 1 ? "The pending approval was" : `${approvals.cancelledCount} pending approvals were`} cancelled, so nothing it asked for ran.${RESET}`
      );
      return;
    }
    const resumedRuns = approvals.resumedRuns;
    // Test fakes can hand back no record at all; the real gateway always does.
    const turnMessageIds = new Set([finalRun, ...resumedRuns].flatMap((entry) => entry?.messageIds ?? []));
    finalRun = resumedRuns.at(-1) ?? finalRun;

    const snapshot = (await handle.snapshot()).snapshot;

    // The final answer arrives as the `attempt_complete` summary, which the
    // loop persists as a tagged assistant message. It never streams (it is a
    // tool argument, not generated text), so without this the operator sees
    // reasoning and status lines and no answer at all. Only a summary this
    // turn's runs wrote counts: the snapshot holds the whole session, and an
    // earlier turn's answer must never be re-printed as this one's.
    const completionSummary = extractCompletionSummary(snapshot, turnMessageIds);
    // Unless it only repeats what just streamed: the answer used to appear twice.
    if (completionSummary && !repeatsShownText(completionSummary, streamedContent)) {
      writeLine(streams.stdout, completionSummary);
    }

    const errorMessage = snapshot.session.lastError?.message;
    if (errorMessage) {
      writeLine(streams.stderr, `Error: ${errorMessage}`);
      // A provider error that names a model is almost always a config-location
      // problem rather than a provider problem, and the provider cannot know
      // that. Say which id we asked for and which files chose it.
      if (context.modelProvenance && mentionsChatModel(errorMessage)) {
        writeLine(streams.stderr, `${DIM}${context.modelProvenance}${RESET}`);
      }
    } else {
      // A turn that ends for any reason other than "the agent finished" used
      // to print nothing at all, which is how a paused or blocked run read as
      // the agent stopping for no reason.
      const notice = formatTurnStopNotice(finalRun, snapshot, Boolean(completionSummary));
      if (notice) {
        writeLine(streams.stderr, notice);
      }
    }
  } catch (error) {
    writeLine(streams.stderr, renderCliError(error));
  } finally {
    turnScope.signal.removeEventListener("abort", cancelTurn);
    turnScope.close();
    unsubscribe();
  }
}

// Interactive approval loop. Answers: `y` approves once, `a` approves and
// auto-approves the same target for the rest of this CLI session, `e` denies
// and prompts for what to do instead, anything else denies silently. An `e`
// explanation is sent as the resolution comment, which the gateway queues as
// steering so the agent hears "no, but do this instead" on the resumed turn.
// `question`-kind approvals (ask_user_question) are answered directly: the
// typed reply (or the chosen option's label) is the resolution comment the
// tool returns to the model. Returns every run it resumed, in order.
//
// Ctrl-C (the turn signal) cancels every pending approval with the gateway's
// "cancelled" decision, which, unlike a denial, is not turned into steering,
// and resumes nothing: the operator stopped the turn, so nothing it asked for
// runs and the model is not woken to carry on.
type ApprovalLoopResult =
  | { outcome: "cancelled"; cancelledCount: number }
  | { outcome: "exit" }
  | { outcome: "settled"; resumedRuns: GatewayRunRecord[] };

async function resolvePendingApprovals(
  handle: AIAgentSessionHandle,
  context: ChatTurnContext & { turnSignal: AbortSignal }
): Promise<ApprovalLoopResult> {
  const { streams } = context;
  const state = context.approvalState;
  const ask = createOperatorPrompt(context);
  const resumedRuns: GatewayRunRecord[] = [];
  // With nothing left pending (the Ctrl-C landed while the run was going),
  // the turn ends the usual way and reports the cancelled run.
  const stop = async (): Promise<ApprovalLoopResult> => {
    if (context.exitSignal.aborted) {
      return { outcome: "exit" };
    }
    const cancelledCount = await cancelPendingApprovals(handle);
    return cancelledCount > 0 ? { cancelledCount, outcome: "cancelled" } : { outcome: "settled", resumedRuns };
  };

  for (let round = 0; round < 50; round += 1) {
    if (context.exitSignal.aborted || context.turnSignal.aborted) {
      return stop();
    }
    const pending = await handle.listPendingApprovals();
    if (pending.length === 0) {
      return { outcome: "settled", resumedRuns };
    }

    for (const approval of pending) {
      const target = approval.request.target;

      if (target.kind === "question") {
        if ((await answerAgentQuestion(handle, approval, context, ask)) === INTERRUPTED) {
          return stop();
        }
        continue;
      }

      const alwaysKey = `${target.kind}:${target.value}`;
      if (state.alwaysApprove.has(alwaysKey)) {
        await handle.resolveApproval({
          comment: 'Auto-approved: the operator answered "always" for this target earlier in the CLI session.',
          decision: "approved",
          requestId: approval.request.id
        });
        writeLine(streams.stdout, `Auto-approved ${target.value} (always for this session).`);
        continue;
      }

      writeLine(streams.stdout, `${ANSI_DIM}  ${approval.request.justification}${ANSI_RESET}`);
      // Everything the policy weighed: the full command line with its argv,
      // each path, the tool. A prompt for "write_file" alone never said which
      // file it would write.
      for (const evaluated of readApprovalTargets(approval.request)) {
        writeLine(streams.stdout, `  ${evaluated.kind}: ${evaluated.value}`);
      }
      const reply = await ask(
        `Approve ${target.label} → ${target.value}? [y/N/a/e] (y = yes, N = no, a = always approve ${describeAlwaysScope(target)} for this session, e = no + explain what to do instead) `
      );
      if (reply === INTERRUPTED) {
        return stop();
      }
      const answer = reply?.trim().toLowerCase() ?? "";

      if (answer === "a" || answer === "always") {
        state.alwaysApprove.add(alwaysKey);
        await handle.resolveApproval({
          decision: "approved",
          requestId: approval.request.id
        });
        writeLine(
          streams.stdout,
          `Approved ${target.value}; ${describeAlwaysScope(target)} is auto-approved for this session.`
        );
        continue;
      }

      if (answer === "y" || answer === "yes") {
        await handle.resolveApproval({
          decision: "approved",
          requestId: approval.request.id
        });
        writeLine(streams.stdout, `Approved ${target.value}.`);
        continue;
      }

      let note = "";
      if (answer === "e" || answer === "explain") {
        const explanation = await ask("What should the agent do instead? ");
        if (explanation === INTERRUPTED) {
          return stop();
        }
        note = explanation?.trim() ?? "";
      }
      await handle.resolveApproval({
        ...(note.length > 0 ? { comment: note } : {}),
        decision: "denied",
        requestId: approval.request.id
      });
      writeLine(
        streams.stdout,
        note.length > 0
          ? `Denied ${target.value}. Your note was queued as steering for the agent.`
          : `Denied ${target.value}.`
      );
    }

    const resumeRun = await handle.resume();
    const resumed = await raceAbort(resumeRun.wait(), context.exitSignal);
    if (resumed === INTERRUPTED) {
      return { outcome: "exit" };
    }
    if (resumed) {
      resumedRuns.push(resumed);
    }
  }

  writeLine(
    streams.stderr,
    "Stopped after 50 rounds of approvals without the session settling. Run the prompt again, or resolve the remaining approvals from another surface."
  );
  return { outcome: "settled", resumedRuns };
}

// What answering "a" covers: the target that decided the prompt, matched
// exactly (`kind:value`) for the rest of the CLI session.
function describeAlwaysScope(target: { kind: string; value: string }): string {
  switch (target.kind) {
    case "command":
      return "this exact command line";
    case "path":
      return `every request for ${target.value}`;
    case "mcp_server":
      return `every tool on MCP server ${target.value}`;
    default:
      return `every ${target.value} request`;
  }
}

async function cancelPendingApprovals(handle: AIAgentSessionHandle): Promise<number> {
  const pending = await handle.listPendingApprovals();
  for (const approval of pending) {
    await handle.resolveApproval({
      comment: "Cancelled by the operator (Ctrl-C).",
      decision: "cancelled",
      requestId: approval.request.id
    });
  }
  return pending.length;
}

/**
 * Asks the operator something and reads their reply, or INTERRUPTED on
 * Ctrl-C.
 *
 * Buffered input is dropped immediately before the question is written: on a
 * terminal, a human cannot have answered a question they had not yet seen, so
 * anything already queued is stale — an impatient Enter pressed while the
 * agent was working, say. Consuming it silently denied approvals the operator
 * meant to grant, and pushed their real keystroke onto the next prompt.
 */
function createOperatorPrompt(
  context: ChatTurnContext & { turnSignal: AbortSignal }
): (question: string) => Promise<string | null | typeof INTERRUPTED> {
  const interrupted = AbortSignal.any([context.turnSignal, context.exitSignal]);
  return async (question: string) => {
    context.input.discardBuffered();
    context.screen.prompt(question);
    const reply = await context.input.read(interrupted);
    if (reply !== INTERRUPTED) {
      context.screen.inputReceived();
    }
    return reply;
  };
}

async function answerAgentQuestion(
  handle: AIAgentSessionHandle,
  approval: GatewayApprovalRecord,
  context: ChatTurnContext,
  ask: (question: string) => Promise<string | null | typeof INTERRUPTED>
): Promise<void | typeof INTERRUPTED> {
  const { streams } = context;
  writeLine(streams.stdout, `The agent asks: ${approval.request.justification}`);
  const options = readQuestionOptions(approval.request.metadata?.options);
  for (const [index, option] of options.entries()) {
    writeLine(streams.stdout, `  ${index + 1}) ${option.label}${option.description ? ` — ${option.description}` : ""}`);
  }

  const reply = await ask(
    options.length > 0
      ? "Your answer (number, or type your own answer; Enter to skip): "
      : "Your answer (Enter to skip): "
  );
  if (reply === INTERRUPTED) {
    return INTERRUPTED;
  }
  const typed = reply?.trim() ?? "";
  // A bare number is shorthand for the option at that position; the tool only
  // ever sees the label, so option numbering stays a CLI presentation detail.
  const chosen = /^\d+$/u.test(typed) ? options[Number.parseInt(typed, 10) - 1] : undefined;
  const answer = chosen?.label ?? typed;

  await handle.resolveApproval({
    ...(answer.length > 0 ? { comment: answer } : {}),
    decision: "approved",
    requestId: approval.request.id
  });
  writeLine(streams.stdout, answer.length > 0 ? "Answer sent to the agent." : "Continued without an answer.");
}

function readQuestionOptions(raw: JsonValue | undefined): Array<{ description?: string; label: string }> {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((option) => {
    if (typeof option !== "object" || option === null || Array.isArray(option)) {
      return [];
    }
    const label = typeof option.label === "string" ? option.label : null;
    if (!label) {
      return [];
    }
    const description = typeof option.description === "string" ? option.description : undefined;
    return [{ ...(description ? { description } : {}), label }];
  });
}

async function runPromptCli(
  input: {
    cwd: string;
    goal: string;
    prompt: string;
    title: string;
  },
  streams: CliStreams,
  deps: CliDependencies
): Promise<number> {
  const sdk = await resolveSdk(deps, input.cwd);

  try {
    const created = await sdk.sessions.create({
      cwd: input.cwd,
      goal: input.goal,
      initialMessage: {
        text: input.prompt
      },
      metadata: {
        surface: "cli"
      },
      title: input.title
    });

    const run = created.run ? await created.run.wait() : null;
    const snapshot = await created.handle.snapshot();
    const assistantSummary = extractLatestAssistantSummary(snapshot);
    const errorMessage = snapshot.snapshot.session.lastError?.message;

    writeLine(
      streams.stdout,
      [
        `Session: ${created.session.id}`,
        run ? `Run: ${run.id}` : undefined,
        `Status: ${snapshot.snapshot.session.status}`,
        `Goal: ${created.session.goal}`,
        assistantSummary ? `Assistant: ${assistantSummary}` : undefined,
        errorMessage ? `Error: ${errorMessage}` : undefined
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n")
    );

    return snapshot.snapshot.session.status === "completed" ? 0 : 1;
  } catch (error) {
    writeLine(streams.stderr, renderCliError(error));
    return 1;
  } finally {
    await sdk.close().catch(() => undefined);
  }
}

async function mainCli(): Promise<void> {
  try {
    const exitCode = await runCli();
    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  } catch (error) {
    process.stderr.write(`${renderCliError(error)}\n`);
    process.exitCode = 1;
  }
}

/**
 * Joins a live interactive external-agent terminal.
 *
 * The session itself lives in whichever process hosts the gateway, so this is a
 * client: it dials the configured gateway WebSocket instead of starting its own
 * runtime. That is what lets a desktop window, the agent, and the operator all
 * drive the same PTY.
 */
async function runAttachCli(args: string[], streams: CliStreams, deps: CliDependencies = {}): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      url: { type: "string" }
    }
  });

  const externalSessionId = positionals[0];
  if (!externalSessionId) {
    writeLine(streams.stderr, "Usage: aia attach <external-session-id> [--url <ws url>]");
    return 1;
  }

  try {
    const loaded = await loadAIAgentConfig({
      cwd: values.cwd ? path.resolve(values.cwd) : process.cwd(),
      ...(deps.userHomeDirectory ? { userHomeDirectory: deps.userHomeDirectory } : {})
    });
    const gateway = loaded.resolvedConfig.gateway;
    // Prefer the listener published by a running interactive CLI: that is the
    // process actually hosting the PTY when the agent is driven from `aia`.
    // Fall back to the configured gateway, which is where a dev/prod server
    // listens. An explicit --url always wins, and a record published for that
    // URL still supplies the listener's per-launch token.
    const published = await readAttachEndpoint(
      loaded.resolvedConfig.memory.stateRoot,
      values.url ? { url: values.url } : {}
    );
    const url = values.url ?? published?.url ?? `ws://${gateway.hostname}:${gateway.port}${gateway.websocketPath}`;
    const token = published?.token ?? (typeof gateway.auth.token === "string" ? gateway.auth.token : undefined);

    writeLine(streams.stderr, `Attached to ${externalSessionId}. Press Ctrl-] to detach.`);
    const attach = deps.attachToExternalAgentSession ?? attachToExternalAgentSession;
    return await attach({
      externalSessionId,
      streams: { stdin: process.stdin, stdout: streams.stdout as NodeJS.WritableStream },
      ...(token ? { token } : {}),
      url
    });
  } catch (error) {
    writeLine(streams.stderr, renderCliError(error));
    return 1;
  }
}

async function runVoiceCli(args: string[], streams: CliStreams, deps: CliDependencies = {}): Promise<number> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    writeLine(streams.stdout, formatVoiceHelp());
    return 0;
  }

  try {
    switch (subcommand) {
      case "list-devices":
        return await withVoiceContext(deps, async (context) => {
          const { values } = parseArgs({
            args: args.slice(1),
            allowPositionals: false,
            options: {
              help: { short: "h", type: "boolean" },
              kind: { type: "string" },
              provider: { type: "string" }
            }
          });
          if (values.help) {
            writeLine(streams.stdout, "Usage: aia voice list-devices [--provider <id>] [--kind input|output]");
            return 0;
          }

          const devices = await context.voiceService.listDevices({
            kind: parseDeviceKind(values.kind),
            providerId: values.provider
          });
          if (devices.length === 0) {
            writeLine(streams.stdout, "No matching voice devices were found.");
            return 0;
          }

          for (const device of devices) {
            writeLine(
              streams.stdout,
              `${device.kind}\t${device.id}\t${device.name}\t${device.providerId}${device.default ? "\tdefault" : ""}`
            );
          }
          return 0;
        });
      case "list-voices":
        return await withVoiceContext(deps, async (context) => {
          const { values } = parseArgs({
            args: args.slice(1),
            allowPositionals: false,
            options: {
              help: { short: "h", type: "boolean" },
              locale: { type: "string" },
              provider: { type: "string" }
            }
          });
          if (values.help) {
            writeLine(streams.stdout, "Usage: aia voice list-voices [--provider <id>] [--locale <locale>]");
            return 0;
          }

          const voices = await context.voiceService.listVoices({
            locale: values.locale,
            providerId: values.provider
          });
          if (voices.length === 0) {
            writeLine(streams.stdout, "No matching voices were found.");
            return 0;
          }

          for (const voice of voices) {
            writeLine(
              streams.stdout,
              `${voice.id}\t${voice.locale ?? "-"}\t${voice.providerId}${voice.default ? "\tdefault" : ""}`
            );
          }
          return 0;
        });
      case "transcribe-file":
        return await withVoiceContext(deps, async (context) => {
          const { values } = parseArgs({
            args: args.slice(1),
            allowPositionals: false,
            options: {
              file: { type: "string" },
              help: { short: "h", type: "boolean" },
              locale: { type: "string" },
              provider: { type: "string" },
              session: { type: "string" }
            }
          });
          if (values.help || !values.file) {
            writeLine(
              streams.stdout,
              "Usage: aia voice transcribe-file --file <path> [--provider <id>] [--locale <locale>] [--session <id>]"
            );
            return values.help ? 0 : 1;
          }

          const filePath = path.resolve(values.file);
          const audio = await buildVoiceAudioArtifact({
            filePath,
            locale: values.locale,
            mediaType: inferAudioMediaType(filePath),
            name: path.basename(filePath)
          });
          const result = await context.voiceService.transcribe({
            audio,
            id: `voice.transcribe.${crypto.randomUUID()}`,
            locale: values.locale,
            metadata: {},
            providerId: values.provider,
            sessionId: values.session
          });

          if (values.session) {
            await appendVoiceUserMessage({
              audio,
              sessionId: values.session,
              sessions: context.sessions,
              text: result.text,
              transcriptionId: result.id,
              voiceProviderId: result.providerId
            });
          }

          writeLine(streams.stdout, result.text);
          return 0;
        });
      case "capture":
        return await withVoiceContext(deps, async (context) => {
          const { values } = parseArgs({
            args: args.slice(1),
            allowPositionals: false,
            options: {
              help: { short: "h", type: "boolean" },
              "input-device": { type: "string" },
              locale: { type: "string" },
              "max-duration-ms": { type: "string" },
              provider: { type: "string" },
              session: { type: "string" },
              "silence-timeout-ms": { type: "string" }
            }
          });
          if (values.help) {
            writeLine(
              streams.stdout,
              "Usage: aia voice capture [--provider <id>] [--locale <locale>] [--session <id>] [--input-device <id>] [--max-duration-ms <ms>] [--silence-timeout-ms <ms>]"
            );
            return 0;
          }

          const capture = await context.voiceService.startCapture({
            id: `voice.capture.${crypto.randomUUID()}`,
            inputDevice: values["input-device"],
            locale: values.locale,
            maxDurationMs: parseOptionalInteger(values["max-duration-ms"], "--max-duration-ms"),
            metadata: {},
            providerId: values.provider,
            sessionId: values.session,
            silenceTimeoutMs: parseOptionalInteger(values["silence-timeout-ms"], "--silence-timeout-ms")
          });

          writeLine(
            streams.stderr,
            "Recording microphone input. Press Ctrl+C to stop, or wait for silence/max duration."
          );

          let stopping = false;
          const stop = async () => {
            if (stopping) {
              return;
            }
            stopping = true;
            await context.voiceService.stopCapture(capture.id).catch(() => undefined);
          };

          const onSignal = () => {
            void stop();
          };

          process.on("SIGINT", onSignal);
          process.on("SIGTERM", onSignal);

          try {
            const result = await context.voiceService.waitForCapture(capture.id);
            if (result.status !== "completed" || !result.text || !result.audio) {
              writeLine(streams.stderr, formatVoiceCaptureFailure(result));
              return 1;
            }

            if (values.session) {
              await appendVoiceUserMessage({
                audio: result.audio,
                sessionId: values.session,
                sessions: context.sessions,
                text: result.text,
                transcriptionId: result.transcriptionId ?? result.id,
                voiceProviderId: result.providerId
              });
            }

            writeLine(streams.stdout, result.text);
            return 0;
          } finally {
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
          }
        });
      case "speak":
        return await withVoiceContext(deps, async (context) => {
          const { values } = parseArgs({
            args: args.slice(1),
            allowPositionals: false,
            options: {
              help: { short: "h", type: "boolean" },
              "output-device": { type: "string" },
              provider: { type: "string" },
              text: { type: "string" },
              voice: { type: "string" }
            }
          });
          if (values.help || !values.text) {
            writeLine(
              streams.stdout,
              "Usage: aia voice speak --text <text> [--provider <id>] [--voice <voice>] [--output-device <id>]"
            );
            return values.help ? 0 : 1;
          }

          await context.voiceService.playback({
            id: `voice.playback.${crypto.randomUUID()}`,
            metadata: {},
            outputDevice: values["output-device"],
            providerId: values.provider,
            text: values.text,
            voice: values.voice
          });
          writeLine(streams.stdout, "Speech playback completed.");
          return 0;
        });
      case "synthesize":
        return await withVoiceContext(deps, async (context) => {
          const { values } = parseArgs({
            args: args.slice(1),
            allowPositionals: false,
            options: {
              help: { short: "h", type: "boolean" },
              locale: { type: "string" },
              provider: { type: "string" },
              text: { type: "string" },
              voice: { type: "string" }
            }
          });
          if (values.help || !values.text) {
            writeLine(
              streams.stdout,
              "Usage: aia voice synthesize --text <text> [--provider <id>] [--voice <voice>] [--locale <locale>]"
            );
            return values.help ? 0 : 1;
          }

          const result = await context.voiceService.synthesize({
            id: `voice.synthesis.${crypto.randomUUID()}`,
            locale: values.locale,
            metadata: {},
            providerId: values.provider,
            text: values.text,
            voice: values.voice
          });

          writeLine(streams.stdout, result.audio.uri);
          return 0;
        });
      default:
        writeLine(streams.stderr, `Unknown voice subcommand: ${subcommand}`);
        writeLine(streams.stderr, formatVoiceHelp());
        return 1;
    }
  } catch (error) {
    writeLine(streams.stderr, renderCliError(error));
    return 1;
  }
}

async function appendVoiceUserMessage(params: {
  audio: ArtifactReference;
  sessionId: string;
  sessions: FileSessionStore;
  text: string;
  transcriptionId: string;
  voiceProviderId: string;
}): Promise<void> {
  const session = await requireSession(params.sessions, params.sessionId);
  const createdAt = new Date().toISOString();

  await params.sessions.appendMessages([
    {
      createdAt,
      id: `message.user.voice.${crypto.randomUUID()}`,
      metadata: {
        sourceAudioArtifactId: params.audio.id,
        transcriptionId: params.transcriptionId,
        voiceProviderId: params.voiceProviderId
      },
      parts: [
        {
          kind: "text",
          text: params.text
        },
        {
          artifact: params.audio,
          durationMs:
            typeof params.audio.metadata.durationMs === "number"
              ? Math.trunc(params.audio.metadata.durationMs)
              : undefined,
          kind: "audio",
          transcript: params.text,
          uri: params.audio.uri,
          voice: typeof params.audio.metadata.voice === "string" ? params.audio.metadata.voice : undefined,
          waveform: Array.isArray(params.audio.metadata.waveform)
            ? params.audio.metadata.waveform
                .filter((value): value is number => typeof value === "number" && value >= 0 && value <= 1)
                .slice(0, 512)
            : undefined
        }
      ],
      role: "user",
      sessionId: params.sessionId,
      source: "user",
      tags: ["voice", "transcript"],
      visibility: "default"
    }
  ]);

  await params.sessions.saveSession({
    ...session,
    lastActiveAt: createdAt,
    updatedAt: createdAt
  });
}

async function resolveSdk(deps: CliDependencies, cwd: string, loaded?: LoadedAIAgentConfig): Promise<AIAgentSdk> {
  return deps.createSdk
    ? deps.createSdk({ cwd, loaded })
    : createAIAgentSdkFromConfig({ cwd, loaded, userHomeDirectory: deps.userHomeDirectory });
}

function parseChatCommand(
  line: string
): "agents" | "attach" | "compact" | "exit" | "help" | "mcp" | "message" | "unknown" {
  if (!line.startsWith("/")) {
    return "message";
  }
  const name = line.slice(1).trim().toLowerCase().split(/\s+/u)[0];
  switch (name) {
    case "agents":
      return "agents";
    case "attach":
      return "attach";
    case "compact":
      return "compact";
    case "exit":
    case "quit":
      return "exit";
    case "help":
      return "help";
    case "mcp":
      return "mcp";
    default:
      return "unknown";
  }
}

// At a terminal the welcome comes before the session exists (startup runs
// behind the prompt), and the session line follows once it does.
function formatChatWelcome(sessionId?: string): string {
  return [
    "AIAgent interactive session. Type a message and press Enter.",
    ...(sessionId ? [`Session: ${sessionId}`] : []),
    "The session stays open until you type /exit or /quit. Type /help for commands."
  ].join("\n");
}

function formatChatHelp(): string {
  return [
    "Interactive commands:",
    "  /help          Show this help",
    "  /agents        List interactive external-agent terminal sessions",
    "  /attach <id>   Open a desktop terminal window on a live external-agent session",
    "  /compact       Summarize the transcript so far into session memory and free the model's context",
    "  /mcp           List configured MCP servers, their state, and their tools",
    "  /exit, /quit   End the session and return to the shell",
    "Anything else is sent to the agent as a message.",
    "",
    "Ctrl-C stops the running turn; press it again to exit. At the prompt, Ctrl-C exits.",
    "At an approval prompt it cancels the turn and the approvals it was waiting on.",
    "",
    "Approval prompts [y/N/a/e]:",
    "  y  approve once",
    "  a  approve, and auto-approve this exact target for the rest of the session",
    '  e  deny, then say what to do instead; the note reaches the agent as steering ("use ls instead")',
    "  N  deny (Enter, or any other answer, also denies)"
  ].join("\n");
}

function formatExternalAgentSessions(
  sessions: Array<{
    agentId: string;
    cwd: string;
    id: string;
    status: string;
    turnCount: number;
  }>
): string {
  if (sessions.length === 0) {
    return "No interactive external-agent sessions.";
  }

  return sessions
    .map(
      (session) => `${session.id}  ${session.status}  ${session.agentId}  ${session.turnCount} turn(s)  ${session.cwd}`
    )
    .join("\n");
}

function formatMcpServers(
  servers: {
    capabilities: { tools: number };
    error?: string;
    serverName: string;
    state: string;
    tools: { description?: string; invocationName: string }[];
    transport: string;
  }[]
): string {
  if (servers.length === 0) {
    return "No MCP servers are configured.";
  }
  return servers
    .map((server) => {
      const lines = [`${server.serverName}  [${server.state}, ${server.transport}]`];
      if (server.error) {
        lines.push(`  error: ${server.error}`);
      }
      if (server.tools.length > 0) {
        for (const tool of server.tools) {
          lines.push(`  - ${tool.invocationName}${tool.description ? `: ${tool.description}` : ""}`);
        }
      } else {
        lines.push("  (no tools exposed)");
      }
      return lines.join("\n");
    })
    .join("\n");
}

async function runCompactCommand(handle: AIAgentSessionHandle, streams: CliStreams): Promise<void> {
  try {
    const result = await handle.compact();
    writeLine(streams.stdout, formatCompactResult(result));
  } catch (error) {
    writeLine(streams.stderr, `Failed to compact the session: ${renderCliError(error)}`);
  }
}

function formatCompactResult(result: GatewaySessionCompactResult): string {
  const lines = [
    result.hiddenMessageCount > 0
      ? `Compacted ${result.hiddenMessageCount} earlier message(s) into a session summary. The model now sees the summary (Durable Memory) instead of the raw transcript.`
      : "Nothing to compact yet: the session has no transcript to summarize."
  ];
  if (result.summaryPath) {
    lines.push(`Summary file: ${result.summaryPath}`);
  }
  return lines.join("\n");
}

function createStdinLineReader(options: { interactive?: boolean } = {}): CliLineReader {
  // Buffer lines from the moment the reader is created so input that arrives
  // while the runtime is still booting (notably piped/scripted input) is not
  // lost before iteration starts.
  const rl = readline.createInterface({ input: process.stdin });
  const queue: string[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  const notify = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  rl.on("line", (line) => {
    queue.push(line);
    notify();
  });
  rl.on("close", () => {
    closed = true;
    notify();
  });

  // Only a real terminal gets its buffer dropped. When stdin is piped, the
  // queued lines are a script's deliberately pre-supplied answers, and
  // discarding them would break every scripted run.
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY);

  return {
    close(): void {
      rl.close();
    },
    discardBuffered(): void {
      if (interactive) {
        queue.length = 0;
      }
    },
    interactive,
    async next(): Promise<string | null> {
      while (true) {
        if (queue.length > 0) {
          return queue.shift() as string;
        }
        if (closed) {
          return null;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    }
  };
}

/**
 * Wraps a plain async iterable (tests, scripted input) as a line reader.
 * `discardBuffered` is a no-op: a lazy iterable holds nothing ahead of the
 * read, and a script's answers are supplied in order on purpose.
 */
function toLineReader(source: AsyncIterable<string> | CliLineReader): CliLineReader {
  if ("next" in source && "discardBuffered" in source) {
    return source;
  }

  const iterator = (source as AsyncIterable<string>)[Symbol.asyncIterator]();
  return {
    async close(): Promise<void> {
      await iterator.return?.();
    },
    discardBuffered: () => undefined,
    interactive: false,
    async next(): Promise<string | null> {
      const result = await iterator.next();
      return result.done ? null : result.value;
    }
  };
}

function renderCliError(error: unknown): string {
  if (isStructuredError(error)) {
    return `${error.code}: ${error.message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function formatVoiceCaptureFailure(record: VoiceCaptureRecord): string {
  const message = record.error?.message ?? "Voice capture did not complete successfully.";
  return `${record.status}: ${message}`;
}

function inferAudioMediaType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".aif":
    case ".aiff":
      return "audio/aiff";
    case ".m4a":
      return "audio/mp4";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
    default:
      return "audio/wav";
  }
}

function isStructuredError(error: unknown): error is StructuredError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    "retriable" in error &&
    "details" in error
  );
}

function parseDeviceKind(value: string | undefined): "input" | "output" | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "input" || value === "output") {
    return value;
  }
  throw new Error(`Invalid device kind "${value}". Expected "input" or "output".`);
}

function parseOptionalInteger(value: string | undefined, label: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be an integer.`);
  }
  return parsed;
}

async function requireSession(store: FileSessionStore, sessionId: string): Promise<SessionRecord> {
  const session = await store.getSession(sessionId);
  if (!session) {
    throw new Error(`Session "${sessionId}" was not found.`);
  }
  return session;
}

async function withVoiceContext(
  deps: CliDependencies,
  run: (context: VoiceCliContext) => Promise<number>
): Promise<number> {
  const context = await buildVoiceContext(deps);

  try {
    return await run(context);
  } finally {
    await context.voiceService.dispose();
  }
}

async function buildVoiceContext(deps: CliDependencies): Promise<VoiceCliContext> {
  if (deps.createVoiceContext) {
    return deps.createVoiceContext();
  }

  const loaded = await loadAIAgentConfig({
    cwd: process.cwd()
  });
  const sessions = new FileSessionStore(loaded.resolvedConfig.memory.stateRoot);
  const voiceService = createVoiceServiceFromConfig(loaded.resolvedConfig, {
    sessions
  });
  return {
    sessions,
    voiceService
  };
}

function writeLine(stream: CliStream, value: string): void {
  stream.write(`${value}\n`);
}

/**
 * The run's final answer: the newest message tagged as an accepted
 * `attempt_complete` summary. Matching on the tag rather than "last assistant
 * message" keeps this from re-printing streamed narration that the operator
 * already watched arrive.
 */
function extractCompletionSummary(snapshot: SessionSnapshot, turnMessageIds: ReadonlySet<string>): string | null {
  const summaryMessage = snapshot.messages
    .slice()
    .reverse()
    // `tags` is schema-defaulted, but snapshots reach the CLI from fakes and
    // older persisted records too; an absent array must not throw here.
    .find((message) => turnMessageIds.has(message.id) && (message.tags ?? []).includes(COMPLETION_SUMMARY_MESSAGE_TAG));

  if (!summaryMessage) {
    return null;
  }

  return extractMessageText(summaryMessage) || null;
}

function extractLatestAssistantSummary(snapshot: GatewaySessionSnapshot): string | null {
  const assistantMessage = snapshot.snapshot.messages
    .slice()
    .reverse()
    .find((message) => message.role === "assistant");

  if (!assistantMessage) {
    return null;
  }

  return extractMessageText(assistantMessage) || null;
}

function extractMessageText(message: Message): string {
  return message.parts
    .map((part) => {
      switch (part.kind) {
        case "markdown":
          return part.markdown;
        case "status":
          return part.summary;
        case "text":
          return part.text;
        default:
          return "";
      }
    })
    .filter((part) => part.trim().length > 0)
    .join("\n")
    .trim();
}

// Only auto-run when invoked directly (so importing this module in tests does
// not start the CLI). Resolve symlinks on both sides so the linked `aia` bin
// — which the shell invokes through a symlink — still matches the real module.
function isDirectlyInvoked(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isDirectlyInvoked()) {
  void mainCli();
}

/**
 * Shows or changes trust for this workspace's config file (security review H3).
 *
 * Trust is per exact file *contents*, so the command always prints the
 * fingerprint it is acting on: an operator granting trust should be able to see
 * that it matches the file they just reviewed, and a later edit will show up
 * here as "not trusted" again rather than silently keeping the old grant.
 */
async function runTrustCli(args: string[], streams: CliStreams, deps: CliDependencies = {}): Promise<number> {
  let parsed: { values: { cwd?: string; grant?: boolean; help?: boolean; revoke?: boolean } };
  try {
    parsed = parseArgs({
      args,
      allowPositionals: false,
      options: {
        cwd: { type: "string" },
        grant: { type: "boolean" },
        help: { short: "h", type: "boolean" },
        revoke: { type: "boolean" }
      }
    });
  } catch (error) {
    writeLine(streams.stderr, renderCliError(error));
    return 1;
  }

  if (parsed.values.help) {
    writeLine(
      streams.stdout,
      [
        "aia trust — allow this workspace's config to use secret providers that run commands or read files.",
        "",
        "  aia trust                 Show the trust state and what trusting the file would allow",
        "                            (at a terminal, asks before granting)",
        "  aia trust --grant         Trust this exact file without asking",
        "  aia trust --revoke        Remove trust for this workspace's config",
        "  aia trust --cwd <path>    Act on a different workspace"
      ].join("\n")
    );
    return 0;
  }

  if (parsed.values.grant && parsed.values.revoke) {
    writeLine(streams.stderr, "Use either --grant or --revoke, not both.");
    return 1;
  }

  const cwd = parsed.values.cwd ? path.resolve(parsed.values.cwd) : process.cwd();

  try {
    // Skip secret resolution: the whole point is that we may not be allowed to
    // run these providers yet, and resolving would raise the very error the
    // operator is here to fix.
    const loaded = await loadAIAgentConfig({
      cwd,
      resolveSecrets: false,
      ...(deps.userHomeDirectory ? { userHomeDirectory: deps.userHomeDirectory } : {})
    });
    const { paths, workspaceTrust } = loaded;
    const configPath = loaded.sources.config.workspace ?? paths.workspaceConfigPath;

    if (parsed.values.revoke) {
      await revokeConfigTrust(paths.userStateDirectory, configPath);
      writeLine(streams.stdout, `Revoked trust for ${configPath}.`);
      return 0;
    }

    if (!workspaceTrust.required) {
      writeLine(
        streams.stdout,
        loaded.sources.config.workspace
          ? `No trust needed: ${configPath} declares no secret provider that can run commands or read arbitrary files.`
          : // Naming a file that does not exist read as if it had been inspected.
            `No trust needed: there is no workspace config (no ${APP_CONFIG_FILE_NAME} found from ${paths.workspaceRoot} upward).`
      );
      return 0;
    }

    const fingerprint = workspaceTrust.fingerprint;
    if (!fingerprint) {
      writeLine(streams.stderr, `Cannot read the workspace config at ${configPath}.`);
      return 1;
    }

    if (workspaceTrust.trusted) {
      writeLine(streams.stdout, [`Already trusted: ${fingerprint.path}`, `sha256: ${fingerprint.sha256}`].join("\n"));
      return 0;
    }

    // Showing is the default, and granting is explicit. The command used to
    // grant on sight, while its help said it only showed the state, so an
    // operator checking an unfamiliar repo trusted exactly the file they had
    // meant to inspect.
    writeLine(
      streams.stdout,
      [
        `Not trusted: ${fingerprint.path}`,
        `sha256: ${fingerprint.sha256}`,
        "Trusting this exact file would let these secret providers run:",
        ...workspaceTrust.untrustedProviderNames.map((name) =>
          describeTrustGatedProvider(name, loaded.resolvedConfig.secrets.providers[name])
        )
      ].join("\n")
    );

    if (!parsed.values.grant && !(await confirmTrustGrant(streams, deps))) {
      writeLine(streams.stdout, "Not trusted. Review the file, then run `aia trust --grant` to allow them.");
      return 0;
    }

    await grantConfigTrust(paths.userStateDirectory, fingerprint);
    writeLine(
      streams.stdout,
      [
        `Trusted ${fingerprint.path}`,
        `Now allowed: ${workspaceTrust.untrustedProviderNames.join(", ")}`,
        "Editing this file revokes trust until you grant it again."
      ].join("\n")
    );
    return 0;
  } catch (error) {
    writeLine(streams.stderr, renderCliError(error));
    return 1;
  }
}

/**
 * Asks before granting, but only when someone is at a terminal to answer.
 * Anything short of an explicit yes leaves the file untrusted.
 */
async function confirmTrustGrant(streams: CliStreams, deps: CliDependencies): Promise<boolean> {
  const reader = deps.interactiveInput
    ? toLineReader(deps.interactiveInput)
    : process.stdin.isTTY
      ? createStdinLineReader()
      : null;
  if (!reader) {
    return false;
  }

  try {
    // As at any question prompt, input typed before the question is stale.
    reader.discardBuffered();
    streams.stdout.write("Trust this exact file now? [y/N] ");
    const answer = await reader.next();
    return /^(y|yes)$/iu.test(answer?.trim() ?? "");
  } finally {
    await reader.close?.();
  }
}

function describeTrustGatedProvider(name: string, provider: SecretProviderConfig | undefined): string {
  if (provider?.source === "exec") {
    return `  - ${name}: runs ${stringifyArgv([provider.command, ...(provider.args ?? [])]) ?? provider.command}`;
  }
  if (provider?.source === "file") {
    return `  - ${name}: reads ${provider.path}`;
  }
  return `  - ${name}`;
}
