import React from "react";
import { describe, expect, test } from "vitest";

import { renderPrompt } from "@/core/prompts";

describe("prompt renderer", () => {
  test("renders headings, paragraphs, code, and lists into plain text", () => {
    const rendered = renderPrompt(
      <>
        <h1>Prompt Title</h1>
        <p>
          Use the <code>attempt_complete</code> tool when done.
        </p>
        <ul>
          <li>Inspect the workspace first.</li>
          <li>Keep status updates short.</li>
        </ul>
      </>
    );

    expect(rendered).toContain("Prompt Title");
    expect(rendered).toContain("Use the `attempt_complete` tool when done.");
    expect(rendered).toContain("- Inspect the workspace first.");
    expect(rendered).toContain("- Keep status updates short.");
  });
});
