import { createServer } from "node:http";
import process from "node:process";

import next from "next";

import { assertGatewayExposureIsAuthenticated, attachGatewayWebSocketServer, serverAttachUrl } from "@/gateway";
import { ControlPlaneService } from "@/server/control-plane/service";
import {
  closeServerRuntimeContext,
  createServerRuntimeContext,
  primeServerRuntimeContext,
  type ServerRuntimeContext
} from "@/server/runtime-context";
import { createHttpApp } from "@/server/create-http-app";
import { resolveServerRuntimeConfig, type ServerRuntimeConfig } from "@/server/env";
import { authorizeWebAccessUpgrade } from "@/server/web-access";

export async function startServer(argv: string[] = process.argv.slice(2)) {
  const context = await createServerRuntimeContext({
    cwd: process.cwd()
  });
  primeServerRuntimeContext(context);

  // The context is up from here on, and it owns pollers and MCP child processes
  // that keep the event loop alive. Any failure past this point (the exposure
  // refusal, Next failing to prepare, the port being taken, anything else) has
  // to tear it down explicitly, or the process reports the failure and then
  // hangs instead of exiting: the entry point only sets exitCode.
  try {
    // Resolved after the config so gateway.hostname/gateway.port are the
    // defaults; flags and HOSTNAME/PORT still win.
    const runtime = resolveServerRuntimeConfig(argv, process.env, context.loaded.resolvedConfig.gateway);
    return await serveWithContext(runtime, context);
  } catch (error) {
    await closeServerRuntimeContext().catch(() => undefined);
    throw error;
  }
}

async function serveWithContext(runtime: ServerRuntimeConfig, context: ServerRuntimeContext) {
  // Fail closed before anything binds. An exposed gateway with no token grants
  // unauthenticated access to sessions, tools, and approvals, and a tunnel in
  // front of loopback makes every remote request look local.
  assertGatewayExposureIsAuthenticated({
    hostname: runtime.hostname,
    token: context.gatewayAuthToken,
    tunnelEnabled: context.loaded.resolvedConfig.tunnel.enabled
  });

  const nextApp = next({
    dev: runtime.dev,
    dir: process.cwd(),
    hostname: runtime.hostname,
    port: runtime.port
  });

  await nextApp.prepare();

  const httpApp = createHttpApp(
    async (request, response) => {
      await nextApp.getRequestHandler()(request, response);
    },
    {
      channels: {
        channelService: context.channelService,
        gatewayRuntime: context.gatewayRuntime
      },
      controlPlane: {
        access: {
          token: context.gatewayAuthToken
        },
        service: new ControlPlaneService(context)
      },
      gateway: {
        auth: {
          token: context.gatewayAuthToken
        },
        requestTimeoutMs: context.loaded.resolvedConfig.gateway.requestTimeoutMs,
        runtime: context.gatewayRuntime
      },
      webAccess: {
        token: context.gatewayAuthToken
      }
    }
  );

  const server = createServer(httpApp);
  // Attached before the server takes a request, so this listener runs before
  // the one Next's custom server adds on its first request: an upgrade it
  // refuses is closed before Next sees it.
  const gatewayWebSocket = attachGatewayWebSocketServer({
    auth: {
      token: context.gatewayAuthToken
    },
    nextUpgrades: {
      authorize: (request) => authorizeWebAccessUpgrade(request, { token: context.gatewayAuthToken })
    },
    requestTimeoutMs: context.loaded.resolvedConfig.gateway.requestTimeoutMs,
    runtime: context.gatewayRuntime,
    server,
    websocketPath: context.loaded.resolvedConfig.gateway.websocketPath
  });

  server.on("close", () => {
    void gatewayWebSocket.close().catch(() => undefined);
    void closeServerRuntimeContext().catch(() => undefined);
  });

  // A taken port is emitted as an 'error' event, not thrown, so without this
  // listener it became an uncaught exception: Next's dev server logs those and
  // keeps running, and the process hung with the runtime context alive.
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(runtime.port, runtime.hostname, () => {
        server.off("error", reject);
        console.log(
          `AIAgent server listening on http://${runtime.hostname}:${runtime.port} (${runtime.dev ? "dev" : "prod"})`
        );
        resolve();
      });
    });
  } catch (error) {
    await gatewayWebSocket.close().catch(() => undefined);
    await nextApp.close().catch(() => undefined);
    throw describeListenFailure(error, runtime);
  }

  // Lets an interactive external-agent session started from the web UI or a
  // channel open a desktop window that can reach this server.
  const address = server.address();
  context.gatewayRuntime.setAttachEndpoint(
    serverAttachUrl({
      hostname: runtime.hostname,
      port: typeof address === "object" && address ? address.port : runtime.port,
      websocketPath: context.loaded.resolvedConfig.gateway.websocketPath
    })
  );

  return { gatewayRuntime: context.gatewayRuntime, runtime, server };
}

function describeListenFailure(error: unknown, runtime: ServerRuntimeConfig): Error {
  const code = typeof error === "object" && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
  const address = `${runtime.hostname}:${runtime.port}`;
  if (code === "EADDRINUSE") {
    return new Error(
      `Cannot listen on ${address}: the port is already in use. Stop whatever holds it, or start on another port with --port <n> (or PORT, or gateway.port in aia.config.jsonc).`,
      { cause: error }
    );
  }
  if (code === "EACCES") {
    return new Error(`Cannot listen on ${address}: permission denied. Use a port above 1023.`, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isDirectExecution) {
  // A refusal to start (an exposed gateway with no token) is a deliberate
  // decision, not a crash. Printing the message alone keeps it readable and
  // actionable; a raw stack trace reads as a bug in AIAgent.
  void startServer().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
