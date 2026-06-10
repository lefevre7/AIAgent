import crypto from "node:crypto";

import { z } from "zod";

import {
  loadAIAgentConfig,
  type EmbeddingAdapterRegistration,
  type ExternalAgentService,
  type FileSessionStore,
  type LanguageModelAdapterRegistration,
  type LoadedAIAgentConfig
} from "@/core";
import {
  gatewayApprovalResolveRequestSchema,
  gatewayEventReplayQuerySchema,
  gatewayMessageInputSchema,
  gatewayRequestPayloadSchemas,
  gatewayRequestSchema,
  gatewayResponsePayloadSchemas,
  gatewaySessionCreateRequestSchema,
  gatewaySubscriptionSchema,
  toolSearchQuerySchema,
  type GatewayApprovalRecord,
  type GatewayEvent,
  type GatewayEventPage,
  type GatewayRequest,
  type GatewayRequestTopic,
  type GatewayResponse,
  type GatewayRunRecord,
  type GatewayRunStatus,
  type GatewaySessionSnapshot,
  type GatewaySubscription,
  type GatewayTransportClient,
  type JsonValue,
  type SessionRecord,
  type SteeringInjection,
  type ToolDefinition
} from "@/core/contracts";
import {
  createGatewayRuntimeFromLoadedConfig,
  eventMatchesGatewaySubscription,
  type GatewayRuntimeLike,
  type GatewayRuntimeProviderRegistrationHost
} from "@/gateway";

type GatewayRequestPayloadByTopic = {
  [Topic in GatewayRequestTopic]: z.input<(typeof gatewayRequestPayloadSchemas)[Topic]>;
};

type GatewayResponsePayloadByTopic = {
  [Topic in GatewayRequestTopic]: z.infer<(typeof gatewayResponsePayloadSchemas)[Topic]>;
};

export type AIAgentEventFilter = Pick<GatewaySubscription, "sessionId" | "topics">;

export type AIAgentEventStreamOptions = AIAgentEventFilter & {
  signal?: AbortSignal;
};

export type AIAgentGatewayRequestOptions = {
  signal?: AbortSignal;
};

export type AIAgentMessageInput = z.input<typeof gatewayMessageInputSchema>;
export type AIAgentSessionCreateInput = z.input<typeof gatewaySessionCreateRequestSchema>;

export type AIAgentSteeringInput = {
  message: string;
  metadata?: Record<string, JsonValue>;
  turnId?: string;
};

export type AIAgentProviderRegistrations = {
  embeddingAdapters?: EmbeddingAdapterRegistration[];
  languageModelAdapters?: LanguageModelAdapterRegistration[];
};

export type CreateAIAgentSdkOptions = {
  closeControlPlane?: boolean;
  controlPlane: GatewayRuntimeLike;
  providers?: AIAgentProviderRegistrations;
};

export type CreateAIAgentSdkFromConfigOptions = {
  cwd: string;
  env?: Record<string, string | undefined>;
  externalAgentService?: ExternalAgentService;
  fetchImpl?: typeof fetch;
  loaded?: LoadedAIAgentConfig;
  providers?: AIAgentProviderRegistrations;
  sessions?: FileSessionStore;
  userHomeDirectory?: string;
};

export type AIAgentSessionCreateResult = {
  handle: AIAgentSessionHandle;
  run?: AIAgentRunHandle;
  session: SessionRecord;
};

type AIAgentSdkInternalOptions = {
  closeControlPlane?: (() => Promise<void>) | null;
  controlPlane: GatewayRuntimeLike;
  providerHost?: GatewayRuntimeProviderRegistrationHost | null;
};

export class AIAgentSdk {
  readonly approvals = new AIAgentApprovals(this);
  readonly gateway = new AIAgentGateway(this);
  readonly memory = new AIAgentMemory(this);
  readonly providers = new AIAgentProviders(this);
  readonly sessions = new AIAgentSessions(this);
  readonly steering = new AIAgentSteering(this);
  readonly tools = new AIAgentTools(this);

  constructor(private readonly options: AIAgentSdkInternalOptions) {}

  get controlPlane(): GatewayRuntimeLike {
    return this.options.controlPlane;
  }

  async close(): Promise<void> {
    await this.options.closeControlPlane?.();
  }

