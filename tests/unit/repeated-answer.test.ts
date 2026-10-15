import { describe, expect, test } from "vitest";

import { repeatsShownText } from "@/core/agent";

describe("repeatsShownText", () => {
  test("treats a summary already contained in the shown text as a repeat, ignoring case and spacing", () => {
    expect(repeatsShownText("pong", "pong")).toBe(true);
    expect(repeatsShownText("The build  passed.", "Done.\nthe build passed.")).toBe(true);
  });

  test("keeps a summary that adds anything, and an empty one is never a repeat", () => {
    expect(repeatsShownText("The build passed and 3 tests were skipped.", "The build passed.")).toBe(false);
    expect(repeatsShownText("   ", "anything")).toBe(false);
  });
});
