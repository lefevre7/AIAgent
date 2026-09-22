import { describe, expect, test } from "vitest";

import { startProcessSession } from "@/core/process/session";
import { TerminalScreen } from "@/core/process/screen";
import { TerminalTurnWatcher } from "@/core/process/turn-watcher";

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe("TerminalScreen", () => {
  test("renders the screen a human would see rather than the raw byte stream", async () => {
    const screen = new TerminalScreen({ cols: 20, rows: 4 });
    // A spinner rewrites the same cell: concatenating bytes would keep all four
    // frames, while the emulator keeps only the last one.
    screen.write("working -\r");
    screen.write("working \\\r");
    screen.write("working |\r");
    screen.write("working done\r\n");
    screen.write("\u001b[32mgreen\u001b[0m answer");

    const rendered = await screen.read();

    expect(rendered).toBe("working done\ngreen answer");
    expect(rendered).not.toContain("\u001b");
    screen.dispose();
  });

  test("keeps only the visible screen unless scrollback is requested", async () => {
    const screen = new TerminalScreen({ cols: 20, rows: 2 });
    screen.write("one\r\ntwo\r\nthree\r\n");

    expect(await screen.read()).toBe("three");
    expect(await screen.read({ includeScrollback: true })).toBe("one\ntwo\nthree");
    expect(await screen.read({ includeScrollback: true, maxLines: 2 })).toBe("two\nthree");
    screen.dispose();
  });
});

