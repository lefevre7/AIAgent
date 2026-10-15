/**
 * The model's context window, from what is known of it, best first:
 *
 * 1. `runtime.modelSettings.contextWindowTokens` in config;
 * 2. what the server said when it refused a prompt as too long (llama.cpp
 *    sends its `n_ctx`): the window requests really get, which the provider's
 *    model listing can overstate (a model loaded with less than it supports);
 * 3. what the provider reports, re-read before every run.
 *
 * A learned window holds while the provider keeps reporting what it reported
 * when it was learned; a different report means the model changed (reloaded
 * with another context), and the report is used again.
 */
export class ContextWindowTracker {
  private reported: number | undefined;
  private learned: { reportedThen: number | undefined; tokens: number } | undefined;

  constructor(private readonly configured?: number) {}

  /** What the provider reports now; `undefined` (unknown) keeps the last known. */
  report(tokens: number | undefined): void {
    if (tokens !== undefined && tokens > 0) {
      this.reported = tokens;
    }
  }

  /** What a refusal said the window is. */
  learn(tokens: number): void {
    if (tokens > 0) {
      this.learned = { reportedThen: this.reported, tokens };
    }
  }

  get current(): number | undefined {
    if (this.configured !== undefined && this.configured > 0) {
      return this.configured;
    }
    if (this.learned && this.learned.reportedThen === this.reported) {
      return this.learned.tokens;
    }
    return this.reported;
  }
}
