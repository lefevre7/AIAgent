import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { expect, test } from "@playwright/test";

import { startFakeLanguageModelServer } from "../helpers/fake-language-model-server";

test("runs a prompt end-to-end through the CLI against the fake provider", async () => {
  const e2eRoot = path.resolve(".aia", "e2e");
  const fakeProvider = JSON.parse(await fs.readFile(path.join(e2eRoot, "fake-lm.json"), "utf8")) as {
    baseUrl: string;
  };
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-cli-e2e-"));

  try {
    const result = await runCommand(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--prompt", "Finish the CLI end-to-end task.", "--cwd", process.cwd()],
      {
        ...process.env,
        AIA_DEFAULT_MODEL: "fake-lm-studio-model",
        AIA_DEFAULT_PROVIDER: "lm_studio",
        AIA_LM_STUDIO_BASE_URL: fakeProvider.baseUrl,
        AIA_MEMORY_CHAT_SESSION_ROOT: path.join(tempRoot, "chat-session-memory"),
        AIA_MEMORY_EMBEDDINGS_ENABLED: "false",
        AIA_MEMORY_HARD_FAIL_ON_STARTUP: "false",
        AIA_MEMORY_SQLITE_PATH: path.join(tempRoot, "memory.sqlite"),
        AIA_MEMORY_STATE_ROOT: path.join(tempRoot, "state"),
        AIA_MEMORY_USER_GLOBAL_ROOT: path.join(tempRoot, "user-memory"),
        AIA_MEMORY_WORKSPACE_ROOT: path.join(tempRoot, "workspace-memory"),
        AIA_OLLAMA_BASE_URL: "http://127.0.0.1:9"
      }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Status: completed");
    expect(result.stdout).toContain("Assistant: Completed fake task");
  } finally {
    await fs.rm(tempRoot, { force: true, recursive: true });
  }
});

test("prompts for an agent question with numbered options and threads the reply back", async () => {
  // The interactive REPL is the only surface that answers approvals, so this
  // exercises the real subprocess: the CLI must render the numbered options and
  // map the typed number back to the option label before resolving.
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-cli-question-"));
  let asked = false;
  const fake = await startFakeLanguageModelServer({
    plan: () => {
      if (asked) {
        return { content: "Using postgres.", toolCalls: [{ arguments: {}, name: "attempt_complete" }] };
      }
      asked = true;
      return {
        content: "",
        toolCalls: [
          {
            arguments: {
              options: [{ description: "Local dev database", label: "sqlite" }, { label: "postgres" }],
              question: "Which database should I target?"
            },
            name: "ask_user_question"
          }
        ]
      };
    }
  });

  try {
    const result = await runCommand(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--cwd", process.cwd()],
      buildCliEnv(fake.baseUrl, tempRoot),
      // All input is written up front: the CLI's line reader buffers stdin from
      // creation, so the answer is waiting by the time the question is asked.
      "set up the db\n2\n/exit\n"
    );

    expect(result.stdout).toContain("The agent asks: Which database should I target?");
    expect(result.stdout).toContain("1) sqlite — Local dev database");
    expect(result.stdout).toContain("2) postgres");
    expect(result.stdout).toContain("number, or type your own answer");
    expect(result.stdout).toContain("Answer sent to the agent.");
    expect(result.exitCode).toBe(0);
  } finally {
    await fake.close();
    await fs.rm(tempRoot, { force: true, recursive: true });
  }
});

function buildCliEnv(baseUrl: string, tempRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AIA_DEFAULT_MODEL: "fake-lm-studio-model",
    AIA_DEFAULT_PROVIDER: "lm_studio",
    AIA_LM_STUDIO_BASE_URL: baseUrl,
    AIA_MEMORY_CHAT_SESSION_ROOT: path.join(tempRoot, "chat-session-memory"),
    AIA_MEMORY_EMBEDDINGS_ENABLED: "false",
    AIA_MEMORY_HARD_FAIL_ON_STARTUP: "false",
    AIA_MEMORY_SQLITE_PATH: path.join(tempRoot, "memory.sqlite"),
    AIA_MEMORY_STATE_ROOT: path.join(tempRoot, "state"),
    AIA_MEMORY_USER_GLOBAL_ROOT: path.join(tempRoot, "user-memory"),
    AIA_MEMORY_WORKSPACE_ROOT: path.join(tempRoot, "workspace-memory"),
    AIA_OLLAMA_BASE_URL: "http://127.0.0.1:9"
  };
}