describe("TerminalTurnWatcher", () => {
  test("ends the turn as soon as the ready pattern appears", async () => {
    const watcher = new TerminalTurnWatcher({
      cols: 40,
      // Long enough that only the ready pattern can end this turn in time.
      idleMs: 60_000,
      readyPattern: /^> $/mu,
      rows: 4
    });
    watcher.write("thinking...\r\n");

    const pending = watcher.waitForTurnEnd({ timeoutMs: 5_000 });
    watcher.write("here is the answer\r\n> ");

    const result = await pending;
    expect(result.reason).toBe("ready_pattern");
    expect(result.screen).toContain("here is the answer");
    watcher.dispose();
  });

  test("does not end the turn on the prompt that was already on screen", async () => {
    const watcher = new TerminalTurnWatcher({
      cols: 40,
      idleMs: 60_000,
      // Sessions compile ready patterns multiline, so a stale prompt line
      // anywhere on screen used to satisfy this.
      readyPattern: /^> $/mu,
      rows: 6
    });
    // The previous turn's prompt is still the last line when this turn begins.
    watcher.write("earlier answer\r\n> ");

    const pending = watcher.waitForTurnEnd({ timeoutMs: 3_000 });
    // The echo of the operator's input arrives before the agent responds; the
    // prompt line is still on screen at that moment.
    watcher.write("do the thing");
    await delay(400);
    watcher.write("\r\nworking\r\nnew answer\r\n> ");

    const result = await pending;
    expect(result.reason).toBe("ready_pattern");
    expect(result.screen).toContain("new answer");
    watcher.dispose();
  });

  test("ends the turn when the rendered screen stops changing and bytes stop arriving", async () => {
    const watcher = new TerminalTurnWatcher({ cols: 40, idleMs: 150, rows: 4, stabilityMs: 150 });
    watcher.write("settled output\r\n");

    const result = await watcher.waitForTurnEnd({ timeoutMs: 5_000 });
    expect(result.reason).toBe("idle");
    expect(result.screen).toBe("settled output");
    watcher.dispose();
  });

  test("a turn the child never answers times out instead of reporting the previous screen", async () => {
    // The whole point of beginTurn(): output from before the instruction was
    // written must not end the turn. Without the boundary, a child that has not
    // replied yet trivially satisfies idle *and* stability — it is silent and
    // the screen is frozen — and the caller is handed the prior turn's screen
    // as though the agent had answered.
    const watcher = new TerminalTurnWatcher({ cols: 40, idleMs: 50, rows: 4, stabilityMs: 50 });
    watcher.write("answer to the previous turn\r\n");
    watcher.beginTurn();

    const result = await watcher.waitForTurnEnd({ timeoutMs: 400 });

    expect(result.reason).toBe("timeout");
    watcher.dispose();
  });

  test("a turn ends on idle once the child answers after the boundary", async () => {
    const watcher = new TerminalTurnWatcher({ cols: 40, idleMs: 50, rows: 4, stabilityMs: 50 });
    watcher.write("answer to the previous turn\r\n");
    watcher.beginTurn();
    setTimeout(() => watcher.write("answer to this turn\r\n"), 20);

    const result = await watcher.waitForTurnEnd({ timeoutMs: 2_000 });

    expect(result.reason).toBe("idle");
    expect(result.screen).toContain("answer to this turn");
    watcher.dispose();
  });

  test("waitForReady settles on the child's first output, with no turn boundary declared", async () => {
    const watcher = new TerminalTurnWatcher({ cols: 40, idleMs: 50, rows: 4, stabilityMs: 50 });
    setTimeout(() => watcher.write("mock agent ready\r\n> "), 30);

    const result = await watcher.waitForReady({ timeoutMs: 2_000 });

    expect(result.reason).toBe("idle");
    expect(result.screen).toContain("mock agent ready");
    watcher.dispose();
  });

  test("waitForReady gives up on a child that prints nothing at all", async () => {
    const watcher = new TerminalTurnWatcher({ cols: 40, idleMs: 50, rows: 4, stabilityMs: 50 });

    const result = await watcher.waitForReady({ timeoutMs: 300 });

    expect(result.reason).toBe("timeout");
    watcher.dispose();
  });

  test("a child that exits ends the turn immediately rather than running out the clock", async () => {
    // A dead child can never settle, answer, or print its prompt, so without
    // this the turn burns the whole timeout and then reports the pre-exit
    // screen as though it were a reply.
    const watcher = new TerminalTurnWatcher({ cols: 40, idleMs: 60_000, rows: 4, stabilityMs: 60_000 });
    watcher.beginTurn();
    watcher.write("goodbye\r\n");
    const exited = new Promise((resolve) => setTimeout(resolve, 50));

    const started = Date.now();
    const result = await watcher.waitForTurnEnd({ exited, timeoutMs: 10_000 });

    expect(result.reason).toBe("exited");
    expect(result.screen).toContain("goodbye");
    expect(Date.now() - started).toBeLessThan(2_000);
    watcher.dispose();
  });

  test("gives up at the deadline when the child never settles", async () => {
    const watcher = new TerminalTurnWatcher({ cols: 40, idleMs: 60_000, rows: 4 });
    const interval = setInterval(() => {
      watcher.write(`tick ${Date.now()}\r\n`);
    }, 20);

    try {
      const result = await watcher.waitForTurnEnd({ timeoutMs: 300 });
      expect(result.reason).toBe("timeout");
    } finally {
      clearInterval(interval);
      watcher.dispose();
    }
  });
});

describe("startProcessSession", () => {
  test("survives writing to a child that closed its stdin", async () => {
    const chunks: string[] = [];
    // Pipes are the fallback whenever node-pty cannot spawn, so this path is
    // reachable in production. The child closes stdin and stays alive, so the
    // parent is writing into a pipe with no reader.
    const session = startProcessSession({
      args: ["-e", "process.stdin.destroy(); setTimeout(() => {}, 5000);"],
      command: process.execPath,
      cwd: process.cwd(),
      onData: (chunk) => {
        chunks.push(chunk);
      },
      usePty: false
    });

    await new Promise((resolve) => setTimeout(resolve, 150));

    // The guarantee under test: stdin has an 'error' listener, so a failed
    // write can never become an uncaught exception that takes the gateway
    // down. A child can always close stdin or die between a caller's check
    // and its write, so this is a normal race, not misuse.
    //
    // Whether EPIPE is actually raised is left unasserted on purpose: a small
    // write into a reader-less pipe is accepted by the kernel buffer on some
    // platforms and only errors on a later write, so asserting the error text
    // would make this test platform-dependent. Surviving is the contract.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(() => {
        session.write("anyone home?", true);
      }).not.toThrow();
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
    // If an error did surface, it arrived as reported output rather than a throw.
    expect(chunks.join("")).not.toContain("Unhandled");

    session.kill("SIGKILL");
    await session.exited;
  });
});
