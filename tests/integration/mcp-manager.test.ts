import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import type { AddressInfo } from "node:net";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { afterEach, describe, expect, test } from "vitest";

import {
  DEFAULT_APPROVAL_SETTINGS,
  MCPManager,
  ToolRuntime,
  createDefaultAppConfig,
  createDefaultToolRegistry,
  createDefaultToolRuntime,
  createMcpManagerFromLoadedConfig,
  createToolApprovalDecider,
  fingerprintWorkspaceConfigFile,
  grantConfigTrust,
  loadAIAgentConfig,
  sanitizeMcpInvocationName,
  sessionRecordSchema,
  toolCallRecordSchema,
  turnRecordSchema,
  withMcpTrustRules,
  type ConnectMcpClientParams,
  type McpConnection
} from "@/core";

const tempRoots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];
const STDIO_FIXTURE_PATH = path.resolve("tests/fixtures/mcp/stdio-server.mjs");
const TOOLS_ONLY_FIXTURE_PATH = path.resolve("tests/fixtures/mcp/stdio-tools-only-server.mjs");
const FLAKY_FIXTURE_PATH = path.resolve("tests/fixtures/mcp/stdio-flaky-server.mjs");
const CAN_BIND_LOOPBACK = await canBindLoopback();
const httpTransportTest = CAN_BIND_LOOPBACK ? test : test.skip;

// The workspace configs these tests write are the operator's own, so they are
// trusted the way the operator would trust them (security review M11 withholds
// an untrusted workspace's MCP entries).
async function trustWorkspaceConfig(home: string, workspace: string): Promise<void> {
  const fingerprint = await fingerprintWorkspaceConfigFile(path.join(workspace, "aia.config.jsonc"));
  if (!fingerprint) {
    throw new Error(`No workspace config to trust in ${workspace}.`);
  }
  await grantConfigTrust(path.join(home, ".aia"), fingerprint);
}

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

