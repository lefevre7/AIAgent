import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { loadImportedMcpServers, sanitizeMcpInvocationName, slugify } from "@/core";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function writeImport(name: string, value: unknown): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-mcp-imports-"));
  tempRoots.push(root);
  const filePath = path.join(root, name);
  await fs.writeFile(filePath, JSON.stringify(value), "utf8");
  return filePath;
}

type ImportEntry = Parameters<typeof loadImportedMcpServers>[0][string];

function entry(overrides: Partial<ImportEntry> & Pick<ImportEntry, "format" | "path">): ImportEntry {
  return { enabled: true, watch: false, ...overrides } as ImportEntry;
}

describe("loadImportedMcpServers", () => {
  test("skips disabled imports and missing files", async () => {
    const present = await writeImport("servers.json", { mcpServers: { a: { command: "node" } } });
    const result = await loadImportedMcpServers({
      disabledImport: entry({ enabled: false, format: "claude_desktop", path: present }),
      missingImport: entry({ format: "claude_desktop", path: path.join(os.tmpdir(), "does-not-exist-xyz.json") })
    });
    expect(result.files).toEqual([]);
    expect(result.servers).toEqual({});
  });

  test("normalizes stdio and http servers from a claude_desktop file with provenance", async () => {
    const filePath = await writeImport("claude.json", {
      mcpServers: {
        disabledServer: { command: "x", disabled: true },
        invalidServer: { note: "no command or url" },
        remote: {
          headers: { Authorization: "Bearer t", bad: 5 },
          required: true,
          tags: ["remote", 7],
          type: "sse",
          url: "https://mcp.example.com"
        },
        scriptServer: {
          args: ["server.js", 42],
          command: "node",
          env: { TOKEN: "abc", numeric: 1 },
          timeout: 30,
          working_directory: "/srv"
        }
      }
    });

    const result = await loadImportedMcpServers({
      primary: entry({ format: "claude_desktop", path: filePath })
    });

    expect(result.files).toEqual([filePath]);
    expect(Object.keys(result.servers).sort()).toEqual(["disabledServer", "remote", "scriptServer"]);

    const script = result.servers.scriptServer;
    expect(script).toMatchObject({
      args: ["server.js"],
      command: "node",
      cwd: "/srv",
      enabled: true,
      env: { TOKEN: "abc" },
      provenance: { importId: "primary", source: "import" },
      timeoutMs: 30000,
      type: "stdio"
    });

    expect(result.servers.disabledServer).toMatchObject({ enabled: false, type: "stdio" });

    expect(result.servers.remote).toMatchObject({
      headers: { Authorization: "Bearer t" },
      required: true,
      tags: ["remote"],
      type: "sse",
      url: "https://mcp.example.com"
    });
  });

  test("reads top-level servers for the generic format and honors timeoutMs/url aliases", async () => {
    const filePath = await writeImport("generic.json", {
      httpServer: { httpUrl: "https://h.example.com", type: "streamableHttp" },
      sseServer: { serverUrl: "https://s.example.com", timeoutMs: 1234 }
    });

    const result = await loadImportedMcpServers({
      gen: entry({ format: "generic_mcp_servers_json", path: filePath })
    });

    expect(result.servers.httpServer).toMatchObject({ type: "streamable-http", url: "https://h.example.com" });
    expect(result.servers.sseServer).toMatchObject({ timeoutMs: 1234, type: "auto", url: "https://s.example.com" });
  });

  test("returns no servers when a non-generic file lacks an mcpServers wrapper", async () => {
    const filePath = await writeImport("roo.json", { topLevel: { command: "node" } });
    const result = await loadImportedMcpServers({
      roo: entry({ format: "roo_project", path: filePath })
    });
    expect(result.servers).toEqual({});
  });
});

describe("mcp invocation names", () => {
  test("builds prefixed snake-case names", () => {
    expect(sanitizeMcpInvocationName("GitHub", "Create Issue")).toBe("mcp_github_create_issue");
  });

  test("hashes overly long names down to 64 characters", () => {
    const name = sanitizeMcpInvocationName("a".repeat(60), "b".repeat(60));
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.startsWith("mcp_")).toBe(true);
  });

  test("slugify normalizes and falls back to mcp", () => {
    expect(slugify("  Hello World!! ")).toBe("hello_world");
    expect(slugify("***")).toBe("mcp");
    expect(slugify("Keep-This_one")).toBe("keep-this_one");
  });
});
