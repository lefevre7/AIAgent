import { describe, expect, test } from "vitest";

import {
  DEFAULT_APPROVAL_SETTINGS,
  RegexApprovalPolicy,
  createDefaultToolRegistry,
  createToolApprovalDecider,
  sessionRecordSchema,
  toolCallRecordSchema,
  turnRecordSchema
} from "@/core";

// Security review H1: the shipped default rules were over-escaped, which made
// `\s`/`\b` literal characters and silently disabled the destructive-command
// deny rule. These tests instantiate the real defaults instead of look-alikes.
describe("default approval rules", () => {
  const policy = new RegexApprovalPolicy(DEFAULT_APPROVAL_SETTINGS);

  const evaluateCommand = (command: string) =>
    policy.evaluateTargets([{ kind: "command", label: "command", value: command }]);

  test("deny destructive commands", () => {
    for (const command of [
      "rm -rf /",
      "rm -rf /*",
      "rm -fr ~",
      "rm -rf ~/",
      "rm -r .",
      "rm -rf *",
      "sudo rm -rf /",
      "cd /tmp && rm -rf /",
      "echo ok; rm -rf ~",
      "rm -rf --no-preserve-root /var",
      "mkfs.ext4 /dev/sda1",
      "mkfs /dev/sdb",
      "dd if=/dev/zero of=/dev/sda bs=1M",
      "shred -n 3 /dev/sda",
      "cat payload.img > /dev/sda",
      "shutdown now",
      "sudo shutdown -h now",
      "reboot",
      "halt",
      "poweroff",
      "chmod -R 777 /",
      "sudo chown -R nobody /",
      ":(){ :|:& };:"
    ]) {
      const match = evaluateCommand(command);
      expect(match.mode, command).toBe("deny");
      expect(match.rule?.id, command).toMatch(/^rule\.command\.destructive\./u);
    }
  });

  test("do not deny ordinary deletes and words that merely contain the dangerous tokens", () => {
    for (const command of [
      "rm -rf ./build",
      "rm -rf /tmp/aia-scratch",
      "rm notes.txt",
      "git rm -r --cached dist",
      "echo shutdown-notes.md",
      "ls /dev/sda",
      "grep reboot CHANGELOG.md"
    ]) {
      expect(evaluateCommand(command).mode, command).not.toBe("deny");
    }
  });

  test("allow common read-only inspection commands, including ones with flags", () => {
    for (const command of ["pwd", "ls -la", "ls", "find . -name '*.ts'", "rg approval src", "cat README.md", "git status --short", "git diff HEAD~1", "head -n 20 file", "wc -l file"]) {
      const match = evaluateCommand(command);
      expect(match.mode, command).toBe("allow");
      expect(match.rule?.id, command).toBe("rule.command.read.allow");
    }
  });

  test("ask for build, test, and package-manager commands", () => {
    for (const command of ["npm test", "pnpm install", "node script.js", "python3 -m pytest", "cargo build", "./gradlew test", "gradle build"]) {
      const match = evaluateCommand(command);
      expect(match.mode, command).toBe("ask");
      expect(match.rule?.id, command).toBe("rule.command.build.ask");
    }
  });

  test("fall back to the default mode for unmatched commands", () => {
    expect(evaluateCommand("curl https://example.com").mode).toBe("ask");
  });

  test("shell_command with rm -rf / is denied end to end through the default decider and registry", async () => {
    const registry = createDefaultToolRegistry({
      stateRoot: "/workspace/.aia",
      workspaceRoot: "/workspace"
    });
    const decider = createToolApprovalDecider({ settings: DEFAULT_APPROVAL_SETTINGS });
    const definition = registry.getDefinition("shell_command");
    if (!definition) {
      throw new Error("shell_command must be registered.");
    }

    const denied = await decider({
      call: buildCall({ command: "rm -rf /", cwd: "/workspace" }),
      definition,
      session: buildSession(),
      turn: buildTurn()
    });
    expect(denied.mode).toBe("deny");

    const allowed = await decider({
      call: buildCall({ command: "ls -la", cwd: "/workspace" }),
      definition,
      session: buildSession(),
      turn: buildTurn()
    });
    expect(allowed).toEqual({ mode: "execute" });
  });
});

function buildSession() {
  return sessionRecordSchema.parse({
    createdAt: "2026-09-14T12:00:00.000Z",
    cwd: "/workspace",
    goal: "Exercise default approval rules",
    id: "session.defaults.1",
    lastActiveAt: "2026-09-14T12:00:00.000Z",
    metadata: {},
    status: "running_model",
    tags: [],
    title: "Default Approvals",
    updatedAt: "2026-09-14T12:00:00.000Z"
  });
}

function buildTurn() {
  return turnRecordSchema.parse({
    approvalRequestIds: [],
    executedToolCallIds: [],
    id: "turn.defaults.1",
    inputMessageIds: [],
    metadata: {},
    outputMessageIds: [],
    requestedToolCallIds: [],
    sequence: 0,
    sessionId: "session.defaults.1",
    startedAt: "2026-09-14T12:00:00.000Z",
    status: "running",
    trigger: "user"
  });
}

function buildCall(args: Record<string, string>) {
  return toolCallRecordSchema.parse({
    arguments: args,
    id: "tool-call.defaults.1",
    metadata: {},
    sessionId: "session.defaults.1",
    startedAt: "2026-09-14T12:00:00.000Z",
    status: "pending",
    toolName: "shell_command",
    turnId: "turn.defaults.1"
  });
}
