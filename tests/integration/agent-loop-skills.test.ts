import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  AgentLoop,
  CHANNEL_OPERATOR_METADATA_KEY,
  COMPACTION_WATERMARK_METADATA_KEY,
  DEFAULT_SKILLS_SETTINGS,
  FileSessionStore,
  SKILL_ACTIVATIONS_METADATA_KEY,
  ToolRegistryBuilder,
  ToolRuntime,
  createSkillTool,
  readSkillActivations,
  skillToolDefinition,
  type AgentLoopModel,
  type AgentLoopToolExecutionResult,
  type LanguageModelRequest,
  type LanguageModelResponse,
  type Message,
  type SessionRecord,
  type SkillProvider,
  type SkillRecord,
  type ToolCallRecord,
  type ToolDefinition
} from "@/core";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("agent loop skills", () => {
  test("offers the skill tool with an enum of the model's skills, and not at all without one", async () => {
    const withSkills = await createHarness({
      responses: [complete()],
      skills: [
        skill("alpha"),
        skill("beta"),
        skill("reserved", { disableModelInvocation: true }),
        skill("off", { enabled: false })
      ]
    });
    await withSkills.loop.run({
      availableTools: [attemptCompleteTool, skillToolDefinition],
      session: withSkills.session,
      userMessages: [userMessage("Hello")]
    });

    const request = withSkills.model.requests[0]!;
    const offered = request.availableTools.find((tool) => tool.name === "skill");
    expect((offered?.inputSchema.properties as Record<string, { enum?: string[] }>).name?.enum).toEqual([
      "alpha",
      "beta"
    ]);
    expect(request.instructions).toContain("<skill><name>alpha</name><description>alpha description</description>");
    expect(request.instructions).not.toContain("<name>reserved</name>");
    // The location is listed even with the tool, so the model can find the files beside a skill.
    expect(request.instructions).toContain("<location>/skills/alpha/SKILL.md</location>");
    expect(request.instructions).toContain("load it with the `skill` tool");

    const withoutSkills = await createHarness({
      responses: [complete()],
      skills: [skill("reserved-only", { disableModelInvocation: true })]
    });
    await withoutSkills.loop.run({
      availableTools: [attemptCompleteTool, skillToolDefinition],
      session: withoutSkills.session,
      userMessages: [userMessage("Hello")]
    });
    const bare = withoutSkills.model.requests[0]!;
    expect(bare.availableTools.map((tool) => tool.name)).toEqual(["attempt_complete"]);
    expect(bare.instructions).not.toContain("Available Skills");
  });

  test("without the skill tool, the catalog gives each SKILL.md's location to read", async () => {
    const harness = await createHarness({ responses: [complete(), complete()], skills: [skill("alpha")] });
    await harness.loop.run({
      availableTools: [attemptCompleteTool, readFileTool],
      session: harness.session,
      userMessages: [userMessage("Hello")]
    });
    expect(harness.model.requests[0]!.instructions).toContain("<location>/skills/alpha/SKILL.md</location>");
    expect(harness.model.requests[0]!.instructions).toContain("with `read_file`");

    // Without read_file either, the prompt does not name a tool the model lacks.
    await harness.loop.run({
      availableTools: [attemptCompleteTool],
      session: harness.session,
      userMessages: [userMessage("Hello again", "message.user.2")]
    });
    expect(harness.model.requests[1]!.instructions).toContain("read its SKILL.md at the listed location before acting");
    expect(harness.model.requests[1]!.instructions).not.toContain("with `read_file`");
  });

  test("a $mention adds the skill's instructions after the message, once, and records it", async () => {
    const harness = await createHarness({
      responses: [complete(), complete()],
      skills: [skill("alpha"), skill("beta"), skill("reserved", { disableModelInvocation: true })]
    });

    const first = await harness.loop.run({
      availableTools: [attemptCompleteTool],
      session: harness.session,
      userMessages: [userMessage("Use $alpha, then $reserved, then $alpha again. $unknown is not a skill.")]
    });

    const snapshot = await harness.store.getSessionSnapshot(harness.session.id);
    const skillMessages = (snapshot?.messages ?? []).filter((message) => message.tags.includes("skill"));
    expect(skillMessages.map((message) => message.metadata.skillName)).toEqual(["alpha", "reserved"]);
    expect(skillMessages[0]).toMatchObject({ role: "user", source: "system", visibility: "compact" });
    expect(textOf(skillMessages[0]!)).toContain('<skill_content name="alpha">\nalpha instructions');

    // The model saw the operator's message, then the skills' instructions.
    const sent = harness.model.requests[0]!.messages.map((message) => message.id);
    expect(sent.indexOf(skillMessages[0]!.id)).toBeGreaterThan(sent.indexOf("message.user.1"));
    expect(readSkillActivations(first.session.metadata)).toEqual([
      { messageId: skillMessages[0]!.id, name: "alpha" },
      { messageId: skillMessages[1]!.id, name: "reserved" }
    ]);

    // Named again in a later run: already loaded, so nothing is added.
    await harness.loop.run({
      availableTools: [attemptCompleteTool],
      session: first.session,
      userMessages: [userMessage("Keep using $alpha.", "message.user.2")]
    });
    const later = await harness.store.getSessionSnapshot(harness.session.id);
    expect((later?.messages ?? []).filter((message) => message.tags.includes("skill"))).toHaveLength(2);
  });

  test("a channel message loads a skill by naming it only when its sender is an operator", async () => {
    const harness = await createHarness({ responses: [complete(), complete()], skills: [skill("alpha")] });
    const stranger = await harness.loop.run({
      availableTools: [attemptCompleteTool],
      session: harness.session,
      userMessages: [{ ...userMessage("Run $alpha"), source: "channel" }]
    });
    const afterStranger = await harness.store.getSessionSnapshot(harness.session.id);
    expect((afterStranger?.messages ?? []).some((message) => message.tags.includes("skill"))).toBe(false);

    await harness.loop.run({
      availableTools: [attemptCompleteTool],
      session: stranger.session,
      userMessages: [
        {
          ...userMessage("Run $alpha", "message.user.2"),
          metadata: { [CHANNEL_OPERATOR_METADATA_KEY]: true },
          source: "channel"
        }
      ]
    });
    const afterOperator = await harness.store.getSessionSnapshot(harness.session.id);
    expect((afterOperator?.messages ?? []).filter((message) => message.tags.includes("skill"))).toHaveLength(1);
  });

  test("the skill tool loads a skill once; asking again says it is already loaded", async () => {
    const skills = [skill("alpha")];
    const provider = fixedProvider(skills);
    const runtime = new ToolRuntime({
      registry: new ToolRegistryBuilder().register(createSkillTool({ skills: provider })).build()
    });
    const harness = await createHarness({
      responses: [
        callTool("skill", { name: "alpha" }, "call.skill.1"),
        callTool("skill", { name: "ALPHA" }, "call.skill.2"),
        callTool("skill", { name: "missing" }, "call.skill.3"),
        complete()
      ],
      skillProvider: provider,
      toolCatalog: runtime,
      toolExecutor: runtime
    });

    const result = await harness.loop.run({
      availableTools: [attemptCompleteTool, skillToolDefinition],
      session: harness.session,
      userMessages: [userMessage("Do the alpha task.")]
    });

    const toolMessages = (await harness.store.getSessionSnapshot(harness.session.id))?.messages.filter(
      (message) => message.role === "tool"
    );
    expect(textOf(toolMessages![0]!)).toContain('<skill_content name="alpha">');
    expect(textOf(toolMessages![1]!)).toContain('The "alpha" skill is already loaded in this session.');
    expect(JSON.stringify(toolMessages![2]!.parts)).toContain(
      'No skill is named \\"missing\\". Available skills: alpha.'
    );
    expect(readSkillActivations(result.session.metadata)).toEqual([{ messageId: toolMessages![0]!.id, name: "alpha" }]);
  });

  // The model is offered only the skills it may load, but a server that does
  // not hold tool calls to their schema lets it name any: the tool checks.
  test("the skill tool refuses a disabled skill and one only the operator may start, however it is named", async () => {
    const skills = [
      skill("alpha"),
      skill("deploy", { disableModelInvocation: true }),
      skill("retired", { enabled: false })
    ];
    const provider = fixedProvider(skills);
    const runtime = new ToolRuntime({
      registry: new ToolRegistryBuilder().register(createSkillTool({ skills: provider })).build()
    });
    const harness = await createHarness({
      responses: [
        callTool("skill", { name: "deploy" }, "call.skill.1"),
        callTool("skill", { name: "DEPLOY" }, "call.skill.2"),
        callTool("skill", { name: "$retired" }, "call.skill.3"),
        complete()
      ],
      skillProvider: provider,
      toolCatalog: runtime,
      toolExecutor: runtime
    });

    const result = await harness.loop.run({
      availableTools: [attemptCompleteTool, skillToolDefinition],
      session: harness.session,
      userMessages: [userMessage("Deploy it.")]
    });

    const toolMessages = (await harness.store.getSessionSnapshot(harness.session.id))?.messages.filter(
      (message) => message.role === "tool"
    );
    const replies = toolMessages!.map((message) => JSON.stringify(message.parts));
    expect(replies).toHaveLength(3);
    expect(replies[0]).toContain('The \\"deploy\\" skill runs only when the operator names it as $deploy.');
    expect(replies[1]).toContain('No skill is named \\"DEPLOY\\". Available skills: alpha.');
    expect(replies[2]).toContain('The \\"retired\\" skill is disabled in this configuration (skills.disabled).');
    expect(replies.join("\n")).not.toContain("<skill_content");
    expect(readSkillActivations(result.session.metadata)).toEqual([]);
  });

  test("the skill tool loads from the run's skills: the folders are searched once per run, not per call", async () => {
    // Each call walked every skill root again, and could disagree with the
    // name enum the model was given at the start of the run.
    let discoveries = 0;
    const counting: SkillProvider = {
      discover: async () => {
        discoveries += 1;
        return { diagnostics: [], skills: [skill("alpha"), skill("beta")] };
      },
      settings: DEFAULT_SKILLS_SETTINGS
    };
    const runtime = new ToolRuntime({
      registry: new ToolRegistryBuilder().register(createSkillTool({ skills: counting })).build()
    });
    const harness = await createHarness({
      responses: [
        callTool("skill", { name: "alpha" }, "call.skill.1"),
        callTool("skill", { name: "beta" }, "call.skill.2"),
        complete()
      ],
      skillProvider: counting,
      toolCatalog: runtime,
      toolExecutor: runtime
    });

    const result = await harness.loop.run({
      availableTools: [attemptCompleteTool, skillToolDefinition],
      session: harness.session,
      userMessages: [userMessage("Do alpha and beta.")]
    });

    expect(readSkillActivations(result.session.metadata).map((activation) => activation.name)).toEqual([
      "alpha",
      "beta"
    ]);
    expect(discoveries).toBe(1);
  });

  test("a skill asked for twice in one response is loaded once", async () => {
    // Loads were recorded only after every call of the turn, so the second
    // call saw nothing loaded and added the whole text again.
    const provider = fixedProvider([skill("alpha")]);
    const runtime = new ToolRuntime({
      registry: new ToolRegistryBuilder().register(createSkillTool({ skills: provider })).build()
    });
    const harness = await createHarness({
      responses: [
        response([
          { arguments: { name: "alpha" }, callId: "call.skill.a", toolName: "skill" },
          { arguments: { name: "alpha" }, callId: "call.skill.b", toolName: "skill" }
        ]),
        complete()
      ],
      skillProvider: provider,
      toolCatalog: runtime,
      toolExecutor: runtime
    });

    await harness.loop.run({
      availableTools: [attemptCompleteTool, skillToolDefinition],
      session: harness.session,
      userMessages: [userMessage("Do the alpha task.")]
    });

    const toolMessages = (await harness.store.getSessionSnapshot(harness.session.id))!.messages.filter(
      (message) => message.role === "tool"
    );
    expect(toolMessages.filter((message) => textOf(message).includes("<skill_content"))).toHaveLength(1);
    expect(textOf(toolMessages[1]!)).toContain("already loaded");
  });

  test("a skill loaded in a turn that pauses for approval stays recorded", async () => {
    // The turn returned to wait for the approval before the load was
    // recorded: a later load added the whole text again, and compaction
    // dropped the skill instead of restating it.
    const provider = fixedProvider([skill("alpha")]);
    const deploy = toolDefinition("deploy", { approvalMode: "always" });
    const runtime = new ToolRuntime({
      registry: new ToolRegistryBuilder()
        .register(createSkillTool({ skills: provider }))
        .register({ definition: deploy, execute: async () => ({ result: "deployed" }) })
        .build()
    });
    const harness = await createHarness({
      responses: [
        response([
          { arguments: { name: "alpha" }, callId: "call.skill.a", toolName: "skill" },
          { arguments: {}, callId: "call.deploy.a", toolName: "deploy" }
        ])
      ],
      skillProvider: provider,
      toolCatalog: runtime,
      toolExecutor: runtime
    });

    const result = await harness.loop.run({
      availableTools: [attemptCompleteTool, skillToolDefinition, deploy],
      session: harness.session,
      userMessages: [userMessage("Load alpha, then deploy.")]
    });

    expect(result.stopReason).toBe("awaiting_approval");
    expect(readSkillActivations(result.session.metadata).map((activation) => activation.name)).toEqual(["alpha"]);
    const stored = await harness.store.getSessionSnapshot(harness.session.id);
    expect(readSkillActivations(stored!.session.metadata).map((activation) => activation.name)).toEqual(["alpha"]);
  });

  test("after compaction folds a loaded skill away, the prompt restates it under Active Skills", async () => {
    const executed: string[] = [];
    const harness = await createHarness({
      autoCompactThresholdTokens: 1,
      memoryLifecycle: {
        async compactSession() {
          // The summary itself does not matter here, only the watermark.
        },
        async initializeSessionMemory() {
          // no-op
        }
      },
      responses: [callTool("read_file", { path: "a.txt" }, "call.read.1"), complete()],
      skills: [skill("alpha")],
      toolExecutor: {
        async execute(call: ToolCallRecord): Promise<AgentLoopToolExecutionResult> {
          executed.push(call.toolName);
          return {
            toolCall: { ...call, completedAt: new Date().toISOString(), result: "contents", status: "succeeded" }
          };
        }
      }
    });

    const result = await harness.loop.run({
      availableTools: [attemptCompleteTool, readFileTool],
      maxTurns: 3,
      session: harness.session,
      userMessages: [userMessage("Follow $alpha.")]
    });

    expect(executed).toEqual(["read_file"]);
    expect(typeof result.session.metadata[COMPACTION_WATERMARK_METADATA_KEY]).toBe("string");
    const [beforeCompaction, afterCompaction] = harness.model.requests;
    expect(beforeCompaction!.instructions).not.toContain("Active Skills");
    expect(beforeCompaction!.messages.some((message) => message.tags.includes("skill"))).toBe(true);
    // The skill message is behind the watermark now, so it is no longer
    // replayed; its instructions live in the system prompt instead.
    expect(afterCompaction!.messages.some((message) => message.tags.includes("skill"))).toBe(false);
    expect(afterCompaction!.instructions).toContain("Active Skills");
    expect(afterCompaction!.instructions).toContain('<skill_content name="alpha">\nalpha instructions');
    expect(result.session.metadata[SKILL_ACTIVATIONS_METADATA_KEY]).toHaveLength(1);
  });
});

