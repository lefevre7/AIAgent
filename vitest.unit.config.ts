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
    setupFiles: ["tests/setup/unit.ts"],
    // Matches the integration project. A few unit tests spawn real macOS
    // helpers (`say`, the native voice helper); under V8 coverage
    // instrumentation those exceed vitest's 5s default, which made
    // `npm run test:coverage` fail intermittently while `npm run test:unit`
    // passed. The product's own timeouts still bound every wait.
    testTimeout: 30_000
  }
});
