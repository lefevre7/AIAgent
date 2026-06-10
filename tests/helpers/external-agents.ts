import path from "node:path";
import process from "node:process";

import { sessionRecordSchema, type ExternalAgentConfig } from "@/core";

export const mockExternalAgentFixturePath = path.resolve(
  process.cwd(),
  "tests/fixtures/external-agents/mock-external-agent-cli.mjs"
);

export function createMockCodexConfig(overrides: Partial<ExternalAgentConfig> = {}): ExternalAgentConfig {
  return {
    args: [mockExternalAgentFixturePath, "codex"],
    command: process.execPath,
    displayName: "Mock Codex CLI",
    enabled: true,
    env: {},
    instructionMode: "arg",
    jsonFlag: "--json",
    kind: "codex",
    outputLastMessageFlag: "--output-last-message",
    passEnv: [],
    resumeSubcommand: ["exec", "resume"],
    schemaFlag: "--output-schema",
    skipGitRepoCheck: false,
    skipGitRepoCheckFlag: "--skip-git-repo-check",
    ...overrides
  } as ExternalAgentConfig;
}

export function createMockMistralVibeConfig(overrides: Partial<ExternalAgentConfig> = {}): ExternalAgentConfig {
  return {
    args: [mockExternalAgentFixturePath, "vibe"],
    command: process.execPath,
    displayName: "Mock Mistral Vibe CLI",
    enabled: true,
    env: {},
    instructionMode: "arg",
    kind: "mistral_vibe",
    outputFlag: "--output",
    outputJsonValue: "json",
    passEnv: [],
    promptFlag: "--prompt",
    resumeFlag: "--resume",
    workdirFlag: "--workdir",
    ...overrides
  } as ExternalAgentConfig;
}

export function buildExternalAgentSession(params: { cwd: string; id?: string }) {
  const sessionId = params.id ?? "session.external-agent.1";
  const timestamp = "2026-03-31T12:00:00.000Z";
  return sessionRecordSchema.parse({
    createdAt: timestamp,
    cwd: params.cwd,
    goal: "Exercise external-agent integration tests",
    id: sessionId,
    lastActiveAt: timestamp,
    metadata: {},
    status: "running_model",
    tags: ["external-agent"],
    title: "External Agent Test Session",
    updatedAt: timestamp
  });
}
