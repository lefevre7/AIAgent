import crypto from "node:crypto";
import { createRequire } from "node:module";

import { gatewayEventSchema, gatewayResponseSchema } from "@/core/contracts";

const require = createRequire(import.meta.url);

export type AttachWebSocketClient = {
  close(code?: number, reason?: string): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "open", listener: () => void): void;
  readyState: number;
  send(data: string): void;
};

export type AttachStreams = {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WritableStream;
};

export type AttachOptions = {
  /**
   * Opens the transport. Injected so tests can drive the relay without a real
   * server, and because `ws` is loaded through `createRequire` (webpack's
   * interop hands back an undefined default for a static import) and so cannot
   * be module-mocked.
   */
  createWebSocket?: (url: string) => AttachWebSocketClient;
  externalSessionId: string;
  streams: AttachStreams;
  token?: string;
  url: string;
};

/**
 * Relays a local terminal to a live interactive external-agent session.
 *
 * This is deliberately a *thin* relay over the existing gateway WebSocket
 * rather than a second transport: the human's keystrokes travel the same
 * authenticated path the agent's do, so attaching works over a tunnel and
 * inherits gateway auth instead of inventing a second trust boundary.
 *
 * Resolves when the socket closes (the session stopped, or the operator
 * pressed Ctrl-] to detach).
 */
export async function attachToExternalAgentSession(options: AttachOptions): Promise<number> {
  const url = new URL(options.url);
  if (options.token) {
    url.searchParams.set("token", options.token);
  }

  const socket = options.createWebSocket
    ? options.createWebSocket(url.toString())
    : new (
        require("ws") as {
          WebSocket: new (target: string) => AttachWebSocketClient;
        }
      ).WebSocket(url.toString());
  const restoreStdin = configureRawStdin(options.streams.stdin);

  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const finish = (code: number, error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      restoreStdin();
      options.streams.stdin.removeListener("data", onStdinData);
      // A flowing stdin keeps the process alive: without this the window sat
      // on a finished relay after Ctrl-] or after its host went away.
      options.streams.stdin.pause();
      if (socket.readyState === 1) {
        socket.close(1000, "detached");
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(code);
    };

    const onStdinData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      // Ctrl-] detaches, mirroring telnet/tmux muscle memory. Without an escape
      // the operator would have to kill the window to leave, which would also
      // look like a crash to anyone reading the logs.
      if (text.includes("\u001d")) {
        finish(0);
        return;
      }

      sendRequest(socket, "external_agent.session.write", {
        externalSessionId: options.externalSessionId,
        text
      });
    };

    socket.on("open", () => {
      sendRequest(socket, "gateway.subscribe", { topics: ["tool.output.delta"] });
      sendRequest(socket, "external_agent.session.read", {
        externalSessionId: options.externalSessionId,
        includeScrollback: true
      });
      options.streams.stdin.on("data", onStdinData);
      options.streams.stdin.resume();
    });

    socket.on("message", (data) => {
      const text = typeof data === "string" ? data : Buffer.isBuffer(data) ? data.toString("utf8") : null;
      if (!text) {
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        return;
      }

      const event = gatewayEventSchema.safeParse(parsed);
      if (event.success) {
        if (
          event.data.topic === "tool.output.delta" &&
          event.data.payload.sourceKind === "external_agent" &&
          event.data.payload.sourceId === options.externalSessionId
        ) {
          options.streams.stdout.write(event.data.payload.chunk);
        }
        return;
      }

      const response = gatewayResponseSchema.safeParse(parsed);
      if (!response.success) {
        return;
      }

      if (!response.data.ok) {
        finish(1, new Error(response.data.error?.message ?? "The gateway rejected an attach request."));
        return;
      }

      // The initial read primes the window with the screen as it already is,
      // so an operator joining mid-task sees context rather than a blank pane.
      if (response.data.topic === "external_agent.session.read") {
        const payload = response.data.payload as { screen?: unknown } | undefined;
        if (typeof payload?.screen === "string") {
          options.streams.stdout.write(`${payload.screen}\n`);
        }
      }
    });

    socket.on("close", () => {
      finish(0);
    });

    socket.on("error", (error) => {
      finish(1, error);
    });
  });
}

function sendRequest(socket: AttachWebSocketClient, topic: string, payload: unknown): void {
  if (socket.readyState !== 1) {
    return;
  }

  socket.send(
    JSON.stringify({
      createdAt: new Date().toISOString(),
      id: `request.${crypto.randomUUID()}`,
      metadata: {},
      payload,
      topic
    })
  );
}

function configureRawStdin(stdin: NodeJS.ReadStream): () => void {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return () => undefined;
  }

  // Raw mode is what makes this a terminal rather than a line editor: arrow
  // keys, Ctrl-C, and a TUI's own key handling all need bytes forwarded
  // unbuffered and uninterpreted.
  stdin.setRawMode(true);
  return () => {
    stdin.setRawMode(false);
  };
}
