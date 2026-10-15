import { afterEach, describe, expect, test } from "vitest";

import type { TerminalLineInput } from "@/commands/terminal-input";
import { createFakeTerminal, type FakeTerminal } from "../helpers/fake-terminal";

const opened: TerminalLineInput[] = [];
afterEach(() => {
  for (const lines of opened.splice(0)) {
    lines.close();
  }
});

function terminal(): FakeTerminal {
  const fake = createFakeTerminal({ columns: 60 });
  opened.push(fake.lines);
  return fake;
}

// Readline handles input a tick or two after it is written.
async function settle(ms = 5): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function lastLine(fake: FakeTerminal): Promise<string> {
  return (await fake.screenText()).split("\n").at(-1) ?? "";
}

describe("terminal line input", () => {
  test("reads a line typed at the prompt, owning the terminal only while the prompt is up", async () => {
    const fake = terminal();

    fake.lines.prompt("› ");
    expect(fake.lines.prompting).toBe(true);
    expect(fake.rawModes).toEqual([true]);
    await fake.type("hello\r");
    await expect(fake.lines.next()).resolves.toBe("hello");

    fake.lines.release();
    expect(fake.lines.prompting).toBe(false);
    // Back to the terminal's own line mode while a turn runs.
    expect(fake.rawModes).toEqual([true, false]);
    expect(await fake.screenText()).toBe("› hello");
  });

  // The terminal's own line mode cannot send a line of 1,024 bytes or more on
  // macOS: Enter does nothing.
  test("sends a line of any length", async () => {
    const fake = terminal();

    fake.lines.prompt("› ");
    await fake.type(`${"x".repeat(5_000)}\r`);

    await expect(fake.lines.next()).resolves.toBe("x".repeat(5_000));
  });

  // The 2026-10-02 report: startup finished while a prompt was half typed, the
  // session line printed after it, and the text looked sent when it was not.
  test("writes output above the prompt and keeps the typed text under it", async () => {
    const fake = terminal();

    fake.lines.prompt("› ");
    await fake.type("please help me add");
    fake.lines.writeAbove(() => {
      fake.output.write("Session: session.1\n· MCP drps-jedi failed: fetch failed — /mcp\n");
    });

    expect(await fake.screenText()).toBe(
      ["Session: session.1", "· MCP drps-jedi failed: fetch failed — /mcp", "› please help me add"].join("\n")
    );
    await fake.type(" two MCP servers\r");
    await expect(fake.lines.next()).resolves.toBe("please help me add two MCP servers");
  });

  test("redraws a typed line that wraps, with the cursor where it was", async () => {
    const fake = terminal();
    const typed = `${"a".repeat(50)}${"b".repeat(50)}`;

    fake.lines.prompt("› ");
    await fake.type(typed);
    // Back over the b's: the cursor sits mid-line when the output arrives.
    await fake.type("\x1b[D".repeat(50));
    fake.lines.writeAbove(() => {
      fake.output.write("a notice\n");
    });

    const screen = await fake.screenText();
    expect(screen.split("\n")[0]).toBe("a notice");
    expect(screen.split("\n").slice(1).join("")).toBe(`› ${typed}`);
    // Typing goes in at the cursor, between the a's and the b's.
    await fake.type("|\r");
    await expect(fake.lines.next()).resolves.toBe(`${"a".repeat(50)}|${"b".repeat(50)}`);
  });

  test("keeps a half-typed line for the next prompt when output takes the terminal back", async () => {
    const fake = terminal();

    fake.lines.prompt("› ");
    await fake.type("draft");
    fake.lines.release({ below: true });
    fake.output.write("a turn's output\n");
    fake.lines.prompt("› ");
    await settle();

    expect(await fake.screenText()).toBe(["› draft", "a turn's output", "› draft"].join("\n"));
    await fake.type("\r");
    await expect(fake.lines.next()).resolves.toBe("draft");
  });

  test("leaves a line typed between prompts for the next prompt", async () => {
    const fake = terminal();
    fake.lines.prompt("› ");
    fake.lines.release();

    // Nothing reads the terminal while a turn runs.
    await fake.type("typed ahead\r");
    let received: string | null | undefined;
    void fake.lines.next().then((line) => {
      received = line;
    });
    await settle();
    expect(received).toBeUndefined();

    fake.lines.prompt("› ");
    await settle();
    expect(received).toBe("typed ahead");
  });

  test("a line pasted with another is shown as sent at the next prompt", async () => {
    const fake = terminal();

    fake.lines.prompt("› ");
    await fake.type("first\rsecond\r");
    await expect(fake.lines.next()).resolves.toBe("first");
    fake.lines.release();
    fake.lines.prompt("› ");

    await expect(fake.lines.next()).resolves.toBe("second");
    expect(await lastLine(fake)).toBe("› second");
  });

  // A question's answer must be typed after the question appears; an Enter
  // pressed while the agent worked used to answer (and deny) an approval.
  test("drops what the terminal held from before a question", async () => {
    const fake = terminal();
    fake.lines.prompt("› ");
    fake.lines.release();

    await fake.type("stale line\rhalf typ");
    fake.lines.discardBuffered();
    fake.lines.prompt("Answer: ");
    await settle(120);

    expect(await lastLine(fake)).toBe("Answer: ");
    await fake.type("fresh\r");
    await expect(fake.lines.next()).resolves.toBe("fresh");
  });

  test("Ctrl-C at a prompt reaches subscribers and abandons the line; Ctrl-D on an empty line ends input", async () => {
    const fake = terminal();
    let interrupts = 0;
    fake.lines.subscribe(() => {
      interrupts += 1;
    });

    fake.lines.prompt("› ");
    await fake.type("abc\x03");
    expect(interrupts).toBe(1);
    expect(await lastLine(fake)).toBe("› ");

    await fake.type("\x04");
    await expect(fake.lines.next()).resolves.toBeNull();
    expect(fake.lines.prompting).toBe(false);
    expect(fake.rawModes.at(-1)).toBe(false);
  });

  test("recalls earlier lines with Up across prompts", async () => {
    const fake = terminal();

    fake.lines.prompt("› ");
    await fake.type("remember me\r");
    await fake.lines.next();
    fake.lines.release();
    fake.lines.prompt("› ");
    await fake.type("\x1b[A\r");

    await expect(fake.lines.next()).resolves.toBe("remember me");
  });
});
