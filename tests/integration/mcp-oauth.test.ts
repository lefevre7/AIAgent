import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  createDefaultAppConfig,
  createMcpManagerFromLoadedConfig,
  loadAIAgentConfig,
  loginToMcpServer,
  MCPManager,
  McpCredentialsStore,
  mcpCredentialsFilePath,
  type AppConfig,
  type MCPServerStatus
} from "@/core";
import { headlessBrowser, startProtectedMcpServer } from "../helpers/oauth-server";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function createStore(): Promise<McpCredentialsStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-mcp-oauth-login-"));
  cleanups.push(() => fs.rm(root, { force: true, recursive: true }));
  return new McpCredentialsStore(path.join(root, ".aia", "mcp-credentials.json"));
}

function managerFor(url: string, store: McpCredentialsStore): MCPManager {
  const config: AppConfig = createDefaultAppConfig({ userStateDirectory: path.join(os.tmpdir(), "unused-aia-home") });
  config.mcp.servers.protected = {
    enabled: true,
    headers: {},
    required: false,
    tags: [],
    type: "streamable-http",
    url
  };
  const manager = new MCPManager({ config, oauthStore: store, watch: false });
  cleanups.push(() => manager.close());
  return manager;
}

describe("MCP OAuth", () => {
  test("a server that needs a sign-in reports needs_login instead of registering a client on its own", async () => {
    const server = await startProtectedMcpServer(cleanups);
    const manager = managerFor(server.url, await createStore());
    await manager.initialize();

    const status = manager.getServerStatuses()[0];
    expect(status?.state).toBe("needs_login");
    expect(status?.error?.message).toContain("aia mcp login protected");
    // Never signed in, so no OAuth ran: no discovery, no client registered.
    expect(server.state.registrations).toBe(0);
  });

  test("login registers aia, completes PKCE through the callback, and a session then connects with the token", async () => {
    const server = await startProtectedMcpServer(cleanups);
    const store = await createStore();
    const shown: string[] = [];

    await loginToMcpServer({
      onAuthorizationUrl: (url) => shown.push(url),
      openBrowser: headlessBrowser,
      serverName: "protected",
      serverUrl: server.url,
      store,
      timeoutMs: 10_000
    });

    expect(shown[0]).toContain(`${server.base}/authorize`);
    expect(new URL(shown[0]!).searchParams.get("code_challenge_method")).toBe("S256");
    expect(server.state.registrations).toBe(1);
    expect(await store.hasTokens("protected", server.url)).toBe(true);
    expect((await fs.stat(store.filePath)).mode & 0o777).toBe(0o600);

    const manager = managerFor(server.url, store);
    await manager.initialize();
    expect(manager.getServerStatuses()[0]?.state).toBe("connected");
    const result = await manager.callTool("protected", "whoami");
    expect(JSON.stringify(result.content)).toContain("token:access-1");
  });

  // A sign-in elsewhere used to reload all config and retry every failed
  // server, and so did every token refresh any session wrote to the file.
  test("a sign-in elsewhere reconnects the servers waiting on one, and nothing else", async () => {
    const server = await startProtectedMcpServer(cleanups);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-mcp-oauth-watch-"));
    cleanups.push(() => fs.rm(root, { force: true, recursive: true }));
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    await fs.mkdir(path.join(home, ".aia"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(home, ".aia", "config.jsonc"),
      JSON.stringify({
        configVersion: 1,
        mcp: {
          servers: {
            missing: {
              args: [],
              command: path.join(root, "no-such-binary"),
              enabled: true,
              env: {},
              required: false,
              stderr: "pipe",
              tags: [],
              type: "stdio"
            },
            protected: {
              enabled: true,
              headers: {},
              required: false,
              tags: [],
              type: "streamable-http",
              url: server.url
            }
          }
        }
      })
    );
    const loaded = await loadAIAgentConfig({ cwd: workspace, env: {}, userHomeDirectory: home });
    const manager = createMcpManagerFromLoadedConfig({
      cwd: workspace,
      env: {},
      loaded,
      userHomeDirectory: home,
      watch: true
    });
    cleanups.push(() => manager.close());
    await manager.initialize();
    const stateOf = (name: string) => manager.getServerStatuses().find((status) => status.serverName === name)?.state;
    // macOS can deliver the config file's own creation to the new watcher a
    // moment late, and that reload retries everything: let it pass first.
    await untilQuiet(manager, 600);
    expect(stateOf("protected")).toBe("needs_login");
    expect(stateOf("missing")).toBe("failed");
    const retried: string[] = [];
    manager.on("server_updated", ({ status }: { status: MCPServerStatus }) => {
      if (status.state === "connecting") {
        retried.push(status.serverName);
      }
    });

    // What `aia mcp login` in another terminal leaves behind.
    server.state.validTokens.add("signed-in-elsewhere");
    await new McpCredentialsStore(mcpCredentialsFilePath(path.join(home, ".aia"))).update(
      "protected",
      server.url,
      (current) => ({ ...current, tokens: { access_token: "signed-in-elsewhere", token_type: "Bearer" } })
    );
    const deadline = Date.now() + 5_000;
    while (stateOf("protected") !== "connected" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(stateOf("protected")).toBe("connected");
    expect(retried).toEqual(["protected"]);
  });

  test("a revoked access token is refreshed without another sign-in", async () => {
    const server = await startProtectedMcpServer(cleanups);
    const store = await createStore();
    await loginToMcpServer({
      onAuthorizationUrl: () => undefined,
      openBrowser: headlessBrowser,
      serverName: "protected",
      serverUrl: server.url,
      store,
      timeoutMs: 10_000
    });
    server.state.validTokens.clear();

    const manager = managerFor(server.url, store);
    await manager.initialize();

    expect(manager.getServerStatuses()[0]?.state).toBe("connected");
    expect(server.state.tokenRequests).toEqual(["authorization_code", "refresh_token"]);
    expect((await store.get("protected", server.url))?.tokens?.access_token).toBe("access-2");
  });

  test("a sign-in response that does not match the request saves nothing", async () => {
    const server = await startProtectedMcpServer(cleanups);
    const store = await createStore();

    await expect(
      loginToMcpServer({
        onAuthorizationUrl: () => undefined,
        openBrowser: async (url) => {
          const authorize = await fetch(url, { redirect: "manual" });
          const callback = new URL(authorize.headers.get("location")!);
          callback.searchParams.set("state", "forged");
          await fetch(callback);
        },
        serverName: "protected",
        serverUrl: server.url,
        store,
        timeoutMs: 10_000
      })
    ).rejects.toThrow("state mismatch");
    expect(await store.hasTokens("protected", server.url)).toBe(false);
    // Nor the client this attempt registered: a failed login leaves the
    // store as it was.
    expect(await store.get("protected", server.url)).toBeUndefined();
  });

  test("a later login on a new callback port registers a client for that callback", async () => {
    // A registration is for one redirect URI, and each login listens on a new
    // port: reusing the old client was refused by a server that checks.
    const server = await startProtectedMcpServer(cleanups);
    const store = await createStore();
    const login = () =>
      loginToMcpServer({
        onAuthorizationUrl: () => undefined,
        openBrowser: headlessBrowser,
        serverName: "protected",
        serverUrl: server.url,
        store,
        timeoutMs: 10_000
      });
    await login();
    server.state.validTokens.clear();
    await store.update("protected", server.url, (current) => ({ ...current, tokens: undefined }));
    await login();

    expect(server.state.registrations).toBe(2);
    expect(await store.hasTokens("protected", server.url)).toBe(true);
  });
});

/** Resolves once the manager has gone `quietMs` without a status change or reload. */
async function untilQuiet(manager: MCPManager, quietMs: number): Promise<void> {
  let last = Date.now();
  const touch = () => {
    last = Date.now();
  };
  manager.on("server_updated", touch);
  manager.on("refreshed", touch);
  try {
    while (Date.now() - last < quietMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    manager.off("server_updated", touch);
    manager.off("refreshed", touch);
  }
}