test("runs when invoked through a symlinked bin (linked `aia`)", async () => {
  // Reproduces the linked `aia` path: the shell invokes a symlink, so argv[1]
  // is the symlink while import.meta.url resolves to the real module. The entry
  // guard must resolve symlinks on both sides or the CLI silently no-ops.
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-bin-"));
  const symlinkPath = path.join(binDir, "aia");
  await fs.symlink(path.resolve("src/cli.ts"), symlinkPath);

  try {
    // `info` reads config now, so point HOME away from the developer's own ~/.aia.
    const result = await runCommand(process.execPath, ["--import", "tsx", symlinkPath, "info"], {
      ...process.env,
      HOME: binDir
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Chat model:");
  } finally {
    await fs.rm(binDir, { force: true, recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Where state lands when no config chooses it (0ba351c). These run the real CLI
// with its own HOME and no AIA_MEMORY_* overrides, because the default
// resolution is exactly what is under test.
// ---------------------------------------------------------------------------

// chmod does not stop root, so the unwritable cases cannot fail for it.
const unwritableTest = process.getuid?.() === 0 ? test.skip : test;

async function withStateTree(run: (root: string, fakeBaseUrl: string) => Promise<void>): Promise<void> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-cli-state-")));
  const fake = await startFakeLanguageModelServer();
  try {
    await run(root, fake.baseUrl);
  } finally {
    await fake.close();
    await chmodTree(root, 0o755);
    await fs.rm(root, { force: true, recursive: true });
  }
}

async function chmodTree(root: string, mode: number): Promise<void> {
  await fs.chmod(root, mode).catch(() => undefined);
  for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) {
      await chmodTree(path.join(root, entry.name), mode);
    }
  }
}

function sandboxEnv(home: string, fakeBaseUrl: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AIA_DEFAULT_MODEL: "fake-lm-studio-model",
    AIA_DEFAULT_PROVIDER: "lm_studio",
    AIA_LM_STUDIO_BASE_URL: fakeBaseUrl,
    AIA_MEMORY_EMBEDDINGS_ENABLED: "false",
    AIA_OLLAMA_BASE_URL: "http://127.0.0.1:9",
    HOME: home,
    ...extra
  };
}

async function runPrompt(start: string, home: string, fakeBaseUrl: string, extra: Record<string, string> = {}) {
  return runCommand(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", "--prompt", "Finish the state-location check.", "--cwd", start],
    sandboxEnv(home, fakeBaseUrl, extra)
  );
}

async function sessionCount(stateRoot: string): Promise<number> {
  const raw = await fs.readFile(path.join(stateRoot, "sessions", "index.json"), "utf8").catch(() => "[]");
  return (JSON.parse(raw) as unknown[]).length;
}

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(
    () => true,
    () => false
  );
}

// The original failure: started in the home directory, state went to its
// parent (`/Users/.aia`), which the user cannot create, so every start failed
// with EACCES. The parent here is locked the same way.
unwritableTest(
  "keeps state in the start directory when no config is found, even with an unwritable parent",
  async () => {
    await withStateTree(async (root, fakeBaseUrl) => {
      const home = path.join(root, "home");
      await fs.mkdir(home);
      await fs.chmod(root, 0o555);

      const result = await runPrompt(home, home, fakeBaseUrl);

      expect(result.stderr).not.toContain("EACCES");
      expect(result.exitCode).toBe(0);
      expect(await sessionCount(path.join(home, ".aia"))).toBe(1);
      expect(await exists(path.join(root, ".aia"))).toBe(false);
    });
  }
);

test("keeps a direct child of home out of the home directory's state", async () => {
  await withStateTree(async (root, fakeBaseUrl) => {
    const home = path.join(root, "home");
    const documents = path.join(home, "Documents");
    await fs.mkdir(documents, { recursive: true });

    const result = await runPrompt(documents, home, fakeBaseUrl);

    expect(result.exitCode).toBe(0);
    expect(await sessionCount(path.join(documents, ".aia"))).toBe(1);
    expect(await exists(path.join(home, ".aia", "sessions"))).toBe(false);
  });
});

test("uses the directory holding the nearest config for a nested start directory", async () => {
  await withStateTree(async (root, fakeBaseUrl) => {
    const project = path.join(root, "project");
    const deep = path.join(project, "src", "deep");
    await fs.mkdir(deep, { recursive: true });
    await fs.writeFile(path.join(project, "aia.config.jsonc"), '{ "configVersion": 1 }', "utf8");

    const result = await runPrompt(deep, path.join(root, "home"), fakeBaseUrl);

    expect(result.exitCode).toBe(0);
    expect(await sessionCount(path.join(project, ".aia"))).toBe(1);
    expect(await exists(path.join(deep, ".aia"))).toBe(false);
  });
});

test("uses the directory holding a lone approvals file", async () => {
  await withStateTree(async (root, fakeBaseUrl) => {
    const project = path.join(root, "project");
    const nested = path.join(project, "nested");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(project, "aia.approvals.jsonc"), '{ "configVersion": 1 }', "utf8");

    const result = await runPrompt(nested, path.join(root, "home"), fakeBaseUrl);

    expect(result.exitCode).toBe(0);
    expect(await sessionCount(path.join(project, ".aia"))).toBe(1);
    expect(await exists(path.join(nested, ".aia"))).toBe(false);
  });
});

test("resolves a relative AIA_MEMORY_STATE_ROOT against the start directory", async () => {
  await withStateTree(async (root, fakeBaseUrl) => {
    const start = path.join(root, "home", "Documents");
    await fs.mkdir(start, { recursive: true });

    const result = await runPrompt(start, path.join(root, "home"), fakeBaseUrl, { AIA_MEMORY_STATE_ROOT: ".aia-alt" });

    expect(result.exitCode).toBe(0);
    expect(await sessionCount(path.join(start, ".aia-alt"))).toBe(1);
  });
});

// With a stdio MCP server configured, a startup failure used to print its
// error and then hang forever, because nothing closed the spawned server.
unwritableTest("explains an unwritable state directory and exits instead of hanging", async () => {
  await withStateTree(async (root, fakeBaseUrl) => {
    const home = path.join(root, "home");
    const locked = path.join(root, "locked");
    await fs.mkdir(path.join(home, ".aia"), { recursive: true });
    await fs.mkdir(locked);
    await fs.writeFile(path.join(home, ".aia", "config.jsonc"), JSON.stringify(stdioMcpConfig()), "utf8");
    await fs.chmod(locked, 0o555);

    const result = await runCommand(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--cwd", locked],
      sandboxEnv(home, fakeBaseUrl),
      "/exit\n",
      20_000
    );

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`Cannot create or write the state directory ${locked}/.aia (permission denied).`);
    expect(result.stderr).toContain("AIA_MEMORY_STATE_ROOT");
  });
});

