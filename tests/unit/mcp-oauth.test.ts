import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  isMcpLoginRequiredError,
  McpCredentialsStore,
  McpLoginRequiredError,
  mcpOAuthCallbackPath,
  StoredMcpOAuthProvider
} from "@/core";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function createStore(): Promise<McpCredentialsStore> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-mcp-oauth-"));
  tempRoots.push(root);
  return new McpCredentialsStore(path.join(root, ".aia", "mcp-credentials.json"));
}

describe("McpCredentialsStore", () => {
  test("keeps tokens per server and URL, in a file only the owner can read", async () => {
    const store = await createStore();
    await store.update("jira", "https://jira.example.com/mcp", (current) => ({
      ...current,
      tokens: { access_token: "a", token_type: "Bearer" }
    }));

    expect(await store.hasTokens("jira", "https://jira.example.com/mcp")).toBe(true);
    // The same name at another URL is another server.
    expect(await store.hasTokens("jira", "https://evil.example.com/mcp")).toBe(false);
    expect((await fs.stat(store.filePath)).mode & 0o777).toBe(0o600);
  });

  test("forgets a server by name, and deletes the file once it is empty", async () => {
    const store = await createStore();
    await store.update("jira", "https://jira.example.com/mcp", (current) => ({
      ...current,
      tokens: { access_token: "a", token_type: "Bearer" }
    }));

    expect(await store.remove("jira")).toBe(true);
    expect(await store.remove("jira")).toBe(false);
    await expect(fs.access(store.filePath)).rejects.toThrow();
  });

  test("refuses to read or write through a symlink", async () => {
    const store = await createStore();
    const decoy = path.join(path.dirname(path.dirname(store.filePath)), "decoy.json");
    await fs.writeFile(decoy, '{ "version": 1, "servers": {} }');
    await fs.mkdir(path.dirname(store.filePath), { recursive: true });
    await fs.symlink(decoy, store.filePath);

    await expect(store.get("jira", "https://jira.example.com/mcp")).rejects.toThrow("symbolic link");
    await expect(store.update("jira", "https://jira.example.com/mcp", (current) => ({ ...current }))).rejects.toThrow(
      "symbolic link"
    );
  });
});

