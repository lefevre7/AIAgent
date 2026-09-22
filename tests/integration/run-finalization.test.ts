import { describe, expect, test } from "vitest";

import {
  ScriptedLanguageModelAdapter,
  buildScriptedResponse,
  buildToolCall,
  withExampleSdk
} from "../../examples/shared";
import { runCli } from "@/cli";
import type { GatewayEvent, ToolCallRecord } from "@/core/contracts";
import type { AIAgentSdk } from "@/sdk";
import { AIAgentRunWaitTimeoutError } from "@/sdk";

// These cover the failure that made an interactive run look like it stopped for
// no reason: a tool result that could not be serialized threw while the gateway
// emitted the run's events, the rejection was discarded, the run never reached a
// terminal status, and the CLI waited on it forever without ever reaching the
// approval prompt. Every assertion here is about a run reaching a terminal
// state and the operator being told what happened.

type CaptureStreams = {
  stderr: { write: (value: string) => boolean };
  stdout: { write: (value: string) => boolean };
};

function createCaptureStreams(): {
  getStderr: () => string;
  getStdout: () => string;
  streams: CaptureStreams;
} {
  let stderr = "";
  let stdout = "";
  return {
    getStderr: () => stderr,
    getStdout: () => stdout,
    streams: {
      stderr: {
        write: (value: string) => {
          stderr += value;
          return true;
        }
      },
      stdout: {
        write: (value: string) => {
          stdout += value;
          return true;
        }
      }
    }
  };
}

async function* lineSource(items: string[]): AsyncIterable<string> {
  for (const item of items) {
    yield item;
  }
}

function scriptToolCalls(calls: Array<{ args: Record<string, unknown>; name: string }>): ScriptedLanguageModelAdapter {
  return new ScriptedLanguageModelAdapter({
    modelId: "run-finalization-model",
    providerId: "example_lm",
    responses: calls.map(
      (call) => (request: never) =>
        buildScriptedResponse({
          request,
          text: `Calling ${call.name}.`,
          toolCalls: [buildToolCall(call.name, call.args as never)]
        })
    ) as never
  });
}

function collectEvents(sdk: AIAgentSdk): {
  runStatuses: () => string[];
  toolActivity: () => ToolCallRecord[];
} {
  const events: GatewayEvent[] = [];
  sdk.subscribe((event) => {
    events.push(event);
  });
  return {
    runStatuses: () => events.filter((event) => event.topic === "run.updated").map((event) => event.payload.status),
    toolActivity: () => events.filter((event) => event.topic === "tool.updated").map((event) => event.payload)
  };
}