test("exits when a required MCP server cannot connect instead of hanging", async () => {
  await withStateTree(async (root, fakeBaseUrl) => {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    const config = stdioMcpConfig();
    config.mcp.servers.needed = {
      enabled: true,
      headers: {},
      required: true,
      tags: [],
      type: "streamable-http",
      url: "http://127.0.0.1:9/mcp"
    };
    await fs.writeFile(path.join(workspace, "aia.config.jsonc"), JSON.stringify(config), "utf8");

    const result = await runCommand(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "--cwd", workspace],
      sandboxEnv(path.join(root, "home"), fakeBaseUrl),
      "/exit\n",
      20_000
    );

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Required MCP servers failed to connect");
  });
});

function stdioMcpConfig(): { configVersion: number; mcp: { servers: Record<string, Record<string, unknown>> } } {
  return {
    configVersion: 1,
    mcp: {
      servers: {
        docs: {
          args: [path.resolve("tests/fixtures/mcp/stdio-server.mjs")],
          command: process.execPath,
          enabled: true,
          env: {},
          required: false,
          tags: [],
          type: "stdio"
        }
      }
    }
  };
}

async function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin?: string,
  timeoutMs?: number
): Promise<{ exitCode: number | null; stderr: string; stdout: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: path.resolve("."),
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    // Closing stdin immediately keeps the non-interactive callers behaving as
    // if stdin were ignored, while still giving the interactive REPL a pipe.
    child.stdin.end(stdin ?? "");

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    // A process that hangs must fail the test with its output, not stall the
    // suite until Playwright's own timeout.
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (timer) {
        clearTimeout(timer);
      }
      resolve({
        exitCode,
        stderr,
        stdout,
        timedOut
      });
    });
  });
}
