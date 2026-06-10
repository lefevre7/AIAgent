import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { expect, test } from "@playwright/test";

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

async function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: path.resolve("."),
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

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