function skill(name: string, overrides: Partial<SkillRecord> = {}): SkillRecord {
  return {
    allowedTools: [],
    body: `${name} instructions`,
    description: `${name} description`,
    directory: `/skills/${name}`,
    disableModelInvocation: false,
    enabled: true,
    filePath: `/skills/${name}/SKILL.md`,
    metadata: {},
    name,
    scope: "project",
    ...overrides
  };
}

function fixedProvider(skills: SkillRecord[]): SkillProvider {
  return {
    discover: async () => ({ diagnostics: [], skills }),
    settings: DEFAULT_SKILLS_SETTINGS
  };
}

async function createHarness(params: {
  autoCompactThresholdTokens?: number;
  memoryLifecycle?: ConstructorParameters<typeof AgentLoop>[0]["memoryLifecycle"];
  responses: LanguageModelResponse[];
  skillProvider?: SkillProvider;
  skills?: SkillRecord[];
  toolCatalog?: { getDefinition(toolName: string): ToolDefinition | null };
  toolExecutor?: ConstructorParameters<typeof AgentLoop>[0]["toolExecutor"];
}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-loop-skills-"));
  tempRoots.push(root);
  const store = new FileSessionStore(path.join(root, ".aia"));
  const session = buildSession(root);
  await store.saveSession(session);
  const model = new ScriptedModel(params.responses);
  const loop = new AgentLoop({
    ...(params.autoCompactThresholdTokens !== undefined
      ? { autoCompactThresholdTokens: params.autoCompactThresholdTokens }
      : {}),
    ...(params.memoryLifecycle ? { memoryLifecycle: params.memoryLifecycle } : {}),
    model,
    sessions: store,
    skills: params.skillProvider ?? fixedProvider(params.skills ?? []),
    ...(params.toolCatalog ? { toolCatalog: params.toolCatalog } : {}),
    ...(params.toolExecutor ? { toolExecutor: params.toolExecutor } : {}),
    userHomeDirectory: root
  });
  return { loop, model, session, store };
}

