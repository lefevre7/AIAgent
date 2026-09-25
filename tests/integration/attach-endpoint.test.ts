import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  attachEndpointFilePath,
  attachEndpointsDirectory,
  readAttachEndpoint,
  serveAttachEndpoint
} from "@/gateway/attach-endpoint";
import type { GatewayRuntimeLike } from "@/gateway";

type WsClientLike = {
  close(): void;
  on(event: "open", listener: () => void): void;
  on(event: "unexpected-response", listener: (request: unknown, response: { statusCode?: number }) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
};

const loadModule = createRequire(import.meta.url);
const { WebSocket } = loadModule("ws") as { WebSocket: new (url: string) => WsClientLike };

const tempRoots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close().catch(() => undefined)));
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aia-attach-endpoint-"));
  tempRoots.push(root);
  return root;
}

function stubRuntime(): GatewayRuntimeLike {
  return {
    getApprovalRecord: async () => ({}) as never,
    getSessionSnapshot: async () => ({}) as never,
    listApprovalRecords: async () => [],
    replayEvents: async () => ({ events: [] }) as never,
    request: async () => ({}) as never,
    subscribe: () => () => undefined
  };
}

async function writeRecord(stateRoot: string, record: Record<string, unknown>, pid = record.pid as number) {
  await fs.mkdir(attachEndpointsDirectory(stateRoot), { recursive: true });
  await fs.writeFile(attachEndpointFilePath(stateRoot, pid), JSON.stringify(record), "utf8");
}

/** Resolves "open", or the HTTP status the upgrade was refused with. */
async function connect(url: string): Promise<"open" | number> {
  const client = new WebSocket(url);
  try {
    return await new Promise<"open" | number>((resolve, reject) => {
      client.on("open", () => resolve("open"));
      client.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
      client.on("error", reject);
    });
  } finally {
    client.close();
  }
}

