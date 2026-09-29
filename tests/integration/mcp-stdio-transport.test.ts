import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { ProcessGroupStdioClientTransport } from "@/core/mcp/stdio-transport";

const posixTest = process.platform === "win32" ? test.skip : test;
const tempRoots: string[] = [];
const transports: ProcessGroupStdioClientTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map(async (transport) => transport.close().catch(() => undefined)));
  await Promise.all(tempRoots.splice(0).map(async (root) => fs.rm(root, { force: true, recursive: true })));
});

describe("stdio MCP transport", () => {
  // A terminal's Ctrl-C signals aia's whole process group. With the SDK's
  // transport that group included every stdio MCP server, so cancelling a
  // turn killed them, and nothing reconnected them for the rest of the session.
  posixTest("starts the server in its own process group and stops that group on close", async () => {
    const transport = new ProcessGroupStdioClientTransport({
      args: [path.resolve("tests/fixtures/mcp/stdio-server.mjs")],
      command: process.execPath,
      stderr: "pipe"
    });
    transports.push(transport);
    const client = new Client({ name: "stdio-transport-test", version: "1.0.0" });
    await client.connect(transport);

    const pid = transport.pid;
    expect(pid).toBeTypeOf("number");
    expect(processGroupOf(pid!)).toBe(pid);
    expect(processGroupOf(pid!)).not.toBe(processGroupOf(process.pid));
    await expect(client.listTools()).resolves.toHaveProperty("tools");

    await client.close();
    expect(isAlive(pid!)).toBe(false);
  });

  // The SDK pipes stderr into a stream nothing reads: once about 80 KB had
  // piled up, a server that writes stderr synchronously (as most non-Node
  // servers do) blocked on its next write and stopped answering.
  posixTest("keeps a server that floods stderr answering", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "aia-stdio-transport-"));
    tempRoots.push(root);
    const script = path.join(root, "noisy.mjs");
    await fs.writeFile(
      script,
      [
        'import fs from "node:fs";',
        'const line = "x".repeat(1023) + "\\n";',
        "for (let index = 0; index < 512; index += 1) fs.writeSync(2, line);",
        'fs.writeSync(1, JSON.stringify({ jsonrpc: "2.0", method: "notifications/ready" }) + "\\n");',
        "setInterval(() => {}, 1000);"
      ].join("\n"),
      "utf8"
    );
    const transport = new ProcessGroupStdioClientTransport({
      args: [script],
      command: process.execPath,
      stderr: "pipe"
    });
    transports.push(transport);

    const received = new Promise<unknown>((resolve) => {
      transport.onmessage = (message) => {
        resolve(message);
      };
    });
    await transport.start();

    await expect(
      Promise.race([
        received,
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("no message within 5s")), 5_000))
      ])
    ).resolves.toEqual({ jsonrpc: "2.0", method: "notifications/ready" });
    expect(transport.recentStderr.length).toBeGreaterThan(0);
    expect(transport.recentStderr.length).toBeLessThanOrEqual(8_192);
  });
});

function processGroupOf(pid: number): number {
  return Number.parseInt(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim(), 10);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