describe("MCP manager", () => {
  test("connects to a stdio server and exposes tools, resources, prompts, and templates", async () => {
    const config = createDefaultAppConfig({
      userStateDirectory: path.join(await createTempRoot(), "home", ".aia")
    });
    config.mcp.servers.docs = {
      args: [STDIO_FIXTURE_PATH],
      command: process.execPath,
      description: "Fixture stdio docs server",
      enabled: true,
      env: {},
      required: true,
      stderr: "pipe",
      tags: ["docs", "fixture"],
      type: "stdio"
    };

    const manager = new MCPManager({
      config,
      watch: false
    });
    cleanups.push(() => manager.close());

    await manager.initialize();

    const status = manager.getServerStatuses().find((entry) => entry.serverName === "docs");
    expect(status?.state).toBe("connected");
    expect(status?.capabilities).toMatchObject({
      prompts: 1,
      resourceTemplates: 1,
      resources: 1,
      tools: 1
    });

    const invocationName = sanitizeMcpInvocationName("docs", "docs.lookup");
    const toolCapability = manager
      .getToolCapabilities()
      .find((capability) => capability.invocationName === invocationName);
    expect(toolCapability?.rawName).toBe("docs.lookup");
    expect(toolCapability?.annotations.readOnlyHint).toBe(true);

    const toolResult = await manager.callTool("docs", invocationName, {
      topic: "mcp"
    });
    expect(toolResult.structuredContent).toMatchObject({
      summary: "Documentation for mcp",
      topic: "mcp"
    });

    // callTool also accepts the raw server-side tool name (not just the
    // sanitized invocation name), routing it through unchanged.
    const rawNameResult = await manager.callTool("docs", "docs.lookup", {
      topic: "raw"
    });
    expect(rawNameResult.structuredContent).toMatchObject({
      summary: "Documentation for raw",
      topic: "raw"
    });

    const fixedResource = await manager.readResource("docs", "file:///docs/guide.md");
    expect(fixedResource.contents[0]).toMatchObject({
      text: "# Guide\nStatic guide content.\n",
      uri: "file:///docs/guide.md"
    });

    const templatedResource = await manager.readResourceTemplate("docs", "file:///docs/{name}.md", {
      name: "api"
    });
    expect(templatedResource.uri).toBe("file:///docs/api.md");
    expect(templatedResource.contents[0]).toMatchObject({
      text: "# api\nDynamic content for api.\n"
    });

    const prompt = await manager.getPrompt("docs", "summarize_doc", {
      topic: "MCP"
    });
    expect(prompt.messages[0]).toMatchObject({
      content: {
        text: "Summarize the documentation for MCP.",
        type: "text"
      },
      role: "user"
    });

    const searchMatches = manager.searchCapabilities({
      kinds: ["tool", "resource", "resource_template", "prompt"],
      limit: 10,
      query: "docs"
    });
    expect(searchMatches.map((match) => match.capability.kind)).toEqual(
      expect.arrayContaining(["tool", "resource", "resource_template"])
    );

    // listing + health surfaces
    const docsPrompts = await manager.listPrompts("docs");
    expect((docsPrompts as Array<{ name: string }>).some((prompt) => prompt.name === "summarize_doc")).toBe(true);
    const allPrompts = (await manager.listPrompts()) as Array<{
      serverName: string;
    }>;
    expect(allPrompts.some((entry) => entry.serverName === "docs")).toBe(true);
    expect(Object.keys(manager.listTemplates()).length).toBeGreaterThan(0);
    expect(manager.getCatalog().list().length).toBeGreaterThan(0);
    const health = await manager.getHealth();
    expect(health.servers.some((server) => server.serverName === "docs")).toBe(true);
  });

  test("builds every server's status for statuses_changed and refreshed only when something listens", async () => {
    const config = createDefaultAppConfig({
      userStateDirectory: path.join(await createTempRoot(), "home", ".aia")
    });
    config.mcp.servers.docs = {
      args: [STDIO_FIXTURE_PATH],
      command: process.execPath,
      enabled: true,
      env: {},
      required: true,
      stderr: "pipe",
      tags: [],
      type: "stdio"
    };
    const manager = new MCPManager({ config, watch: false });
    cleanups.push(() => manager.close());
    let built = 0;
    const getServerStatuses = manager.getServerStatuses.bind(manager);
    manager.getServerStatuses = () => {
      built += 1;
      return getServerStatuses();
    };

    // Connecting is several transitions; each used to build every status.
    await manager.initialize();
    expect(built).toBe(0);

    const heard: string[][] = [];
    let refreshed = 0;
    manager.on("statuses_changed", ({ statuses }) => heard.push(statuses.map((status) => status.serverName)));
    manager.on("refreshed", () => {
      refreshed += 1;
    });
    await manager.refresh();
    expect(heard.at(-1)).toEqual(["docs"]);
    expect(refreshed).toBe(1);
  });

  test("records an error status when a server fails to connect", async () => {
    const config = createDefaultAppConfig({
      userStateDirectory: path.join(await createTempRoot(), "home", ".aia")
    });
    config.mcp.servers.broken = {
      args: ["/nonexistent/script.mjs"],
      command: "/nonexistent/aiagent-mcp-binary",
      description: "Intentionally broken stdio server",
      enabled: true,
      env: {},
      required: false,
      stderr: "pipe",
      tags: ["broken"],
      type: "stdio"
    };

    const manager = new MCPManager({ config, watch: false });
    cleanups.push(() => manager.close());
    await manager.initialize();

    const status = manager.getServerStatuses().find((entry) => entry.serverName === "broken");
    expect(status?.state).toBe("failed");
    expect(status?.error).toBeTruthy();
  });

  test("records a disabled status for servers that are turned off", async () => {
    const config = createDefaultAppConfig({
      userStateDirectory: path.join(await createTempRoot(), "home", ".aia")
    });
    config.mcp.servers.dormant = {
      args: [STDIO_FIXTURE_PATH],
      command: process.execPath,
      description: "Disabled stdio server",
      enabled: false,
      env: {},
      required: false,
      stderr: "pipe",
      tags: ["dormant"],
      type: "stdio"
    };

    const manager = new MCPManager({ config, watch: false });
    cleanups.push(() => manager.close());
    await manager.initialize();

    const status = manager.getServerStatuses().find((entry) => entry.serverName === "dormant");
    expect(status?.state).toBe("disabled");
    expect(status?.capabilities.tools).toBe(0);
  });

  test("throws when a required server cannot connect", async () => {
    const config = createDefaultAppConfig({
      userStateDirectory: path.join(await createTempRoot(), "home", ".aia")
    });
    config.mcp.servers.mandatory = {
      args: ["/nonexistent/script.mjs"],
      command: "/nonexistent/aiagent-mcp-binary",
      description: "Required but broken",
      enabled: true,
      env: {},
      required: true,
      stderr: "pipe",
      tags: ["required"],
      type: "stdio"
    };

    const manager = new MCPManager({ config, watch: false });
    cleanups.push(() => manager.close());
    await expect(manager.initialize()).rejects.toThrow(/Required MCP servers failed/u);

    const status = manager.getServerStatuses().find((entry) => entry.serverName === "mandatory");
    expect(status?.state).toBe("failed");
  });

  // One after another, startup took the sum of every server's handshake, so a
  // single slow or unreachable server held all the others up. Here the first
  // server cannot finish until the second has started, which only works if
  // they connect at the same time.
  test("connects every server at once instead of one after another", async () => {
    const config = createDefaultAppConfig({
      userStateDirectory: path.join(await createTempRoot(), "home", ".aia")
    });
    for (const serverName of ["first", "second"]) {
      config.mcp.servers[serverName] = {
        args: [],
        command: process.execPath,
        enabled: true,
        env: {},
        required: false,
        stderr: "pipe",
        tags: [],
        type: "stdio"
      };
    }
    const started: string[] = [];
    let markSecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    const manager = new MCPManager({
      config,
      connectClient: async ({ serverName }) => {
        started.push(serverName);
        if (serverName === "first") {
          await secondStarted;
        } else {
          markSecondStarted();
        }
        throw new Error(`${serverName} refused the connection`);
      },
      watch: false
    });
    cleanups.push(async () => {
      await manager.close();
    });

    await Promise.race([
      manager.initialize(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("servers were connected one at a time")), 5_000))
    ]);

    expect(started).toEqual(["first", "second"]);
    expect(manager.getServerStatuses().map((status) => `${status.serverName}:${status.state}`)).toEqual([
      "first:failed",
      "second:failed"
    ]);
  });

  // Each connect carries an epoch, and a reconnect, reload or close moves it
  // on. A connect that was superseded while it ran must close its client when
  // it finishes, never take over from the newer connection.
  describe("a connect that finishes after it was superseded", () => {
    async function createGatedManager() {
      const config = createDefaultAppConfig({
        userStateDirectory: path.join(await createTempRoot(), "home", ".aia")
      });
      // A short grace (0 would wait for every server), so startup returns
      // while the first connect is held.
      config.mcp.optionalStartupGraceMs = 50;
      config.mcp.servers.docs = {
        args: [],
        command: process.execPath,
        enabled: true,
        env: {},
        required: false,
        stderr: "pipe",
        tags: [],
        type: "stdio"
      };
      let releaseFirst!: () => void;
      const firstMayFinish = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const closed: string[] = [];
      let attempts = 0;
      const manager = new MCPManager({
        config,
        connectClient: async (params) => {
          attempts += 1;
          const label = attempts === 1 ? "first" : `attempt-${attempts}`;
          const connection = await connectInMemory(label, params, () => closed.push(label));
          if (label === "first") {
            await firstMayFinish;
          }
          return connection;
        },
        watch: false
      });
      cleanups.push(() => manager.close());
      await manager.initialize();
      expect(manager.getServerStatuses()[0]?.state).toBe("connecting");
      return { closed, manager, releaseFirst };
    }

    test("a reconnect meanwhile: the late client is closed and the newer one keeps serving", async () => {
      const { closed, manager, releaseFirst } = await createGatedManager();

      expect((await manager.reconnect("docs")).state).toBe("connected");
      releaseFirst();
      await waitForCondition(() => closed.includes("first"));

      expect(closed).toEqual(["first"]);
      expect(manager.getServerStatuses()[0]?.state).toBe("connected");
      expect(JSON.stringify(await manager.callTool("docs", "whoami", {}))).toContain("attempt-2");
    });

    test("a close meanwhile: the late client is closed, not left running", async () => {
      const { closed, manager, releaseFirst } = await createGatedManager();

      await manager.close();
      releaseFirst();

      await waitForCondition(() => closed.includes("first"));
      expect(closed).toEqual(["first"]);
    });
  });

  test("keeps a tools-only server connected instead of failing on missing resources/prompts", async () => {
    const config = createDefaultAppConfig({
      userStateDirectory: path.join(await createTempRoot(), "home", ".aia")
    });
    config.mcp.servers.toolsOnly = {
      args: [TOOLS_ONLY_FIXTURE_PATH],
      command: process.execPath,
      description: "Tools-only stdio server",
      enabled: true,
      env: {},
      // Required so a regression (server discarded as failed) throws here.
      required: true,
      stderr: "pipe",
      tags: ["tools-only"],
      type: "stdio"
    };

    const manager = new MCPManager({ config, watch: false });
    cleanups.push(() => manager.close());
    await manager.initialize();

    const status = manager.getServerStatuses().find((entry) => entry.serverName === "toolsOnly");
    expect(status?.state).toBe("connected");
    expect(status?.capabilities).toMatchObject({
      prompts: 0,
      resourceTemplates: 0,
      resources: 0,
      tools: 1
    });

    const echo = sanitizeMcpInvocationName("toolsOnly", "echo");
    const result = await manager.callTool("toolsOnly", echo, { text: "hi" });
    expect(result.structuredContent).toMatchObject({ echoed: "hi" });
  });

  test("rejects tool calls for unregistered and non-connected servers", async () => {
    const config = createDefaultAppConfig({
      userStateDirectory: path.join(await createTempRoot(), "home", ".aia")
    });
    config.mcp.servers.dormant = {
      args: [STDIO_FIXTURE_PATH],
      command: process.execPath,
      description: "Disabled stdio server",
      enabled: false,
      env: {},
      required: false,
      stderr: "pipe",
      tags: [],
      type: "stdio"
    };

    const manager = new MCPManager({ config, watch: false });
    cleanups.push(() => manager.close());
    await manager.initialize();

    await expect(manager.callTool("missing", "whatever")).rejects.toThrow(/is registered/u);
    await expect(manager.callTool("dormant", "whatever")).rejects.toThrow(/not connected/u);
  });

  test("retries a previously failed server on refresh once it can connect", async () => {
    const root = await createTempRoot();
    const readyFile = path.join(root, "ready.marker");
    const config = createDefaultAppConfig({
      userStateDirectory: path.join(root, "home", ".aia")
    });
    config.mcp.servers.flaky = {
      args: [FLAKY_FIXTURE_PATH],
      command: process.execPath,
      description: "Flaky stdio server",
      enabled: true,
      env: { MCP_READY_FILE: readyFile },
      required: false,
      stderr: "pipe",
      tags: ["flaky"],
      // Bounds the failing connect attempt (also exercises timeout wiring).
      timeoutMs: 5000,
      type: "stdio"
    };

    const manager = new MCPManager({ config, watch: false });
    cleanups.push(() => manager.close());

    await manager.initialize();
    expect(manager.getServerStatuses().find((entry) => entry.serverName === "flaky")?.state).toBe("failed");

    // The remote becomes connectable without any config change (same signature).
    await fs.writeFile(readyFile, "ready");
    await manager.refresh(config);

    const status = manager.getServerStatuses().find((entry) => entry.serverName === "flaky");
    expect(status?.state).toBe("connected");
    expect(status?.capabilities.tools).toBe(1);
  });

  httpTransportTest("supports streamable HTTP and auto-fallback to SSE", async () => {
    const streamable = await startStreamableServer("streamable");
    const sse = await startSseServer("legacy");
    const config = createDefaultAppConfig({
      userStateDirectory: path.join(await createTempRoot(), "home", ".aia")
    });

    config.mcp.servers.streamable = {
      description: "Streamable fixture",
      enabled: true,
      headers: {},
      required: true,
      tags: ["remote", "streamable"],
      type: "streamable-http",
      url: streamable.url
    };
    config.mcp.servers.legacy = {
      description: "Legacy SSE fixture",
      enabled: true,
      headers: {},
      required: true,
      tags: ["legacy", "remote"],
      // Trusted so the read-only tool round-trip below auto-approves; MCP
      // tools otherwise require approval (see the dedicated approval test).
      trust: "trusted",
      type: "auto",
      url: sse.url
    };

    const manager = new MCPManager({
      config,
      watch: false
    });
    cleanups.push(() => manager.close());

    await manager.initialize();

    const statusByName = Object.fromEntries(manager.getServerStatuses().map((status) => [status.serverName, status]));
    expect(statusByName.streamable?.transport).toBe("streamable-http");
    expect(statusByName.legacy?.transport).toBe("sse");

    const runtime = new ToolRuntime({
      approvalDecider: createToolApprovalDecider({
        settings: withMcpTrustRules(DEFAULT_APPROVAL_SETTINGS, {
          legacy: { trust: "trusted" }
        })
      }),
      registry: createDefaultToolRegistry({ mcpManager: manager })
    });

    const legacyInvocation = sanitizeMcpInvocationName("legacy", "docs.lookup");
    const runtimeResult = await runtime.execute(
      createToolCall({
        arguments: {
          topic: "fallback"
        },
        id: "tool-call.mcp.legacy.1",
        toolName: legacyInvocation
      }),
      {
        session: buildSession(),
        turn: buildTurn()
      }
    );

    expect(runtimeResult.toolCall.status).toBe("succeeded");
    expect(runtimeResult.toolCall.result).toMatchObject({
      isError: false,
      structuredContent: {
        summary: "Documentation for fallback",
        topic: "fallback"
      }
    });
    expect(runtime.listDefinitions().map((definition) => definition.invocationName)).toEqual(
      expect.arrayContaining([
        sanitizeMcpInvocationName("streamable", "docs.lookup"),
        sanitizeMcpInvocationName("legacy", "docs.lookup")
      ])
    );
  });

  test("merges imported config, installs templates, and refreshes runtime-visible MCP tools", async () => {
    const root = await createTempRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const importedConfigPath = path.join(workspace, ".roo", "mcp.json");

    await fs.mkdir(path.dirname(importedConfigPath), { recursive: true });
    await fs.mkdir(path.join(home, ".aia"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      importedConfigPath,
      JSON.stringify({
        mcpServers: {
          shared: {
            type: "auto",
            url: "http://127.0.0.1:9/mcp"
          }
        }
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(workspace, "aia.config.jsonc"),
      `{
        "mcp": {
          "imports": {
            "roo": {
              "enabled": true,
              "format": "roo_project",
              "path": "./.roo/mcp.json",
              "watch": true
            }
          },
          "servers": {
            "shared": {
              "type": "stdio",
              "command": "${escapeJsonString(process.execPath)}",
              "args": ["${escapeJsonString(STDIO_FIXTURE_PATH)}"],
              "enabled": true,
              "required": true,
              "stderr": "pipe",
              "env": {},
              "tags": ["native", "override"]
            }
          }
        }
      }`,
      "utf8"
    );

    await trustWorkspaceConfig(home, workspace);
    const loaded = await loadAIAgentConfig({
      cwd: workspace,
      env: {},
      userHomeDirectory: home
    });
    const manager = createMcpManagerFromLoadedConfig({
      cwd: workspace,
      env: {},
      loaded,
      userHomeDirectory: home,
      watch: false
    });
    cleanups.push(() => manager.close());

    await manager.initialize();

    const sharedStatus = manager.getServerStatuses().find((status) => status.serverName === "shared");
    expect(sharedStatus?.state).toBe("connected");
    expect(sharedStatus?.transport).toBe("stdio");

    const templateMatches = manager.searchCapabilities({
      kinds: ["server_template"],
      limit: 10,
      query: "context7",
      scopes: ["templates"]
    });
    expect(templateMatches.some((match) => match.capability.name === "context7-remote")).toBe(true);

    const runtime = createDefaultToolRuntime({
      mcpManager: manager
    });
    const installedInvocation = sanitizeMcpInvocationName("installed_docs", "docs.lookup");
    expect(runtime.listDefinitions().map((definition) => definition.invocationName)).not.toContain(installedInvocation);

    await manager.installTemplate({
      destination: "workspace",
      overrides: {
        args: [STDIO_FIXTURE_PATH],
        command: process.execPath,
        description: "Installed from the custom stdio template",
        type: "stdio"
      },
      serverName: "installed_docs",
      templateId: "custom-stdio"
    });

    // Installing without an explicit serverName derives a default name.
    const defaultInstall = await manager.installTemplate({
      destination: "workspace",
      overrides: {
        args: [STDIO_FIXTURE_PATH],
        command: process.execPath,
        type: "stdio"
      },
      templateId: "custom-stdio"
    });
    expect(defaultInstall.installedServerName.length).toBeGreaterThan(0);

    await manager.refresh();

    const toolSearchAfterRefresh = runtime.searchDefinitions({
      limit: 10,
      query: "installed_docs"
    });
    expect(toolSearchAfterRefresh.map((match) => match.definition.invocationName)).toContain(installedInvocation);

    const mcpSearchResult = await runtime.execute(
      createToolCall({
        arguments: {
          kinds: ["server_template", "tool"],
          limit: 20
        },
        id: "tool-call.mcp.search.1",
        toolName: "mcp_search"
      }),
      {
        session: buildSession(),
        turn: buildTurn()
      }
    );

    expect(mcpSearchResult.toolCall.status).toBe("succeeded");
    expect(mcpSearchResult.toolCall.result).toMatchObject({
      matches: expect.arrayContaining([
        expect.objectContaining({
          kind: "tool",
          serverName: "installed_docs"
        }),
        expect.objectContaining({
          kind: "server_template",
          name: "custom-stdio"
        })
      ])
    });
  });

  test("a reload after a config change does not repeat the untrusted-config warning", async () => {
    const root = await createTempRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(home, ".aia"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    const userConfig = path.join(home, ".aia", "config.jsonc");
    await fs.writeFile(userConfig, '{ "configVersion": 1 }', "utf8");
    await fs.writeFile(
      path.join(workspace, "aia.config.jsonc"),
      JSON.stringify({
        mcp: {
          servers: { repo: { args: [], command: "node", enabled: true, required: false, tags: [], type: "stdio" } }
        }
      }),
      "utf8"
    );
    const loaded = await loadAIAgentConfig({
      cwd: workspace,
      env: {},
      userHomeDirectory: home,
      warnWhenUntrusted: false
    });
    const manager = createMcpManagerFromLoadedConfig({
      cwd: workspace,
      env: {},
      loaded,
      userHomeDirectory: home,
      // Reloaded by hand below: a write made just after a watch starts is not
      // always reported on macOS, and the test then waited out its timeout.
      watch: false
    });
    cleanups.push(() => manager.close());
    await manager.initialize();
    const warnings: string[] = [];
    const listener = (warning: Error & { code?: string }) => {
      if (warning.code === "AIA_UNTRUSTED_CONFIG") {
        warnings.push(warning.message);
      }
    };
    process.on("warning", listener);
    try {
      await fs.writeFile(userConfig, '{ "configVersion": 1, "mcp": { "watch": true } }', "utf8");
      await manager.refresh();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("warning", listener);
    }
    // Said once at startup; every reload used to say it again.
    expect(warnings).toEqual([]);
    expect(manager.getServerStatuses().map((status) => status.state)).toEqual(["untrusted"]);
  });

  test("attaches config watchers when watch mode is enabled", async () => {
    const root = await createTempRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(home, ".aia"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, "aia.config.jsonc"),
      `{
        "mcp": {
          "servers": {
            "docs": {
              "type": "stdio",
              "command": "${escapeJsonString(process.execPath)}",
              "args": ["${escapeJsonString(STDIO_FIXTURE_PATH)}"],
              "enabled": true,
              "required": true,
              "stderr": "pipe",
              "env": {},
              "tags": ["docs"]
            }
          }
        }
      }`,
      "utf8"
    );

    await trustWorkspaceConfig(home, workspace);
    const loaded = await loadAIAgentConfig({
      cwd: workspace,
      env: {},
      userHomeDirectory: home
    });
    const manager = createMcpManagerFromLoadedConfig({
      cwd: workspace,
      env: {},
      loaded,
      userHomeDirectory: home,
      watch: true
    });
    cleanups.push(() => manager.close());

    await manager.initialize();
    expect(manager.getServerStatuses().find((status) => status.serverName === "docs")?.state).toBe("connected");
    const health = await manager.getHealth();
    expect(health.servers.length).toBeGreaterThanOrEqual(1);
  });

  test("reports an untrusted workspace server, and starts it on the next refresh once trust is granted", async () => {
    const root = await createTempRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(home, ".aia"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, "aia.config.jsonc"),
      JSON.stringify({
        mcp: {
          servers: {
            docs: {
              args: [STDIO_FIXTURE_PATH],
              command: process.execPath,
              enabled: true,
              env: {},
              required: false,
              stderr: "pipe",
              tags: [],
              type: "stdio"
            }
          }
        }
      }),
      "utf8"
    );

    const loaded = await loadAIAgentConfig({
      cwd: workspace,
      env: {},
      userHomeDirectory: home,
      warnWhenUntrusted: false
    });
    const manager = createMcpManagerFromLoadedConfig({
      cwd: workspace,
      env: {},
      loaded,
      userHomeDirectory: home,
      watch: false
    });
    cleanups.push(() => manager.close());
    await manager.initialize();

    const [untrusted] = manager.summarizeServers();
    expect(untrusted).toMatchObject({ serverName: "docs", state: "untrusted", tools: [], transport: "stdio" });
    expect(untrusted?.error).toContain("has not been trusted");
    await expect(manager.callTool("docs", "docs.lookup", { topic: "x" })).rejects.toThrow(/has not been trusted/u);

    await trustWorkspaceConfig(home, workspace);
    await manager.refresh();

    expect(manager.getServerStatuses()).toEqual([expect.objectContaining({ serverName: "docs", state: "connected" })]);
  });

  test("installing into an untrusted workspace config does not trust the rest of it", async () => {
    const root = await createTempRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(home, ".aia"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, "aia.config.jsonc"),
      JSON.stringify({
        mcp: { servers: { payload: { command: "sh", enabled: true, required: false, tags: [], type: "stdio" } } }
      }),
      "utf8"
    );

    const loaded = await loadAIAgentConfig({
      cwd: workspace,
      env: {},
      userHomeDirectory: home,
      warnWhenUntrusted: false
    });
    const manager = createMcpManagerFromLoadedConfig({
      cwd: workspace,
      env: {},
      loaded,
      userHomeDirectory: home,
      watch: false
    });
    cleanups.push(() => manager.close());
    await manager.initialize();
    await manager.installTemplate({
      destination: "workspace",
      overrides: { args: [STDIO_FIXTURE_PATH], command: process.execPath, type: "stdio" },
      serverName: "installed_docs",
      templateId: "custom-stdio"
    });

    await expect(fs.access(path.join(home, ".aia", "trust.json"))).rejects.toThrow();
    const reloaded = await loadAIAgentConfig({
      cwd: workspace,
      env: {},
      userHomeDirectory: home,
      warnWhenUntrusted: false
    });
    expect(reloaded.workspaceTrust.trusted).toBe(false);
    expect(reloaded.workspaceTrust.untrustedMcpEntries.map((entry) => entry.name).sort()).toEqual([
      "installed_docs",
      "payload"
    ]);
  });

  test("connects to a server defined in the user-global ~/.aia/config.jsonc", async () => {
    const root = await createTempRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");

    await fs.mkdir(path.join(home, ".aia"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(home, ".aia", "config.jsonc"),
      JSON.stringify({
        mcp: {
          servers: {
            global_docs: {
              args: [STDIO_FIXTURE_PATH],
              command: process.execPath,
              enabled: true,
              env: {},
              required: true,
              stderr: "pipe",
              tags: ["global", "docs"],
              type: "stdio"
            }
          }
        }
      }),
      "utf8"
    );

    const loaded = await loadAIAgentConfig({
      cwd: workspace,
      env: {},
      userHomeDirectory: home
    });
    const manager = createMcpManagerFromLoadedConfig({
      cwd: workspace,
      env: {},
      loaded,
      userHomeDirectory: home,
      watch: false
    });
    cleanups.push(() => manager.close());

    await manager.initialize();

    const status = manager.getServerStatuses().find((entry) => entry.serverName === "global_docs");
    expect(status?.state).toBe("connected");
    expect(status?.transport).toBe("stdio");
  });

  test("installTemplate into the user scope writes ~/.aia/config.jsonc when it exists, as aia mcp add does", async () => {
    const root = await createTempRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(home, ".aia"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(path.join(home, ".aia", "config.jsonc"), '{ "configVersion": 1 }\n', "utf8");
    const loaded = await loadAIAgentConfig({ cwd: workspace, env: {}, userHomeDirectory: home });
    const manager = createMcpManagerFromLoadedConfig({
      cwd: workspace,
      env: {},
      loaded,
      userHomeDirectory: home,
      watch: false
    });
    cleanups.push(() => manager.close());
    await manager.initialize();

    const installed = await manager.installTemplate({
      destination: "user",
      overrides: { enabled: false },
      serverName: "docs7",
      templateId: "context7-remote"
    });

    // It used to go to ~/.aia/aia.config.jsonc, next to the file in use.
    expect(installed.configPath).toBe(path.join(home, ".aia", "config.jsonc"));
    const written = await fs.readFile(installed.configPath, "utf8");
    expect(written).toContain('"docs7"');
    expect(written).toContain('"templateId": "context7-remote"');
    await expect(fs.stat(path.join(home, ".aia", "aia.config.jsonc"))).rejects.toThrow();
    await expect(manager.installTemplate({ destination: "user", templateId: "nope" })).rejects.toThrow(
      /No MCP server template "nope"\. Known: .*context7-remote/u
    );
  });

  test("summarizeServers and the mcp_status tool report connected, failed, and disabled servers with their tools", async () => {
    const config = createDefaultAppConfig({
      userStateDirectory: path.join(await createTempRoot(), "home", ".aia")
    });
    config.mcp.servers.docs = {
      args: [STDIO_FIXTURE_PATH],
      command: process.execPath,
      enabled: true,
      env: {},
      required: false,
      stderr: "pipe",
      tags: ["docs"],
      type: "stdio"
    };
    config.mcp.servers.broken = {
      args: ["/nonexistent/script.mjs"],
      command: "/nonexistent/aiagent-mcp-binary",
      enabled: true,
      env: {},
      required: false,
      stderr: "pipe",
      tags: ["broken"],
      type: "stdio"
    };
    config.mcp.servers.dormant = {
      args: [STDIO_FIXTURE_PATH],
      command: process.execPath,
      enabled: false,
      env: {},
      required: false,
      stderr: "pipe",
      tags: ["dormant"],
      type: "stdio"
    };

    const manager = new MCPManager({ config, watch: false });
    cleanups.push(() => manager.close());
    await manager.initialize();

    // The catalog is listed (and sorted) once for all the servers, not once each.
    let listed = 0;
    const getToolCapabilities = manager.getToolCapabilities.bind(manager);
    manager.getToolCapabilities = () => {
      listed += 1;
      return getToolCapabilities();
    };
    const summaries = Object.fromEntries(manager.summarizeServers().map((server) => [server.serverName, server]));
    expect(listed).toBe(1);
    expect(manager.summarizeServers(new Set(["docs"])).map((server) => server.serverName)).toEqual(["docs"]);
    const docsInvocation = sanitizeMcpInvocationName("docs", "docs.lookup");
    expect(summaries.docs?.state).toBe("connected");
    expect(summaries.docs?.tools.map((tool) => tool.invocationName)).toContain(docsInvocation);
    expect(summaries.broken?.state).toBe("failed");
    expect(summaries.broken?.error).toBeTruthy();
    expect(summaries.broken?.tools).toEqual([]);
    expect(summaries.dormant?.state).toBe("disabled");
    expect(summaries.dormant?.tools).toEqual([]);

    const runtime = createDefaultToolRuntime({ mcpManager: manager });
    const result = await runtime.execute(
      createToolCall({
        arguments: {},
        id: "tool-call.mcp.status.1",
        toolName: "mcp_status"
      }),
      { session: buildSession(), turn: buildTurn() }
    );
    expect(result.toolCall.status).toBe("succeeded");
    expect(result.toolCall.result).toMatchObject({
      servers: expect.arrayContaining([
        expect.objectContaining({ serverName: "broken", state: "failed" }),
        expect.objectContaining({ serverName: "docs", state: "connected" })
      ])
    });
  });
});

async function startStreamableServer(serverName: string): Promise<{ close: () => Promise<void>; url: string }> {
  const app = createMcpExpressApp();

  app.post("/mcp", async (request, response) => {
    const server = createFixtureServer(serverName);

    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined
      });
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
      response.on("close", () => {
        void transport.close();
        void server.close();
      });
    } catch (error) {
      if (!response.headersSent) {
        response.status(500).json({
          error: String(error)
        });
      }
      await server.close().catch(() => undefined);
    }
  });

  app.get("/mcp", (_request, response) => {
    response.status(405).json({
      error: "Method not allowed"
    });
  });

  app.delete("/mcp", (_request, response) => {
    response.status(405).json({
      error: "Method not allowed"
    });
  });

  return startHttpServer(app, "/mcp");
}

