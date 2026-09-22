import { TerminalScreen, type TerminalScreenOptions } from "@/core/process/screen";

export type TerminalTurnWatcherOptions = TerminalScreenOptions & {
  /** Milliseconds with no new bytes before the turn is considered idle. */
  idleMs?: number;
  /** Regex matched against the last non-empty rendered line; a match ends the turn. */
  readyPattern?: RegExp;
  /** Milliseconds the rendered screen must stay unchanged. */
  stabilityMs?: number;
};

export type TerminalTurnResult = {
  reason: "exited" | "idle" | "ready_pattern" | "timeout";
  screen: string;
};

const DEFAULT_IDLE_MS = 1_500;
const DEFAULT_STABILITY_MS = 750;
const POLL_INTERVAL_MS = 100;

/**
 * Tracks a PTY stream and decides when the child has finished responding.
 *
 * There is no protocol here to ask — a TUI never says "turn over" — so the end of
 * a turn has to be inferred from three weak signals that are strong together:
 *
 * 1. **Byte idle.** Nothing arrived for `idleMs`. Alone this is wrong: a spinner
 *    emits bytes forever, and a slow model emits nothing for seconds mid-answer.
 * 2. **Screen stability.** The *rendered* screen is identical across two samples
 *    `stabilityMs` apart. This is what survives spinners and progress bars: their
 *    bytes keep coming but the cells they rewrite settle back to the same text
 *    only when... they do not, so pairing it with idle covers both directions.
 * 3. **Ready pattern.** A per-agent regex for the prompt the CLI prints when it
 *    wants input. It is matched against the *last non-empty line* only, because a
 *    prompt means "the cursor is waiting here" — matching anywhere on screen would
 *    match the prompt printed before the previous turn, which never scrolls away.
 *    It is also only honored once new output has arrived and then stopped, so the
 *    prompt that was already on screen when the turn began cannot end it early.
 *
 * Any single signal produces false positives; requiring idle *and* stability, or
 * an explicit ready pattern, is the cheap approximation that works in practice.
 *
 * A fourth, unambiguous signal short-circuits all of them: the child exiting.
 *
 * All three are gated on output that arrived **after the turn began**. A child
 * that has not answered yet trivially satisfies both idle and stability — it is
 * emitting nothing and the screen is not changing — so without that gate a slow
 * agent's `send` returns an empty screen the moment `stabilityMs` elapses, and
 * the caller is told the turn succeeded. Waiting for the timeout and reporting
 * `"timeout"` is the honest answer to "the agent never said anything".
 */
export class TerminalTurnWatcher {
  private readonly screen: TerminalScreen;
  private readonly idleMs: number;
  private readonly stabilityMs: number;
  private readonly readyPattern: RegExp | undefined;
  private lastChunkAt = Date.now();
  private chunkCount = 0;
  // Snapshotted by beginTurn() at the moment the instruction is written, not when
  // waitForTurnEnd() is entered: the caller persists state between the two, and
  // an echo that lands in that window would otherwise look like output that
  // predates the turn. Null means no turn boundary was declared, in which case
  // the whole stream counts — a caller that never calls beginTurn() is asking
  // "has this settled", not "has it answered me".
  private turnStartChunkCount: number | null = null;

  constructor(options: TerminalTurnWatcherOptions = {}) {
    const { idleMs, readyPattern, stabilityMs, ...screenOptions } = options;
    this.screen = new TerminalScreen(screenOptions);
    this.idleMs = idleMs ?? DEFAULT_IDLE_MS;
    this.stabilityMs = stabilityMs ?? DEFAULT_STABILITY_MS;
    this.readyPattern = readyPattern;
  }

  write(chunk: string): void {
    this.lastChunkAt = Date.now();
    this.chunkCount += 1;
    this.screen.write(chunk);
  }

  /** Marks the point a turn's input was written. See `turnStartChunkCount`. */
  beginTurn(): void {
    this.turnStartChunkCount = this.chunkCount;
  }

  resize(cols: number, rows: number): void {
    this.screen.resize(cols, rows);
  }

  dispose(): void {
    this.screen.dispose();
  }

  async read(options?: { includeScrollback?: boolean; maxLines?: number }): Promise<string> {
    return this.screen.read(options);
  }

  /**
   * Resolves when the child appears to be waiting for input again.
   *
   * `timeoutMs` is a hard ceiling so a child that never settles (a live log tail,
   * an animation that genuinely never repeats) cannot hang the caller forever.
   */
  async waitForTurnEnd(params: {
    /**
     * Resolves when the child exits. A dead child can never settle, answer, or
     * print its prompt, so every other signal here would simply run out the
     * clock and then report the pre-exit screen as though it were a reply.
     */
    exited?: Promise<unknown>;
    signal?: AbortSignal;
    timeoutMs: number;
  }): Promise<TerminalTurnResult> {
    const deadline = Date.now() + params.timeoutMs;
    const startChunkCount = this.turnStartChunkCount ?? 0;
    this.turnStartChunkCount = null;
    let exited = false;
    void params.exited?.then(() => {
      exited = true;
    });
    let stableSince: number | null = null;
    let readyMatchedAtChunkCount: number | null = null;
    let previousScreen = await this.screen.read();

    while (!params.signal?.aborted) {
      await delay(POLL_INTERVAL_MS);
      const screen = await this.screen.read();

      // Checked after the poll so the child's dying output is rendered first.
      if (exited) {
        return { reason: "exited", screen };
      }

      if (this.chunkCount > startChunkCount && this.matchesReadyPattern(screen)) {
        if (readyMatchedAtChunkCount === this.chunkCount) {
          return { reason: "ready_pattern", screen };
        }
        readyMatchedAtChunkCount = this.chunkCount;
      } else {
        readyMatchedAtChunkCount = null;
      }

      if (screen === previousScreen) {
        stableSince ??= Date.now();
        const answered = this.chunkCount > startChunkCount;
        const stableLongEnough = Date.now() - stableSince >= this.stabilityMs;
        const idleLongEnough = Date.now() - this.lastChunkAt >= this.idleMs;
        if (answered && stableLongEnough && idleLongEnough) {
          return { reason: "idle", screen };
        }
      } else {
        stableSince = null;
        previousScreen = screen;
      }

      if (Date.now() >= deadline) {
        return { reason: "timeout", screen };
      }
    }

    return { reason: "timeout", screen: await this.screen.read() };
  }

  /**
   * Resolves once the child has produced output and settled at its prompt.
   *
   * Starting a session is not the same as the agent being ready for input: a TUI
   * spends a noticeable moment booting and painting, and keystrokes sent before
   * it has drawn its input area are simply lost. This is the same settle logic a
   * turn uses, applied to the child's very first output.
   */
  async waitForReady(params: {
    exited?: Promise<unknown>;
    signal?: AbortSignal;
    timeoutMs: number;
  }): Promise<TerminalTurnResult> {
    // No beginTurn(): readiness is about the child's first output, so the whole
    // stream counts.
    return this.waitForTurnEnd(params);
  }

  private matchesReadyPattern(screen: string): boolean {
    if (!this.readyPattern) {
      return false;
    }

    const lines = screen.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index] ?? "";
      if (line.trim().length === 0) {
        continue;
      }
      return this.readyPattern.test(line);
    }

    return false;
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
