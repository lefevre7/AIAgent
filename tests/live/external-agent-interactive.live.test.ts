import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect } from "vitest";

import type { ExternalAgentConfig } from "@/core/config";
import { DEFAULT_APP_CONFIG, externalAgentConfigSchema } from "@/core/config";
import { FileExternalAgentSessionService } from "@/core/external-agents/sessions";
import { createLiveTestHarness, envFlag } from "./helpers";

/**
 * Drives a real external agent CLI as an interactive terminal session.
 *
 * Opt in with AIA_LIVE_EXTERNAL_AGENT_INTERACTIVE=1. Point
 * AIA_LIVE_EXTERNAL_AGENT_COMMAND at the CLI (default: `codex`) and
 * AIA_LIVE_EXTERNAL_AGENT_READY at a regex matching its prompt.
 *
 * This is opt-in because it launches a real coding agent with its approval
 * bypass flags, which can modify files in the temporary workspace.
 */
const harness = createLiveTestHarness({
  enabled: envFlag("AIA_LIVE_EXTERNAL_AGENT_INTERACTIVE"),
  prefix: "aiagent-live-ext-session-"
});

describe("interactive external agent (live)", () => {
  harness.liveTest("starts a real agent CLI, sends a turn, and reads the screen", async () => {
    const root = await harness.createTempRoot();
    const command = process.env.AIA_LIVE_EXTERNAL_AGENT_COMMAND ?? "codex";
    const readyPattern = process.env.AIA_LIVE_EXTERNAL_AGENT_READY;
    const preset = command.includes("claude") ? "claude" : "codex";

    // Codex asks whether to trust every new folder, and this test starts in a
    // new one each run, so it trusts the folder it just created, for this run
    // only: a `-c` override is not saved to the Codex config. Codex resolves
    // the working directory to its real path, and it splits `-c` keys on
    // dots, so the path goes in an inline table rather than a dotted key.
    const trustThisFolder =
      preset === "codex" ? ["-c", `projects={${JSON.stringify(await fs.realpath(root))}={trust_level="trusted"}}`] : [];

    // Start from the shipped preset so this exercises the configuration that
    // actually ships, including its approval-bypass and inline-mode flags.
    const shipped = DEFAULT_APP_CONFIG.externalAgents.agents[preset];
    const agent: ExternalAgentConfig = externalAgentConfigSchema.parse({
      ...shipped,
      command,
      interactive: {
        ...shipped.interactive,
        args: [...(shipped.interactive?.args ?? []), ...trustThisFolder],
        idleMs: 4_000,
        ...(readyPattern ? { readyPattern } : {}),
        stabilityMs: 2_000,
        turnTimeoutMs: 120_000
      }
    });

    const service = new FileExternalAgentSessionService({
      agents: { live: agent },
      defaultCwd: root,
      stateRoot: path.join(root, "external-agents"),
      turnTimeoutMs: 120_000
    });

    try {
      const record = await service.startSession({ agentId: "live" });
      expect(record.status).toBe("running");
      // A real agent CLI must get a PTY: without one it detects a pipe and
      // refuses to render its TUI at all.
      expect(record.pty).toBe(true);

      // Read before writing. A CLI can open on a screen that needs a person (an
      // update offer, a folder-trust question), and text sent to it picks one
      // of its options: this test once accepted Codex's "Update now" and
      // started `brew upgrade`. The service refuses such a send; this shows
      // the screen that made it refuse.
      const opening = await service.readSession({ externalSessionId: record.id, includeScrollback: false });
      const turn = await service
        .sendToSession({
          externalSessionId: record.id,
          noWait: false,
          text: "Reply with the single word READY and nothing else."
        })
        .catch((error: unknown) => {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n\nThe agent opened on:\n${opening.screen}\n\n"${command}" is asking a person something, so nothing was sent.`
          );
        });

      expect(turn.screen.length).toBeGreaterThan(0);
      expect(turn.record.turnCount).toBe(1);
    } finally {
      await service.shutdown();
    }
  });
});
