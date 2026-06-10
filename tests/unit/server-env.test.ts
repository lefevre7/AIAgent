import { describe, expect, test } from "vitest";

import { resolveServerRuntimeConfig } from "@/server/env";

describe("server env", () => {
  test("defaults dev from NODE_ENV and uses metadata defaults", () => {
    const config = resolveServerRuntimeConfig([], { NODE_ENV: "development" });
    expect(config.dev).toBe(true);
    expect(config.hostname).toBeTruthy();
    expect(config.port).toBeGreaterThan(0);
  });

  test("disables dev under production", () => {
    const config = resolveServerRuntimeConfig([], { NODE_ENV: "production" });
    expect(config.dev).toBe(false);
  });

  test("honors CLI flags over environment", () => {
    const config = resolveServerRuntimeConfig(["--dev", "--hostname", "0.0.0.0", "--port", "4321"], {
      HOSTNAME: "ignored",
      NODE_ENV: "production",
      PORT: "9999"
    });
    expect(config).toEqual({ dev: true, hostname: "0.0.0.0", port: 4321 });
  });

  test("falls back to environment hostname and port", () => {
    const config = resolveServerRuntimeConfig([], { HOSTNAME: "example.test", NODE_ENV: "production", PORT: "8080" });
    expect(config).toEqual({ dev: false, hostname: "example.test", port: 8080 });
  });
});
