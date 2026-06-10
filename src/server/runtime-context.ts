import {
  ChannelService,
  FileSessionStore,
  TunnelService,
  WhatsAppChannelAdapter,
  createBootstrapInfo,
  createExternalAgentServiceFromConfig,
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

let runtimeContextPromise: Promise<ServerRuntimeContext> | null = null;

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
  const sessions = new FileSessionStore(loaded.resolvedConfig.memory.stateRoot);
  const externalAgentService = createExternalAgentServiceFromConfig({
    config: loaded.resolvedConfig,
    sessions
  });
  const gatewayAuthToken =
    typeof loaded.resolvedConfig.gateway.auth.token === "string"
      ? loaded.resolvedConfig.gateway.auth.token
      : undefined;
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
  await channelService.start();

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

export async function getServerRuntimeContext(params: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  userHomeDirectory?: string;
} = {}): Promise<ServerRuntimeContext> {
  if (!runtimeContextPromise) {
    runtimeContextPromise = createServerRuntimeContext({
      cwd: params.cwd ?? process.cwd(),
      env: params.env,
      fetchImpl: params.fetchImpl,
      userHomeDirectory: params.userHomeDirectory
    });
  }

  return runtimeContextPromise;
}

export function primeServerRuntimeContext(context: ServerRuntimeContext | Promise<ServerRuntimeContext>): void {
  runtimeContextPromise = Promise.resolve(context);
}

export async function closeServerRuntimeContext(): Promise<void> {
  const contextPromise = runtimeContextPromise;
  runtimeContextPromise = null;
  if (!contextPromise) {
    return;
  }

  const context = await contextPromise;
  await context.channelService.close().catch(() => undefined);
  await context.gatewayRuntime.close().catch(() => undefined);
}
