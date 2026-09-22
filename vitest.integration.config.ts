import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/integration/**/*.test.ts"],
    name: "integration",
    // Integration tests spawn real child processes, and several now spawn real
    // PTYs (the command runtime and interactive external agents share one
    // process primitive). Under the full suite's parallelism a native PTY spawn
    // plus a Node child's startup routinely exceeds vitest's 5s default, which
    // showed up as timeouts that never reproduced when a file ran alone. The
    // product's own timeouts still bound every wait; this only stops the
    // harness from calling a slow machine a failure.
    testTimeout: 30_000
  }
});
