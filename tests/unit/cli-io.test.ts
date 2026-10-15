import { describe, expect, test } from "vitest";

import { runSubcommands, sanitizeForTerminal } from "@/commands/io";

describe("sanitizeForTerminal", () => {
  test("shows escape sequences instead of letting them drive the terminal", () => {
    expect(sanitizeForTerminal("\u001b[31mred\u001b[0m")).toBe("\\x1b[31mred\\x1b[0m");
    // OSC 52 writes the clipboard; OSC 8 makes a link whose text lies.
    expect(sanitizeForTerminal("\u001b]52;c;ZXZpbA==\u0007")).toBe("\\x1b]52;c;ZXZpbA==\\x07");
    // The 8-bit CSI introducer works on some terminals without an ESC.
    expect(sanitizeForTerminal("\u009b2J")).toBe("\\x9b2J");
  });

  test("shows a carriage return, which could overwrite what came before it", () => {
    expect(sanitizeForTerminal("Approve? safe\rApprove? EVIL")).toBe("Approve? safe\\rApprove? EVIL");
  });

  test("shows bidirectional overrides, which reorder what a reader sees", () => {
    expect(sanitizeForTerminal("file\u202etxt.exe")).toBe("file\\u202etxt.exe");
    expect(sanitizeForTerminal("a\u2066b\u2069")).toBe("a\\u2066b\\u2069");
  });

  test("keeps newlines and tabs in text, and shows them on a single line", () => {
    expect(sanitizeForTerminal("one\n\ttwo")).toBe("one\n\ttwo");
    expect(sanitizeForTerminal("one\n\ttwo", { singleLine: true })).toBe("one\\n\\ttwo");
  });

  test("leaves ordinary text, accents and emoji alone", () => {
    const text = "Café — résumé 👍 日本語";
    expect(sanitizeForTerminal(text)).toBe(text);
    expect(sanitizeForTerminal(text, { singleLine: true })).toBe(text);
  });
});

describe("runSubcommands", () => {
  function capture() {
    const out = { stderr: "", stdout: "" };
    return {
      out,
      streams: {
        stderr: { write: (text: string) => ((out.stderr += text), true) },
        stdout: { write: (text: string) => ((out.stdout += text), true) }
      }
    };
  }
  const run = (args: string[], handlers: Record<string, (args: string[]) => Promise<number>>) => {
    const { out, streams } = capture();
    return runSubcommands({ args, command: "mcp", handlers, help: () => "HELP", streams }).then((code) => ({
      code,
      ...out
    }));
  };

  test("runs the named subcommand with the rest of the arguments", async () => {
    const seen: string[][] = [];
    const result = await run(["list", "--json"], { list: async (args) => (seen.push(args), 0) });
    expect(result.code).toBe(0);
    expect(seen).toEqual([["--json"]]);
  });

  test("prints help and exits 0, asked for or with no subcommand, as aia voice does", async () => {
    // A bare `aia mcp` used to exit 1 after printing help to stdout.
    for (const args of [["--help"], ["-h"], ["help"], []]) {
      expect(await run(args, {})).toMatchObject({ code: 0, stderr: "", stdout: "HELP\n" });
    }
  });

  test("an inherited property is not a subcommand", async () => {
    // `handlers["constructor"]` is Object: `aia mcp constructor` used to
    // call it and return an array as the exit code.
    for (const name of ["constructor", "toString", "__proto__"]) {
      const result = await run([name], { list: async () => 0 });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`Unknown mcp subcommand: ${name}`);
    }
  });

  test("reports what a subcommand throws, and exits 1", async () => {
    const result = await run(["add"], {
      add: async () => {
        throw new Error("no such file");
      }
    });
    expect(result).toMatchObject({ code: 1, stderr: "aia mcp add failed: no such file\n" });
  });
});
