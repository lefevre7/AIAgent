import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createDefaultToolRuntime, sessionRecordSchema, toolCallRecordSchema, turnRecordSchema, type ToolRuntime } from "@/core";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

describe("workspace and command built-ins", () => {
  test("handles binary file tools across arbitrary local paths", async () => {
    const root = await createTempRoot();
    const externalRoot = await createTempRoot();
    const runtime = createRuntime(root);
    const binaryPath = path.join(externalRoot, "payload.bin");
    const base64Content = Buffer.from([0x00, 0x01, 0x7f, 0xff]).toString("base64");

    const writeResult = await executeApproved(runtime, root, "write_file", {
      base64Content,
      path: binaryPath
    });
    expect(writeResult.toolCall.status).toBe("succeeded");
    await expect(fs.readFile(binaryPath)).resolves.toEqual(Buffer.from(base64Content, "base64"));

    const readResult = await executeApproved(runtime, root, "read_file", {
      path: binaryPath
    });
    expect(readResult.toolCall.status).toBe("succeeded");
    expect(readResult.toolCall.result).toMatchObject({
      base64Content,
      isBinary: true,
      path: normalizeTestPath(binaryPath)
    });

    const undoResult = await executeApproved(runtime, root, "undo_file_edit", {
      path: binaryPath
    });
    expect(undoResult.toolCall.status).toBe("succeeded");
    await expect(fs.readFile(binaryPath)).rejects.toThrow();
  });

  test("runs one-shot shell commands and exposes persisted logs", async () => {
    const root = await createTempRoot();
    const runtime = createRuntime(root);

    const shellResult = await executeApproved(runtime, root, "shell_command", {
      command: buildNodeShellCommand("process.stdout.write('shell:ok\\n'); process.stderr.write('shell:warn\\n');")
    });
    expect(shellResult.toolCall.status).toBe("succeeded");
    expect(shellResult.toolCall.result).toMatchObject({
      combinedOutput: expect.stringContaining("shell:ok"),
      status: "completed"
    });

    const sessionId = getStringField(shellResult.toolCall.result, "sessionId");
    const outputResult = await executeApproved(runtime, root, "read_command_output", {
      sessionId,
      stream: "combined"
    });
    expect(outputResult.toolCall.status).toBe("succeeded");
    expect(outputResult.toolCall.result).toMatchObject({
      output: expect.stringContaining("shell:warn"),
      sessionId,
      stream: "combined"
    });

    const listResult = await executeApproved(runtime, root, "list_command_sessions", {});
    expect(listResult.toolCall.status).toBe("succeeded");
    expect(listResult.toolCall.result).toMatchObject({
      sessions: expect.arrayContaining([
        expect.objectContaining({
          sessionId,
          status: "completed"
        })
      ])
    });
  });

  test("supports PTY exec sessions with stdin, wait, and kill lifecycle tools", async () => {
    const root = await createTempRoot();
    const runtime = createRuntime(root);
    const interactiveScript = [
      "process.stdin.setEncoding('utf8');",
      "process.stdout.write('ready\\n');",
      "process.stdin.on('data', (chunk) => {",
      "  process.stdout.write(`echo:${chunk}`);",
      "  if (chunk.includes('exit')) process.exit(0);",
      "});",
      "setInterval(() => {}, 1000);"
    ].join("");

    const started = await executeApproved(runtime, root, "exec_command", {
      args: ["-e", interactiveScript],
      command: process.execPath
    });
    expect(started.toolCall.status).toBe("succeeded");
    const interactiveSessionId = getStringField(started.toolCall.result, "sessionId");

    await waitForOutput(runtime, root, interactiveSessionId, "ready");

    const writeResult = await executeApproved(runtime, root, "write_stdin", {
      sessionId: interactiveSessionId,
      submit: true,
      text: "hello"
    });
    expect(writeResult.toolCall.status).toBe("succeeded");
    await waitForOutput(runtime, root, interactiveSessionId, "echo:hello");

    await executeApproved(runtime, root, "write_stdin", {
      sessionId: interactiveSessionId,
      submit: true,
      text: "exit"
    });
    const waited = await executeApproved(runtime, root, "wait_command", {
      sessionId: interactiveSessionId,
      timeoutMs: 5_000
    });
    expect(waited.toolCall.status).toBe("succeeded");
    expect(waited.toolCall.result).toMatchObject({
      sessionId: interactiveSessionId,
      status: "completed",
      timedOut: false
    });

    const longRunning = await executeApproved(runtime, root, "exec_command", {
      args: ["-e", "setInterval(() => {}, 1000);"],
      command: process.execPath
    });
    expect(longRunning.toolCall.status).toBe("succeeded");
    const longRunningSessionId = getStringField(longRunning.toolCall.result, "sessionId");

    const killed = await executeApproved(runtime, root, "kill_command", {
      sessionId: longRunningSessionId,
      timeoutMs: 5_000
    });
    expect(killed.toolCall.status).toBe("succeeded");
    expect(killed.toolCall.result).toMatchObject({
      sessionId: longRunningSessionId,
      status: "killed",
      timedOut: false
    });
  });
});

