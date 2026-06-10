import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  FileExternalAgentService,
  ToolRuntime,
  createDefaultToolRegistry,
  createDefaultToolRuntime,
  createExternalAgentApprovalTargetResolver,
  createToolApprovalDecider,
  toolCallRecordSchema,
  turnRecordSchema,
  type ApprovalSettings
} from "@/core";

import { buildExternalAgentSession, createMockCodexConfig } from "../helpers/external-agents";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

describe("external-agent tool", () => {
  test("bypasses approval for list and still requests approval for run in the default runtime", async () => {
    const root = await createTempRoot();
    const service = new FileExternalAgentService({
      agents: {
        codex: createMockCodexConfig()
      },
      stateRoot: path.join(root, ".aia", "external-agents")
    });
    const runtime = createDefaultToolRuntime({
      externalAgentService: service
    });
    const session = buildExternalAgentSession({
      cwd: root
    });
    const turn = buildTurn(session.id);

    const listResult = await runtime.execute(
      createCall("tool-call.external-agent.list", session.id, turn.id, {
        action: "list"
      }),
      {
        session,
        turn
      }
    );

    expect(listResult.toolCall.status).toBe("succeeded");
    expect(listResult.toolCall.result).toMatchObject({
      action: "list",
      definitions: [
        expect.objectContaining({
          id: "codex"
        })
      ]
    });

    const runResult = await runtime.execute(
      createCall("tool-call.external-agent.run.default", session.id, turn.id, {
        action: "run",
        agentId: "codex",
        instructions: "default runtime"
      }),
      {
        session,
        turn
      }
    );

    expect(runResult.toolCall.status).toBe("awaiting_approval");
    expect(runResult.approvalRequest?.target.kind).toBe("external_agent");
  });

  test("resolves external-agent approval targets for mutating run actions", async () => {
    const root = await createTempRoot();
    const service = new FileExternalAgentService({
      agents: {
        codex: createMockCodexConfig()
      },
      stateRoot: path.join(root, ".aia", "external-agents")
    });
    const settings: ApprovalSettings = {
      configVersion: 1,
      defaultMode: "ask",
      rules: [
        {
          id: "rule.external-agent.codex.allow",
          mode: "allow",
          pattern: "^codex$",
          targetKind: "external_agent"
        }
      ]
    };
    const runtime = new ToolRuntime({
      approvalDecider: createToolApprovalDecider({
        resolveAdditionalTargets: createExternalAgentApprovalTargetResolver({
          service
        }),
        settings
      }),
      registry: createDefaultToolRegistry({
        externalAgentService: service
      })
    });
    const session = buildExternalAgentSession({
      cwd: root,
      id: "session.external-agent.allowed"
    });
    const turn = buildTurn(session.id);

    const result = await runtime.execute(
      createCall("tool-call.external-agent.run.allowed", session.id, turn.id, {
        action: "run",
        agentId: "codex",
        instructions: "allowed runtime execution"
      }),
      {
        session,
        turn
      }
    );

    expect(result.toolCall.status).toBe("awaiting_approval");
    expect(result.approvalRequest?.target).toEqual({
      kind: "external_agent",
      label: "Mock Codex CLI",
      value: "codex"
    });
    expect(result.approvalRequest?.metadata.matchedApprovalRuleId).toBe("rule.external-agent.codex.allow");
  });
});

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-external-agent-tool-"));
  tempRoots.push(root);
  return root;
}

function buildTurn(sessionId: string) {
  return turnRecordSchema.parse({
    approvalRequestIds: [],
    executedToolCallIds: [],
    id: `turn.${sessionId}`,
    inputMessageIds: [],
    metadata: {},
    outputMessageIds: [],
    requestedToolCallIds: [],
    sequence: 0,
    sessionId,
    startedAt: "2026-03-31T12:00:00.000Z",
    status: "running",
    trigger: "user"
  });
}

function createCall(id: string, sessionId: string, turnId: string, argumentsValue: Record<string, unknown>) {
  return toolCallRecordSchema.parse({
    arguments: argumentsValue,
    id,
    metadata: {},
    sessionId,
    startedAt: "2026-03-31T12:00:00.000Z",
    status: "pending",
    toolName: "external_agent",
    turnId
  });
}
