import path from "node:path";

import { describe, expect } from "vitest";

import { createDefaultToolRuntime, sessionRecordSchema, toolCallRecordSchema, turnRecordSchema, type ToolRuntime } from "@/core";
import { createLiveTestHarness, envFlag } from "./helpers";

const { createTempRoot, liveTest } = createLiveTestHarness({
  enabled: envFlag("AIA_RUN_LIVE_COMMAND_TESTS"),
  prefix: "aiagent-live-command-tools-"
});

describe("command tools (live)", () => {
  liveTest("runs PTY sessions through the default runtime", async () => {
    const root = await createTempRoot();
    const runtime = createDefaultToolRuntime({
      stateRoot: path.join(root, ".aia"),
      workspaceRoot: root
    });
    const script = [
      "process.stdin.setEncoding('utf8');",
      "process.stdout.write('ready\\n');",
      "process.stdin.on('data', (chunk) => {",
      "  process.stdout.write(`echo:${chunk}`);",
      "  if (chunk.includes('exit')) process.exit(0);",
      "});",
      "setInterval(() => {}, 1000);"
    ].join("");

    const started = await executeApproved(runtime, root, "exec_command", {
      args: ["-e", script],
      command: process.execPath
    });
    expect(started.toolCall.status).toBe("succeeded");
    const sessionId = getStringField(started.toolCall.result, "sessionId");

    await waitForOutput(runtime, root, sessionId, "ready");
    await executeApproved(runtime, root, "write_stdin", {
      sessionId,
      submit: true,
      text: "live"
    });
    await waitForOutput(runtime, root, sessionId, "echo:live");

    await executeApproved(runtime, root, "write_stdin", {
      sessionId,
      submit: true,
      text: "exit"
    });
    const waited = await executeApproved(runtime, root, "wait_command", {
      sessionId,
      timeoutMs: 10_000
    });
    expect(waited.toolCall.status).toBe("succeeded");
    expect(waited.toolCall.result).toMatchObject({
      sessionId,
      status: "completed",
      timedOut: false
    });
  });
});

async function executeApproved(
  runtime: ToolRuntime,
  cwd: string,
  toolName: string,
  args: Record<string, unknown>
) {
  return runtime.executeApproved(
    toolCallRecordSchema.parse({
      arguments: args,
      id: `tool-call.live.${toolName}.${Math.random().toString(36).slice(2, 10)}`,
      metadata: {},
      sessionId: "session.live.command.tools",
      startedAt: "2026-03-27T12:00:00.000Z",
      status: "pending",
      toolName,
      turnId: `turn.live.${toolName}`
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
    goal: "Exercise live command tools",
    id: "session.live.command.tools",
    lastActiveAt: "2026-03-27T12:00:00.000Z",
    metadata: {},
    status: "running_model",
    tags: [],
    title: "Live Command Tools",
    updatedAt: "2026-03-27T12:00:00.000Z"
  });
}

function buildTurn(toolName: string) {
  return turnRecordSchema.parse({
    approvalRequestIds: [],
    executedToolCallIds: [],
    id: `turn.live.${toolName}`,
    inputMessageIds: [],
    metadata: {},
    outputMessageIds: [],
    requestedToolCallIds: [],
    sequence: 0,
    sessionId: "session.live.command.tools",
    startedAt: "2026-03-27T12:00:00.000Z",
    status: "running",
    trigger: "user"
  });
}

function getStringField(value: unknown, field: string): string {
  if (typeof value !== "object" || value === null || typeof (value as Record<string, unknown>)[field] !== "string") {
    throw new Error(`Expected ${field} to be a string.`);
  }

  return (value as Record<string, string>)[field];
}

async function waitForOutput(runtime: ToolRuntime, cwd: string, sessionId: string, needle: string): Promise<void> {
  const deadline = Date.now() + 10_000;

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