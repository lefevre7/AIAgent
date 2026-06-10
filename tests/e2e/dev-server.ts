import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { startFakeLanguageModelServer } from "../helpers/fake-language-model-server";

async function main(): Promise<void> {
  const port = parsePort(process.argv.slice(2));
  const projectRoot = process.cwd();
  const e2eRoot = path.join(projectRoot, ".aia", "e2e");
  const stateRoot = path.join(e2eRoot, "state");

  await fs.rm(e2eRoot, { force: true, recursive: true });
  await fs.mkdir(e2eRoot, { recursive: true });

  const fakeServer = await startFakeLanguageModelServer();
  await fs.writeFile(
    path.join(e2eRoot, "fake-lm.json"),
    `${JSON.stringify({ baseUrl: fakeServer.baseUrl }, null, 2)}\n`,
    "utf8"
  );

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/server/start.ts", "--dev", "--port", String(port)],
    {
      cwd: projectRoot,
      env: {
        ...process.env,
        AIA_BROWSER_ARTIFACT_ROOT: path.join(e2eRoot, "browser"),
        AIA_DEFAULT_MODEL: "fake-lm-studio-model",
        AIA_DEFAULT_PROVIDER: "lm_studio",
        AIA_EXTERNAL_AGENTS_STATE_ROOT: path.join(e2eRoot, "external-agents"),
        AIA_LM_STUDIO_BASE_URL: fakeServer.baseUrl,
        AIA_LOG_LEVEL: "warn",
        AIA_MEMORY_CHAT_SESSION_ROOT: path.join(e2eRoot, "chat-session-memory"),
        AIA_MEMORY_EMBEDDINGS_ENABLED: "false",
        AIA_MEMORY_HARD_FAIL_ON_STARTUP: "false",
        AIA_MEMORY_SQLITE_PATH: path.join(e2eRoot, "memory.sqlite"),
        AIA_MEMORY_STATE_ROOT: stateRoot,
        AIA_MEMORY_USER_GLOBAL_ROOT: path.join(e2eRoot, "user-memory"),
        AIA_MEMORY_WORKSPACE_ROOT: path.join(e2eRoot, "workspace-memory"),
        AIA_OLLAMA_BASE_URL: "http://127.0.0.1:9",
        AIA_WHATSAPP_SESSION_DIRECTORY: path.join(e2eRoot, "channels", "whatsapp"),
        HOSTNAME: "127.0.0.1",
        PORT: String(port)
      },
      stdio: "inherit"
    }
  );

  const cleanup = async (exitCode?: number) => {
    child.kill("SIGTERM");
    await Promise.race([
      once(child, "exit").catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000))
    ]);
    await fakeServer.close().catch(() => undefined);
    process.exit(exitCode ?? 0);
  };

  process.on("SIGINT", () => {
    void cleanup(130);
  });
  process.on("SIGTERM", () => {
    void cleanup(143);
  });

  child.on("exit", (code) => {
    void cleanup(code ?? 1);
  });
}

function parsePort(argv: string[]): number {
  const flagIndex = argv.findIndex((entry) => entry === "--port");
  const rawPort = flagIndex >= 0 ? argv[flagIndex + 1] : process.env.PORT;
  const parsed = Number.parseInt(rawPort ?? "3200", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid e2e server port: ${rawPort ?? "<missing>"}`);
  }
  return parsed;
}

void main();
