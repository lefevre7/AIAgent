import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createDefaultAppConfig,
  MCPManager,
  type AppConfig,
  type MCPManagerOptions,
  type MCPServerStatus
} from "@/core";

const FIXTURE = path.resolve("tests/fixtures/mcp/stdio-lifecycle-server.mjs");

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function createConfig(
  servers: Record<string, Partial<Extract<AppConfig["mcp"]["servers"][string], { type: "stdio" }>>>,
  mcp: Partial<AppConfig["mcp"]> = {}
): Promise<AppConfig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-mcp-lifecycle-"));
  cleanups.push(() => fs.rm(root, { force: true, recursive: true }));
  const config = createDefaultAppConfig({ userStateDirectory: path.join(root, "home", ".aia") });
  Object.assign(config.mcp, mcp);
  for (const [name, overrides] of Object.entries(servers)) {
    config.mcp.servers[name] = {
      args: [FIXTURE],
      command: process.execPath,
      enabled: true,
      env: {},
      required: false,
      stderr: "pipe",
      tags: [],
      type: "stdio",
      ...overrides
    };
  }
  return config;
}

function startManager(config: AppConfig, options: Partial<MCPManagerOptions> = {}): MCPManager {
  const manager = new MCPManager({ config, watch: false, ...options });
  cleanups.push(() => manager.close());
  return manager;
}

function statusOf(manager: MCPManager, name: string): MCPServerStatus | undefined {
  return manager.getServerStatuses().find((status) => status.serverName === name);
}

// Resolves once the server's status satisfies `predicate`, now or later.
function waitForServer(
  manager: MCPManager,
  name: string,
  predicate: (status: MCPServerStatus) => boolean,
  timeoutMs = 15_000
): Promise<MCPServerStatus> {
  const current = statusOf(manager, name);
  if (current && predicate(current)) {
    return Promise.resolve(current);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      manager.off("server_updated", listener);
      reject(new Error(`${name} never reached the expected state (last: ${statusOf(manager, name)?.state})`));
    }, timeoutMs);
    const listener = ({ status }: { status: MCPServerStatus }) => {
      if (status.serverName === name && predicate(status)) {
        clearTimeout(timer);
        manager.off("server_updated", listener);
        resolve(status);
      }
    };
    manager.on("server_updated", listener);
  });
}

function textOf(result: Awaited<ReturnType<MCPManager["callTool"]>>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content.map((item) => (item.type === "text" ? item.text : "")).join("");
}