type LoopRequest = Omit<LanguageModelRequest, "modelId" | "provider">;

class ScriptedModel implements AgentLoopModel {
  readonly requests: LoopRequest[] = [];

  constructor(private readonly responses: LanguageModelResponse[]) {}

  async generate(request: LoopRequest): Promise<LanguageModelResponse> {
    this.requests.push(structuredClone(request));
    const response = this.responses[this.requests.length - 1];
    if (!response) {
      throw new Error(`Unexpected model turn ${this.requests.length}.`);
    }
    return response;
  }
}

function buildSession(cwd: string): SessionRecord {
  const now = "2026-09-30T12:00:00.000Z";
  return {
    createdAt: now,
    cwd,
    goal: "Use skills.",
    id: "session.skills.1",
    lastActiveAt: now,
    metadata: {},
    status: "idle",
    tags: [],
    title: "Skills Session",
    updatedAt: now
  };
}

function userMessage(text: string, id = "message.user.1"): Message {
  return {
    createdAt: new Date().toISOString(),
    id,
    metadata: {},
    parts: [{ kind: "text", text }],
    role: "user",
    sessionId: "session.skills.1",
    source: "user",
    tags: [],
    visibility: "default"
  };
}

function textOf(message: Message): string {
  return message.parts.map((part) => (part.kind === "text" ? part.text : "")).join("");
}

