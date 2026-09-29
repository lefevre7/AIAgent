import { afterEach, describe, expect, test, vi } from "vitest";

import {
  closeServerRuntimeContext,
  getServerRuntimeContext,
  primeServerRuntimeContext,
  type ServerRuntimeContext
} from "@/server/runtime-context";

afterEach(async () => {
  await closeServerRuntimeContext();
});

function fakeContext() {
  const channelClose = vi.fn(async () => undefined);
  const gatewayClose = vi.fn(async () => undefined);
  const context = {
    channelService: { close: channelClose },
    gatewayRuntime: { close: gatewayClose }
  } as unknown as ServerRuntimeContext;
  return { channelClose, context, gatewayClose };
}

describe("server runtime context singleton", () => {
  test("closing with nothing primed is a no-op", async () => {
    await expect(closeServerRuntimeContext()).resolves.toBeUndefined();
  });

  test("primes, returns the cached context, and closes it", async () => {
    const { channelClose, context, gatewayClose } = fakeContext();
    primeServerRuntimeContext(context);

    await expect(getServerRuntimeContext()).resolves.toBe(context);

    await closeServerRuntimeContext();
    expect(channelClose).toHaveBeenCalledOnce();
    expect(gatewayClose).toHaveBeenCalledOnce();

    // after close, a second close is a no-op again
    await expect(closeServerRuntimeContext()).resolves.toBeUndefined();
  });

  // Next compiles pages into their own bundle, with its own copy of this
  // module. The page's copy found no context and built a second runtime: a
  // second gateway, MCP manager (duplicate MCP processes) and channel pollers.
  test("every copy of the module shares the context", async () => {
    const first = fakeContext();
    primeServerRuntimeContext(first.context);
    vi.resetModules();
    const secondCopy = await import("@/server/runtime-context");

    await secondCopy.closeServerRuntimeContext();
    expect(first.gatewayClose).toHaveBeenCalledOnce();

    const second = fakeContext();
    secondCopy.primeServerRuntimeContext(second.context);
    await expect(getServerRuntimeContext()).resolves.toBe(second.context);
  });
});