  events(options: AIAgentEventStreamOptions = {}): AsyncIterable<GatewayEvent> {
    return createGatewayEventStream((listener) => this.subscribe(listener, options), options.signal);
  }

  subscribe(listener: (event: GatewayEvent) => void, options: AIAgentEventStreamOptions = {}): () => void {
    const subscription = gatewaySubscriptionSchema.parse({
      sessionId: options.sessionId,
      topics: options.topics
    });
    const wrappedListener = (event: GatewayEvent) => {
      if (eventMatchesGatewaySubscription(event, subscription)) {
        listener(event);
      }
    };
    const unsubscribe = this.options.controlPlane.subscribe(wrappedListener);
    const abortCleanup = bindAbortCleanup(options.signal, unsubscribe);

    return () => {
      abortCleanup();
      unsubscribe();
    };
  }

  async replayEvents(
    query: z.input<typeof gatewayEventReplayQuerySchema>,
    options: AIAgentGatewayRequestOptions = {}
  ): Promise<GatewayEventPage> {
    return withAbort(this.options.controlPlane.replayEvents(gatewayEventReplayQuerySchema.parse(query)), options.signal);
  }

  async request<Topic extends GatewayRequestTopic>(
    topic: Topic,
    payload: GatewayRequestPayloadByTopic[Topic],
    options: AIAgentGatewayRequestOptions = {}
  ): Promise<GatewayResponsePayloadByTopic[Topic]> {
    const request = gatewayRequestSchema.parse({
      createdAt: new Date().toISOString(),
      id: `gateway-request.sdk.${crypto.randomUUID()}`,
      metadata: {
        surface: "sdk"
      },
      payload: gatewayRequestPayloadSchemas[topic].parse(payload),
      topic
    });
    const response = await withAbort(this.options.controlPlane.request(request), options.signal);
    if (!response.ok) {
      throw buildGatewayResponseError(response);
    }

    return gatewayResponsePayloadSchemas[topic].parse(response.payload) as GatewayResponsePayloadByTopic[Topic];
  }

  registerEmbeddingAdapter(registration: EmbeddingAdapterRegistration): void {
    this.requireProviderHost().registerEmbeddingAdapter(registration);
  }

  registerLanguageModelAdapter(registration: LanguageModelAdapterRegistration): void {
    this.requireProviderHost().registerLanguageModelAdapter(registration);
  }

  async waitForRun(run: GatewayRunRecord, options: AIAgentGatewayRequestOptions = {}): Promise<GatewayRunRecord> {
    if (isTerminalRunStatus(run.status)) {
      return run;
    }

    return withAbort(
      new Promise<GatewayRunRecord>((resolve) => {
        const unsubscribe = this.subscribe(
          (event) => {
            if (event.topic !== "run.updated" || event.payload.id !== run.id) {
              return;
            }

            if (isTerminalRunStatus(event.payload.status)) {
              unsubscribe();
              resolve(event.payload);
            }
          },
          {
            sessionId: run.sessionId,
            topics: ["run.updated"]
          }
        );
      }),
      options.signal
    );
  }

  private requireProviderHost(): GatewayRuntimeProviderRegistrationHost {
    if (this.options.providerHost) {
      return this.options.providerHost;
    }

    throw new Error("The current control plane does not support provider registration.");
  }
}

export class AIAgentSessionHandle {
  constructor(
    private readonly sdk: AIAgentSdk,
    readonly sessionId: string
  ) {}

  async cancel(options: AIAgentGatewayRequestOptions = {}): Promise<GatewayRunRecord> {
    return (await this.sdk.request("session.cancel", { sessionId: this.sessionId }, options)).run;
  }

  events(options: Omit<AIAgentEventStreamOptions, "sessionId"> = {}): AsyncIterable<GatewayEvent> {
    return this.sdk.events({
      ...options,
      sessionId: this.sessionId
    });
  }

  async injectSteering(input: AIAgentSteeringInput, options: AIAgentGatewayRequestOptions = {}): Promise<SteeringInjection> {
    return this.sdk.steering.inject(this.sessionId, input, options);
  }

  async listPendingApprovals(options: AIAgentGatewayRequestOptions = {}): Promise<GatewayApprovalRecord[]> {
    return this.sdk.approvals.list(
      {
        pendingOnly: true,
        sessionId: this.sessionId
      },
      options
    );
  }