let responseCounter = 0;

function response(toolCalls: LanguageModelResponse["toolCalls"]): LanguageModelResponse {
  responseCounter += 1;
  return {
    id: `response.skills.${responseCounter}`,
    message: {
      createdAt: new Date().toISOString(),
      id: `message.assistant.skills.${responseCounter}`,
      metadata: {},
      parts: [],
      role: "assistant",
      sessionId: "session.skills.1",
      source: "assistant",
      tags: [],
      visibility: "default"
    },
    metadata: {},
    modelId: "test-model",
    provider: "lm_studio",
    stopReason: "tool_calls",
    toolCalls,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
  };
}

function complete(): LanguageModelResponse {
  return response([
    {
      arguments: { status: "success", summary: "Done." },
      callId: `call.complete.${responseCounter}`,
      toolName: "attempt_complete"
    }
  ]);
}

function callTool(toolName: string, args: Record<string, string>, callId: string): LanguageModelResponse {
  return response([{ arguments: args, callId, toolName }]);
}

function toolDefinition(name: string, overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    aliases: [],
    annotations: { meta: {}, readOnlyHint: true, title: name },
    approvalMode: "never",
    descriptor: {
      examples: [],
      purpose: name,
      whenNotToUse: [],
      whenToUse: []
    },
    description: name,
    displayName: name,
    execution: { inputMode: "json", resumable: false, taskSupport: "forbidden" },
    idempotent: true,
    inputSchema: { type: "object" },
    invocationName: name,
    kind: "built_in",
    metadata: {},
    name,
    outputKind: "json",
    retryable: false,
    searchTags: [],
    sideEffects: ["none"],
    source: { displayName: "Test", kind: "built_in" },
    streamingMode: "none",
    toolId: `tool.test.${name}`,
    usageGuidance: name,
    version: "1.0.0",
    ...overrides
  };
}

const attemptCompleteTool = toolDefinition("attempt_complete");
const readFileTool = toolDefinition("read_file", { sideEffects: ["workspace_read"] });
