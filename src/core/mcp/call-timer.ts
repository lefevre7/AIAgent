/**
 * A tool call's timeout: `toolTimeoutMs` without progress. Progress from the
 * server starts the clock again, and while the server waits on the operator
 * (an elicitation) the clock stops, so a person thinking about an answer
 * never times out the call that asked.
 */
export class McpCallTimer {
  private timer: NodeJS.Timeout | undefined;
  private pauses = 0;
  private finished = false;

  constructor(
    private readonly timeoutMs: number,
    private readonly onTimeout: () => void
  ) {}

  start(): void {
    this.arm();
  }

  /** Progress arrived: the full budget again. */
  reset(): void {
    if (this.pauses === 0) {
      this.arm();
    }
  }

  /** The server is waiting on the operator. Nests: every pause needs a resume. */
  pause(): void {
    this.pauses += 1;
    this.clear();
  }

  resume(): void {
    this.pauses = Math.max(0, this.pauses - 1);
    if (this.pauses === 0) {
      this.arm();
    }
  }

  stop(): void {
    this.finished = true;
    this.clear();
  }

  private arm(): void {
    this.clear();
    if (this.finished) {
      return;
    }
    this.timer = setTimeout(() => {
      this.finished = true;
      this.onTimeout();
    }, this.timeoutMs);
    this.timer.unref?.();
  }

  private clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
