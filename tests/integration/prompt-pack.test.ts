import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { buildPromptPack, type ToolDefinition } from "@/core";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

describe("prompt pack", () => {
  test("loads AGENTS.md documents and skills with the intended precedence", async () => {
    const root = await createTempRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const nested = path.join(workspace, "packages", "app");

    await fs.mkdir(path.join(home, ".aia", "skills", "shared-skill"), { recursive: true });
    await fs.mkdir(path.join(home, ".aia", "skills", "global-skill"), { recursive: true });
    await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
    await fs.mkdir(path.join(workspace, "skills", "shared-skill"), { recursive: true });
    await fs.mkdir(path.join(nested, "skills", "local-skill"), { recursive: true });

    await fs.writeFile(path.join(home, ".aia", "AGENTS.md"), "User-level instruction: be concise.", "utf8");
    await fs.writeFile(path.join(workspace, "AGENTS.md"), "Workspace instruction: prefer the canonical path.", "utf8");
    await fs.writeFile(path.join(nested, "AGENTS.md"), "Nested instruction: edit only files under this app when possible.", "utf8");

    await fs.writeFile(
      path.join(home, ".aia", "skills", "shared-skill", "SKILL.md"),
      `---
name: shared-skill
description: User shared skill
---
User version should lose to the workspace copy.`,
      "utf8"
    );
    await fs.writeFile(
      path.join(home, ".aia", "skills", "global-skill", "SKILL.md"),
      `---
name: global-skill
description: Global research workflow
---
Use this for reusable research steps.`,
      "utf8"
    );
    await fs.writeFile(
      path.join(workspace, "skills", "shared-skill", "SKILL.md"),
      `---
name: shared-skill
description: Workspace shared skill
---
Workspace version should win.`,
      "utf8"
    );
    await fs.writeFile(
      path.join(nested, "skills", "local-skill", "SKILL.md"),
      `---
name: local-skill
description: Nested skill for this package
---
Package-local workflow.`,
      "utf8"
    );

    const tools: ToolDefinition[] = [
      {
        aliases: ["task_complete"],
        annotations: {
          meta: {},
          readOnlyHint: true,
          title: "Attempt Complete"
        },
        approvalMode: "ask",
        descriptor: {
          approvalNotes: "The runtime still validates completion before ending the task.",
          examples: ["Use after the requested work is complete."],
          purpose: "Finish the active task through the runtime completion gate.",
          sideEffectSummary: "No side effects.",
          whenNotToUse: ["Do not use it while work is still unresolved."],
          whenToUse: ["Use only when the task is fully complete."]
        },
        description: "Complete the current task.",
        displayName: "Attempt Complete",
        execution: {
          inputMode: "json",
          resumable: false,
          taskSupport: "forbidden"
        },
        idempotent: true,
        inputSchema: { type: "object" },
        invocationName: "attempt_complete",
        kind: "built_in",
        metadata: {},
        name: "attempt_complete",
        outputKind: "json",
        retryable: false,
        searchTags: ["completion"],
        sideEffects: ["none"],
        source: {
          displayName: "Built-in Tools",
          kind: "built_in"
        },
        streamingMode: "none",
        toolId: "tool.builtin.attempt_complete",
        usageGuidance: "Call only when the task is fully complete.",
        version: "1.0.0"
      },
      {
        aliases: [],
        annotations: {
          meta: {},
          readOnlyHint: true,
          title: "Skill"
        },
        approvalMode: "ask",
        descriptor: {
          approvalNotes: "Approval may depend on the underlying actions that the skill later triggers.",
          examples: ["Use when the task matches a known workflow."],
          purpose: "Load the full instructions for a relevant skill.",
          sideEffectSummary: "Reads skill instructions from disk.",
          whenNotToUse: ["Do not use when no skill is relevant."],
          whenToUse: ["Use when a task matches an available skill."]
        },
        description: "Load a full skill by name.",
        displayName: "Skill",
        execution: {
          inputMode: "json",
          resumable: false,
          taskSupport: "forbidden"
        },
        idempotent: true,
        inputSchema: { type: "object" },
        invocationName: "skill",
        kind: "skill",
        metadata: {},
        name: "skill",
        outputKind: "markdown",
        retryable: true,
        searchTags: ["skills"],
        sideEffects: ["workspace_read"],
        source: {
          displayName: "Built-in Skills",
          kind: "skill"
        },
        streamingMode: "none",
        toolId: "tool.skill.load",
        usageGuidance: "Use when a task matches an available skill.",
        version: "1.0.0"
      }
    ];

    const pack = await buildPromptPack({
      availableTools: tools,
      cwd: nested,
      taskSummary: "Implement the prompt stack",
      userHomeDirectory: home
    });

    expect(pack.agentsDocuments.user?.path).toBe(path.join(home, ".aia", "AGENTS.md"));
    expect(pack.agentsDocuments.project.map((doc) => doc.path)).toEqual([
      path.join(workspace, "AGENTS.md"),
      path.join(nested, "AGENTS.md")
    ]);
    expect(pack.availableSkills.map((skill) => skill.name)).toEqual(["global-skill", "local-skill", "shared-skill"]);
    expect(pack.availableSkills.find((skill) => skill.name === "shared-skill")?.description).toBe("Workspace shared skill");
    expect(pack.systemPrompt).toContain("Project instructions override user-level instructions.");
    expect(pack.systemPrompt).toContain("Workspace instruction: prefer the canonical path.");
    expect(pack.systemPrompt).toContain("Nested instruction: edit only files under this app when possible.");
    expect(pack.systemPrompt).toContain("`attempt_complete`");
    expect(pack.systemPrompt).toContain("use the `skill` tool to load the full skill instructions");
    expect(pack.nudges.taskContinuation).toContain("attempt_complete");
  });

  test("renders the strengthened Completion Contract directly under the intro", async () => {
    const root = await createTempRoot();
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(workspace, ".git"), { recursive: true });

    const pack = await buildPromptPack({
      availableTools: [],
      cwd: workspace,
      userHomeDirectory: root
    });

    // The section heading wording (and "read first" cue) signals the prompt
    // change to future maintainers; the contract must be visible enough that a
    // small local model treats completion as an explicit tool call rather than
    // a chat-only sign-off.
    expect(pack.systemPrompt).toContain("Completion Contract (read first)");
    // "Saying I'm done is not enough" — the literal anti-prose sentence is the
    // headline behavior change. If this string is renamed, update both the
    // section and the docs in docs/AGENT_LOOP.md.
    expect(pack.systemPrompt).toMatch(/Saying .*I.?m done/u);
    expect(pack.systemPrompt).toContain("completion_blocked");
    // The literal JSON example must be present so the model can imitate the
    // tool-call shape verbatim. We assert the call name and the required
    // argument together to defend against accidental schema drift.
    expect(pack.systemPrompt).toContain(
      `{"name":"attempt_complete","arguments":{"summary":"`
    );
    // The Completion Contract section must appear before the Safety section so
    // the model reads it first.
    const completionIndex = pack.systemPrompt.indexOf(
      "Completion Contract (read first)"
    );
    const safetyIndex = pack.systemPrompt.indexOf("Safety and Reliability");
    expect(completionIndex).toBeGreaterThan(-1);
    expect(safetyIndex).toBeGreaterThan(completionIndex);
  });

  test("truncates oversized instruction documents and memory summaries with a read_file pointer", async () => {
    const root = await createTempRoot();
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
    await fs.writeFile(path.join(workspace, "AGENTS.md"), `Start marker. ${"x".repeat(5_000)} End marker.`, "utf8");

    const pack = await buildPromptPack({
      availableTools: [],
      cwd: workspace,
      instructionDocCharBudget: 500,
      memoryContext: {
        sessionSummary: `Summary head. ${"y".repeat(2_000)}`
      },
      memorySummaryCharBudget: 100,
      userHomeDirectory: root
    });

    expect(pack.systemPrompt).toContain("Start marker.");
    expect(pack.systemPrompt).not.toContain("End marker.");
    expect(pack.systemPrompt).toContain("Truncated to 500 of");
    expect(pack.systemPrompt).toContain("read_file");
    expect(pack.systemPrompt).toContain("Summary head.");
    expect(pack.systemPrompt).toContain("Truncated to 100 of");
  });

  test("does not render a per-tool catalog in the system prompt and explains tool_search when available", async () => {
    const root = await createTempRoot();
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(workspace, ".git"), { recursive: true });

    const toolSearchTool: ToolDefinition = {
      aliases: [],
      annotations: { meta: {}, readOnlyHint: true, title: "Tool Search" },
      approvalMode: "never",
      descriptor: {
        examples: [],
        purpose: "Search the tool catalog.",
        whenNotToUse: [],
        whenToUse: ["Use when unsure which tool to call."]
      },
      description: "Search the tool catalog.",
      displayName: "Tool Search",
      execution: { inputMode: "json", resumable: false, taskSupport: "forbidden" },
      idempotent: true,
      inputSchema: { type: "object" },
      invocationName: "tool_search",
      kind: "built_in",
      metadata: {},
      name: "tool_search",
      outputKind: "json",
      retryable: true,
      searchTags: ["catalog"],
      sideEffects: ["none"],
      source: { displayName: "Built-in Tools", kind: "built_in" },
      streamingMode: "none",
      toolId: "tool.builtin.tool_search",
      usageGuidance: "This guidance text must not be duplicated into the system prompt.",
      version: "1.0.0"
    };

    const pack = await buildPromptPack({
      availableTools: [toolSearchTool],
      cwd: workspace,
      userHomeDirectory: root
    });

    expect(pack.systemPrompt).not.toContain("Available Tools");
    expect(pack.systemPrompt).not.toContain("This guidance text must not be duplicated into the system prompt.");
    expect(pack.systemPrompt).toContain("Working With Tools");
    expect(pack.systemPrompt).toContain("`tool_search`");
  });

  test("renders task-state context when a plan and working memory are available", async () => {
    const root = await createTempRoot();
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(workspace, ".git"), { recursive: true });

    const pack = await buildPromptPack({
      availableTools: [],
      cwd: workspace,
      taskState: {
        activePlanId: "plan.prompt.1",
        blockers: [
          {
            createdAt: "2026-03-27T16:20:00.000Z",
            id: "working-memory.blocker.prompt.1",
            kind: "blocker",
            metadata: {},
            priority: "high",
            sessionId: "session.prompt.1",
            text: "Waiting on a browser automation adapter."
          }
        ],
        nextStep: {
          createdAt: "2026-03-27T16:20:00.000Z",
          id: "working-memory.next-step.prompt.1",
          kind: "next_step",
          metadata: {},
          priority: "high",
          sessionId: "session.prompt.1",
          text: "Implement the plan tool next."
        },
        plan: {
          createdAt: "2026-03-27T16:20:00.000Z",
          id: "plan.prompt.1",
          items: [
            {
              id: "plan-item.prompt.1",
              metadata: {},
              order: 0,
              status: "in_progress",
              title: "Implement the plan tool"
            }
          ],
          metadata: {},
          sessionId: "session.prompt.1",
          summary: "Track the task state centrally.",
          tags: [],
          title: "Prompt Plan",
          updatedAt: "2026-03-27T16:20:00.000Z"
        },
        progress: {
          blocked: 0,
          cancelled: 0,
          completed: 0,
          inProgress: 1,
          pending: 0,
          total: 1
        },
        recentAttempts: [
          {
            createdAt: "2026-03-27T16:20:00.000Z",
            id: "working-memory.attempt.prompt.1",
            kind: "recent_attempt",
            metadata: {},
            priority: "medium",
            sessionId: "session.prompt.1",
            text: "Defined the task-state contracts."
          }
        ],
        sessionId: "session.prompt.1",
        summary: "Track the task state centrally.",
        updatedAt: "2026-03-27T16:20:00.000Z",
        workingMemory: []
      },
      userHomeDirectory: root
    });

    expect(pack.systemPrompt).toContain("Progress: 0/1 completed");
    expect(pack.systemPrompt).toContain("Next step: Implement the plan tool next.");
    expect(pack.systemPrompt).toContain("Blocker: Waiting on a browser automation adapter.");
    expect(pack.systemPrompt).toContain("Recent attempt: Defined the task-state contracts.");
  });

  test("renders durable memory context when summaries are available", async () => {
    const root = await createTempRoot();
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(workspace, ".git"), { recursive: true });

    const pack = await buildPromptPack({
      availableTools: [],
      cwd: workspace,
      memoryContext: {
        sessionSummary: "# Session Summary\n\nGoal: Finish the task.",
        userGlobalSummary: "# User Global Memory\n\n- Prefer concise updates.",
        workspaceSummary: "# Workspace Memory\n\n- Use Node 22 and TypeScript ESM."
      },
      userHomeDirectory: root
    });

    expect(pack.systemPrompt).toContain("# Workspace Memory");
    expect(pack.systemPrompt).toContain("Prefer concise updates.");
    expect(pack.systemPrompt).toContain("# Session Summary");
  });
});

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-prompts-"));
  tempRoots.push(root);
  return root;
}
