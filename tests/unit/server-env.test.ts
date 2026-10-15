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

  // The config's gateway.hostname/port used to be ignored here, so a
  // configured port changed what `aia info` printed and where `aia attach`
  // dialled while the server kept listening on the default.
  test("listens where the config says when neither flags nor the environment say otherwise", () => {
    const config = resolveServerRuntimeConfig([], { NODE_ENV: "production" }, { hostname: "127.0.0.2", port: 4100 });
    expect(config).toEqual({ dev: false, hostname: "127.0.0.2", port: 4100 });
  });

  test("still lets flags and the environment override the config", () => {
    const gateway = { hostname: "127.0.0.2", port: 4100 };
    expect(resolveServerRuntimeConfig(["--port", "4200"], { NODE_ENV: "production" }, gateway).port).toBe(4200);
    expect(resolveServerRuntimeConfig([], { NODE_ENV: "production", PORT: "4300" }, gateway).port).toBe(4300);
    expect(resolveServerRuntimeConfig([], { HOSTNAME: "127.0.0.3", NODE_ENV: "production" }, gateway).hostname).toBe(
      "127.0.0.3"
    );
  });
});
