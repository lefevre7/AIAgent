import { describe, expect, test, vi } from "vitest";

// Stand-ins for the two heavy pieces: Next itself, and the runtime context that
// owns pollers and MCP children (the part that keeps the event loop alive).
const { closeServerRuntimeContext, prepare } = vi.hoisted(() => ({
  closeServerRuntimeContext: vi.fn(async () => undefined),
  prepare: vi.fn(async () => undefined)
}));

vi.mock("next", () => ({
  default: () => ({
    getRequestHandler: () => async () => undefined,
    getUpgradeHandler: () => () => undefined,
    prepare
  })
}));

vi.mock("@/server/runtime-context", () => ({
  closeServerRuntimeContext,
  createServerRuntimeContext: async () => ({
    gatewayAuthToken: undefined,
    loaded: {
      resolvedConfig: { gateway: { requestTimeoutMs: 1_000, websocketPath: "/ws" }, tunnel: { enabled: false } }
    }
  }),
  primeServerRuntimeContext: () => undefined
}));

import { startServer } from "@/server/start";

// Only the exposure refusal used to tear the context down. The entry point
// catches startup errors and only sets exitCode, so a failure after the
// context was up (a production start with no web build, for one) printed the
// error and then left the process running on the context's pollers and MCP
// children.
describe("startServer", () => {
  test("tears the runtime context down when startup fails after it is up", async () => {
    prepare.mockRejectedValueOnce(new Error("Could not find a production build in the '.next' directory."));

    await expect(startServer(["--hostname", "127.0.0.1", "--port", "3999"])).rejects.toThrow(/production build/u);
    expect(closeServerRuntimeContext).toHaveBeenCalledOnce();
  });

  test("still tears it down when the exposure check refuses to start", async () => {
    closeServerRuntimeContext.mockClear();

    await expect(startServer(["--hostname", "0.0.0.0", "--port", "3999"])).rejects.toThrow(/gateway\.auth\.token/u);
    expect(closeServerRuntimeContext).toHaveBeenCalledOnce();
  });
});
