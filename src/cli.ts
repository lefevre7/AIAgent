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
  type ArtifactReference,
  type SessionRecord,
  type StructuredError,
  type VoiceCaptureRecord,
  type VoiceService
} from "@/core";
import {
  createAIAgentSdkFromConfig,
  type AIAgentSdk,
  type AIAgentSessionHandle
} from "@/sdk";
import type {
  GatewayEvent,
  GatewaySessionSnapshot,
  Message
} from "@/core/contracts";

type CliStream = Pick<NodeJS.WriteStream, "write">;

type CliStreams = {
  stderr: CliStream;
  stdout: CliStream;
};

type CliDependencies = {
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
    writeLine(
      streams.stderr,
      `Failed to start AIAgent: ${renderCliError(error)}`
    );
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

    const created = await sdk.sessions.create({
      cwd: input.cwd,
      goal: input.goal,
      metadata: {
        surface: "cli"
      },
      title: input.title
    });

    writeLine(streams.stdout, formatChatWelcome(created.session.id));

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
            writeLine(
              streams.stderr,
              `Failed to list MCP servers: ${renderCliError(error)}`
            );
          }
          continue;
        }
        if (command === "unknown") {
          writeLine(
            streams.stderr,
            `Unknown command "${line}". Type /help for options, or /exit to leave.`
          );
          continue;
        }

        await runChatTurn(created.handle, line, streams, nextLine);
      }
    } finally {
      await iterator.return?.();
    }
  } catch (error) {
    writeLine(
      streams.stderr,
      `Failed to start AIAgent: ${renderCliError(error)}`
    );
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

function formatModelUnavailable(model: {
  details: Record<string, unknown>;
  providerId: string;
  status: string;
}): string {
  const detail =
    typeof model.details.error === "string" ? ` (${model.details.error})` : "";
  return [
    `Cannot start an interactive session: the chat model provider "${model.providerId}" is ${model.status}${detail}.`,
    'Start the provider (for example launch LM Studio or Ollama), then run `aia` again. For a one-shot run use `aia --prompt "…"`.'
  ].join("\n");
}

async function runChatTurn(
  handle: AIAgentSessionHandle,
  text: string,
  streams: CliStreams,
  nextLine: () => Promise<string | null>
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
      // Surface the failure reason so the operator can see why a tool failed.
      closeReasoning();
      const tool = event.payload;
      if (tool.status === "failed" && tool.error) {
        writeLine(
          streams.stderr,
          `· ${tool.toolName}: failed — ${tool.error.message}`
        );
      } else {
        writeLine(streams.stderr, `· ${tool.toolName}: ${tool.status}`);
      }
    } else if (event.topic === "gateway.status") {
      const metrics = event.payload.metrics;
      if (metrics) {
        closeReasoning();
        writeLine(
          streams.stderr,
          `${DIM}${formatStatusMetrics(metrics)}${RESET}`
        );
      }
    }
  };
  const unsubscribe = handle.subscribe(onEvent, {
    topics: [
      "message.delta",
      "message.reasoning",
      "tool.updated",
      "gateway.status"
    ]
  });

  try {
    // Thinking line is terminated so streamed tokens / tool lines start cleanly.
    writeLine(streams.stdout, "Thinking…");
    const run = await handle.sendMessage({ text });
    await run.wait();

    closeReasoning();
    if (streamedText) {
      streams.stdout.write("\n");
    }

    await resolvePendingApprovals(handle, streams, nextLine);

    const errorMessage = (await handle.snapshot()).snapshot.session.lastError
      ?.message;
    if (errorMessage) {
      writeLine(streams.stderr, `Error: ${errorMessage}`);
    }
  } catch (error) {
    writeLine(streams.stderr, renderCliError(error));
  } finally {
    unsubscribe();
  }
}

