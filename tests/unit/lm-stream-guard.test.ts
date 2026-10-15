import { afterEach, describe, expect, test, vi } from "vitest";

import { buildStreamAbortError, createStreamGuard } from "@/core/lm/shared";

afterEach(() => {
  vi.useRealTimers();
});

describe("createStreamGuard", () => {
  test("aborts after the idle timeout elapses with no activity once tokens have started", () => {
    vi.useFakeTimers();
    const guard = createStreamGuard({ idleTimeoutMs: 100 });
    guard.observe("hello");
    expect(guard.signal.aborted).toBe(false);
    vi.advanceTimersByTime(150);
    expect(guard.signal.aborted).toBe(true);
    expect(guard.abortReason()).toBe("idle");
    guard.dispose();
  });

  test("touch() resets the idle timer so a steady stream is never killed", () => {
    vi.useFakeTimers();
    const guard = createStreamGuard({ idleTimeoutMs: 100 });
    guard.observe("hello");
    for (let i = 0; i < 5; i += 1) {
      vi.advanceTimersByTime(80);
      guard.touch();
    }
    expect(guard.signal.aborted).toBe(false);
    vi.advanceTimersByTime(120);
    expect(guard.abortReason()).toBe("idle");
    guard.dispose();
  });

  test("aborts when the same line repeats past the threshold", () => {
    const guard = createStreamGuard({
      idleTimeoutMs: 0,
      repetitionThreshold: 3
    });
    guard.observe("I'll use apply_patch\nI'll use apply_patch\n");
    expect(guard.signal.aborted).toBe(false);
    guard.observe("I'll use apply_patch\n");
    expect(guard.signal.aborted).toBe(true);
    expect(guard.abortReason()).toBe("repetition");
    guard.dispose();
  });

  test("does not abort on varied output", () => {
    const guard = createStreamGuard({
      idleTimeoutMs: 0,
      repetitionThreshold: 3
    });
    guard.observe("first line\nsecond line\nthird line\nfourth line\n");
    expect(guard.signal.aborted).toBe(false);
    expect(guard.abortReason()).toBeNull();
    guard.dispose();
  });

  test("ignores trivial repeated lines (blank/braces) below the min length", () => {
    const guard = createStreamGuard({
      idleTimeoutMs: 0,
      repetitionThreshold: 3,
      minRepeatLineLength: 4
    });
    guard.observe("}\n}\n}\n}\n}\n");
    expect(guard.signal.aborted).toBe(false);
    guard.dispose();
  });

  test("uses the generous first-token budget before any token, then the tighter idle window", () => {
    vi.useFakeTimers();
    const guard = createStreamGuard({
      firstTokenTimeoutMs: 1000,
      idleTimeoutMs: 100
    });

    // Pre-first-token: the short idle window must NOT apply yet.
    vi.advanceTimersByTime(300);
    expect(guard.signal.aborted).toBe(false);

    // First token arrives → switch to the tighter idle window.
    guard.observe("hello");
    vi.advanceTimersByTime(80);
    expect(guard.signal.aborted).toBe(false);
    vi.advanceTimersByTime(40);
    expect(guard.abortReason()).toBe("idle");
    guard.dispose();
  });

  // Told apart from a stall: a local model sends nothing while it reads a long
  // prompt, and the 2026-10-02 report was this budget, worded as a stall.
  test("reports the first-token budget, not a stall, when no token ever arrives", () => {
    vi.useFakeTimers();
    const guard = createStreamGuard({
      firstTokenTimeoutMs: 1000,
      idleTimeoutMs: 100
    });
    // Chunks without text (a role delta, keep-alives) do not start the stream.
    guard.touch();
    vi.advanceTimersByTime(1100);
    expect(guard.abortReason()).toBe("first_token");
    guard.dispose();
  });
});

// The ways a stream guard kills a generation. These messages are what the
// operator sees when a run fails, so they have to name the cause, and the
// setting to change, rather than surfacing a bare AbortError.
describe("buildStreamAbortError", () => {
  test("explains an idle stall as a stall, with the window and the setting", () => {
    const error = buildStreamAbortError("lm_studio", "idle", {
      firstTokenTimeoutMs: 1_800_000,
      idleTimeoutMs: 60_000,
      settingsPath: "providers.lmStudio"
    });

    expect(error.code).toBe("provider_stream_idle");
    expect(error.message).toBe(
      "The lm_studio stream stalled: no new tokens arrived within 1 min after it started. To wait longer, raise providers.lmStudio.streamIdleTimeoutMs."
    );
    expect(error.details).toEqual({ provider: "lm_studio", reason: "idle" });
    // Retrying an idle stall automatically would just stall again.
    expect(error.retriable).toBe(false);
  });

  test("explains a first-token timeout as a model that may still be reading the prompt", () => {
    const error = buildStreamAbortError("lm_studio", "first_token", {
      firstTokenTimeoutMs: 1_800_000,
      idleTimeoutMs: 60_000,
      settingsPath: "providers.lmStudio"
    });

    expect(error.code).toBe("provider_stream_first_token");
    expect(error.message).toBe(
      "The lm_studio model did not start answering within 30 min. A local model may still be reading a long prompt; to wait longer, raise providers.lmStudio.streamFirstTokenTimeoutMs."
    );
  });

  test("names the setting generically for an adapter built without a settings path", () => {
    const error = buildStreamAbortError("custom", "first_token", { firstTokenTimeoutMs: 45_000 });

    expect(error.message).toContain("within 45 s");
    expect(error.message).toContain("raise the provider's streamFirstTokenTimeoutMs");
  });

  test("explains a repetition abort as a likely model loop", () => {
    const error = buildStreamAbortError("ollama", "repetition");

    expect(error.code).toBe("provider_stream_repetition");
    expect(error.message).toContain("model loop");
    expect(error.details).toEqual({ provider: "ollama", reason: "repetition" });
  });
});
