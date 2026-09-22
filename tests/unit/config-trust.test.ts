import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  collectTrustGatedProviderNames,
  fingerprintConfigContents,
  fingerprintConfigFile,
  grantConfigTrust,
  isConfigTrusted,
  readConfigTrustStore,
  revokeConfigTrust
} from "@/core/config/trust";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-config-trust-"));
  tempRoots.push(root);
  return root;
}

describe("workspace config trust (security review H3)", () => {
  describe("collectTrustGatedProviderNames", () => {
    test("names exec and file providers, which can run commands or read arbitrary paths", () => {
      expect(
        collectTrustGatedProviderNames({
          secrets: {
            providers: {
              payload: { command: "./payload.sh", source: "exec" },
              keyfile: { path: "/Users/someone/.ssh/id_rsa", source: "file" }
            }
          }
        })
      ).toEqual(["keyfile", "payload"]);
    });

    test("ignores env providers, which can only read the environment we already have", () => {
      expect(
        collectTrustGatedProviderNames({ secrets: { providers: { env: { source: "env" } } } })
      ).toEqual([]);
    });

    test("tolerates fragments with no secrets section at all", () => {
      expect(collectTrustGatedProviderNames(null)).toEqual([]);
      expect(collectTrustGatedProviderNames({})).toEqual([]);
      expect(collectTrustGatedProviderNames({ secrets: {} })).toEqual([]);
    });
  });

  test("grants, recognizes, and revokes trust for one exact file", async () => {
    const root = await tempRoot();
    const configPath = path.join(root, "aia.config.jsonc");
    await fs.writeFile(configPath, '{ "configVersion": 1 }', "utf8");

    const fingerprint = await fingerprintConfigFile(configPath);
    expect(fingerprint).not.toBeNull();

    expect(isConfigTrusted(await readConfigTrustStore(root), fingerprint!)).toBe(false);

    await grantConfigTrust(root, fingerprint!);
    expect(isConfigTrusted(await readConfigTrustStore(root), fingerprint!)).toBe(true);

    await revokeConfigTrust(root, configPath);
    expect(isConfigTrusted(await readConfigTrustStore(root), fingerprint!)).toBe(false);
  });

  // The whole point of hashing contents: a repo you trusted once must not be
  // able to grow an `exec` provider afterwards and inherit the old grant.
  test("editing a trusted config revokes its trust", async () => {
    const root = await tempRoot();
    const configPath = path.join(root, "aia.config.jsonc");
    await fs.writeFile(configPath, '{ "configVersion": 1 }', "utf8");

    const original = await fingerprintConfigFile(configPath);
    await grantConfigTrust(root, original!);
    expect(isConfigTrusted(await readConfigTrustStore(root), original!)).toBe(true);

    await fs.writeFile(
      configPath,
      '{ "configVersion": 1, "secrets": { "providers": { "x": { "source": "exec", "command": "./payload.sh" } } } }',
      "utf8"
    );
    const edited = await fingerprintConfigFile(configPath);

    expect(edited!.sha256).not.toBe(original!.sha256);
    expect(isConfigTrusted(await readConfigTrustStore(root), edited!)).toBe(false);
  });

  test("re-granting replaces the previous hash rather than leaving both valid", async () => {
    const root = await tempRoot();
    const configPath = path.join(root, "aia.config.jsonc");

    const first = fingerprintConfigContents(configPath, "one");
    const second = fingerprintConfigContents(configPath, "two");

    await grantConfigTrust(root, first);
    await grantConfigTrust(root, second);

    const store = await readConfigTrustStore(root);
    expect(store.trustedConfigs).toHaveLength(1);
    expect(isConfigTrusted(store, second)).toBe(true);
    expect(isConfigTrusted(store, first)).toBe(false);
  });

  // Corruption must not become a bypass.
  test("a damaged trust store fails closed instead of trusting everything", async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, "trust.json"), "{ not json", "utf8");

    const store = await readConfigTrustStore(root);
    expect(store.trustedConfigs).toEqual([]);
    expect(isConfigTrusted(store, fingerprintConfigContents("/anything", "x"))).toBe(false);
  });

  // Caught by running `aia trust --revoke` for real: the grant was keyed on
  // the realpath while the revoke resolved the symlinked spelling, so revoke
  // printed success and removed nothing. A revoke that silently does nothing
  // is the dangerous direction for a trust store.
  test("revokes trust granted through a symlinked path", async () => {
    const root = await tempRoot();
    const realDir = path.join(root, "real");
    const linkDir = path.join(root, "link");
    await fs.mkdir(realDir, { recursive: true });
    await fs.symlink(realDir, linkDir);

    const realConfig = path.join(realDir, "aia.config.jsonc");
    await fs.writeFile(realConfig, '{ "configVersion": 1 }', "utf8");

    const viaLink = await fingerprintConfigFile(path.join(linkDir, "aia.config.jsonc"));
    const viaReal = await fingerprintConfigFile(realConfig);
    // Both spellings must produce one canonical key.
    expect(viaLink!.path).toBe(viaReal!.path);

    await grantConfigTrust(root, viaLink!);
    expect(isConfigTrusted(await readConfigTrustStore(root), viaReal!)).toBe(true);

    await revokeConfigTrust(root, path.join(linkDir, "aia.config.jsonc"));
    expect(isConfigTrusted(await readConfigTrustStore(root), viaReal!)).toBe(false);
  });

  test("fingerprinting a missing file reports absence rather than throwing", async () => {
    const root = await tempRoot();
    await expect(fingerprintConfigFile(path.join(root, "nope.jsonc"))).resolves.toBeNull();
  });
});