async function resolvePendingApprovals(
  handle: AIAgentSessionHandle,
  streams: CliStreams,
  nextLine: () => Promise<string | null>
): Promise<void> {
  for (let round = 0; round < 50; round += 1) {
    const pending = await handle.listPendingApprovals();
    if (pending.length === 0) {
      return;
    }

    for (const approval of pending) {
      const target = `${approval.request.target.label} → ${approval.request.target.value}`;
      streams.stdout.write(`Approve ${target}? [y/N] `);
      const answer = (await nextLine())?.trim().toLowerCase() ?? "";
      const decision =
        answer === "y" || answer === "yes" ? "approved" : "denied";
      await handle.resolveApproval({
        decision,
        requestId: approval.request.id
      });
      writeLine(
        streams.stdout,
        decision === "approved"
          ? `Approved ${approval.request.target.value}.`
          : `Denied ${approval.request.target.value}.`
      );
    }

    const resumeRun = await handle.resume();
    await resumeRun.wait();
  }
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

async function runVoiceCli(
  args: string[],
  streams: CliStreams,
  deps: CliDependencies = {}
): Promise<number> {
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
            writeLine(
              streams.stdout,
              "Usage: aia voice list-devices [--provider <id>] [--kind input|output]"
            );
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
            writeLine(
              streams.stdout,
              "Usage: aia voice list-voices [--provider <id>] [--locale <locale>]"
            );
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
            maxDurationMs: parseOptionalInteger(
              values["max-duration-ms"],
              "--max-duration-ms"
            ),
            metadata: {},
            providerId: values.provider,
            sessionId: values.session,
            silenceTimeoutMs: parseOptionalInteger(
              values["silence-timeout-ms"],
              "--silence-timeout-ms"
            )
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
            await context.voiceService
              .stopCapture(capture.id)
              .catch(() => undefined);
          };

          const onSignal = () => {
            void stop();
          };

          process.on("SIGINT", onSignal);
          process.on("SIGTERM", onSignal);

          try {
            const result = await context.voiceService.waitForCapture(
              capture.id
            );
            if (
              result.status !== "completed" ||
              !result.text ||
              !result.audio
            ) {
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
          voice:
            typeof params.audio.metadata.voice === "string"
              ? params.audio.metadata.voice
              : undefined,
          waveform: Array.isArray(params.audio.metadata.waveform)
            ? params.audio.metadata.waveform
                .filter(
                  (value): value is number =>
                    typeof value === "number" && value >= 0 && value <= 1
                )
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

async function resolveSdk(
  deps: CliDependencies,
  cwd: string
): Promise<AIAgentSdk> {
  return deps.createSdk
    ? deps.createSdk({ cwd })
    : createAIAgentSdkFromConfig({ cwd });
}

function parseChatCommand(
  line: string
): "exit" | "help" | "mcp" | "message" | "unknown" {
  if (!line.startsWith("/")) {
    return "message";
  }
  const name = line.slice(1).trim().toLowerCase().split(/\s+/u)[0];
  switch (name) {
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
    "  /mcp           List configured MCP servers, their state, and their tools",
    "  /exit, /quit   End the session and return to the shell",
    "Anything else is sent to the agent as a message."
  ].join("\n");
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
      const lines = [
        `${server.serverName}  [${server.state}, ${server.transport}]`
      ];
      if (server.error) {
        lines.push(`  error: ${server.error}`);
      }
      if (server.tools.length > 0) {
        for (const tool of server.tools) {
          lines.push(
            `  - ${tool.invocationName}${tool.description ? `: ${tool.description}` : ""}`
          );
        }
      } else {
        lines.push("  (no tools exposed)");
      }
      return lines.join("\n");
    })
    .join("\n");
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
  const message =
    record.error?.message ?? "Voice capture did not complete successfully.";
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

function parseDeviceKind(
  value: string | undefined
): "input" | "output" | undefined {
  if (!value) {
    return undefined;
  }
  if (value === "input" || value === "output") {
    return value;
  }
  throw new Error(
    `Invalid device kind "${value}". Expected "input" or "output".`
  );
}

function parseOptionalInteger(
  value: string | undefined,
  label: string
): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be an integer.`);
  }
  return parsed;
}

async function requireSession(
  store: FileSessionStore,
  sessionId: string
): Promise<SessionRecord> {
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

async function buildVoiceContext(
  deps: CliDependencies
): Promise<VoiceCliContext> {
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

function extractLatestAssistantSummary(
  snapshot: GatewaySessionSnapshot
): string | null {
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