async function startSseServer(serverName: string): Promise<{ close: () => Promise<void>; url: string }> {
  const app = createMcpExpressApp();
  const transports = new Map<string, { server: McpServer; transport: SSEServerTransport }>();

  app.get("/mcp", async (_request, response) => {
    const server = createFixtureServer(serverName);

    try {
      const transport = new SSEServerTransport("/messages", response);
      transports.set(transport.sessionId, {
        server,
        transport
      });
      transport.onclose = () => {
        transports.delete(transport.sessionId);
      };
      await server.connect(transport);
    } catch (error) {
      if (!response.headersSent) {
        response.status(500).send(String(error));
      }
      await server.close().catch(() => undefined);
    }
  });

  app.post("/messages", async (request, response) => {
    const sessionId = Array.isArray(request.query.sessionId) ? request.query.sessionId[0] : request.query.sessionId;
    if (typeof sessionId !== "string") {
      response.status(400).send("Missing sessionId");
      return;
    }

    const active = transports.get(sessionId);
    if (!active) {
      response.status(404).send("Session not found");
      return;
    }

    await active.transport.handlePostMessage(request, response, request.body);
  });

  const started = await startHttpServer(app, "/mcp");
  cleanups.push(async () => {
    for (const active of transports.values()) {
      await active.server.close().catch(() => undefined);
    }
    transports.clear();
  });
  return started;
}