  async resolveApproval(
    input: Omit<z.input<typeof gatewayApprovalResolveRequestSchema>, "actor"> & {
      actor?: z.input<typeof gatewayApprovalResolveRequestSchema>["actor"];
    },
    options: AIAgentGatewayRequestOptions = {}
  ): Promise<{ approval: GatewayApprovalRecord; steeringInjection?: SteeringInjection }> {
    return this.sdk.approvals.resolve(input, options);
  }

  async resume(options: AIAgentGatewayRequestOptions = {}): Promise<AIAgentRunHandle> {
    return this.sdk.sessions.resume(this.sessionId, options);
  }

  async sendMessage(input: AIAgentMessageInput, options: AIAgentGatewayRequestOptions = {}): Promise<AIAgentRunHandle> {
    return this.sdk.sessions.sendMessage(this.sessionId, input, options);
  }

  async snapshot(options: AIAgentGatewayRequestOptions = {}): Promise<GatewaySessionSnapshot> {
    return this.sdk.sessions.snapshot(this.sessionId, options);
  }

  subscribe(listener: (event: GatewayEvent) => void, options: Omit<AIAgentEventStreamOptions, "sessionId"> = {}): () => void {
    return this.sdk.subscribe(listener, {
      ...options,
      sessionId: this.sessionId
    });
  }
}

export class AIAgentRunHandle {
  constructor(
    private readonly sdk: AIAgentSdk,
    private record: GatewayRunRecord
  ) {}

  get run(): GatewayRunRecord {
    return this.record;
  }

  get runId(): string {
    return this.record.id;
  }

  get sessionId(): string {
    return this.record.sessionId;
  }

  async cancel(options: AIAgentGatewayRequestOptions = {}): Promise<GatewayRunRecord> {
    this.record = (await this.sdk.request("run.cancel", { runId: this.record.id }, options)).run;
    return this.record;
  }

  async wait(options: AIAgentGatewayRequestOptions = {}): Promise<GatewayRunRecord> {
    this.record = await this.sdk.waitForRun(this.record, options);
    return this.record;
  }
}

class AIAgentApprovals {
  constructor(private readonly sdk: AIAgentSdk) {}

  async get(requestId: string, options: AIAgentGatewayRequestOptions = {}): Promise<GatewayApprovalRecord> {
    return this.sdk.request("approval.get", { requestId }, options);
  }

  async list(
    query: GatewayRequestPayloadByTopic["approval.list"] = {},
    options: AIAgentGatewayRequestOptions = {}
  ): Promise<GatewayApprovalRecord[]> {
    return (await this.sdk.request("approval.list", query, options)).approvals;
  }

  async resolve(
    input: Omit<GatewayRequestPayloadByTopic["approval.resolve"], "actor"> & {
      actor?: GatewayRequestPayloadByTopic["approval.resolve"]["actor"];
    },
    options: AIAgentGatewayRequestOptions = {}
  ): Promise<{ approval: GatewayApprovalRecord; steeringInjection?: SteeringInjection }> {
    return this.sdk.request(
      "approval.resolve",
      {
        ...input,
        actor: input.actor ?? "sdk"
      },
      options
    );
  }
}

class AIAgentGateway {
  readonly client: GatewayTransportClient;

  constructor(private readonly sdk: AIAgentSdk) {
    this.client = {
      request: async (request) => this.request(request),
      subscribe: async (listener) => this.subscribe(listener)
    };
  }

  async health(options: AIAgentGatewayRequestOptions = {}): Promise<GatewayResponsePayloadByTopic["gateway.health"]> {
    return this.sdk.request("gateway.health", {}, options);
  }

  async replayEvents(
    query: z.input<typeof gatewayEventReplayQuerySchema> = {},
    options: AIAgentGatewayRequestOptions = {}
  ): Promise<GatewayEventPage> {
    return this.sdk.replayEvents(query, options);
  }

  async request(request: GatewayRequest, options: AIAgentGatewayRequestOptions = {}): Promise<GatewayResponse> {
    return withAbort(this.sdk.controlPlane.request(gatewayRequestSchema.parse(request)), options.signal);
  }

  async subscribe(
    listener: (event: GatewayEvent) => void,
    options: AIAgentGatewayRequestOptions = {}
  ): Promise<() => void> {
    if (options.signal?.aborted) {
      return () => undefined;
    }

    const unsubscribe = this.sdk.controlPlane.subscribe(listener);
    const abortCleanup = bindAbortCleanup(options.signal, unsubscribe);
    return () => {
      abortCleanup();
      unsubscribe();
    };
  }
}

