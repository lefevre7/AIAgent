import readline from "node:readline";

/**
 * Typing at a terminal, edited by Node's readline instead of the terminal
 * driver while a prompt is on screen.
 *
 * In the driver's own line mode the kernel holds a half-typed line where aia
 * cannot see it. Output written meanwhile (startup finishing, an MCP server
 * failing) moved that text off the prompt line, and a fresh, empty prompt
 * followed, so the text looked sent when it was not (2026-10-02). The driver
 * also caps a line at MAX_CANON, 1,024 bytes on macOS: a longer paste could
 * not be sent at all, and Enter did nothing.
 *
 * Readline owns the line only while a prompt is up. While a turn runs the
 * terminal is back in line mode, as before: typing echoes, a line typed ahead
 * waits for the next prompt, and Ctrl-C is the SIGINT the REPL already
 * handles. Readline redraws its prompt line on edits and on every resize,
 * which would erase a turn's streamed output.
 */
export type TerminalLineInput = {
  readonly interactive: true;
  /** A prompt is on screen and readline owns the line. */
  readonly prompting: boolean;
  close(): void;
  /** Drops what was typed before now, including what the terminal still holds. */
  discardBuffered(): void;
  next(): Promise<string | null>;
  /** Puts `text` on screen and hands the line to the person, with whatever they had typed. */
  prompt(text: string): void;
  /**
   * Takes the terminal back for output. `below` first moves past the typed
   * text, for output that starts while a prompt is still up. A half-typed
   * line is kept for the next prompt.
   */
  release(options?: { below?: boolean }): void;
  /** Ctrl-C typed at a prompt: readline turns off the terminal's own SIGINT. */
  subscribe(listener: () => void): () => void;
  /** Writes output above the prompt, then redraws the prompt and the typed text under it. */
  writeAbove(write: () => void): void;
};

// Input the terminal already held when a question appears arrives at once;
// anything typed this long after the question is on screen is its answer.
const STALE_INPUT_DRAIN_MS = 50;

export function isTerminalLineInput(value: unknown): value is TerminalLineInput {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<TerminalLineInput>).writeAbove === "function" &&
    typeof (value as Partial<TerminalLineInput>).release === "function"
  );
}

export function createTerminalLineInput(terminal: {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}): TerminalLineInput {
  const { input, output } = terminal;
  // Shared by every prompt's interface, so Up recalls earlier prompts' lines.
  const history: string[] = [];
  const queue: string[] = [];
  const interruptListeners = new Set<() => void>();
  let active: readline.Interface | null = null;
  let draining: { interface: readline.Interface; timer: NodeJS.Timeout } | null = null;
  let promptText = "";
  // Typed but not sent when the line was last handed back.
  let carried = "";
  let discardHeld = false;
  let ended = false;
  let releasing = false;
  let wake: (() => void) | null = null;

  const notify = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };

  // Readline's own editing keys, so its idea of the line and the screen agree.
  const press = (target: readline.Interface, key: readline.Key): void => {
    target.write(null, key);
  };
  const clearTyped = (target: readline.Interface): void => {
    press(target, { ctrl: true, name: "e" });
    press(target, { ctrl: true, name: "u" });
  };

  // A prompt's interface shows and records what is typed; a drain's does
  // neither.
  const open = (forPrompt: boolean): readline.Interface => {
    const created = readline.createInterface({
      input,
      terminal: true,
      ...(forPrompt ? { history, output, removeHistoryDuplicates: true } : { historySize: 0 })
    });
    created.on("SIGINT", () => {
      // As the terminal does: Ctrl-C abandons the line being typed.
      clearTyped(created);
      for (const listener of [...interruptListeners]) {
        listener();
      }
    });
    // After Ctrl-Z and `fg` readline pauses itself and leaves resuming to us.
    created.on("SIGCONT", () => {
      created.resume();
    });
    created.on("close", () => {
      if (active === created) {
        active = null;
      }
      if (!releasing) {
        // Ctrl-D on an empty line, or the terminal went away.
        ended = true;
        notify();
      }
    });
    return created;
  };

  const shut = (target: readline.Interface): void => {
    releasing = true;
    try {
      target.close();
    } finally {
      releasing = false;
    }
  };

  const show = (): void => {
    const created = open(true);
    created.on("line", (line) => {
      queue.push(line);
      notify();
    });
    active = created;
    created.setPrompt(promptText);
    created.prompt();
    if (carried.length > 0) {
      const typed = carried;
      carried = "";
      created.write(typed);
    }
  };

  const stopDraining = (): void => {
    if (draining) {
      clearTimeout(draining.timer);
      shut(draining.interface);
      draining = null;
    }
  };

  return {
    close(): void {
      stopDraining();
      if (active) {
        const current = active;
        active = null;
        shut(current);
      }
      ended = true;
      notify();
    },
    discardBuffered(): void {
      queue.length = 0;
      carried = "";
      if (active) {
        clearTyped(active);
      } else {
        // Lines typed while a turn ran are still the terminal's.
        discardHeld = true;
      }
    },
    interactive: true,
    async next(): Promise<string | null> {
      for (;;) {
        if (queue.length > 0) {
          return queue.shift() as string;
        }
        if (ended) {
          return null;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
    get prompting(): boolean {
      return active !== null;
    },
    prompt(text: string): void {
      promptText = text;
      if (active) {
        active.setPrompt(text);
        active.prompt(true);
        return;
      }
      if (draining) {
        // The prompt appears when the drain ends.
        return;
      }
      if (queue.length > 0) {
        // Sent before this prompt (the rest of a multi-line paste): it goes
        // now, so show it as sent here.
        output.write(`${text}${queue[0]}\r\n`);
        return;
      }
      if (discardHeld) {
        // Read what the terminal held from before the question, through an
        // interface that shows and sends nothing, then drop it.
        discardHeld = false;
        const drainer = open(false);
        draining = {
          interface: drainer,
          timer: setTimeout(() => {
            draining = null;
            shut(drainer);
            if (!ended) {
              show();
            }
          }, STALE_INPUT_DRAIN_MS)
        };
        return;
      }
      show();
    },
    release(options: { below?: boolean } = {}): void {
      stopDraining();
      const current = active;
      if (!current) {
        return;
      }
      if (options.below) {
        press(current, { ctrl: true, name: "e" });
        output.write("\r\n");
      }
      carried = current.line;
      active = null;
      shut(current);
    },
    subscribe(listener: () => void): () => void {
      interruptListeners.add(listener);
      return () => {
        interruptListeners.delete(listener);
      };
    },
    writeAbove(write: () => void): void {
      const current = active;
      if (!current) {
        write();
        return;
      }
      const typed = current.line;
      const cursor = current.cursor;
      // Emptying the line through readline leaves only the prompt on screen,
      // with readline's count of the rows it spans still right.
      clearTyped(current);
      const { rows } = current.getCursorPos();
      readline.moveCursor(output, 0, -rows);
      readline.cursorTo(output, 0);
      readline.clearScreenDown(output);
      write();
      // Readline redraws the prompt from `rows` rows above where it last left
      // the cursor; start it just below the output instead.
      if (rows > 0) {
        output.write("\n".repeat(rows));
      }
      current.prompt(true);
      if (typed.length > 0) {
        current.write(typed);
        for (let left = typed.length - cursor; left > 0; left -= 1) {
          press(current, { name: "left" });
        }
      }
    }
  };
}
