import { afterEach, describe, expect, test, vi } from "vitest";

import { createStreamGuard } from "@/core/lm/shared";

afterEach(() => {
  vi.useRealTimers();
});

describe("createStreamGuard", () => {
  test("aborts after the idle timeout elapses with no activity", () => {
    vi.useFakeTimers();
    const guard = createStreamGuard({ idleTimeoutMs: 100 });
    expect(guard.signal.aborted).toBe(false);
    vi.advanceTimersByTime(150);
    expect(guard.signal.aborted).toBe(true);
    expect(guard.abortReason()).toBe("idle");
    guard.dispose();
  });

  test("touch() resets the idle timer so a steady stream is never killed", () => {
    vi.useFakeTimers();
    const guard = createStreamGuard({ idleTimeoutMs: 100 });
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
});
