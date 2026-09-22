import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { attachEndpointFilePath, readAttachEndpoint, serveAttachEndpoint } from "@/gateway/attach-endpoint";
import type { GatewayRuntimeLike } from "@/gateway";

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

    // Loopback only: this surface is unauthenticated when no token is set.
    expect(served!.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/api\/gateway\/ws$/u);

    const published = await readAttachEndpoint(stateRoot);
    expect(published?.url).toBe(served!.url);
    expect(published?.pid).toBe(process.pid);
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

  // A crashed CLI leaves its file behind. Reporting a dead listener would send
  // the window to a confusing connection error instead of a clear one.
  test("ignores a record whose process is gone", async () => {
    const stateRoot = await tempRoot();
    await fs.mkdir(stateRoot, { recursive: true });
    await fs.writeFile(
      attachEndpointFilePath(stateRoot),
      JSON.stringify({
        createdAt: "2026-03-31T12:00:00.000Z",
        // A pid that cannot be running: the kernel reserves it.
        pid: 999_999_999,
        url: "ws://127.0.0.1:1/api/gateway/ws"
      }),
      "utf8"
    );

    await expect(readAttachEndpoint(stateRoot)).resolves.toBeNull();
  });

  test("reports nothing when no CLI has published an endpoint", async () => {
    await expect(readAttachEndpoint(await tempRoot())).resolves.toBeNull();
  });

  test("a damaged record reads as absent rather than throwing", async () => {
    const stateRoot = await tempRoot();
    await fs.mkdir(stateRoot, { recursive: true });
    await fs.writeFile(attachEndpointFilePath(stateRoot), "{ not json", "utf8");

    await expect(readAttachEndpoint(stateRoot)).resolves.toBeNull();
  });
});
