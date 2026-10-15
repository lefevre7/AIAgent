import { gatewayResponseSchema, type GatewayRequestTopic, type GatewayResponse } from "@/core/contracts";
import { buildGatewayRequest, openGatewaySocket, type AttachWebSocketClient } from "@/gateway/attach-client";

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Sends one gateway request over a gateway WebSocket and resolves with its
 * response: how a separate `aia` process (`aia mcp reconnect`) reaches a
 * running session. The socket is closed either way.
 */
export async function requestGatewayOverWebSocket(params: {
  /** Injected by tests (see openGatewaySocket). */
  createWebSocket?: (url: string) => AttachWebSocketClient;
  payload: unknown;
  timeoutMs?: number;
  token?: string;
  topic: GatewayRequestTopic;
  url: string;
}): Promise<GatewayResponse> {
  const socket = openGatewaySocket(params);
  const request = buildGatewayRequest(params.topic, params.payload);

  return new Promise<GatewayResponse>((resolve, reject) => {
    let settled = false;
    const finish = (outcome: { error: Error } | { response: GatewayResponse }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.close();
      if ("error" in outcome) {
        reject(outcome.error);
      } else {
        resolve(outcome.response);
      }
    };
    const timer = setTimeout(
      () =>
        finish({
          error: new Error(
            `No answer from ${params.url} within ${Math.round((params.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} s.`
          )
        }),
      params.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    socket.on("open", () => socket.send(JSON.stringify(request)));
    socket.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }
      const response = gatewayResponseSchema.safeParse(parsed);
      if (response.success && response.data.requestId === request.id) {
        finish({ response: response.data });
      }
    });
    socket.on("error", (error) => finish({ error }));
    socket.on("close", () => finish({ error: new Error(`The gateway at ${params.url} closed the connection.`) }));
  });
}
