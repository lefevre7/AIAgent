import path from "node:path";

import { describe, expect } from "vitest";

import { MCPManager, createDefaultAppConfig } from "@/core";
import { createLiveTestHarness, envFlag, readJsonEnv } from "./helpers";

type LiveMcpConfig = {
  servers?: ReturnType<typeof createDefaultAppConfig>["mcp"]["servers"];
  templates?: ReturnType<typeof createDefaultAppConfig>["mcp"]["templates"];
};

const liveMcpConfig = readJsonEnv<LiveMcpConfig>("AIA_LIVE_MCP_CONFIG_JSON");
const { createTempRoot, liveTest } = createLiveTestHarness({
  enabled: envFlag("AIA_RUN_LIVE_MCP_TESTS") && Boolean(liveMcpConfig?.servers),
  prefix: "aiagent-live-mcp-"
});

describe("MCP manager (live)", () => {
  liveTest("connects to the configured live MCP server set", async () => {
    const root = await createTempRoot();
    const config = createDefaultAppConfig({
      userStateDirectory: path.join(root, "home", ".aia")
    });
    config.mcp.servers = liveMcpConfig?.servers ?? {};
    config.mcp.templates = liveMcpConfig?.templates ?? {};

    const manager = new MCPManager({
      config,
      watch: false
    });
    await manager.initialize();

    try {
      const statuses = manager.getServerStatuses();
      expect(statuses.some((status) => status.state === "connected")).toBe(true);
      expect(manager.getCatalog().list().length).toBeGreaterThan(0);

      const requestedServerName = process.env.AIA_LIVE_MCP_SERVER_NAME;
      const requestedToolName = process.env.AIA_LIVE_MCP_TOOL_NAME;
      if (requestedServerName && requestedToolName) {
        const toolArgs = readJsonEnv<Record<string, unknown>>("AIA_LIVE_MCP_TOOL_ARGS_JSON") ?? {};
        const toolResult = await manager.callTool(requestedServerName, requestedToolName, toolArgs);
        expect(toolResult.isError).not.toBe(true);
      }
    } finally {
      await manager.close();
    }
  });
});
