import { describe, expect, test } from "vitest";

import { bm25ToRelevance } from "@/core/memory";

// sqlite's bm25() returns 0 or a negative number, with *more negative*
// meaning a *better* match. Clamping the raw score to a minimum of 0 before
// use — as this used to do — discards that entirely, since real matches are
// always <= 0: every genuine result collapsed to the same clamped score,
// flattening lexical ranking to a constant. These assertions pin the
// deterministic transform directly, since real FTS5 ranking behavior is
// otherwise only exercisable when the local node:sqlite build happens to
// have FTS5 compiled in (it frequently does not — see docs/INITIAL_DESIGN.md).
describe("bm25ToRelevance", () => {
  test("a strongly negative (excellent) bm25 score scores much higher than a weak one", () => {
    const excellent = bm25ToRelevance(-20);
    const weak = bm25ToRelevance(-0.5);
    expect(excellent).toBeGreaterThan(weak);
  });

  test("is monotonically increasing as the raw score becomes more negative", () => {
    const scores = [-0.1, -1, -5, -10, -50].map(bm25ToRelevance);
    for (let index = 1; index < scores.length; index += 1) {
      expect(scores[index]).toBeGreaterThan(scores[index - 1]!);
    }
  });

  test("never collapses distinct real matches to the same score", () => {
    // The exact bug: Math.max(0, rawScore) is 0 for every real (<= 0) bm25
    // value, so 1 / (1 + 0) was 1 regardless of match quality.
    expect(bm25ToRelevance(-1)).not.toBe(bm25ToRelevance(-10));
    expect(bm25ToRelevance(-1)).not.toBe(bm25ToRelevance(-0.01));
  });

  test("stays within [0, 1) for any real bm25 output", () => {
    for (const raw of [0, -0.001, -1, -10, -1000]) {
      const score = bm25ToRelevance(raw);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThan(1);
    }
  });

  test("floors an unexpected positive value to the weakest score instead of going negative", () => {
    expect(bm25ToRelevance(5)).toBe(0);
  });
});
