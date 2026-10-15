import path from "node:path";

import { loadAIAgentConfig } from "@/core/config";
import { extractStructuredError } from "@/core/contracts";

export type CliStream = Pick<NodeJS.WriteStream, "write">;

export type CliStreams = {
  stderr: CliStream;
  stdout: CliStream;
};

export const ANSI_DIM = "\x1b[2m";
export const ANSI_RESET = "\x1b[0m";

export function writeLine(stream: CliStream, value: string): void {
  stream.write(`${value}\n`);
}

/**
 * Runs one of a command's subcommands (`aia mcp <subcommand>`): help with
 * none (exit 1) or `--help`/`-h`/`help` (exit 0), an error naming an unknown
 * one, and whatever a handler throws reported as
 * `aia <command> <subcommand> failed: …` (exit 1).
 */
export async function runSubcommands(params: {
  args: string[];
  command: string;
  handlers: Record<string, (args: string[]) => Promise<number>>;
  help: () => string;
  streams: CliStreams;
}): Promise<number> {
  const [subcommand, ...rest] = params.args;
  // A bare `aia mcp` is a request for help, as a bare `aia voice` is.
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    writeLine(params.streams.stdout, params.help());
    return 0;
  }
  // Own keys only: "constructor" is not a subcommand.
  const handler = Object.hasOwn(params.handlers, subcommand) ? params.handlers[subcommand] : undefined;
  if (!handler) {
    writeLine(params.streams.stderr, `Unknown ${params.command} subcommand: ${subcommand}\n\n${params.help()}`);
    return 1;
  }
  try {
    return await handler(rest);
  } catch (error) {
    writeLine(params.streams.stderr, `aia ${params.command} ${subcommand} failed: ${renderCliError(error)}`);
    return 1;
  }
}

/**
 * The config a one-shot command (`aia mcp`, `aia skills`, `aia info`,
 * `aia trust`) reads: from `cwd` (the current directory without one), with no
 * untrusted-config warning, since these commands show what is untrusted or
 * are the answer to it. Secrets are resolved only for a command that uses them.
 */
export function loadCommandConfig(params: { cwd?: string; resolveSecrets: boolean; userHomeDirectory?: string }) {
  return loadAIAgentConfig({
    cwd: params.cwd ? path.resolve(params.cwd) : process.cwd(),
    resolveSecrets: params.resolveSecrets,
    ...(params.userHomeDirectory ? { userHomeDirectory: params.userHomeDirectory } : {}),
    warnWhenUntrusted: false
  });
}

// C0 controls except tab and newline, DEL, C1 controls, and the Unicode
// bidirectional overrides and isolates ("Trojan Source"). Matching control
// characters is the point of these two patterns.
// eslint-disable-next-line no-control-regex
const UNSAFE_TERMINAL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;
// eslint-disable-next-line no-control-regex
const UNSAFE_SINGLE_LINE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;

/**
 * Makes text that came from outside aia safe to print to the operator's
 * terminal: a workspace config, an MCP server's messages, instructions or
 * stderr, a SKILL.md. Control characters are shown as visible escapes, so an
 * ESC sequence or a carriage return cannot erase or rewrite what the operator
 * is looking at (a trust prompt listing a harmless command over a malicious
 * one), set the clipboard (OSC 52), or disguise a link (OSC 8).
 *
 * `singleLine` also escapes newlines and tabs, for a value that is meant to sit
 * on one line (a name, a command, a URL).
 */
export function sanitizeForTerminal(text: string, options: { singleLine?: boolean } = {}): string {
  return text.replace(options.singleLine ? UNSAFE_SINGLE_LINE_CHARACTERS : UNSAFE_TERMINAL_CHARACTERS, (character) =>
    escapeCharacter(character)
  );
}

function escapeCharacter(character: string): string {
  switch (character) {
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\t":
      return "\\t";
    default: {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
    }
  }
}

export function renderCliError(error: unknown): string {
  const structured = extractStructuredError(error);
  if (structured) {
    return `${structured.code}: ${structured.message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
