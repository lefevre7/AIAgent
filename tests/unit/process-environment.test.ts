import { describe, expect, test } from "vitest";

import { buildChildProcessEnvironment, listBaseEnvironmentAllowlist } from "@/core";

const processEnv = {
  AWS_SECRET_ACCESS_KEY: "should-not-leak",
  HOME: "/Users/tester",
  LC_MESSAGES: "en_US.UTF-8",
  NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem",
  PATH: "/usr/bin",
  REQUESTS_CA_BUNDLE: "/etc/corp-ca.pem",
  TOKEN: "opted-in",
  __CF_USER_TEXT_ENCODING: "0x1F5:0:0",
  https_proxy: "http://proxy:8080"
};

describe("buildChildProcessEnvironment", () => {
  test("passes the floor (locale categories, proxies, CA bundles) and nothing else", () => {
    expect(buildChildProcessEnvironment({ platform: "darwin", processEnv })).toEqual({
      HOME: "/Users/tester",
      LC_MESSAGES: "en_US.UTF-8",
      NODE_EXTRA_CA_CERTS: "/etc/corp-ca.pem",
      PATH: "/usr/bin",
      REQUESTS_CA_BUNDLE: "/etc/corp-ca.pem",
      __CF_USER_TEXT_ENCODING: "0x1F5:0:0",
      https_proxy: "http://proxy:8080"
    });
  });

  test("adds the passEnv names that are set, then explicit values over everything", () => {
    const env = buildChildProcessEnvironment({
      env: { HOME: "/override", NEW: "value" },
      passEnv: ["TOKEN", "NOT_SET"],
      processEnv
    });
    expect(env.TOKEN).toBe("opted-in");
    expect("NOT_SET" in env).toBe(false);
    expect(env.HOME).toBe("/override");
    expect(env.NEW).toBe("value");
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  test("keeps Codex's CA-bundle names on the floor", () => {
    for (const name of ["CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "SSL_CERT_FILE", "npm_config_cafile"]) {
      expect(listBaseEnvironmentAllowlist()).toContain(name);
    }
  });

  test("passes the locale categories by name, not every LC_ variable", () => {
    // sshd forwards LC_* by default, so a name starting with LC_ says nothing
    // about what it holds.
    const env = buildChildProcessEnvironment({
      platform: "linux",
      processEnv: { LANGUAGE: "en", LC_ALL: "C.UTF-8", LC_TERMINAL: "iTerm2", LC_VAULT_TOKEN: "s.secret" }
    });
    expect(env).toEqual({ LANGUAGE: "en", LC_ALL: "C.UTF-8" });
  });

  test("on Windows, matches names in any case and passes what a process needs to start", () => {
    const windowsEnv = {
      AWS_SECRET_ACCESS_KEY: "should-not-leak",
      ComSpec: "C:\\Windows\\system32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      Path: "C:\\Windows\\system32",
      SystemRoot: "C:\\Windows",
      Token: "opted-in",
      USERPROFILE: "C:\\Users\\tester"
    };
    // In one case, so the SDK's own defaults (PATH) replace rather than sit
    // beside them (Path).
    expect(
      buildChildProcessEnvironment({
        env: { Path: "C:\\explicit" },
        passEnv: ["TOKEN"],
        platform: "win32",
        processEnv: windowsEnv
      })
    ).toEqual({
      COMSPEC: windowsEnv.ComSpec,
      PATH: "C:\\explicit",
      PATHEXT: windowsEnv.PATHEXT,
      SYSTEMROOT: windowsEnv.SystemRoot,
      TOKEN: "opted-in",
      USERPROFILE: windowsEnv.USERPROFILE
    });
    // Elsewhere names are case-sensitive, and the Windows names are not on the floor.
    expect(buildChildProcessEnvironment({ passEnv: ["TOKEN"], platform: "linux", processEnv: windowsEnv })).toEqual({});
    expect(listBaseEnvironmentAllowlist("linux")).not.toContain("SYSTEMROOT");
  });
});
