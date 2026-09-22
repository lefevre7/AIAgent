import { describe, expect, it } from "vitest";

import { buildExternalAgentEnvironment, listBaseEnvironmentAllowlist } from "@/core/external-agents/environment";

const processEnv = {
  AWS_SECRET_ACCESS_KEY: "should-not-leak",
  DATABASE_URL: "postgres://should-not-leak",
  HOME: "/Users/tester",
  LANG: "en_US.UTF-8",
  OPENAI_API_KEY: "sk-opted-in",
  PATH: "/usr/bin:/bin",
  TERM: "xterm-256color"
};

describe("buildExternalAgentEnvironment", () => {
  it("passes the base floor through and withholds everything else", () => {
    const env = buildExternalAgentEnvironment({
      config: { env: {}, passEnv: [] },
      processEnv
    });

    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.HOME).toBe("/Users/tester");
    expect(env.TERM).toBe("xterm-256color");
    expect(env.LANG).toBe("en_US.UTF-8");
    // The whole point: an external agent runs with its own approvals bypassed,
    // so unrelated credentials in the operator's shell must not ride along.
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("adds exactly the keys the agent opted into via passEnv", () => {
    const env = buildExternalAgentEnvironment({
      config: { env: {}, passEnv: ["OPENAI_API_KEY"] },
      processEnv
    });

    expect(env.OPENAI_API_KEY).toBe("sk-opted-in");
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("skips passEnv keys that are not set, rather than defining them empty", () => {
    const env = buildExternalAgentEnvironment({
      config: { env: {}, passEnv: ["ANTHROPIC_API_KEY"] },
      processEnv
    });

    expect("ANTHROPIC_API_KEY" in env).toBe(false);
  });

  it("applies config env over passEnv, and overrides over both", () => {
    const env = buildExternalAgentEnvironment({
      config: { env: { OPENAI_API_KEY: "from-config", VIBE_HOME: "/opt/vibe" }, passEnv: ["OPENAI_API_KEY"] },
      overrides: { OPENAI_API_KEY: "from-override" },
      processEnv
    });

    expect(env.VIBE_HOME).toBe("/opt/vibe");
    expect(env.OPENAI_API_KEY).toBe("from-override");
  });

  it("keeps the floor a floor", () => {
    // These decide whether the child runs at all: binaries, its own config
    // directory, PTY rendering, and byte decoding. Dropping one turns
    // "restricted" into "broken".
    for (const key of ["HOME", "LANG", "PATH", "TERM"]) {
      expect(listBaseEnvironmentAllowlist()).toContain(key);
    }
  });
});