// Without this listener, `aia attach` only worked while `npm run dev` was
// running: nothing else attaches the gateway WebSocket, so a window opened
// from a bare `aia` REPL died on ECONNREFUSED before showing anything.
describe("CLI attach endpoint", () => {
  test("publishes a loopback websocket URL that attach can discover", async () => {
    const stateRoot = await tempRoot();

    const served = await serveAttachEndpoint({
      runtime: stubRuntime(),
      stateRoot,
      websocketPath: "/api/gateway/ws"
    });
    expect(served).not.toBeNull();
    closers.push(() => served!.close());

    // Loopback only: this surface must not be reachable off this machine.
    expect(served!.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/api\/gateway\/ws$/u);

    const published = await readAttachEndpoint(stateRoot);
    expect(published?.url).toBe(served!.url);
    expect(published?.pid).toBe(process.pid);
  });

  // With no gateway token configured, this listener used to accept anyone on
  // loopback — including a web page, since browsers do not apply CORS to
  // WebSocket handshakes. It now demands a token minted for this launch.
  test("requires a per-launch token that only its owner can read", async () => {
    const stateRoot = await tempRoot();
    const served = await serveAttachEndpoint({ runtime: stubRuntime(), stateRoot, websocketPath: "/api/gateway/ws" });
    closers.push(() => served!.close());

    const published = await readAttachEndpoint(stateRoot);
    expect(published?.token).toBeTruthy();
    const mode = (await fs.stat(attachEndpointFilePath(stateRoot))).mode & 0o777;
    expect(mode).toBe(0o600);

    expect(await connect(served!.url)).toBe(401);
    expect(await connect(`${served!.url}?token=${encodeURIComponent(published!.token!)}`)).toBe("open");
  });

  test("uses a configured gateway token rather than publishing one", async () => {
    const stateRoot = await tempRoot();
    const served = await serveAttachEndpoint({
      runtime: stubRuntime(),
      stateRoot,
      token: "configured-secret",
      websocketPath: "/api/gateway/ws"
    });
    closers.push(() => served!.close());

    // A configured secret reaches `aia attach` through config; copying it into
    // the workspace would only spread it.
    expect((await readAttachEndpoint(stateRoot))?.token).toBeUndefined();
    expect(await connect(`${served!.url}?token=configured-secret`)).toBe("open");
  });

  test("binds an ephemeral port, so a running dev server does not block it", async () => {
    const stateRoot = await tempRoot();

    const first = await serveAttachEndpoint({ runtime: stubRuntime(), stateRoot, websocketPath: "/api/gateway/ws" });
    const second = await serveAttachEndpoint({
      runtime: stubRuntime(),
      stateRoot: await tempRoot(),
      websocketPath: "/api/gateway/ws"
    });
    closers.push(
      () => first!.close(),
      () => second!.close()
    );

    expect(first!.url).not.toBe(second!.url);
  });

  test("removes its published record on close", async () => {
    const stateRoot = await tempRoot();

    const served = await serveAttachEndpoint({ runtime: stubRuntime(), stateRoot, websocketPath: "/api/gateway/ws" });
    await served!.close();

    await expect(fs.access(attachEndpointFilePath(stateRoot))).rejects.toThrow();
    await expect(readAttachEndpoint(stateRoot)).resolves.toBeNull();
  });

  // One record used to serve the whole workspace: a second CLI replaced the
  // first's endpoint and then deleted it on exit.
  test("keeps one record per process, so another CLI's record is neither replaced nor removed", async () => {
    const stateRoot = await tempRoot();
    const otherCli = {
      createdAt: "2026-03-31T12:00:00.000Z",
      // The test runner's parent: alive and owned by this user.
      pid: process.ppid,
      token: "other-cli-token",
      url: "ws://127.0.0.1:1/api/gateway/ws"
    };
    await writeRecord(stateRoot, otherCli);

    const served = await serveAttachEndpoint({ runtime: stubRuntime(), stateRoot, websocketPath: "/api/gateway/ws" });
    expect((await readAttachEndpoint(stateRoot))?.url).toBe(served!.url);
    await expect(readAttachEndpoint(stateRoot, { url: otherCli.url })).resolves.toEqual(otherCli);

    await served!.close();
    await expect(readAttachEndpoint(stateRoot)).resolves.toEqual(otherCli);
  });

  // A crashed CLI leaves its file behind. Reporting a dead listener would send
  // the window to a confusing connection error instead of a clear one.
  test("ignores a record whose process is gone", async () => {
    const stateRoot = await tempRoot();
    await writeRecord(stateRoot, {
      createdAt: "2026-03-31T12:00:00.000Z",
      // A pid that cannot be running: the kernel reserves it.
      pid: 999_999_999,
      url: "ws://127.0.0.1:1/api/gateway/ws"
    });

    await expect(readAttachEndpoint(stateRoot)).resolves.toBeNull();
  });

  // The state root sits inside the workspace, so a cloned repository can ship
  // a record, and `aia attach` sends the gateway token wherever it points.
  test.skipIf(process.getuid?.() === 0)("does not trust a record naming another user's process", async () => {
    const stateRoot = await tempRoot();
    // pid 1 belongs to root: signalling it fails with EPERM, which used to read as alive.
    await writeRecord(stateRoot, { createdAt: "2026-03-31T12:00:00.000Z", pid: 1, url: "ws://127.0.0.1:1/ws" });

    await expect(readAttachEndpoint(stateRoot)).resolves.toBeNull();
  });

  test("does not trust a record pointing anywhere but a loopback ws:// URL", async () => {
    const stateRoot = await tempRoot();
    for (const [pid, url] of [
      [process.pid, "wss://attacker.example/collect"],
      [process.ppid, "ws://192.0.2.1:3000/api/gateway/ws"]
    ] as const) {
      await writeRecord(stateRoot, { createdAt: "2026-03-31T12:00:00.000Z", pid, url });
    }

    await expect(readAttachEndpoint(stateRoot)).resolves.toBeNull();
  });

  test("reports nothing when no CLI has published an endpoint", async () => {
    await expect(readAttachEndpoint(await tempRoot())).resolves.toBeNull();
  });

  test("a damaged record reads as absent rather than throwing", async () => {
    const stateRoot = await tempRoot();
    await fs.mkdir(attachEndpointsDirectory(stateRoot), { recursive: true });
    await fs.writeFile(attachEndpointFilePath(stateRoot), "{ not json", "utf8");

    await expect(readAttachEndpoint(stateRoot)).resolves.toBeNull();
  });
});