describe("MCP manager lifecycle", () => {
  // A config watcher can fire, or a reload be queued, while the manager shuts
  // down. Such a refresh used to start servers (and watchers) after close(),
  // which nothing stopped, and the process stayed up.
  test("a refresh queued around close() starts nothing", async () => {
    const empty = await createConfig({});
    const marker = path.join(path.dirname(empty.memory.userGlobalRoot), "spawned");
    const late = await createConfig({
      late: {
        args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); setTimeout(() => {}, 3000)`]
      }
    });
    const manager = startManager(empty);
    await manager.initialize();

    const inFlight = manager.refresh(late);
    await manager.close();
    await inFlight;
    await manager.refresh(late);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(manager.getServerStatuses()).toEqual([]);
    await expect(fs.access(marker)).rejects.toThrow();
  });

  test("an optional server slow to start does not hold up startup, and joins once it connects", async () => {
    // A grace long enough for a quick server to spawn and list its tools on a
    // loaded machine (the full suite runs many in parallel; 200 ms flaked),
    // and a slow server well past it.
    const manager = startManager(
      await createConfig(
        { fast: {}, slow: { env: { MCP_TEST_START_DELAY_MS: "6000" } } },
        { optionalStartupGraceMs: 1_500 }
      )
    );
    const started = Date.now();
    await manager.initialize();

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(statusOf(manager, "fast")?.state).toBe("connected");
    expect(statusOf(manager, "slow")?.state).toBe("connecting");

    await waitForServer(manager, "slow", (status) => status.state === "connected");
    expect(manager.getToolCapabilities().some((tool) => tool.serverName === "slow")).toBe(true);
  });

  test("a required server holds up startup until it has connected", async () => {
    const manager = startManager(
      await createConfig({ needed: { env: { MCP_TEST_START_DELAY_MS: "800" }, required: true } })
    );
    const started = Date.now();
    await manager.initialize();

    expect(Date.now() - started).toBeGreaterThanOrEqual(700);
    expect(statusOf(manager, "needed")?.state).toBe("connected");
  });

  test("a call to a server still connecting waits for it", async () => {
    const manager = startManager(
      await createConfig({ late: { env: { MCP_TEST_START_DELAY_MS: "1200" } } }, { optionalStartupGraceMs: 50 })
    );
    await manager.initialize();
    expect(statusOf(manager, "late")?.state).toBe("connecting");

    expect(textOf(await manager.callTool("late", "echo", { text: "hi" }))).toBe("echo:hi");
  });

  test("a server that exits is marked failed with its exit code and stderr, then reconnected", async () => {
    const manager = startManager(await createConfig({ fragile: {} }));
    await manager.initialize();

    const failed = waitForServer(manager, "fragile", (status) => status.state === "failed");
    await manager.callTool("fragile", "crash").catch(() => undefined);
    const status = await failed;
    expect(status.error?.code).toBe("mcp_connection_lost");
    expect(status.error?.message).toContain("exited with code 3");
    expect(status.error?.message).toContain("boom: the fixture crashed on purpose");
    expect(manager.getToolCapabilities().some((tool) => tool.serverName === "fragile")).toBe(false);

    // The first retry comes a second later.
    await waitForServer(manager, "fragile", (next) => next.state === "connected");
    expect(textOf(await manager.callTool("fragile", "echo", { text: "back" }))).toBe("echo:back");
  });

  // Resetting the attempt count on every handshake respawned a server that
  // crashed right after connecting about every 1.6 s, forever.
  test("a server that crashes right after connecting is tried five more times, then left failed", async () => {
    const manager = startManager(await createConfig({ flaky: { env: { MCP_TEST_CRASH_AFTER_CONNECT_MS: "100" } } }), {
      reconnectBaseDelayMs: 20
    });
    let connects = 0;
    manager.on("server_updated", ({ status }: { status: MCPServerStatus }) => {
      if (status.serverName === "flaky" && status.state === "connecting") {
        connects += 1;
      }
    });
    await manager.initialize();

    const gaveUp = await waitForServer(manager, "flaky", (status) => status.error?.code === "mcp_reconnect_gave_up");
    expect(gaveUp.state).toBe("failed");
    expect(gaveUp.error?.message).toContain("Gave up after 5 reconnect attempts");
    const after = connects;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(connects).toBe(after);
  });

  test("a connection that lasted earns a fresh set of reconnect attempts", async () => {
    const manager = startManager(await createConfig({ flaky: { env: { MCP_TEST_CRASH_AFTER_CONNECT_MS: "150" } } }), {
      reconnectBaseDelayMs: 20,
      stableConnectionMs: 50
    });
    let connections = 0;
    let gaveUp = false;
    manager.on("server_updated", ({ status }: { status: MCPServerStatus }) => {
      if (status.serverName !== "flaky") {
        return;
      }
      connections += status.state === "connected" ? 1 : 0;
      gaveUp ||= status.error?.code === "mcp_reconnect_gave_up";
    });
    await manager.initialize();

    await waitForServer(manager, "flaky", () => connections >= 7);
    expect(gaveUp).toBe(false);
  });

  test("a server that dies during the handshake shows its exit code and stderr, and is retried", async () => {
    const manager = startManager(await createConfig({ broken: { env: { MCP_TEST_CRASH_BEFORE_HANDSHAKE: "1" } } }), {
      reconnectBaseDelayMs: 20
    });
    await manager.initialize();

    const first = await waitForServer(manager, "broken", (status) => status.state === "failed");
    expect(first.error?.message).toContain("exited with code 5");
    expect(first.error?.message).toContain("fatal: the fixture could not start on purpose");
    // Retried on the schedule until it gives up, not left after one try.
    await waitForServer(manager, "broken", (status) => status.error?.code === "mcp_reconnect_gave_up");
  });

  test("one malformed tool, or one with a schema it cannot read, is skipped and the rest load", async () => {
    // The SDK checks a tools/list page as a whole, so one bad entry failed
    // the server; a malformed %-escape in a $ref threw a URIError the same way.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const manager = startManager(
        await createConfig({
          raw: {
            args: [path.resolve("tests/fixtures/mcp/raw-tools-server.mjs")],
            env: {
              MCP_RAW_TOOLS: JSON.stringify([
                { inputSchema: { type: "object" }, name: "good" },
                { inputSchema: "not a schema", name: 42 },
                {
                  inputSchema: { $defs: {}, properties: { a: { $ref: "#/$defs/%E0%A4%A" } }, type: "object" },
                  name: "odd_ref"
                }
              ])
            }
          }
        })
      );
      await manager.initialize();

      expect(statusOf(manager, "raw")?.state).toBe("connected");
      const names = manager.getToolCapabilities().map((tool) => tool.rawName);
      expect(names).toContain("good");
      expect(names).toContain("odd_ref");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("[AIA_MCP_TOOL_SKIPPED]"));
    } finally {
      warn.mockRestore();
    }
  });

  test("finished listings are never cancelled when their time budget runs out later", async () => {
    // A listing phase shared one AbortSignal.timeout; when it fired, after
    // the requests had finished, the SDK cancelled each of them anyway.
    const manager = startManager(
      await createConfig({
        raw: {
          args: [path.resolve("tests/fixtures/mcp/raw-tools-server.mjs")],
          env: { MCP_RAW_TOOLS: JSON.stringify([{ inputSchema: { type: "object" }, name: "cancellations" }]) },
          startupTimeoutMs: 200
        }
      })
    );
    await manager.initialize();
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(textOf(await manager.callTool("raw", "cancellations"))).toBe("0");
  });

  test("the tool limit counts what enabledTools leaves", async () => {
    const manager = startManager(
      await createConfig({ big: { enabledTools: ["echo"], env: { MCP_TEST_TOOL_COUNT: "2100" } } })
    );
    await manager.initialize();
    expect(statusOf(manager, "big")?.state).toBe("connected");
    expect(manager.getToolCapabilities().map((tool) => tool.rawName)).toEqual(["echo"]);
  });

  test("a call made while reconnect() is under way waits for it instead of failing", async () => {
    // During the close the slot said "connected" with no connection, and a
    // call then failed with "not connected (state: connected)".
    const manager = startManager(await createConfig({ busy: {} }));
    await manager.initialize();

    const reconnecting = manager.reconnect("busy");
    const result = await manager.callTool("busy", "echo", { text: "meanwhile" });

    expect(textOf(result)).toBe("echo:meanwhile");
    expect((await reconnecting).state).toBe("connected");
  });

  test("a call made while a reload replaces the server waits for the new connection", async () => {
    // The old connection takes a while to close. Meanwhile the slot used to
    // read "connected" with no connection, and a call failed with "not
    // connected (state: connected)".
    const config = await createConfig({ docs: { env: { MCP_TEST_LINGER_MS: "1000" } } });
    const manager = startManager(config);
    await manager.initialize();

    const changed = structuredClone(config);
    changed.mcp.servers.docs = { ...config.mcp.servers.docs!, description: "changed" };
    const reloading = manager.refresh(changed);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(statusOf(manager, "docs")?.state).toBe("connecting");
    const result = await manager.callTool("docs", "echo", { text: "meanwhile" });

    expect(textOf(result)).toBe("echo:meanwhile");
    await reloading;
  });

  test("reconnect() starts a server's connection again now", async () => {
    const manager = startManager(await createConfig({ docs: {} }));
    await manager.initialize();
    const before = manager.getGeneration();

    const status = await manager.reconnect("docs");

    expect(status.state).toBe("connected");
    expect(manager.getGeneration()).toBeGreaterThan(before);
    await expect(manager.reconnect("missing")).rejects.toThrow('No MCP server named "missing"');
  });

  test("a server that says its tools changed is listed again", async () => {
    const manager = startManager(await createConfig({ growing: {} }));
    await manager.initialize();
    expect(manager.getToolCapabilities().some((tool) => tool.name === "late")).toBe(false);

    const relisted = new Promise<void>((resolve) => {
      manager.on("server_updated", () => {
        if (manager.getToolCapabilities().some((tool) => tool.name === "late")) {
          resolve();
        }
      });
    });
    await manager.callTool("growing", "add_tool");
    await relisted;
  });

  test("tools, prompts and resources changed together are listed again once", async () => {
    // Each kind of list_changed notice used to list everything again on its
    // own: three full listings, three rebuilt catalogs, three updates.
    const manager = startManager(await createConfig({ growing: { env: { MCP_TEST_LISTS: "1" } } }));
    await manager.initialize();
    const relists: number[] = [];
    manager.on("server_updated", ({ previousState, status }) => {
      if (previousState === "connected" && status.state === "connected") {
        relists.push(status.capabilities.prompts);
      }
    });

    await manager.callTool("growing", "add_everything");
    await waitForServer(manager, "growing", (status) => status.capabilities.prompts === 2);
    // Long enough for any further relist the notices could have started.
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(relists).toEqual([2]);
    expect(statusOf(manager, "growing")?.capabilities).toMatchObject({ prompts: 2, resources: 2 });
    expect(manager.getToolCapabilities().some((tool) => tool.name === "late_tool")).toBe(true);
  });

  test("enabledTools and disabledTools decide what is listed, and are checked again at call time", async () => {
    const manager = startManager(
      await createConfig({ filtered: { disabledTools: ["env"], enabledTools: ["echo", "env"] } })
    );
    await manager.initialize();

    expect(
      manager
        .getToolCapabilities()
        .filter((tool) => tool.serverName === "filtered")
        .map((tool) => tool.name)
    ).toEqual(["echo"]);
    await expect(manager.callTool("filtered", "env", { name: "PATH" })).rejects.toThrow(
      'The tool "env" is disabled for MCP server "filtered"'
    );
  });

  test("the server's instructions reach its status and summary", async () => {
    const manager = startManager(
      await createConfig({ guided: { env: { MCP_TEST_INSTRUCTIONS: "Call echo before anything else." } } })
    );
    await manager.initialize();

    expect(statusOf(manager, "guided")?.instructions).toBe("Call echo before anything else.");
    expect(manager.summarizeServers()[0]?.instructions).toBe("Call echo before anything else.");
    expect(manager.getServerInstructions("guided")).toBe("Call echo before anything else.");
  });

  test("a stdio server gets the base allowlist, passEnv, and env, and nothing else", async () => {
    process.env.AIA_TEST_WITHHELD = "should-not-leak";
    process.env.AIA_TEST_PASSED = "passed-per-server";
    process.env.AIA_TEST_GLOBAL = "passed-globally";
    cleanups.push(async () => {
      delete process.env.AIA_TEST_WITHHELD;
      delete process.env.AIA_TEST_PASSED;
      delete process.env.AIA_TEST_GLOBAL;
    });
    const manager = startManager(
      await createConfig(
        { scoped: { env: { EXPLICIT: "from-config" }, passEnv: ["AIA_TEST_PASSED"] } },
        { passEnv: ["AIA_TEST_GLOBAL"] }
      )
    );
    await manager.initialize();

    const read = async (name: string) => textOf(await manager.callTool("scoped", "env", { name }));
    expect(await read("AIA_TEST_WITHHELD")).toBe("<unset>");
    expect(await read("AIA_TEST_PASSED")).toBe("passed-per-server");
    expect(await read("AIA_TEST_GLOBAL")).toBe("passed-globally");
    expect(await read("EXPLICIT")).toBe("from-config");
    expect(await read("PATH")).not.toBe("<unset>");
  });

  test("a tool call times out without progress, and progress keeps it going", async () => {
    const manager = startManager(await createConfig({ timed: { toolTimeoutMs: 600 } }));
    await manager.initialize();

    await expect(manager.callTool("timed", "slow", { ms: 1_500 })).rejects.toThrow(
      'The MCP server "timed" did not finish within 1 s without reporting progress'
    );
    expect(textOf(await manager.callTool("timed", "slow", { ms: 1_500, progress: true }))).toBe("slept:1500");
  });

  test("a question from the server pauses the call's clock and returns the operator's answer", async () => {
    const manager = startManager(await createConfig({ asking: { toolTimeoutMs: 400 } }));
    await manager.initialize();
    const seen: unknown[] = [];
    manager.setElicitationHandler(async (request) => {
      seen.push({ context: request.context, message: request.params.message, server: request.serverName });
      // Longer than the tool timeout: the clock must be stopped meanwhile.
      await new Promise((resolve) => setTimeout(resolve, 900));
      return { action: "accept", content: { count: 2, name: "Ada", ok: true } };
    });

    const result = await manager.callTool("asking", "ask", {}, { sessionId: "session.1", turnId: "turn.1" });

    expect(JSON.parse(textOf(result))).toEqual({ action: "accept", content: { count: 2, name: "Ada", ok: true } });
    expect(seen).toEqual([
      { context: { sessionId: "session.1", turnId: "turn.1" }, message: "Who is deploying?", server: "asking" }
    ]);
  });

  test("a question asked while calls from two sessions wait is declined, never shown to either", async () => {
    // It used to go to whichever call had started last, which could be the
    // other session's operator.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const manager = startManager(await createConfig({ shared: {} }));
      await manager.initialize();
      const asked: unknown[] = [];
      manager.setElicitationHandler(async (request) => {
        asked.push(request.context);
        return { action: "accept", content: { count: 1, name: "Ada", ok: true } };
      });

      const other = manager.callTool("shared", "slow", { ms: 1_500 }, { sessionId: "session.b", turnId: "turn.b" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const result = await manager.callTool("shared", "ask", {}, { sessionId: "session.a", turnId: "turn.a" });
      await other;

      expect(JSON.parse(textOf(result))).toEqual({ action: "decline" });
      expect(asked).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("[AIA_MCP_ELICITATION_AMBIGUOUS]"));
    } finally {
      warn.mockRestore();
    }
  });

  test("with nobody to answer, a server's question is declined", async () => {
    const manager = startManager(await createConfig({ asking: {} }));
    await manager.initialize();

    expect(JSON.parse(textOf(await manager.callTool("asking", "ask")))).toEqual({ action: "decline" });
  });

  test("a server that lists more than 2,048 tools fails to start", async () => {
    const manager = startManager(await createConfig({ huge: { env: { MCP_TEST_TOOL_COUNT: "2050" } } }));
    await manager.initialize();

    const status = await waitForServer(manager, "huge", (next) => next.state === "failed");
    expect(status.error?.message).toContain("at most 2048 are supported");
  });
});