function createFixtureServer(serverName: string): McpServer {
  const server = new McpServer({
    name: `${serverName}-fixture`,
    version: "1.0.0"
  });

  server.registerTool(
    "docs.lookup",
    {
      annotations: {
        idempotentHint: true,
        readOnlyHint: true,
        title: "Docs Lookup"
      },
      description: "Look up documentation by topic.",
      inputSchema: {
        topic: z.string().min(1)
      },
      outputSchema: {
        server: z.string(),
        summary: z.string(),
        topic: z.string()
      },
      title: "Docs Lookup"
    },
    async ({ topic }) => ({
      content: [
        {
          text: `${serverName}:${topic}`,
          type: "text"
        }
      ],
      structuredContent: {
        server: serverName,
        summary: `Documentation for ${topic}`,
        topic
      }
    })
  );

  server.registerPrompt(
    "summarize_doc",
    {
      argsSchema: {
        topic: z.string().min(1)
      },
      description: "Build a summary prompt for a topic."
    },
    async ({ topic }) => ({
      description: `Prompt for ${topic}`,
      messages: [
        {
          content: {
            text: `Summarize the documentation for ${topic}.`,
            type: "text"
          },
          role: "user"
        }
      ]
    })
  );

  server.registerResource(
    "guide",
    "file:///docs/guide.md",
    {
      description: "Static guide resource.",
      mimeType: "text/markdown",
      title: "Guide"
    },
    async (uri) => ({
      contents: [
        {
          mimeType: "text/markdown",
          text: `# Guide\n${serverName} guide content.\n`,
          uri: uri.toString()
        }
      ]
    })
  );

  server.registerResource(
    "doc-template",
    new ResourceTemplate("file:///docs/{name}.md", {
      list: undefined
    }),
    {
      description: "Dynamic document resource template.",
      mimeType: "text/markdown",
      title: "Document Template"
    },
    async (uri) => {
      const name = decodeURIComponent(uri.pathname.split("/").pop() ?? "unknown").replace(/\.md$/i, "");
      return {
        contents: [
          {
            mimeType: "text/markdown",
            text: `# ${name}\n${serverName} dynamic content for ${name}.\n`,
            uri: uri.toString()
          }
        ]
      };
    }
  );

  return server;
}

