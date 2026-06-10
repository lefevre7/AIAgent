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
    hookTimeout: 300_000,
    include: ["tests/live/**/*.test.ts"],
    testTimeout: 300_000
  }
});
