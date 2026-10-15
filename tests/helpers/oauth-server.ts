import crypto from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

/**
 * An MCP server behind OAuth, with its own authorization server: discovery
 * documents, dynamic client registration, an authorize endpoint that approves
 * at once, and a token endpoint that checks PKCE and supports refresh.
 */
export async function startProtectedMcpServer(cleanups: Array<() => Promise<void>>) {
  const app = express();
  const state = {
    // Every x-api-key header that reached this server, in order.
    apiKeys: [] as string[],
    challenges: new Map<string, string>(),
    registrations: 0,
    tokenRequests: [] as string[],
    validTokens: new Set<string>()
  };
  let base = "";
  let issued = 0;
  const issue = () => {
    issued += 1;
    const token = `access-${issued}`;
    state.validTokens.add(token);
    return { access_token: token, expires_in: 3600, refresh_token: `refresh-${issued}`, token_type: "Bearer" };
  };

  app.use((request, _response, next) => {
    const apiKey = request.header("x-api-key");
    if (apiKey) {
      state.apiKeys.push(apiKey);
    }
    next();
  });
  app.get("/.well-known/oauth-protected-resource{/*rest}", (_request, response) => {
    response.json({ authorization_servers: [base], resource: `${base}/mcp` });
  });
  app.get(
    ["/.well-known/oauth-authorization-server{/*rest}", "/.well-known/openid-configuration"],
    (_request, response) => {
      response.json({
        authorization_endpoint: `${base}/authorize`,
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        issuer: base,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        token_endpoint: `${base}/token`,
        token_endpoint_auth_methods_supported: ["none"]
      });
    }
  );
  app.post("/register", express.json(), (request, response) => {
    state.registrations += 1;
    response.status(201).json({ ...request.body, client_id: `client-${state.registrations}` });
  });
  app.get("/authorize", (request, response) => {
    const query = request.query as Record<string, string>;
    const code = `code-${crypto.randomUUID()}`;
    state.challenges.set(code, query.code_challenge ?? "");
    const redirect = new URL(query.redirect_uri!);
    redirect.searchParams.set("code", code);
    if (query.state) {
      redirect.searchParams.set("state", query.state);
    }
    response.redirect(302, redirect.toString());
  });
  app.post("/token", express.urlencoded({ extended: false }), (request, response) => {
    const body = request.body as Record<string, string>;
    state.tokenRequests.push(body.grant_type ?? "");
    if (body.grant_type === "authorization_code") {
      const challenge = state.challenges.get(body.code ?? "");
      const computed = crypto
        .createHash("sha256")
        .update(body.code_verifier ?? "")
        .digest("base64url");
      if (!challenge || challenge !== computed) {
        response.status(400).json({ error: "invalid_grant" });
        return;
      }
      state.challenges.delete(body.code!);
      response.json(issue());
      return;
    }
    if (body.grant_type === "refresh_token" && body.refresh_token?.startsWith("refresh-")) {
      response.json(issue());
      return;
    }
    response.status(400).json({ error: "invalid_grant" });
  });
  app.post("/mcp", express.json(), async (request, response) => {
    const token = /^Bearer (.+)$/u.exec(request.headers.authorization ?? "")?.[1];
    if (!token || !state.validTokens.has(token)) {
      response
        .status(401)
        .set("WWW-Authenticate", `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`)
        .json({ error: "unauthorized" });
      return;
    }
    const server = new McpServer({ name: "protected", version: "1.0.0" });
    server.registerTool("whoami", { description: "Say who is signed in." }, async () => ({
      content: [{ text: `token:${token}`, type: "text" }]
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(request, response, request.body);
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
  });

  const listener = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  cleanups.push(() => new Promise<void>((resolve) => listener.close(() => resolve())));
  base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  return { base, state, url: `${base}/mcp` };
}

/** A browser that follows the authorization server's redirect to aia's callback. */
export async function headlessBrowser(url: string): Promise<void> {
  const authorize = await fetch(url, { redirect: "manual" });
  await fetch(authorize.headers.get("location")!);
}
