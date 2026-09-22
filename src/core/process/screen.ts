import { createRequire } from "node:module";

import type { Terminal as XtermTerminal } from "@xterm/headless";

// `@xterm/headless` ships CommonJS only. A static `import` of it is resolved by
// bundlers, and webpack's interop hands back an `undefined` default (the Next
// build crashed on `const { Terminal } = headless`). Loading it through a real
// runtime `require` keeps the builtin CJS semantics under tsx, tsup, and Next
// alike — the same reason `src/gateway/websocket.ts` loads `ws` this way.
const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as {
  Terminal: new (options: Record<string, unknown>) => XtermTerminal;
};

export type TerminalScreenOptions = {
  cols?: number;
  rows?: number;
  /** Lines of history kept above the visible screen. */
  scrollback?: number;
};

export type TerminalScreenReadOptions = {
  /** Include the scrollback history above the visible screen. */
  includeScrollback?: boolean;
  /** Keep only the last N rendered lines. */
  maxLines?: number;
};

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 40;
const DEFAULT_SCROLLBACK = 2_000;

/**
 * Replays a PTY byte stream through a real terminal emulator so callers can read
 * the *rendered screen* instead of raw bytes.
 *
 * Why this is necessary: a TUI does not emit a transcript. It emits cursor moves,
 * line erases, colour changes, and alternate-screen switches, then rewrites cells
 * in place. Concatenating the bytes produces a garbled log in which a spinner
 * appears a thousand times and the "final" answer is interleaved with the frames
 * that were overwritten before a human ever saw them. Feeding those same bytes to
 * an emulator and reading its buffer yields exactly what the human's terminal
 * shows — which is the only sane thing to hand a language model.
 *
 * Stripping ANSI escapes with a regex is the tempting shortcut and it is wrong:
 * it keeps every overwritten frame and loses the cursor addressing that decides
 * where text actually landed.
 */
export class TerminalScreen {
  private readonly terminal: InstanceType<typeof Terminal>;

  constructor(options: TerminalScreenOptions = {}) {
    this.terminal = new Terminal({
      allowProposedApi: true,
      cols: options.cols ?? DEFAULT_COLS,
      rows: options.rows ?? DEFAULT_ROWS,
      scrollback: options.scrollback ?? DEFAULT_SCROLLBACK
    });
  }

  write(chunk: string): void {
    this.terminal.write(chunk);
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }

  dispose(): void {
    this.terminal.dispose();
  }

  /**
   * Renders the current screen. Awaits the emulator's parse queue first, so a
   * caller that just wrote bytes sees their effect rather than the prior frame.
   */
  async read(options: TerminalScreenReadOptions = {}): Promise<string> {
    await this.flush();

    const buffer = this.terminal.buffer.active;
    // `baseY` is the first row of the visible screen within the whole buffer, so
    // everything below it is on screen and everything above it is scrollback.
    const start = options.includeScrollback ? 0 : buffer.baseY;
    const end = buffer.baseY + this.terminal.rows;

    const lines: string[] = [];
    for (let index = start; index < end; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
    }

    const trimmed = trimTrailingBlankLines(lines);
    const limited =
      options.maxLines !== undefined && trimmed.length > options.maxLines
        ? trimmed.slice(trimmed.length - options.maxLines)
        : trimmed;

    return limited.join("\n");
  }

  private async flush(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.terminal.write("", resolve);
    });
  }
}

function trimTrailingBlankLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.trim().length === 0) {
    end -= 1;
  }

  return lines.slice(0, end);
}
