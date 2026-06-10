import { defineConfig } from "tsup";

export default defineConfig([
  {
    clean: true,
    dts: true,
    entry: {
      "core/index": "src/core/index.ts",
      "gateway/index": "src/gateway/index.ts",
      index: "src/index.ts",
      "sdk/index": "src/sdk/index.ts",
      "server/index": "src/server/index.ts"
    },
    format: ["esm"],
    outDir: "dist",
    sourcemap: true,
    splitting: false,
    target: "node22"
  },
  {
    banner: {
      js: "#!/usr/bin/env node"
    },
    clean: false,
    dts: false,
    entry: {
      cli: "src/cli.ts",
      "server/start": "src/server/start.ts"
    },
    format: ["esm"],
    outDir: "dist",
    sourcemap: true,
    splitting: false,
    target: "node22"
  }
]);
