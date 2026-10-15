import { PassThrough, Writable } from "node:stream";

import { createTerminalLineInput, type TerminalLineInput } from "@/commands/terminal-input";
import { TerminalScreen } from "@/core/process/screen";

export type FakeTerminal = {
  lines: TerminalLineInput;
  output: Writable;
  /** Every raw-mode switch the input asked for, in order. */
  rawModes: boolean[];
  /** The screen as a person would see it, scrollback included. */
  screenText(): Promise<string>;
  /** Keystrokes, as the terminal would deliver them; waits for readline to take them. */
  type(text: string): Promise<void>;
};

/**
 * A terminal for the terminal line input to drive: keystrokes go in, and what
 * is written comes out through a terminal emulator, so tests read the rendered
 * screen rather than escape codes.
 */
export function createFakeTerminal(options: { columns?: number; rows?: number } = {}): FakeTerminal {
  const columns = options.columns ?? 60;
  const rows = options.rows ?? 20;
  const screen = new TerminalScreen({ cols: columns, rows });
  const rawModes: boolean[] = [];
  const input = Object.assign(new PassThrough(), {
    isRaw: false,
    isTTY: true,
    setRawMode(mode: boolean) {
      input.isRaw = mode;
      rawModes.push(mode);
      return input;
    }
  });
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, callback) {
        // A terminal driver turns "\n" into "\r\n" on the way out (ONLCR).
        screen.write(String(chunk).replace(/\r?\n/gu, "\r\n"));
        callback();
      }
    }),
    { columns, isTTY: true, rows }
  );
  const lines = createTerminalLineInput({
    input: input as unknown as NodeJS.ReadStream,
    output: output as unknown as NodeJS.WriteStream
  });
  return {
    lines,
    output,
    rawModes,
    async screenText(): Promise<string> {
      return screen.read({ includeScrollback: true });
    },
    async type(text: string): Promise<void> {
      input.write(text);
      // Readline handles input a tick or two after it is written.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
}