async function startHttpServer(
  app: ReturnType<typeof createMcpExpressApp>,
  endpointPath: string
): Promise<{ close: () => Promise<void>; url: string }> {
  const address = await new Promise<AddressInfo>((resolve, reject) => {
    const instance = app.listen(0, "127.0.0.1", () => {
      void resolveTcpAddress(instance).then(resolve, reject);
    });
    instance.once("error", reject);
    cleanups.push(
      async () =>
        await new Promise<void>((cleanupResolve, cleanupReject) => {
          instance.close((error) => {
            if (error) {
              cleanupReject(error);
              return;
            }
            cleanupResolve();
          });
        })
    );
  });
  const url = `http://127.0.0.1:${address.port}${endpointPath}`;

  return {
    close: cleanups[cleanups.length - 1]!,
    url
  };
}

async function resolveTcpAddress(
  server: ReturnType<ReturnType<typeof createMcpExpressApp>["listen"]>
): Promise<AddressInfo> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const address = server.address();
    if (address && typeof address !== "string") {
      return address;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("MCP fixture server did not expose a TCP address.");
}

function buildSession() {
  return sessionRecordSchema.parse({
    createdAt: "2026-03-27T12:00:00.000Z",
    cwd: "/workspace",
    goal: "Exercise MCP runtime coverage",
    id: "session.mcp.integration.1",
    lastActiveAt: "2026-03-27T12:00:00.000Z",
    metadata: {},
    status: "running_model",
    tags: [],
    title: "MCP Integration Session",
    updatedAt: "2026-03-27T12:00:00.000Z"
  });
}

