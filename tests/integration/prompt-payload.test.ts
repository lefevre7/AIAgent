import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  buildPromptPack,
  CommandRuntime,
  createDefaultToolRegistry,
  LEAN_TOOL_PROFILE_INVOCATION_NAMES,
  resolveVisibleToolDefinitions,
  WorkspaceMutationEngine
} from "@/core";
import type { BrowserAutomationService, ChannelService, ExternalAgentService, ImageService } from "@/core";
import { serializeToolDefinitions } from "@/core/lm/shared";

// Regression budget for the harness weight sent to small local models. If one
// of these assertions starts failing, a tool or prompt change re-bloated the
// model-visible payload — shrink it or consciously raise the budget here.
const MAX_LEAN_TOOL_COUNT = 20;
const MAX_LEAN_TOOLS_JSON_CHARS = 40_000;
const MAX_BASE_SYSTEM_PROMPT_CHARS = 8_000;

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

describe("model-visible payload budget", () => {
  test("the lean tool profile stays within the small-model budget", async () => {
    const root = await createTempRoot();
    const registry = buildFullRegistry(root);

    const leanTools = resolveVisibleToolDefinitions({
      registry,
      toolsConfig: { exclude: [], include: [], profile: "lean" }
    });

    expect(leanTools.length).toBeGreaterThan(0);
    expect(leanTools.length).toBeLessThanOrEqual(MAX_LEAN_TOOL_COUNT);

    const allNames = new Set(registry.listDefinitions().map((definition) => definition.invocationName));
    for (const name of LEAN_TOOL_PROFILE_INVOCATION_NAMES) {
      // Guard against typos in the lean list: every lean name that the default
      // registry can provide must resolve to a registered tool. (web_search and
      // other service-dependent tools are absent here because no MCP manager is
      // wired in this fixture.)
      if (allNames.has(name)) {
        expect(leanTools.some((definition) => definition.invocationName === name)).toBe(true);
      }
    }

    const toolsJson = JSON.stringify(serializeToolDefinitions(leanTools));
    expect(toolsJson.length).toBeLessThanOrEqual(MAX_LEAN_TOOLS_JSON_CHARS);
  });

  test("the full profile exposes strictly more tools than lean", async () => {
    const root = await createTempRoot();
    const registry = buildFullRegistry(root);

    const lean = resolveVisibleToolDefinitions({
      registry,
      toolsConfig: { exclude: [], include: [], profile: "lean" }
    });
    const full = resolveVisibleToolDefinitions({
      registry,
      toolsConfig: { exclude: [], include: [], profile: "full" }
    });

    expect(full.length).toBeGreaterThan(lean.length);
  });

  test("include and exclude adjust the visible set", async () => {
    const root = await createTempRoot();
    const registry = buildFullRegistry(root);

    const withInclude = resolveVisibleToolDefinitions({
      registry,
      toolsConfig: { exclude: [], include: ["view_image"], profile: "lean" }
    });
    expect(withInclude.some((definition) => definition.invocationName === "view_image")).toBe(true);

    const withExclude = resolveVisibleToolDefinitions({
      registry,
      toolsConfig: { exclude: ["web_fetch"], include: [], profile: "lean" }
    });
    expect(withExclude.some((definition) => definition.invocationName === "web_fetch")).toBe(false);
  });

  test("the base system prompt stays small without instruction documents", async () => {
    const root = await createTempRoot();
    const registry = buildFullRegistry(root);
    const leanTools = resolveVisibleToolDefinitions({
      registry,
      toolsConfig: { exclude: [], include: [], profile: "lean" }
    });

    const workspace = path.join(root, "empty-workspace");
    await fs.mkdir(path.join(workspace, ".git"), { recursive: true });

    const pack = await buildPromptPack({
      availableTools: leanTools,
      cwd: workspace,
      userHomeDirectory: path.join(root, "empty-home")
    });

    expect(pack.systemPrompt.length).toBeLessThanOrEqual(MAX_BASE_SYSTEM_PROMPT_CHARS);
    // The per-tool catalog must not be duplicated into the system prompt; the
    // provider tools array is the single source of tool descriptions.
    expect(pack.systemPrompt).not.toContain("Usage guidance:");
  });
});

function buildFullRegistry(root: string) {
  const stub = {} as never;
  return createDefaultToolRegistry({
    browserService: stub as BrowserAutomationService,
    channelService: stub as ChannelService,
    commandRuntime: new CommandRuntime({ baseDirectory: root, stateRoot: path.join(root, ".aia") }),
    externalAgentService: stub as ExternalAgentService,
    imageService: stub as ImageService,
    workspaceEngine: new WorkspaceMutationEngine({
      allowArbitraryPaths: true,
      stateRoot: path.join(root, ".aia"),
      workspaceRoot: root
    })
  });
}

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-payload-"));
  tempRoots.push(root);
  return root;
}
