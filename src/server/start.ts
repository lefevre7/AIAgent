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

export async function startServer(argv: string[] = process.argv.slice(2)) {
  const runtime = resolveServerRuntimeConfig(argv);
  const context = await createServerRuntimeContext({
    cwd: process.cwd()
  });
  primeServerRuntimeContext(context);

  // The context is up from here on, and it owns pollers and MCP child processes
  // that keep the event loop alive. Any failure past this point (the exposure
  // refusal, Next failing to prepare, anything else) has to tear it down
  // explicitly, or the process reports the failure and then hangs instead of
  // exiting: the entry point only sets exitCode.
  try {
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
  const gatewayWebSocket = attachGatewayWebSocketServer({
    auth: {
      token: context.gatewayAuthToken
    },
    fallbackUpgradeHandler: nextApp.getUpgradeHandler(),
    requestTimeoutMs: context.loaded.resolvedConfig.gateway.requestTimeoutMs,
    runtime: context.gatewayRuntime,
    server,
    websocketPath: context.loaded.resolvedConfig.gateway.websocketPath
  });

  server.on("close", () => {
    void gatewayWebSocket.close().catch(() => undefined);
    void closeServerRuntimeContext().catch(() => undefined);
  });

  await new Promise<void>((resolve) => {
    server.listen(runtime.port, runtime.hostname, () => {
      console.log(
        `AIAgent server listening on http://${runtime.hostname}:${runtime.port} (${runtime.dev ? "dev" : "prod"})`
      );
      resolve();
    });
  });

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
