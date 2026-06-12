import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // App-router pages rely on the automatic JSX runtime (no explicit React
  // import); use it so those modules can be imported under test.
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react"
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src")
    }
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
    name: "unit",
    setupFiles: ["tests/setup/unit.ts"]
  }
});