describe("McpCredentialsStore under concurrency and damage", () => {
  test("two writers at once lose neither's change", async () => {
    // Read-modify-write without a lock: a session refreshing a token while
    // `aia mcp login` ran elsewhere dropped one of the two.
    const first = await createStore();
    const second = new McpCredentialsStore(first.filePath);
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 === 0 ? first : second).update(
          `server-${index}`,
          `https://s${index}.example.com/mcp`,
          (current) => ({
            ...current,
            tokens: { access_token: `t${index}`, token_type: "Bearer" }
          })
        )
      )
    );
    for (let index = 0; index < 12; index += 1) {
      expect(await first.hasTokens(`server-${index}`, `https://s${index}.example.com/mcp`)).toBe(true);
    }
    await expect(fs.access(`${first.filePath}.lock`)).rejects.toThrow();
  });

  test("a corrupt file reads as empty with one warning, and the next change moves it aside", async () => {
    const store = await createStore();
    await fs.mkdir(path.dirname(store.filePath), { recursive: true });
    await fs.writeFile(store.filePath, "{ not json", { mode: 0o600 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(await store.get("jira", "https://jira.example.com/mcp")).toBeUndefined();
      expect(await store.get("jira", "https://jira.example.com/mcp")).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);

      // What a login does: it used to fail on the corrupt file every time.
      await store.update("jira", "https://jira.example.com/mcp", (current) => ({
        ...current,
        tokens: { access_token: "a", token_type: "Bearer" }
      }));
      expect(await store.hasTokens("jira", "https://jira.example.com/mcp")).toBe(true);
      const kept = (await fs.readdir(path.dirname(store.filePath))).filter((name) => name.includes(".corrupt-"));
      expect(kept).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("StoredMcpOAuthProvider", () => {
  test("in a session it never registers a client or starts a browser login", async () => {
    const provider = new StoredMcpOAuthProvider({
      interactive: false,
      serverName: "jira",
      serverUrl: "https://jira.example.com/mcp",
      store: await createStore()
    });

    expect(provider.saveClientInformation).toBeUndefined();
    await expect(provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"))).rejects.toThrow(
      McpLoginRequiredError
    );
    // A redirect URL must exist, or the SDK would try a machine-to-machine flow.
    expect(provider.redirectUrl).toContain(mcpOAuthCallbackPath("https://jira.example.com/mcp"));
  });

  test("uses a configured client id, and keeps what the SDK stamps on tokens", async () => {
    const store = await createStore();
    const provider = new StoredMcpOAuthProvider({
      interactive: true,
      onAuthorizationUrl: () => undefined,
      serverName: "github",
      serverUrl: "https://api.github.example/mcp",
      settings: { clientId: "preregistered", clientSecret: "s3cret", scopes: ["repo"] },
      store
    });

    expect(await provider.clientInformation()).toEqual({ client_id: "preregistered", client_secret: "s3cret" });
    expect(provider.clientMetadata).toMatchObject({ scope: "repo", token_endpoint_auth_method: "client_secret_post" });
    await provider.saveTokens({ access_token: "t", issuer: "https://auth.example.com", token_type: "Bearer" } as never);
    expect(await provider.tokens()).toMatchObject({ issuer: "https://auth.example.com" });
  });

  test("binds a configured client to its issuer without copying its secret into the credentials file", async () => {
    const store = await createStore();
    const settings = { clientId: "preregistered", clientSecret: "s3cret-from-keychain" };
    const provider = new StoredMcpOAuthProvider({
      interactive: true,
      onAuthorizationUrl: () => undefined,
      serverName: "github",
      serverUrl: "https://api.github.example/mcp",
      settings,
      store
    });

    // The SDK saves the client it used, stamped with the issuer, at sign-in.
    await provider.saveClientInformation?.({
      client_id: "preregistered",
      client_secret: "s3cret-from-keychain",
      issuer: "https://auth.example.com"
    } as never);

    expect(await fs.readFile(store.filePath, "utf8")).not.toContain("s3cret-from-keychain");
    // The secret still comes from the config, and the binding from the file.
    expect(await provider.clientInformation()).toEqual({
      client_id: "preregistered",
      client_secret: "s3cret-from-keychain",
      issuer: "https://auth.example.com"
    });
    // A session started later (not interactive) sees the same binding.
    const later = new StoredMcpOAuthProvider({
      interactive: false,
      serverName: "github",
      serverUrl: "https://api.github.example/mcp",
      settings,
      store
    });
    expect(await later.clientInformation()).toMatchObject({ issuer: "https://auth.example.com" });
  });

  test("in a session, no client to present is a sign-in to ask for, said with our own error", async () => {
    const make = (interactive: boolean) =>
      new StoredMcpOAuthProvider({
        interactive,
        ...(interactive ? { onAuthorizationUrl: () => undefined } : {}),
        serverName: "jira",
        serverUrl: "https://jira.example.com/mcp",
        store
      });
    const store = await createStore();
    // The SDK registers a client next, which only `aia mcp login` may do.
    await expect(make(false).clientInformation()).rejects.toThrow(McpLoginRequiredError);
    await expect(make(true).clientInformation()).resolves.toBeUndefined();
  });

  test("tells a sign-in failure by its class or the SDK's exact words, not a loose pattern", () => {
    expect(isMcpLoginRequiredError(new McpLoginRequiredError("jira"))).toBe(true);
    expect(
      isMcpLoginRequiredError(
        new Error(
          "OAuth client information is bound to authorization server https://a.example and is not presented to https://b.example. Clear it."
        )
      )
    ).toBe(true);
    // An unrelated failure that happens to say "bound to" used to read as needs_login.
    expect(isMcpLoginRequiredError(new Error("listen EADDRINUSE: address already bound to 127.0.0.1:8080"))).toBe(
      false
    );
  });

  test("a callback path is the same for a server's URL every time, and differs between servers", () => {
    expect(mcpOAuthCallbackPath("https://a.example.com/mcp")).toBe(mcpOAuthCallbackPath("https://a.example.com/mcp#x"));
    expect(mcpOAuthCallbackPath("https://a.example.com/mcp")).not.toBe(
      mcpOAuthCallbackPath("https://b.example.com/mcp")
    );
  });
});
