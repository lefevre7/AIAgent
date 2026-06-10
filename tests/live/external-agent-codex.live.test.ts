import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect } from "vitest";

import { FileExternalAgentService } from "@/core";
import { createLiveTestHarness, envFlag } from "./helpers";

const { createTempRoot, liveTest } = createLiveTestHarness({
  enabled: envFlag("AIA_RUN_LIVE_CODEX_TEST") || envFlag("AIA_RUN_LIVE_EXTERNAL_AGENT_TESTS"),
  prefix: "aiagent-live-codex-"
});

describe("external-agent service (live Codex)", () => {
  liveTest("runs a real blocking Codex job through the external-agent adapter", async () => {
    const root = await createTempRoot();

    const service = new FileExternalAgentService({
      agents: {
        codex: {
          args: [],
          command: "codex",
          displayName: "Codex CLI",
          enabled: true,
          env: {},
          instructionMode: "arg",
          jsonFlag: "--json",
          kind: "codex",
          outputLastMessageFlag: "--output-last-message",
          passEnv: ["CODEX_API_KEY", "OPENAI_API_KEY"],
          resumeSubcommand: ["exec", "resume"],
          schemaFlag: "--output-schema",
          skipGitRepoCheck: true,
          skipGitRepoCheckFlag: "--skip-git-repo-check"
        }
      },
      stateRoot: path.join(root, ".aia", "external-agents")
    });

    const job = await service.run({
      agentId: "codex",
      args: [],
      cwd: root,
      id: "external-job.live.codex",
      instructions: "Reply with exactly LIVE_EXTERNAL_AGENT_OK and nothing else.",
      metadata: {},
      mode: "blocking"
    });

    expect(job.status).toBe("succeeded");
    expect(job.summary).toContain("LIVE_EXTERNAL_AGENT_OK");
    expect(job.resultArtifact?.uri).toBeTruthy();
    if (!job.resultArtifact?.uri) {
      throw new Error("Expected a persisted live Codex result artifact.");
    }
    await expect(fs.readFile(new URL(job.resultArtifact.uri), "utf8")).resolves.toContain("LIVE_EXTERNAL_AGENT_OK");
  });
});
