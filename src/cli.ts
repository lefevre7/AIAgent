import { realpathSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  FileSessionStore,
  buildVoiceAudioArtifact,
  createBootstrapInfo,
  createVoiceServiceFromConfig,
  loadAIAgentConfig,
  grantConfigTrust,
  revokeConfigTrust,
  APP_CONFIG_FILE_NAME,
  COMPLETION_SUMMARY_MESSAGE_TAG,
  DEFAULT_LM_STUDIO_MODEL,
  type ArtifactReference,
  type LoadedAIAgentConfig,
  type SessionRecord,
  type StructuredError,
  type VoiceCaptureRecord,
  type VoiceService
} from "@/core";
import { createAIAgentSdkFromConfig, type AIAgentSdk, type AIAgentSessionHandle } from "@/sdk";
import { attachToExternalAgentSession } from "@/gateway/attach-client";
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

type CliDependencies = {
  // Overrides the terminal relay used by `aia attach`, so tests never need a
  // real gateway socket.
  attachToExternalAgentSession?: typeof attachToExternalAgentSession;
  // Overrides how the SDK is created. Lets tests drive the loop without a full
  // runtime; defaults to createAIAgentSdkFromConfig.
  createSdk?: (options: { cwd: string }) => Promise<AIAgentSdk>;
  // Overrides how the voice context (voice service + session store) is built for
  // `aia voice` subcommands. Lets tests drive them without native voice adapters;
  // defaults to building from the loaded config.
  createVoiceContext?: () => Promise<VoiceCliContext>;
  // Overrides the interactive line source. When omitted, a readline interface
  // over process.stdin is used (only when stdin is a TTY).
  interactiveInput?: AsyncIterable<string>;
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
    "  aia info             Print runtime surfaces and providers",
    "  aia attach <id>      Join a live interactive external-agent terminal (Ctrl-] to detach)",
    "  aia trust [--revoke] [--cwd <path>]",
    "                       Show or change trust for this workspace's config file",
    "  aia --help",
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
    writeLine(streams.stdout, formatBootstrapInfo());
    return 0;
  }

  if (argv[0] === "attach") {
    return runAttachCli(argv.slice(1), streams, deps);
  }

  if (argv[0] === "trust") {
    return runTrustCli(argv.slice(1), streams);
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
      }
    }
  });

  if (values.help) {
    writeLine(streams.stdout, formatHelp());
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
  const lineSource = deps.interactiveInput ?? createStdinLineSource();
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

function formatBootstrapInfo(): string {
  const info = createBootstrapInfo();
  return [
    `${info.name} bootstrap is in place.`,
    `Surfaces: ${info.surfaces.join(", ")}`,
    `Providers: ${info.providers.join(", ")}`
  ].join("\n");
}

async function runChatCli(
  input: {
    cwd: string;
    goal: string;
    title: string;
  },
  streams: CliStreams,
  lineSource: AsyncIterable<string>,
  deps: CliDependencies
): Promise<number> {
  let sdk: AIAgentSdk;
  try {
    sdk = await resolveSdk(deps, input.cwd);
  } catch (error) {
    writeLine(streams.stderr, `Failed to start AIAgent: ${renderCliError(error)}`);
    return 1;
  }

  try {
    // A REPL with no reachable chat model is useless, so gate on it up front
    // and exit cleanly rather than opening a session that errors on every turn.
    const model = await probeModelHealth(sdk);
    if (model.status !== "healthy") {
      writeLine(streams.stderr, formatModelUnavailable(model));
      return 1;
    }

    // Resolved once, not per turn: it only changes if the config files do, and
    // a failing turn is the worst moment to start reading the filesystem.
    const modelProvenance = await resolveChatModelProvenance(input.cwd);

    const created = await sdk.sessions.create({
      cwd: input.cwd,
      goal: input.goal,
      metadata: {
        surface: "cli"
      },
      title: input.title
    });

    writeLine(streams.stdout, formatChatWelcome(created.session.id));
    const approvalState = createCliApprovalState();

    // Manual iteration so approval prompts can pull the next line on demand.
    const iterator = lineSource[Symbol.asyncIterator]();
    const nextLine = async (): Promise<string | null> => {
      const result = await iterator.next();
      return result.done ? null : result.value;
    };

    try {
      for (;;) {
        streams.stdout.write(CHAT_PROMPT);
        const raw = await nextLine();
        if (raw === null) {
          return 0;
        }
        const line = raw.trim();
        if (line.length === 0) {
          continue;
        }

        const command = parseChatCommand(line);
        if (command === "exit") {
          writeLine(streams.stdout, "Goodbye.");
          return 0;
        }
        if (command === "help") {
          writeLine(streams.stdout, formatChatHelp());
          continue;
        }
        if (command === "mcp") {
          try {
            const { servers } = await sdk.request("mcp.list", {});
            writeLine(streams.stdout, formatMcpServers(servers));
          } catch (error) {
            writeLine(streams.stderr, `Failed to list MCP servers: ${renderCliError(error)}`);
          }
          continue;
        }
        if (command === "compact") {
          await runCompactCommand(created.handle, streams);
          continue;
        }
        if (command === "agents") {
          try {
            const { sessions } = await sdk.request("external_agent.session.list", {});
            writeLine(streams.stdout, formatExternalAgentSessions(sessions));
          } catch (error) {
            writeLine(streams.stderr, `Failed to list interactive external-agent sessions: ${renderCliError(error)}`);
          }
          continue;
        }
        if (command === "attach") {
          const externalSessionId = line.slice(1).trim().split(/\s+/u)[1];
          if (!externalSessionId) {
            writeLine(streams.stderr, "Usage: /attach <external-session-id> (see /agents)");
            continue;
          }
          try {
            const result = await sdk.request("external_agent.session.attach", {
              externalSessionId
            });
            writeLine(streams.stdout, `Opened a terminal window running: ${result.command}`);
          } catch (error) {
            writeLine(streams.stderr, `Failed to attach to ${externalSessionId}: ${renderCliError(error)}`);
          }
          continue;
        }
        if (command === "unknown") {
          writeLine(streams.stderr, `Unknown command "${line}". Type /help for options, or /exit to leave.`);
          continue;
        }

        await runChatTurn(created.handle, line, streams, nextLine, approvalState, modelProvenance);
      }
    } finally {
      await iterator.return?.();
    }
  } catch (error) {
    writeLine(streams.stderr, `Failed to start AIAgent: ${renderCliError(error)}`);
    return 1;
  } finally {
    await sdk.close().catch(() => undefined);
  }
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
 * Loads config purely to describe where the chat model id came from.
 *
 * Returns null on any failure: this exists to make an error clearer, so it must
 * never be able to turn one error into two.
 */
async function resolveChatModelProvenance(cwd: string): Promise<string | undefined> {
  try {
    return formatChatModelProvenance(await loadAIAgentConfig({ cwd }));
  } catch {
    return undefined;
  }
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
// unstated reason is indistinguishable from the agent quitting on you.
function formatTurnStopNotice(run: GatewayRunRecord | null, snapshot: SessionSnapshot): string | null {
  if (run?.completionReason === "session_completed") {
    return null;
  }

  const summary = snapshot.resumeMetadata?.statusSummary;
  const detail = summary ? ` ${summary}` : "";
  return `${ANSI_DIM}Turn ended: ${describeCompletionReason(run?.completionReason)} (session ${snapshot.session.status}).${detail}${ANSI_RESET}`;
}

async function runChatTurn(
  handle: AIAgentSessionHandle,
  text: string,
  streams: CliStreams,
  nextLine: () => Promise<string | null>,
  approvalState: CliApprovalState = createCliApprovalState(),
  modelProvenance?: string
): Promise<void> {
  const DIM = "[2m";
  const RESET = "[0m";
  let streamedText = false;
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
    }
  };
  const unsubscribe = handle.subscribe(onEvent, {
    topics: [
      "approval.requested",
      "message.delta",
      "message.reasoning",
      "tool.output.delta",
      "tool.updated",
      "gateway.status"
    ]
  });

  try {
    // Thinking line is terminated so streamed tokens / tool lines start cleanly.
    writeLine(streams.stdout, "Thinking…");
    const run = await handle.sendMessage({ text });
    let finalRun = await run.wait();

    closeReasoning();
    if (streamedText) {
      streams.stdout.write("\n");
    }

    finalRun = (await resolvePendingApprovals(handle, streams, nextLine, approvalState)) ?? finalRun;

    const snapshot = (await handle.snapshot()).snapshot;

    // The final answer arrives as the `attempt_complete` summary, which the
    // loop persists as a tagged assistant message. It never streams (it is a
    // tool argument, not generated text), so without this the operator sees
    // reasoning and status lines and no answer at all.
    const completionSummary = extractCompletionSummary(snapshot);
    if (completionSummary) {
      writeLine(streams.stdout, completionSummary);
    }

    const errorMessage = snapshot.session.lastError?.message;
    if (errorMessage) {
      writeLine(streams.stderr, `Error: ${errorMessage}`);
      // A provider error that names a model is almost always a config-location
      // problem rather than a provider problem, and the provider cannot know
      // that. Say which id we asked for and which files chose it.
      if (modelProvenance && mentionsChatModel(errorMessage)) {
        writeLine(streams.stderr, `${DIM}${modelProvenance}${RESET}`);
      }
    } else {
      // A turn that ends for any reason other than "the agent finished" used
      // to print nothing at all, which is how a paused or blocked run read as
      // the agent stopping for no reason.
      const notice = formatTurnStopNotice(finalRun, snapshot);
      if (notice) {
        writeLine(streams.stderr, notice);
      }
    }
  } catch (error) {
    writeLine(streams.stderr, renderCliError(error));
  } finally {
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
// tool returns to the model.
async function resolvePendingApprovals(
  handle: AIAgentSessionHandle,
  streams: CliStreams,
  nextLine: () => Promise<string | null>,
  state: CliApprovalState
): Promise<GatewayRunRecord | null> {
  let lastRun: GatewayRunRecord | null = null;

  for (let round = 0; round < 50; round += 1) {
    const pending = await handle.listPendingApprovals();
    if (pending.length === 0) {
      return lastRun;
    }

    for (const approval of pending) {
      const target = approval.request.target;

      if (target.kind === "question") {
        await answerAgentQuestion(handle, approval, streams, nextLine);
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
      streams.stdout.write(
        `Approve ${target.label} → ${target.value}? [y/N/a/e] (y = yes, N = no, a = always for this session, e = no + explain what to do instead) `
      );
      const answer = (await nextLine())?.trim().toLowerCase() ?? "";

      if (answer === "a" || answer === "always") {
        state.alwaysApprove.add(alwaysKey);
        await handle.resolveApproval({
          decision: "approved",
          requestId: approval.request.id
        });
        writeLine(
          streams.stdout,
          `Approved ${target.value}; further ${target.value} requests are auto-approved for this session.`
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
        streams.stdout.write("What should the agent do instead? ");
        note = (await nextLine())?.trim() ?? "";
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
    lastRun = await resumeRun.wait();
  }

  writeLine(
    streams.stderr,
    "Stopped after 50 rounds of approvals without the session settling. Run the prompt again, or resolve the remaining approvals from another surface."
  );
  return lastRun;
}

async function answerAgentQuestion(
  handle: AIAgentSessionHandle,
  approval: GatewayApprovalRecord,
  streams: CliStreams,
  nextLine: () => Promise<string | null>
): Promise<void> {
  writeLine(streams.stdout, `The agent asks: ${approval.request.justification}`);
  const options = readQuestionOptions(approval.request.metadata?.options);
  for (const [index, option] of options.entries()) {
    writeLine(streams.stdout, `  ${index + 1}) ${option.label}${option.description ? ` — ${option.description}` : ""}`);
  }

  streams.stdout.write(
    options.length > 0
      ? "Your answer (number, or type your own answer; Enter to skip): "
      : "Your answer (Enter to skip): "
  );
  const typed = (await nextLine())?.trim() ?? "";
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
      cwd: values.cwd ? path.resolve(values.cwd) : process.cwd()
    });
    const gateway = loaded.resolvedConfig.gateway;
    const url = values.url ?? `ws://${gateway.hostname}:${gateway.port}${gateway.websocketPath}`;
    const token = typeof gateway.auth.token === "string" ? gateway.auth.token : undefined;

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

async function resolveSdk(deps: CliDependencies, cwd: string): Promise<AIAgentSdk> {
  return deps.createSdk ? deps.createSdk({ cwd }) : createAIAgentSdkFromConfig({ cwd });
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

function formatChatWelcome(sessionId: string): string {
  return [
    "AIAgent interactive session. Type a message and press Enter.",
    `Session: ${sessionId}`,
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
    "Approval prompts accept y (approve once), a (approve and auto-approve this target for the",
    "rest of the session), or anything else to deny. A denial can carry an optional note that is",
    'sent to the agent as steering, e.g. "use ls instead".'
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

function createStdinLineSource(): AsyncIterable<string> {
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

  return {
    async *[Symbol.asyncIterator](): AsyncIterator<string> {
      try {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift() as string;
            continue;
          }
          if (closed) {
            return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      } finally {
        rl.close();
      }
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
function extractCompletionSummary(snapshot: SessionSnapshot): string | null {
  const summaryMessage = snapshot.messages
    .slice()
    .reverse()
    // `tags` is schema-defaulted, but snapshots reach the CLI from fakes and
    // older persisted records too; an absent array must not throw here.
    .find((message) => (message.tags ?? []).includes(COMPLETION_SUMMARY_MESSAGE_TAG));

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
async function runTrustCli(args: string[], streams: CliStreams): Promise<number> {
  let parsed: { values: { cwd?: string; help?: boolean; revoke?: boolean } };
  try {
    parsed = parseArgs({
      args,
      allowPositionals: false,
      options: {
        cwd: { type: "string" },
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
        "  aia trust                 Show the current trust state",
        "  aia trust --revoke        Remove trust for this workspace's config",
        "  aia trust --cwd <path>    Act on a different workspace"
      ].join("\n")
    );
    return 0;
  }

  const cwd = parsed.values.cwd ? path.resolve(parsed.values.cwd) : process.cwd();

  try {
    // Skip secret resolution: the whole point is that we may not be allowed to
    // run these providers yet, and resolving would raise the very error the
    // operator is here to fix.
    const loaded = await loadAIAgentConfig({ cwd, resolveSecrets: false });
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
        `No trust needed: ${configPath} declares no secret provider that can run commands or read arbitrary files.`
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

    await grantConfigTrust(paths.userStateDirectory, fingerprint);
    writeLine(
      streams.stdout,
      [
        `Trusted ${fingerprint.path}`,
        `sha256: ${fingerprint.sha256}`,
        `Now allowed: ${workspaceTrust.untrustedProviderNames.join(", ")}`,
        "Editing this file revokes trust until you run `aia trust` again."
      ].join("\n")
    );
    return 0;
  } catch (error) {
    writeLine(streams.stderr, renderCliError(error));
    return 1;
  }
}
