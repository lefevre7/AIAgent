import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ConfigValidationError, loadAIAgentConfig } from "@/core/config";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

describe("config loader", () => {
  test("merges global, workspace, and environment config with the right precedence", async () => {
    const root = await createTempRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");
    const nestedCwd = path.join(workspace, "packages", "app");

    await fs.mkdir(path.join(home, ".aia"), { recursive: true });
    await fs.mkdir(nestedCwd, { recursive: true });

    await fs.writeFile(
      path.join(home, ".aia", "aia.config.jsonc"),
      `{
        // user-wide defaults
        "runtime": {
          "defaultProvider": "ollama",
          "logLevel": "debug",
        },
        "gateway": {
          "port": 4100,
        },
        "memory": {
          "userGlobalRoot": "./global-memory",
        },
      }`,
      "utf8"
    );

    await fs.writeFile(
      path.join(workspace, "aia.config.jsonc"),
      `{
        "runtime": {
          "defaultProvider": "lm_studio",
          "defaultModel": "workspace-model",
        },
        "gateway": {
          "hostname": "0.0.0.0",
        },
        "memory": {
          "workspaceRoot": "./workspace-memory",
          "sqlitePath": "./state/runtime.sqlite",
        },
      }`,
      "utf8"
    );

    const loaded = await loadAIAgentConfig({
      cwd: nestedCwd,
      env: {
        AIA_GATEWAY_PORT: "9999",
        AIA_MEMORY_CHAT_SESSION_ROOT: "./session-summaries"
      },
      userHomeDirectory: home
    });

    expect(loaded.paths.workspaceRoot).toBe(workspace);
    expect(loaded.config.runtime.defaultProvider).toBe("lm_studio");
    expect(loaded.config.runtime.defaultModel).toBe("workspace-model");
    expect(loaded.config.gateway.hostname).toBe("0.0.0.0");
    expect(loaded.config.gateway.port).toBe(9999);
    expect(loaded.config.memory.userGlobalRoot).toBe(path.join(home, ".aia", "global-memory"));
    expect(loaded.config.memory.workspaceRoot).toBe(path.join(workspace, "workspace-memory"));
    expect(loaded.config.memory.sqlitePath).toBe(path.join(workspace, "state", "runtime.sqlite"));
    expect(loaded.config.memory.chatSessionRoot).toBe(path.join(workspace, "session-summaries"));
  });

  test("resolves env, file, and exec secret references", async () => {
    const root = await createTempRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");

    await fs.mkdir(path.join(home, ".aia"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, "secrets.json"),
      JSON.stringify({
        channels: {
          discord: {
            token: "file-secret"
          }
        }
      }),
      "utf8"
    );

    await fs.writeFile(
      path.join(workspace, "aia.config.jsonc"),
      `{
        "secrets": {
          "providers": {
            "file": {
              "source": "file",
              "path": "./secrets.json",
              "mode": "json",
            },
            "exec": {
              "source": "exec",
              "command": "/bin/sh",
              "args": ["-lc", "printf '{\\"token\\":\\"exec-secret\\"}'"],
              "jsonOnly": true,
            },
          },
        },
        "channels": {
          "discord": {
            "botToken": { "source": "env", "id": "AIA_TEST_DISCORD_TOKEN" },
          },
          "teams": {
            "appPassword": { "source": "file", "id": "/channels/discord/token" },
          },
          "imessage": {
            "blueBubblesPassword": { "source": "exec", "id": "/token" },
          },
        },
      }`,
      "utf8"
    );

    const loaded = await loadAIAgentConfig({
      cwd: workspace,
      env: {
        AIA_TEST_DISCORD_TOKEN: "env-secret"
      },
      userHomeDirectory: home
    });

    expect(loaded.resolvedConfig.channels.discord.botToken).toBe("env-secret");
    expect(loaded.resolvedConfig.channels.teams.appPassword).toBe("file-secret");
    expect(loaded.resolvedConfig.channels.imessage.blueBubblesPassword).toBe("exec-secret");
  });

  test("accepts MCP config overrides from AIA_MCP_CONFIG_JSON", async () => {
    const root = await createTempRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");

    await fs.mkdir(path.join(home, ".aia"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });

    const loaded = await loadAIAgentConfig({
      cwd: workspace,
      env: {
        AIA_MCP_CONFIG_JSON: JSON.stringify({
          servers: {
            env_docs: {
              args: ["./tests/fixtures/mcp/stdio-server.mjs"],
              command: process.execPath,
              enabled: true,
              env: {},
              required: false,
              stderr: "pipe",
              tags: ["env", "stdio"],
              type: "stdio"
            }
          },
          templates: {
            env_template: {
              bootstrap: [],
              description: "Template from env override",
              displayName: "Env Template",
              marketplace: false,
              prerequisites: [],
              server: {
                description: "Env template server",
                enabled: true,
                headers: {},
                required: false,
                tags: ["env", "template"],
                type: "auto",
                url: "https://example.com/mcp"
              },
              tags: ["env", "template"],
              title: "Env Template"
            }
          }
        })
      },
      userHomeDirectory: home
    });

    expect(loaded.config.mcp.servers.env_docs).toMatchObject({
      args: ["./tests/fixtures/mcp/stdio-server.mjs"],
      command: process.execPath,
      enabled: true,
      stderr: "pipe",
      type: "stdio"
    });
    expect(loaded.config.mcp.templates.env_template).toMatchObject({
      displayName: "Env Template",
      marketplace: false
    });
  });

  test("surfaces validation failures with the originating config path", async () => {
    const root = await createTempRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");

    await fs.mkdir(path.join(home, ".aia"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, "aia.config.jsonc"),
      `{
        "gateway": {
          "port": 70000,
        },
      }`,
      "utf8"
    );

    await expect(
      loadAIAgentConfig({
        cwd: workspace,
        env: {},
        userHomeDirectory: home
      })
    ).rejects.toThrowError(ConfigValidationError);

    await expect(
      loadAIAgentConfig({
        cwd: workspace,
        env: {},
        userHomeDirectory: home
      })
    ).rejects.toThrow(path.join(workspace, "aia.config.jsonc"));
  });

  test("discovers ~/.aia/config.jsonc as a user-global layer when aia.config.jsonc is absent", async () => {
    const root = await createTempRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");

    await fs.mkdir(path.join(home, ".aia"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });

    await fs.writeFile(
      path.join(home, ".aia", "config.jsonc"),
      `{
        "runtime": { "defaultProvider": "ollama" },
        "mcp": {
          "servers": {
            "global_only": {
              "type": "auto",
              "url": "https://example.com/mcp",
              "headers": {},
              "enabled": true,
              "required": false,
              "tags": ["global"]
            }
          }
        }
      }`,
      "utf8"
    );

    const loaded = await loadAIAgentConfig({ cwd: workspace, env: {}, userHomeDirectory: home });

    expect(loaded.config.runtime.defaultProvider).toBe("ollama");
    expect(loaded.config.mcp.servers.global_only).toMatchObject({ type: "auto", url: "https://example.com/mcp" });
    expect(loaded.sources.config.global).toEqual([path.join(home, ".aia", "config.jsonc")]);
  });

  test("merges both global files with config.jsonc as base and aia.config.jsonc overriding", async () => {
    const root = await createTempRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");

    await fs.mkdir(path.join(home, ".aia"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });

    await fs.writeFile(
      path.join(home, ".aia", "config.jsonc"),
      `{
        "runtime": { "defaultProvider": "ollama" },
        "gateway": { "port": 4100 },
        "mcp": {
          "servers": {
            "from_config": {
              "type": "auto",
              "url": "https://config.example.com/mcp",
              "headers": {},
              "enabled": true,
              "required": false,
              "tags": []
            }
          }
        }
      }`,
      "utf8"
    );
    await fs.writeFile(
      path.join(home, ".aia", "aia.config.jsonc"),
      `{
        "gateway": { "port": 4242 },
        "mcp": {
          "servers": {
            "from_aia_config": {
              "type": "auto",
              "url": "https://aia.example.com/mcp",
              "headers": {},
              "enabled": true,
              "required": false,
              "tags": []
            }
          }
        }
      }`,
      "utf8"
    );

    const loaded = await loadAIAgentConfig({ cwd: workspace, env: {}, userHomeDirectory: home });

    // aia.config.jsonc overrides config.jsonc within the global tier.
    expect(loaded.config.gateway.port).toBe(4242);
    // Values only present in config.jsonc still survive.
    expect(loaded.config.runtime.defaultProvider).toBe("ollama");
    // Servers from both global files merge by name.
    expect(Object.keys(loaded.config.mcp.servers).sort()).toEqual(["from_aia_config", "from_config"]);
    expect(loaded.sources.config.global).toEqual([
      path.join(home, ".aia", "config.jsonc"),
      path.join(home, ".aia", "aia.config.jsonc")
    ]);
  });

  test("merges global MCP servers into the workspace config", async () => {
    const root = await createTempRoot();
    const home = path.join(root, "home");
    const workspace = path.join(root, "workspace");

    await fs.mkdir(path.join(home, ".aia"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });

    await fs.writeFile(
      path.join(home, ".aia", "config.jsonc"),
      `{
        "mcp": {
          "servers": {
            "global_http": {
              "type": "streamable-http",
              "url": "https://example.com/mcp",
              "headers": {},
              "enabled": true,
              "required": false,
              "tags": []
            }
          }
        }
      }`,
      "utf8"
    );
    await fs.writeFile(
      path.join(workspace, "aia.config.jsonc"),
      `{
        "mcp": {
          "servers": {
            "workspace_stdio": {
              "type": "stdio",
              "command": "node",
              "args": [],
              "env": {},
              "stderr": "pipe",
              "enabled": true,
              "required": false,
              "tags": []
            }
          }
        }
      }`,
      "utf8"
    );

    const loaded = await loadAIAgentConfig({ cwd: workspace, env: {}, userHomeDirectory: home });

    expect(Object.keys(loaded.config.mcp.servers).sort()).toEqual(["global_http", "workspace_stdio"]);
    expect(loaded.config.mcp.servers.global_http.type).toBe("streamable-http");
    expect(loaded.config.mcp.servers.workspace_stdio.type).toBe("stdio");
  });
});

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-config-"));
  tempRoots.push(root);
  return root;
}
