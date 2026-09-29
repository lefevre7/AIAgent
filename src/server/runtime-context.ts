import {
  ChannelService,
  FileSessionStore,
  TunnelService,
  WhatsAppChannelAdapter,
  createBootstrapInfo,
  createExternalAgentServiceFromConfig,
  ensureStateRootWritable,
  loadAIAgentConfig,
  type ChannelAdapter,
  type BootstrapInfo,
  type ExternalAgentService,
  type LoadedAIAgentConfig
} from "@/core";
import { createGatewayRuntimeFromLoadedConfig, type GatewayRuntime } from "@/gateway";

export type ServerRuntimeContext = {
  bootstrapInfo: BootstrapInfo;
  channelService: ChannelService;
  cwd: string;
  externalAgentService?: ExternalAgentService;
  gatewayAuthToken?: string;
  gatewayRuntime: GatewayRuntime;
  loaded: LoadedAIAgentConfig;
  sessions: FileSessionStore;
  tunnelService: TunnelService;
};

/**
 * One runtime per process. Next compiles the pages into its own bundle, which
 * carries its own copy of this module, so a module-level variable held two
 * contexts: the custom server's, and one the first page render built, with a
 * second gateway, MCP manager (a second set of MCP server processes), channel
 * pollers and events-log writer. A global slot is shared by every copy of this
 * module in the process.
 */
const CONTEXT_SLOT = Symbol.for("aiagent.serverRuntimeContext");

type ContextSlotHolder = { [CONTEXT_SLOT]?: Promise<ServerRuntimeContext> | null };

function readContextSlot(): Promise<ServerRuntimeContext> | null {
  return (globalThis as ContextSlotHolder)[CONTEXT_SLOT] ?? null;
}

function writeContextSlot(value: Promise<ServerRuntimeContext> | null): void {
  (globalThis as ContextSlotHolder)[CONTEXT_SLOT] = value;
}

export async function createServerRuntimeContext(params: {
  cwd: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  userHomeDirectory?: string;
}): Promise<ServerRuntimeContext> {
  const loaded = await loadAIAgentConfig({
    cwd: params.cwd,
    env: params.env,
    userHomeDirectory: params.userHomeDirectory
  });
  // Checked before the services below start recovering state from disk, so an
  // unwritable state root fails here with an explanation instead of in one of
  // their background recoveries.
  await ensureStateRootWritable(loaded);
  const sessions = new FileSessionStore(loaded.resolvedConfig.memory.stateRoot);
  const externalAgentService = createExternalAgentServiceFromConfig({
    config: loaded.resolvedConfig,
    sessions
  });
  const gatewayAuthToken =
    typeof loaded.resolvedConfig.gateway.auth.token === "string" ? loaded.resolvedConfig.gateway.auth.token : undefined;
  const tunnelService = new TunnelService({
    authToken: gatewayAuthToken,
    gatewayConfig: loaded.resolvedConfig.gateway,
    tunnelConfig: loaded.resolvedConfig.tunnel
  });
  const adapters: ChannelAdapter[] = [];
  if (loaded.resolvedConfig.channels.whatsapp.enabled && loaded.resolvedConfig.channels.whatsapp.sessionDirectory) {
    adapters.push(
      new WhatsAppChannelAdapter({
        sessionDirectory: loaded.resolvedConfig.channels.whatsapp.sessionDirectory
      })
    );
  }
  const channelService = new ChannelService({
    adapters,
    channelsConfig: loaded.resolvedConfig.channels,
    sessions,
    stateRoot: loaded.resolvedConfig.memory.stateRoot,
    tunnelService
  });
  const gatewayRuntime = await createGatewayRuntimeFromLoadedConfig({
    channelService,
    cwd: params.cwd,
    env: params.env,
    externalAgentService: externalAgentService ?? undefined,
    fetchImpl: params.fetchImpl,
    loaded,
    sessions,
    userHomeDirectory: params.userHomeDirectory
  });
  channelService.setInboundMessageListener(async (message) => {
    await gatewayRuntime.acceptChannelMessage(message);
  });
  try {
    await channelService.start();
  } catch (error) {
    // The runtime is up by now (MCP children, pollers), and nothing else holds
    // a reference to it yet, so a channel that fails to start must not leave
    // it running.
    await channelService.close().catch(() => undefined);
    await gatewayRuntime.close().catch(() => undefined);
    throw error;
  }

  return {
    bootstrapInfo: createBootstrapInfo(),
    channelService,
    cwd: params.cwd,
    externalAgentService: externalAgentService ?? undefined,
    gatewayAuthToken,
    gatewayRuntime,
    loaded,
    sessions,
    tunnelService
  };
}

export async function getServerRuntimeContext(
  params: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    userHomeDirectory?: string;
  } = {}
): Promise<ServerRuntimeContext> {
  const existing = readContextSlot();
  if (existing) {
    return existing;
  }

  const created = createServerRuntimeContext({
    cwd: params.cwd ?? process.cwd(),
    env: params.env,
    fetchImpl: params.fetchImpl,
    userHomeDirectory: params.userHomeDirectory
  });
  writeContextSlot(created);
  return created;
}

export function primeServerRuntimeContext(context: ServerRuntimeContext | Promise<ServerRuntimeContext>): void {
  writeContextSlot(Promise.resolve(context));
}

export async function closeServerRuntimeContext(): Promise<void> {
  const contextPromise = readContextSlot();
  writeContextSlot(null);
  if (!contextPromise) {
    return;
  }

  const context = await contextPromise;
  await context.channelService.close().catch(() => undefined);
  await context.gatewayRuntime.close().catch(() => undefined);
}