class AIAgentMemory {
  constructor(private readonly sdk: AIAgentSdk) {}

  async query(
    query: GatewayRequestPayloadByTopic["memory.query"],
    options: AIAgentGatewayRequestOptions = {}
  ): Promise<GatewayResponsePayloadByTopic["memory.query"]["hits"]> {
    return (await this.sdk.request("memory.query", query, options)).hits;
  }
}

class AIAgentProviders {
  constructor(private readonly sdk: AIAgentSdk) {}

  registerEmbedding(registration: EmbeddingAdapterRegistration): void {
    this.sdk.registerEmbeddingAdapter(registration);
  }

  registerLanguageModel(registration: LanguageModelAdapterRegistration): void {
    this.sdk.registerLanguageModelAdapter(registration);
  }
}

class AIAgentSessions {
  constructor(private readonly sdk: AIAgentSdk) {}

  get(sessionId: string): AIAgentSessionHandle {
    return new AIAgentSessionHandle(this.sdk, sessionId);
  }

  async create(
    input: AIAgentSessionCreateInput,
    options: AIAgentGatewayRequestOptions = {}
  ): Promise<AIAgentSessionCreateResult> {
    const result = await this.sdk.request("session.create", input, options);
    return {
      handle: this.get(result.session.id),
      run: result.run ? new AIAgentRunHandle(this.sdk, result.run) : undefined,
      session: result.session
    };
  }

  async list(
    query: GatewayRequestPayloadByTopic["session.list"] = {},
    options: AIAgentGatewayRequestOptions = {}
  ): Promise<SessionRecord[]> {
    return (await this.sdk.request("session.list", query, options)).sessions;
  }

  async resume(sessionId: string, options: AIAgentGatewayRequestOptions = {}): Promise<AIAgentRunHandle> {
    const result = await this.sdk.request("session.resume", { sessionId }, options);
    return new AIAgentRunHandle(this.sdk, result.run);
  }

  async sendMessage(
    sessionId: string,
    input: AIAgentMessageInput,
    options: AIAgentGatewayRequestOptions = {}
  ): Promise<AIAgentRunHandle> {
    const result = await this.sdk.request(
      "session.message",
      {
        ...input,
        sessionId
      },
      options
    );
    return new AIAgentRunHandle(this.sdk, result.run);
  }

  async snapshot(sessionId: string, options: AIAgentGatewayRequestOptions = {}): Promise<GatewaySessionSnapshot> {
    return this.sdk.request("session.snapshot", { sessionId }, options);
  }
}

class AIAgentSteering {
  constructor(private readonly sdk: AIAgentSdk) {}

  async inject(
    sessionId: string,
    input: AIAgentSteeringInput,
    options: AIAgentGatewayRequestOptions = {}
  ): Promise<SteeringInjection> {
    return this.sdk.request(
      "steering.inject",
      {
        createdAt: new Date().toISOString(),
        id: `steering.sdk.${crypto.randomUUID()}`,
        message: input.message,
        metadata: input.metadata ?? {},
        sessionId,
        source: "sdk",
        state: "queued",
        ...(input.turnId ? { turnId: input.turnId } : {})
      },
      options
    );
  }
}

class AIAgentTools {
  constructor(private readonly sdk: AIAgentSdk) {}

  async list(options: AIAgentGatewayRequestOptions = {}): Promise<ToolDefinition[]> {
    return this.search({}, options);
  }

  async search(
    query: z.input<typeof toolSearchQuerySchema> = {},
    options: AIAgentGatewayRequestOptions = {}
  ): Promise<ToolDefinition[]> {
    return (await this.sdk.request("tool.search", query, options)).tools;
  }
}

export function createAIAgentSdk(options: CreateAIAgentSdkOptions): AIAgentSdk {
  const sdk = new AIAgentSdk({
    closeControlPlane: resolveCloseControlPlane(options.controlPlane, options.closeControlPlane),
    controlPlane: options.controlPlane,
    providerHost: resolveProviderHost(options.controlPlane)
  });
  applyProviderRegistrations(sdk, options.providers);
  return sdk;
}

