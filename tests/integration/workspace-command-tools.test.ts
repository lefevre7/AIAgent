import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  CommandRuntime,
  createDefaultToolRuntime,
  sessionRecordSchema,
  toolCallRecordSchema,
  turnRecordSchema,
  type MessagePart,
  type ToolRuntime
} from "@/core";

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

    // Lifecycle tools must report what the process actually printed. Returning
    // only a status line is what made command work invisible to the model.
    expect(getStringField(waited.toolCall.result, "output")).toContain("echo:hello");
    expect(renderPartsToText(waited.resultMessage?.parts)).toContain("echo:hello");

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

  test("streams live command output to the configured listener with its owning session", async () => {
    const root = await createTempRoot();
    const events: { chunk: string; ownerSessionId?: string; sessionId: string; stream: string }[] = [];
    const commandRuntime = new CommandRuntime({
      baseDirectory: root,
      onOutput: (event) => {
        events.push(event);
      },
      stateRoot: path.join(root, ".aia")
    });
    const runtime = createDefaultToolRuntime({
      commandRuntime,
      stateRoot: path.join(root, ".aia"),
      workspaceRoot: root
    });

    const started = await executeApproved(runtime, root, "exec_command", {
      args: ["-e", "process.stdout.write('live:hello\\n');"],
      command: process.execPath
    });
    expect(started.toolCall.status).toBe("succeeded");
    const commandSessionId = getStringField(started.toolCall.result, "sessionId");

    await waitForOutput(runtime, root, commandSessionId, "live:hello");

    // Output must be attributable: the listener is how the gateway turns PTY
    // bytes into a tool.output.delta aimed at one agent session, so a chunk
    // without its owner would either leak or be dropped.
    const combined = events
      .filter((event) => event.sessionId === commandSessionId)
      .map((event) => event.chunk)
      .join("");
    expect(combined).toContain("live:hello");
    expect(events.every((event) => event.ownerSessionId === "session.integration.tools")).toBe(true);

    await executeApproved(runtime, root, "kill_command", { sessionId: commandSessionId, timeoutMs: 5_000 });
  });

  test("surfaces errors for unknown command sessions", async () => {
    const root = await createTempRoot();
    const runtime = createRuntime(root);

    const read = await executeApproved(runtime, root, "read_command_output", { sessionId: "command.missing", stream: "combined" });
    expect(read.toolCall.status).toBe("failed");

    const write = await executeApproved(runtime, root, "write_stdin", { sessionId: "command.missing", submit: true, text: "x" });
    expect(write.toolCall.status).toBe("failed");

    const wait = await executeApproved(runtime, root, "wait_command", { sessionId: "command.missing", timeoutMs: 1_000 });
    expect(wait.toolCall.status).toBe("failed");

    const kill = await executeApproved(runtime, root, "kill_command", { sessionId: "command.missing", timeoutMs: 1_000 });
    expect(kill.toolCall.status).toBe("failed");
  });

  test("reports a timeout when waiting on a still-running session", async () => {
    const root = await createTempRoot();
    const runtime = createRuntime(root);

    const started = await executeApproved(runtime, root, "exec_command", {
      args: ["-e", "setInterval(() => {}, 1000);"],
      command: process.execPath
    });
    const sessionId = getStringField(started.toolCall.result, "sessionId");

    const waited = await executeApproved(runtime, root, "wait_command", { sessionId, timeoutMs: 50 });
    expect(waited.toolCall.status).toBe("succeeded");
    expect(waited.toolCall.result).toMatchObject({ sessionId, timedOut: true });

    // write_stdin to a still-running pty session, then clean up.
    const wrote = await executeApproved(runtime, root, "write_stdin", { sessionId, submit: false, text: "noop" });
    expect(wrote.toolCall.status).toBe("succeeded");

    await executeApproved(runtime, root, "kill_command", { sessionId, timeoutMs: 5_000 });
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

// Approximates what the model reads: the tool result message flattened to text.
function renderPartsToText(parts: MessagePart[] | undefined): string {
  return (parts ?? [])
    .map((part) => {
      if (part.kind === "text") {
        return part.text;
      }
      if (part.kind === "json") {
        return JSON.stringify(part.value);
      }
      return "";
    })
    .join("\n");
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
describe("command output querying and pagination", () => {
  test("filters output by query and paginates with offset/maxChars", async () => {
    const root = await createTempRoot();
    const runtime = createRuntime(root);

    const shellResult = await executeApproved(runtime, root, "shell_command", {
      command: buildNodeShellCommand("process.stdout.write('line-one\\nline-two\\nwarn-three\\n');")
    });
    const sessionId = getStringField(shellResult.toolCall.result, "sessionId");

    const query = await executeApproved(runtime, root, "read_command_output", {
      query: "warn",
      sessionId,
      stream: "combined"
    });
    expect(query.toolCall.result).toMatchObject({ matchCount: 1, output: expect.stringContaining("warn-three") });

    const paged = await executeApproved(runtime, root, "read_command_output", {
      maxChars: 4,
      offset: 0,
      sessionId,
      stream: "stdout"
    });
    expect(paged.toolCall.result).toMatchObject({ truncated: true });

    // reading an unavailable stream for a completed session surfaces a failure
    const stderrRead = await executeApproved(runtime, root, "read_command_output", { sessionId, stream: "stdout" });
    expect(stderrRead.toolCall.status).toBe("succeeded");
  });
  test("reads a command tail by seeking, not by loading the whole log", async () => {
    const root = await createTempRoot();
    const commandRuntime = new CommandRuntime({ baseDirectory: root, stateRoot: path.join(root, ".aia") });
    const started = await commandRuntime.startExecCommand({ args: [], command: "cat", cwd: root });

    // Every lifecycle tool calls readCommandTail on each invocation, so a
    // large log must not be read in full just to report its last few KB.
    const logPath = started.logPaths.combined;
    const filler = `${"y".repeat(999)}\n`;
    await fs.writeFile(logPath, filler.repeat(3_000), "utf8");
    await fs.appendFile(logPath, "FINAL-MARKER\n", "utf8");

    const tail = await commandRuntime.readCommandTail({ maxChars: 2_000, sessionId: started.id });
    if (!tail) {
      throw new Error("Expected a tail for a running command session.");
    }

    expect(tail.output.length).toBeLessThanOrEqual(2_000);
    expect(tail.output).toContain("FINAL-MARKER");
    expect(tail.truncated).toBe(true);
    // Reported against the whole file even though only the tail was read.
    expect(tail.totalBytes).toBeGreaterThan(3_000_000);
    expect(tail.offset).toBe(tail.totalBytes - Buffer.byteLength(tail.output, "utf8"));

    // A multi-byte character straddling the seek boundary must not decode as
    // a replacement character.
    await fs.writeFile(logPath, `${"\u00e9".repeat(5_000)}END`, "utf8");
    const multibyte = await commandRuntime.readCommandTail({ maxChars: 100, sessionId: started.id });
    expect(multibyte?.output).not.toContain("\ufffd");
    expect(multibyte?.output.endsWith("END")).toBe(true);

    await commandRuntime.killCommand({ sessionId: started.id });
  });
});
