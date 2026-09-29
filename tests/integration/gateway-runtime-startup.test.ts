import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { loadAIAgentConfig, MCPManager, StateRootUnavailableError } from "@/core";
import { createGatewayRuntimeFromLoadedConfig, GatewayRuntime } from "@/gateway";

const STDIO_FIXTURE = path.resolve("tests/fixtures/mcp/stdio-server.mjs");
const roots: string[] = [];
const unwritableTest = process.getuid?.() === 0 ? test.skip : test;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await fs.chmod(root, 0o755).catch(() => undefined);
    await fs.rm(root, { force: true, recursive: true });
  }
});

async function workspaceWithConfig(config: Record<string, unknown>): Promise<{ home: string; workspace: string }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-runtime-startup-")));
  roots.push(root);
  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(path.join(home, ".aia"), { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(workspace, "aia.config.jsonc"),
    JSON.stringify({ configVersion: 1, memory: { embeddingsEnabled: false }, ...config }),
    "utf8"
  );
  return { home, workspace };
}

const stdioServer = {
  args: [STDIO_FIXTURE],
  command: process.execPath,
  enabled: true,
  env: {},
  required: false,
  tags: [],
  type: "stdio"
};

async function build(workspace: string, home: string) {
  const loaded = await loadAIAgentConfig({ cwd: workspace, env: {}, userHomeDirectory: home });
  return createGatewayRuntimeFromLoadedConfig({ cwd: workspace, loaded, userHomeDirectory: home });
}

// Each of these used to leave a spawned stdio MCP server running after the
// factory threw, so the caller printed the error and the process never exited.
describe("gateway runtime startup failures", () => {
  test("closes the MCP servers it started when a required server fails", async () => {
    const { home, workspace } = await workspaceWithConfig({
      mcp: {
        servers: {
          docs: stdioServer,
          needed: {
            enabled: true,
            headers: {},
            required: true,
            tags: [],
            type: "streamable-http",
            url: "http://127.0.0.1:9/mcp"
          }
        }
      }
    });
    const close = vi.spyOn(MCPManager.prototype, "close");

    await expect(build(workspace, home)).rejects.toThrow(/Required MCP servers failed to connect/u);
    expect(close).toHaveBeenCalled();
  });

  test("closes the whole runtime when initialize fails on a corrupt events log", async () => {
    const { home, workspace } = await workspaceWithConfig({ mcp: { servers: { docs: stdioServer } } });
    await fs.mkdir(path.join(workspace, ".aia", "gateway"), { recursive: true });
    await fs.writeFile(path.join(workspace, ".aia", "gateway", "events.jsonl"), "{not json\n", "utf8");
    const runtimeClose = vi.spyOn(GatewayRuntime.prototype, "close");
    const mcpClose = vi.spyOn(MCPManager.prototype, "close");

    await expect(build(workspace, home)).rejects.toThrow();
    expect(runtimeClose).toHaveBeenCalled();
    expect(mcpClose).toHaveBeenCalled();
  });

  unwritableTest("refuses before starting any MCP server when the state root is unwritable", async () => {
    const { home, workspace } = await workspaceWithConfig({ mcp: { servers: { docs: stdioServer } } });
    await fs.chmod(workspace, 0o555);
    roots.unshift(workspace);
    const initialize = vi.spyOn(MCPManager.prototype, "initialize");

    const failure = await build(workspace, home).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StateRootUnavailableError);
    expect((failure as Error).message).toContain(`${workspace}/.aia`);
    expect(initialize).not.toHaveBeenCalled();
  });
});
