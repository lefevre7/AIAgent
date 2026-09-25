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

async function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin?: string
): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
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
      resolve({
        exitCode,
        stderr,
        stdout
      });
    });
  });
}
