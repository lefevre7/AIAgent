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
});