function buildTurn() {
  return turnRecordSchema.parse({
    approvalRequestIds: [],
    executedToolCallIds: [],
    id: "turn.mcp.integration.1",
    inputMessageIds: [],
    metadata: {},
    outputMessageIds: [],
    requestedToolCallIds: [],
    sequence: 0,
    sessionId: "session.mcp.integration.1",
    startedAt: "2026-03-27T12:00:00.000Z",
    status: "running",
    trigger: "user"
  });
}

function createToolCall(overrides: Partial<Parameters<typeof toolCallRecordSchema.parse>[0]> = {}) {
  return toolCallRecordSchema.parse({
    arguments: {},
    id: "tool-call.mcp.default",
    metadata: {},
    sessionId: "session.mcp.integration.1",
    startedAt: "2026-03-27T12:00:00.000Z",
    status: "pending",
    toolId: "tool.mcp.placeholder",
    toolName: "mcp_search",
    turnId: "turn.mcp.integration.1",
    ...overrides
  });
}

/**
 * A real MCP client and server joined in memory, for a `connectClient` stand-in:
 * its `whoami` tool answers with `label`, and `onClose` runs when the manager
 * closes the client.
 */
async function connectInMemory(
  label: string,
  params: ConnectMcpClientParams,
  onClose: () => void
): Promise<McpConnection> {
  const server = new McpServer({ name: `${label}-fixture`, version: "1.0.0" });
  server.registerTool("whoami", { description: "Says which connection answered." }, async () => ({
    content: [{ text: label, type: "text" }]
  }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "aia-test", version: "1.0.0" }, { capabilities: { elicitation: {} } });
  params.configureClient?.(client);
  await client.connect(clientTransport);
  const close = client.close.bind(client);
  client.close = async () => {
    onClose();
    await close();
  };
  return { client, transport: "stdio" };
}

async function waitForCondition(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for the condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-mcp-"));
  tempRoots.push(root);
  return root;
}

function escapeJsonString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function canBindLoopback(): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.listen(0, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}