describe("gateway run finalization", () => {
  test("a run that pauses for approval reaches a terminal status the CLI can act on", async () => {
    const adapter = scriptToolCalls([
      { args: { path: "." }, name: "list_files" },
      { args: { command: "which codex" }, name: "shell_command" }
    ]);

    await withExampleSdk({
      name: "run-finalization-approval",
      providers: {
        languageModelAdapters: [
          {
            adapter,
            defaultModel: "run-finalization-model",
            enabled: true
          }
        ]
      },
      run: async ({ sdk, workspaceRoot }) => {
        const observed = collectEvents(sdk);
        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Pause for approval",
          metadata: { surface: "cli" },
          title: "Approval pause"
        });

        const run = await created.handle.sendMessage({
          text: "please run an example prompt in codex"
        });
        // A 10s ceiling turns "the run never finishes" into a failing test
        // instead of a hung suite.
        const record = await run.wait({ timeoutMs: 10_000 });

        expect(record.status).toBe("completed");
        expect(record.completionReason).toBe("session_awaiting_approval");
        expect(observed.runStatuses()).toContain("completed");

        const pending = await created.handle.listPendingApprovals();
        expect(pending.map((entry) => entry.request.target.value)).toEqual(["which codex"]);
      }
    });
  });

  test("an unreachable MCP server's status result still finalizes the run", async () => {
    // The original incident exactly: three configured MCP servers that could
    // not connect, so every summary carried `lastConnectedAt` as a key with an
    // explicit undefined value. Emitting that tool result threw, the run never
    // finalized, and the CLI waited on it forever.
    const adapter = scriptToolCalls([
      { args: {}, name: "mcp_status" },
      { args: { summary: "Reported MCP status." }, name: "attempt_complete" }
    ]);

    await withExampleSdk({
      configureConfig: (config) => {
        config.mcp.servers.unreachable = {
          enabled: true,
          headers: {},
          required: false,
          tags: [],
          // Nothing listens here, so the connection fails fast.
          type: "streamable-http",
          url: "http://127.0.0.1:9/mcp"
        } as never;
      },
      name: "run-finalization-unreachable-mcp",
      providers: {
        languageModelAdapters: [
          {
            adapter,
            defaultModel: "run-finalization-model",
            enabled: true
          }
        ]
      },
      run: async ({ sdk, workspaceRoot }) => {
        const observed = collectEvents(sdk);
        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Report MCP status with an unreachable server",
          metadata: { surface: "cli" },
          title: "MCP status"
        });

        const run = await created.handle.sendMessage({
          text: "what MCP servers do you have?"
        });
        const record = await run.wait({ timeoutMs: 20_000 });

        expect(record.status).toBe("completed");
        expect(observed.runStatuses().at(-1)).toBe("completed");

        const status = observed.toolActivity().find((call) => call.toolName === "mcp_status");
        expect(status?.status).toBe("succeeded");
        // The tool.updated event carrying this result is what used to throw.
        expect(JSON.stringify(status?.result)).toContain("unreachable");
      }
    });
  });

  test("waitForRun rejects with a clear error instead of hanging forever", async () => {
    await withExampleSdk({
      name: "run-finalization-timeout",
      providers: {
        languageModelAdapters: [
          {
            adapter: scriptToolCalls([]),
            defaultModel: "run-finalization-model",
            enabled: true
          }
        ]
      },
      run: async ({ sdk, workspaceRoot }) => {
        const created = await sdk.sessions.create({
          cwd: workspaceRoot,
          goal: "Wait on a run that does not exist",
          metadata: { surface: "cli" },
          title: "Timeout"
        });

        // A run id the gateway has never heard of can never report a terminal
        // status, which is exactly the shape of the original hang.
        await expect(
          sdk.waitForRun(
            {
              approvalRequestIds: [],
              createdAt: new Date().toISOString(),
              id: "gateway-run.missing",
              kind: "session_message",
              messageIds: [],
              metadata: {},
              sessionId: created.session.id,
              status: "running",
              toolCallIds: [],
              turnIds: [],
              updatedAt: new Date().toISOString()
            },
            { timeoutMs: 250 }
          )
        ).rejects.toBeInstanceOf(AIAgentRunWaitTimeoutError);
      }
    });
  });

  test("the interactive CLI prompts for the pending approval and says why the turn ended", async () => {
    const adapter = scriptToolCalls([
      { args: { path: "." }, name: "list_files" },
      { args: { command: "which codex" }, name: "shell_command" },
      { args: { summary: "done" }, name: "attempt_complete" }
    ]);
    const capture = createCaptureStreams();

    await withExampleSdk({
      name: "run-finalization-cli",
      providers: {
        languageModelAdapters: [
          {
            adapter,
            defaultModel: "run-finalization-model",
            enabled: true
          }
        ]
      },
      run: async ({ sdk, workspaceRoot }) => {
        const exitCode = await runCli(["--cwd", workspaceRoot], capture.streams as never, {
          createSdk: async () => sdk,
          interactiveInput: lineSource(["please run an example prompt in codex", "y", "/exit"])
        });

        expect(exitCode).toBe(0);
        // The prompt the operator never saw in the original incident.
        expect(capture.getStdout()).toContain("Approve command → which codex?");
        expect(capture.getStdout()).toContain("Approved which codex.");
        // Tool lines carry their arguments, so repeated reads are legible.
        expect(capture.getStderr()).toContain("· list_files(path=.)");
        expect(capture.getStderr()).toContain("· shell_command(command=which codex)");
        // The pause is announced while the run is still going.
        expect(capture.getStderr()).toContain("paused for approval: command → which codex");
      }
    });
  });
});
