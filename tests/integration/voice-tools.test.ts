import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import {
  ToolRuntime,
  createDefaultToolRegistry,
  sessionRecordSchema,
  toolCallRecordSchema,
  turnRecordSchema,
  type ProviderHealth,
  type VoiceService
} from "@/core";

const voiceTempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(voiceTempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("voice tools", () => {
  test("registers the built-in voice tools when a voice service is present", () => {
    const registry = createDefaultToolRegistry({
      voiceService: fakeVoiceService()
    });

    const matches = registry.searchDefinitions({
      kinds: ["voice"],
      limit: 20,
      query: "speech"
    });

    expect(matches.some((match) => match.definition.invocationName === "voice_list_voices")).toBe(true);
    expect(registry.getDefinition("voice_synthesize_text")?.kind).toBe("voice");
  });

  test("routes synthesis through the runtime and surfaces audio parts", async () => {
    const runtime = new ToolRuntime({
      approvalDecider: async () => ({
        mode: "execute"
      }),
      registry: createDefaultToolRegistry({
        voiceService: fakeVoiceService()
      })
    });

    const result = await runtime.execute(
      createCall({
        arguments: {
          text: "Hello from the runtime",
          voice: "Allison"
        },
        id: "tool-call.voice.tools.synthesize",
        toolName: "voice_synthesize_text"
      }),
      {
        session: buildSession(),
        turn: buildTurn()
      }
    );

    expect(result.toolCall.status).toBe("succeeded");
    expect(result.resultMessage?.parts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "audio",
          transcript: "Hello from the runtime",
          voice: "Allison"
        })
      ])
    );
  });

  test("keeps synthesis approval on the generic tool target instead of voice_action", async () => {
    const runtime = new ToolRuntime({
      registry: createDefaultToolRegistry({
        voiceService: fakeVoiceService()
      })
    });

    const result = await runtime.execute(
      createCall({
        arguments: {
          text: "Needs approval"
        },
        id: "tool-call.voice.tools.approval",
        toolName: "voice_synthesize_text"
      }),
      {
        session: buildSession(),
        turn: buildTurn()
      }
    );

    expect(result.toolCall.status).toBe("awaiting_approval");
    expect(result.approvalRequest?.target.kind).toBe("tool");
  });
});

function buildSession() {
  return sessionRecordSchema.parse({
    createdAt: "2026-03-31T12:00:00.000Z",
    cwd: "/workspace",
    goal: "Exercise voice tools",
    id: "session.voice.tools.1",
    lastActiveAt: "2026-03-31T12:00:00.000Z",
    metadata: {},
    status: "running_model",
    tags: [],
    title: "Voice Tool Session",
    updatedAt: "2026-03-31T12:00:00.000Z"
  });
}

function buildTurn() {
  return turnRecordSchema.parse({
    approvalRequestIds: [],
    executedToolCallIds: [],
    id: "turn.voice.tools.1",
    inputMessageIds: [],
    metadata: {},
    outputMessageIds: [],
    requestedToolCallIds: [],
    sequence: 0,
    sessionId: "session.voice.tools.1",
    startedAt: "2026-03-31T12:00:00.000Z",
    status: "running",
    trigger: "user"
  });
}

function createCall(overrides: Partial<Parameters<typeof toolCallRecordSchema.parse>[0]> = {}) {
  return toolCallRecordSchema.parse({
    arguments: {},
    id: "tool-call.voice.tools.default",
    metadata: {},
    sessionId: "session.voice.tools.1",
    startedAt: "2026-03-31T12:00:00.000Z",
    status: "pending",
    toolName: "voice_list_voices",
    turnId: "turn.voice.tools.1",
    ...overrides
  });
}

function fakeVoiceService(): VoiceService {
  const health: ProviderHealth = {
    checkedAt: "2026-03-31T12:00:00.000Z",
    details: {},
    providerId: "local_system",
    status: "healthy"
  };

  return {
    dispose: async () => undefined,
    getCapture: async () => null,
    listDevices: async () => [],
    listProviderHealth: async () => [health],
    listVoices: async () => [
      {
        default: true,
        displayName: "Allison",
        id: "Allison",
        locale: "en-US",
        metadata: {},
        providerId: "local_system"
      }
    ],
    playback: async () => {
      throw new Error("playback not used in this test");
    },
    startCapture: async () => {
      throw new Error("capture not used in this test");
    },
    stopCapture: async () => {
      throw new Error("capture not used in this test");
    },
    synthesize: async (request) => ({
      audio: {
        id: "artifact.audio.voice.tools.1",
        kind: "audio",
        mediaType: "audio/aiff",
        metadata: {
          durationMs: 1200,
          transcript: request.text,
          voice: request.voice ?? "Allison"
        },
        name: "voice-tools.aiff",
        uri: "file:///tmp/voice-tools.aiff"
      },
      completedAt: "2026-03-31T12:00:00.000Z",
      durationMs: 1200,
      id: request.id,
      metadata: request.metadata,
      providerId: request.providerId ?? "local_system"
    }),
    transcribe: async (request) => ({
      completedAt: "2026-03-31T12:00:00.000Z",
      durationMs: 1000,
      id: request.id,
      locale: request.locale,
      metadata: request.metadata,
      providerId: request.providerId ?? "apple_native",
      text: "transcribed"
    }),
    waitForCapture: async () => {
      throw new Error("capture not used in this test");
    }
  };
}

describe("voice tool execution", () => {
  function autoRuntime() {
    return new ToolRuntime({
      approvalDecider: async () => ({ mode: "execute" }),
      registry: createDefaultToolRegistry({ voiceService: fakeVoiceService() })
    });
  }

  test("lists voices as markdown through the runtime", async () => {
    const result = await autoRuntime().execute(
      createCall({ arguments: { locale: "en-US" }, id: "tool-call.voice.list", toolName: "voice_list_voices" }),
      { session: buildSession(), turn: buildTurn() }
    );
    expect(result.toolCall.status).toBe("succeeded");
    expect(JSON.stringify(result.toolCall.result)).toContain("Allison");
  });

  test("transcribes an audio artifact from a file uri", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-voice-tool-"));
    voiceTempRoots.push(root);
    const clip = path.join(root, "clip.wav");
    await fs.writeFile(clip, Buffer.from("RIFF-fake-wav"));

    const result = await autoRuntime().execute(
      createCall({
        arguments: { locale: "en-US", uri: pathToFileURL(clip).href },
        id: "tool-call.voice.transcribe",
        toolName: "voice_transcribe_audio"
      }),
      { session: buildSession(), turn: buildTurn() }
    );
    expect(result.toolCall.status).toBe("succeeded");
    expect(JSON.stringify(result.toolCall.result)).toContain("transcribed");
  });
});