function createRuntime(root: string): ToolRuntime {
  return createDefaultToolRuntime({
    stateRoot: path.join(root, ".aia"),
    workspaceRoot: root
  });
}

async function executeApproved(
  runtime: ToolRuntime,
  cwd: string,
  toolName: string,
  args: Record<string, unknown>
) {
  return runtime.executeApproved(
    toolCallRecordSchema.parse({
      arguments: args,
      id: `tool-call.integration.${toolName}.${Math.random().toString(36).slice(2, 10)}`,
      metadata: {},
      sessionId: "session.integration.tools",
      startedAt: "2026-03-27T12:00:00.000Z",
      status: "pending",
      toolName,
      turnId: `turn.integration.${toolName}`
    }),
    {
      session: buildSession(cwd),
      turn: buildTurn(toolName)
    }
  );
}

function buildSession(cwd: string) {
  return sessionRecordSchema.parse({
    createdAt: "2026-03-27T12:00:00.000Z",
    cwd,
    goal: "Exercise workspace and command built-ins",
    id: "session.integration.tools",
    lastActiveAt: "2026-03-27T12:00:00.000Z",
    metadata: {},
    status: "running_model",
    tags: [],
    title: "Workspace and Command Tools",
    updatedAt: "2026-03-27T12:00:00.000Z"
  });
}

function buildTurn(toolName: string) {
  return turnRecordSchema.parse({
    approvalRequestIds: [],
    executedToolCallIds: [],
    id: `turn.integration.${toolName}`,
    inputMessageIds: [],
    metadata: {},
    outputMessageIds: [],
    requestedToolCallIds: [],
    sequence: 0,
    sessionId: "session.integration.tools",
    startedAt: "2026-03-27T12:00:00.000Z",
    status: "running",
    trigger: "user"
  });
}

function buildNodeShellCommand(script: string): string {
  if (process.platform === "win32") {
    return `"${process.execPath.replace(/"/gu, '""')}" -e "${script.replace(/"/gu, '\\"')}"`;
  }

  return `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function getStringField(value: unknown, field: string): string {
  if (typeof value !== "object" || value === null || typeof (value as Record<string, unknown>)[field] !== "string") {
    throw new Error(`Expected ${field} to be a string.`);
  }

  return (value as Record<string, string>)[field];
}

function normalizeTestPath(targetPath: string): string {
  return targetPath.split(path.sep).join("/");
}

async function waitForOutput(runtime: ToolRuntime, cwd: string, sessionId: string, needle: string): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const outputResult = await executeApproved(runtime, cwd, "read_command_output", {
      sessionId,
      stream: "combined"
    });
    const output = getStringField(outputResult.toolCall.result, "output");
    if (output.includes(needle)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }

  throw new Error(`Timed out waiting for command output to include ${needle}.`);
}

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-workspace-command-tools-"));
  tempRoots.push(root);
  return root;
}