export async function createAIAgentSdkFromConfig(options: CreateAIAgentSdkFromConfigOptions): Promise<AIAgentSdk> {
  const loaded =
    options.loaded ??
    (await loadAIAgentConfig({
      cwd: options.cwd,
      env: options.env,
      userHomeDirectory: options.userHomeDirectory
    }));
  const runtime = await createGatewayRuntimeFromLoadedConfig({
    cwd: options.cwd,
    embeddingAdapters: options.providers?.embeddingAdapters,
    env: options.env,
    externalAgentService: options.externalAgentService,
    fetchImpl: options.fetchImpl,
    languageModelAdapters: options.providers?.languageModelAdapters,
    loaded,
    sessions: options.sessions,
    userHomeDirectory: options.userHomeDirectory
  });

  return createAIAgentSdk({
    closeControlPlane: true,
    controlPlane: runtime
  });
}

function applyProviderRegistrations(sdk: AIAgentSdk, registrations?: AIAgentProviderRegistrations): void {
  for (const registration of registrations?.languageModelAdapters ?? []) {
    sdk.providers.registerLanguageModel(registration);
  }
  for (const registration of registrations?.embeddingAdapters ?? []) {
    sdk.providers.registerEmbedding(registration);
  }
}

function bindAbortCleanup(signal: AbortSignal | undefined, cleanup: () => void): () => void {
  if (!signal) {
    return () => undefined;
  }

  const onAbort = () => {
    cleanup();
  };
  signal.addEventListener("abort", onAbort, {
    once: true
  });
  return () => {
    signal.removeEventListener("abort", onAbort);
  };
}

function buildGatewayResponseError(response: GatewayResponse): Error {
  const structuredError = response.error;
  const error = new Error(structuredError?.message ?? `Gateway request "${response.topic}" failed.`);
  error.name = "AIAgentGatewayError";
  Object.assign(error, structuredError ?? {});
  return error;
}

function createAbortError(): Error {
  return new DOMException("The operation was aborted.", "AbortError");
}

function createGatewayEventStream(
  subscribe: (listener: (event: GatewayEvent) => void) => () => void,
  signal?: AbortSignal
): AsyncIterable<GatewayEvent> {
  return {
    async *[Symbol.asyncIterator](): AsyncIterator<GatewayEvent> {
      const queue: GatewayEvent[] = [];
      let notify: (() => void) | null = null;
      let stopped = false;

      const unsubscribe = subscribe((event) => {
        queue.push(event);
        notify?.();
      });
      const abortCleanup = bindAbortCleanup(signal, () => {
        stopped = true;
        notify?.();
      });

      try {
        while (true) {
          if (queue.length > 0) {
            yield queue.shift() as GatewayEvent;
            continue;
          }

          if (stopped || signal?.aborted) {
            return;
          }

          await new Promise<void>((resolve) => {
            notify = () => {
              notify = null;
              resolve();
            };
          });
        }
      } finally {
        abortCleanup();
        unsubscribe();
      }
    }
  };
}

function isProviderRegistrationHost(value: GatewayRuntimeLike): value is GatewayRuntimeLike & GatewayRuntimeProviderRegistrationHost {
  return (
    typeof (value as Partial<GatewayRuntimeProviderRegistrationHost>).registerEmbeddingAdapter === "function" &&
    typeof (value as Partial<GatewayRuntimeProviderRegistrationHost>).registerLanguageModelAdapter === "function"
  );
}

function isTerminalRunStatus(status: GatewayRunStatus): boolean {
  return status === "cancelled" || status === "completed" || status === "failed";
}

function resolveCloseControlPlane(
  controlPlane: GatewayRuntimeLike,
  closeControlPlane: boolean | undefined
): (() => Promise<void>) | null {
  if (!closeControlPlane) {
    return null;
  }

  if (typeof (controlPlane as { close?: () => Promise<void> }).close === "function") {
    return (controlPlane as unknown as { close: () => Promise<void> }).close.bind(controlPlane);
  }

  throw new Error("closeControlPlane was requested, but the control plane does not expose close().");
}

function resolveProviderHost(
  controlPlane: GatewayRuntimeLike
): GatewayRuntimeProviderRegistrationHost | null {
  return isProviderRegistrationHost(controlPlane) ? controlPlane : null;
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise;
  }

  if (signal.aborted) {
    throw createAbortError();
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(createAbortError());
    };

    signal.addEventListener("abort", onAbort, {
      once: true
    });

    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}
