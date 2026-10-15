import { describe, expect, test } from "vitest";

import { bm25ToRelevance, buildFtsMatchExpression } from "@/core/memory";

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

// FTS5 read the raw query as its own syntax: a quote or a hyphen was an error,
// and several words had to appear together. Each word is now a quoted prefix
// term, joined with OR so bm25 ranks by how many of them a chunk has.
describe("FTS5 match expression", () => {
  test("quotes each meaningful word as a prefix term", () => {
    expect(buildFtsMatchExpression("Where is the release checklist for the gateway?")).toBe(
      '"release"* OR "checklist"* OR "gateway"*'
    );
  });

  test("reads query syntax as plain words", () => {
    expect(buildFtsMatchExpression('gateway "ports" -config (jsonc OR NOT')).toBe(
      '"gateway"* OR "ports"* OR "config"* OR "jsonc"*'
    );
  });

  test("matches a query with no meaningful word as a quoted phrase", () => {
    expect(buildFtsMatchExpression('to "be"')).toBe('"to ""be"""');
  });
});
