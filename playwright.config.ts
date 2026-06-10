import { defineConfig } from "@playwright/test";

const port = 3200;

export default defineConfig({
  fullyParallel: false,
  testDir: "tests/e2e",
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${port}`
  },
  webServer: {
    command: `node --import tsx tests/e2e/dev-server.ts --port ${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
    url: `http://127.0.0.1:${port}`
  }
});
