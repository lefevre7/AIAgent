import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { spawn as spawnPty } from "node-pty";
import { describe, expect } from "vitest";

import { createLiveTestHarness, envFlag } from "./helpers";

/**
 * Runs the real `aia` against your real config and model, from folders the
 * way you would: where the workspace (and its `.aia` state) ends up, a scripted
 * REPL, and the REPL at a terminal, where the prompt comes up before startup
 * finishes.
 *
 * Opt in with AIA_RUN_LIVE_CLI_TESTS=1 (`npm run test:live:cli`). It uses your
 * HOME, so ~/.aia/config.jsonc picks the provider and model, and they must be
 * reachable. Both builds run by default: dist/cli.js (what the linked `aia`
 * runs) and src/cli.ts under tsx. AIA_LIVE_CLI_TARGET=dist or =src runs one.
 */
const harness = createLiveTestHarness({
  enabled: envFlag("AIA_RUN_LIVE_CLI_TESTS"),
  prefix: "aiagent-live-cli-"
});
const run = promisify(execFile);
const REPO = process.cwd();
const TARGETS = (["dist", "src"] as const).filter(
  (target) => !process.env.AIA_LIVE_CLI_TARGET || process.env.AIA_LIVE_CLI_TARGET === target
);
const PROMPT = "Reply with the single word READY, then finish the task.";
// By path: `--import tsx` resolves from the working directory, and these runs
// start in temporary folders with no node_modules.
const TSX_LOADER = pathToFileURL(path.join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href;

function cliCommand(target: "dist" | "src"): { args: string[]; command: string } {
  return target === "dist"
    ? { args: [path.join(REPO, "dist", "cli.js")], command: process.execPath }
    : { args: ["--import", TSX_LOADER, path.join(REPO, "src", "cli.ts")], command: process.execPath };
}

function cliEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, TSX_TSCONFIG_PATH: path.join(REPO, "tsconfig.json") };
}

// The linked `aia` runs dist/cli.js, so a stale build would test old code.
async function assertDistIsFresh(): Promise<void> {
  const distPath = path.join(REPO, "dist", "cli.js");
  if (!existsSync(distPath)) {
    throw new Error("dist/cli.js does not exist. Run `npm run build:node` first.");
  }
  const built = (await fs.stat(distPath)).mtimeMs;
  const newer: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (/\.(ts|tsx)$/u.test(entry.name) && (await fs.stat(entryPath)).mtimeMs > built) {
        newer.push(path.relative(REPO, entryPath));
      }
    }
  };
  await walk(path.join(REPO, "src"));
  if (newer.length > 0) {
    throw new Error(
      `dist/cli.js is older than ${newer.slice(0, 3).join(", ")}${newer.length > 3 ? ` and ${newer.length - 3} more` : ""}. Run \`npm run build:node\` first.`
    );
  }
}

// Session folders only: the sessions directory also holds an index.
async function sessionDirectories(stateRoot: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(stateRoot, "sessions")).catch(() => [] as string[]);
  return entries.filter((entry) => entry.startsWith("session."));
}

describe.each(TARGETS)("aia from %s (live)", (target) => {
  harness.liveTest("answers a prompt from a folder with no config, keeping state in that folder", async () => {
    if (target === "dist") {
      await assertDistIsFresh();
    }
    const folder = await harness.createTempRoot();
    const homeSessionsBefore = await sessionDirectories(path.join(os.homedir(), ".aia"));
    const { args, command } = cliCommand(target);

    const result = await run(command, [...args, "--prompt", PROMPT], {
      cwd: folder,
      env: cliEnvironment(),
      timeout: 280_000
    });

    expect(result.stdout).toMatch(/^Session: session\./mu);
    expect(result.stdout).toMatch(/^Status: completed$/mu);
    expect(await sessionDirectories(path.join(folder, ".aia"))).toHaveLength(1);
    expect(await sessionDirectories(path.join(os.homedir(), ".aia"))).toEqual(homeSessionsBefore);
  });

  harness.liveTest("uses the folder holding the nearest aia.config.jsonc when started below it", async () => {
    const project = await harness.createTempRoot();
    const nested = path.join(project, "packages", "app");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(project, "aia.config.jsonc"), '{ "configVersion": 1 }\n', "utf8");
    const { args, command } = cliCommand(target);

    await run(command, [...args, "--prompt", PROMPT], { cwd: nested, env: cliEnvironment(), timeout: 280_000 });

    expect(await sessionDirectories(path.join(project, ".aia"))).toHaveLength(1);
    expect(existsSync(path.join(nested, ".aia"))).toBe(false);
  });

  harness.liveTest("runs a scripted REPL: the line is sent once startup is done, then /exit", async () => {
    const folder = await harness.createTempRoot();
    const { args, command } = cliCommand(target);
    const child = execFile(command, args, { cwd: folder, env: cliEnvironment(), timeout: 280_000 });
    child.stdin?.end(`${PROMPT}\n/exit\n`);
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Session: session\./u);
    expect(stdout).toContain("Goodbye.");
    expect(stdout.indexOf("Session:")).toBeLessThan(stdout.indexOf("Thinking…"));
  });

  harness.liveTest("at a terminal, shows the prompt before startup finishes and leaves on /exit", async () => {
    const folder = await harness.createTempRoot();
    const { args, command } = cliCommand(target);
    const terminal = spawnPty(command, args, {
      cols: 120,
      cwd: folder,
      env: cliEnvironment() as Record<string, string>,
      name: "xterm-256color",
      rows: 40
    });
    let screen = "";
    terminal.onData((chunk) => {
      screen += chunk;
    });
    const exited = new Promise<number>((resolve) => terminal.onExit(({ exitCode }) => resolve(exitCode)));

    try {
      const deadline = Date.now() + 120_000;
      while (!screen.includes("Session: session.") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(screen).toContain("Session: session.");
      // The prompt was up before the session line: typing could start at once.
      expect(screen.indexOf("› ")).toBeLessThan(screen.indexOf("Session: session."));

      terminal.write("/exit\r");
      expect(await exited).toBe(0);
      expect(screen).toContain("Goodbye.");
    } finally {
      terminal.kill();
    }
  });
});
