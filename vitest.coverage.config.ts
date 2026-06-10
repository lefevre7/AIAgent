import path from "node:path";
import { defineConfig } from "vitest/config";

// Aggregates coverage across the unit (jsdom) and integration (node) projects.
// Each referenced project keeps its own environment and setup files.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  },
  test: {
    coverage: {
      // Per project decision: exclude only the config directory from the
      // denominator. Type-only declarations carry no executable lines.
      exclude: ["src/**/*.d.ts", "src/core/config/**"],
      include: ["src/**/*.{ts,tsx}"],
      provider: "v8",
      reporter: ["text-summary", "text"],
      reportsDirectory: "./coverage",
      // Enforced floor for the deterministic (unit + integration) suites. Set
      // just under the current measured coverage so regressions fail the gate,
      // and ratchet upward as more deterministic tests land. See docs/TESTING.md
      // for the categories that are intentionally lower (native/macOS voice,
      // server entrypoints, e2e-only web/gateway-HTTP, network adapters).
      thresholds: {
        branches: 73,
        functions: 79,
        lines: 74,
        statements: 74
      }
    },
    projects: ["vitest.unit.config.ts", "vitest.integration.config.ts"]
  }
});
