import { EventEmitter } from "node:events";

import { describe, expect, test } from "vitest";

import { attachToExternalAgentSession, type AttachStreams, type AttachWebSocketClient } from "@/gateway/attach-client";

type SentRequest = { payload: Record<string, unknown>; topic: string };

/**
 * A stand-in for the gateway socket that records what the relay sends and lets
 * a test push frames back at it.
 */
class FakeAttachSocket extends EventEmitter implements AttachWebSocketClient {
  readonly sent: SentRequest[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  readyState = 1;

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason });
    this.readyState = 3;
  }

  send(data: string): void {
    const parsed = JSON.parse(data) as SentRequest;
    this.sent.push({ payload: parsed.payload, topic: parsed.topic });
  }

  deliver(value: unknown): void {
    this.emit("message", typeof value === "string" ? value : JSON.stringify(value));
  }
}

function createStreams(): { streams: AttachStreams; stdin: EventEmitter; output: () => string } {
  let output = "";
  const stdin = new EventEmitter() as EventEmitter & { isTTY?: boolean; resume: () => void };
  stdin.resume = () => undefined;

  return {
    output: () => output,
    stdin,
    streams: {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: {
        write: (chunk: string) => {
          output += chunk;
          return true;
        }
      } as unknown as NodeJS.WritableStream
    }
  };
}

function buildOutputDeltaEvent(params: { chunk: string; sourceId: string; sourceKind: string }) {
  return {
    createdAt: "2026-03-31T12:00:00.000Z",
    id: "gateway-event.attach.1",
    metadata: {},
    payload: {
      chunk: params.chunk,
      sourceId: params.sourceId,
      sourceKind: params.sourceKind,
      stream: "combined"
    },
    topic: "tool.output.delta"
  };
}

describe("attachToExternalAgentSession", () => {
  test("subscribes, primes the screen, relays keystrokes, and detaches on Ctrl-]", async () => {
    const socket = new FakeAttachSocket();
    const { output, stdin, streams } = createStreams();

    const exitCode = attachToExternalAgentSession({
      createWebSocket: () => socket,
      externalSessionId: "external-agent-session.abc",
      streams,
      token: "secret",
      url: "ws://127.0.0.1:3000/api/gateway/ws"
    });

    socket.emit("open");

    // The relay must subscribe before anything else, or output produced
    // between connect and subscribe is lost.
    expect(socket.sent.map((entry) => entry.topic)).toEqual(["gateway.subscribe", "external_agent.session.read"]);
    expect(socket.sent[1]?.payload).toMatchObject({
      externalSessionId: "external-agent-session.abc",
      includeScrollback: true
    });

    socket.deliver({
      createdAt: "2026-03-31T12:00:00.000Z",
      id: "gateway-response.1",
      metadata: {},
      ok: true,
      payload: { screen: "existing screen" },
      requestId: "request.1",
      topic: "external_agent.session.read"
    });
    expect(output()).toContain("existing screen");

    socket.deliver(
      buildOutputDeltaEvent({
        chunk: "hello from the agent",
        sourceId: "external-agent-session.abc",
        sourceKind: "external_agent"
      })
    );
    expect(output()).toContain("hello from the agent");

    stdin.emit("data", Buffer.from("ls -la\r", "utf8"));
    expect(socket.sent.at(-1)).toEqual({
      payload: { externalSessionId: "external-agent-session.abc", text: "ls -la\r" },
      topic: "external_agent.session.write"
    });

    // Ctrl-] detaches without killing the session.
    stdin.emit("data", Buffer.from("", "utf8"));

    await expect(exitCode).resolves.toBe(0);
    expect(socket.closes).toEqual([{ code: 1000, reason: "detached" }]);
    // After detaching, further keystrokes must not be relayed.
    const sentAfterDetach = socket.sent.length;
    stdin.emit("data", Buffer.from("rm -rf /\r", "utf8"));
    expect(socket.sent).toHaveLength(sentAfterDetach);
  });

  // The addendum claims an attached terminal "cannot see another session's
  // output" because the filter checks both fields. That was never tested.
  test("ignores output deltas belonging to another session or source kind", async () => {
    const socket = new FakeAttachSocket();
    const { output, streams } = createStreams();

    const exitCode = attachToExternalAgentSession({
      createWebSocket: () => socket,
      externalSessionId: "external-agent-session.mine",
      streams,
      url: "ws://127.0.0.1:3000/api/gateway/ws"
    });

    socket.emit("open");

    socket.deliver(
      buildOutputDeltaEvent({
        chunk: "SOMEONE ELSES SECRETS",
        sourceId: "external-agent-session.theirs",
        sourceKind: "external_agent"
      })
    );
    socket.deliver(
      buildOutputDeltaEvent({
        chunk: "A SHELL COMMANDS OUTPUT",
        sourceId: "external-agent-session.mine",
        sourceKind: "command"
      })
    );

    expect(output()).toBe("");

    socket.emit("close");
    await expect(exitCode).resolves.toBe(0);
  });

  test("puts the auth token on the URL so attaching inherits gateway auth", async () => {
    const socket = new FakeAttachSocket();
    const { streams } = createStreams();
    let requestedUrl = "";

    const exitCode = attachToExternalAgentSession({
      createWebSocket: (url) => {
        requestedUrl = url;
        return socket;
      },
      externalSessionId: "external-agent-session.abc",
      streams,
      token: "secret-token",
      url: "ws://127.0.0.1:3000/api/gateway/ws"
    });

    expect(new URL(requestedUrl).searchParams.get("token")).toBe("secret-token");

    socket.emit("close");
    await expect(exitCode).resolves.toBe(0);
  });

  test("fails with the gateway's own message when a request is rejected", async () => {
    const socket = new FakeAttachSocket();
    const { streams } = createStreams();

    const exitCode = attachToExternalAgentSession({
      createWebSocket: () => socket,
      externalSessionId: "external-agent-session.missing",
      streams,
      url: "ws://127.0.0.1:3000/api/gateway/ws"
    });

    socket.emit("open");
    socket.deliver({
      createdAt: "2026-03-31T12:00:00.000Z",
      error: { code: "not_found", message: "No such interactive session.", retriable: false },
      id: "gateway-response.2",
      metadata: {},
      ok: false,
      requestId: "request.2",
      topic: "external_agent.session.read"
    });

    await expect(exitCode).rejects.toThrow("No such interactive session.");
  });

  test("surfaces a transport error and ignores unparsable frames", async () => {
    const socket = new FakeAttachSocket();
    const { output, streams } = createStreams();

    const exitCode = attachToExternalAgentSession({
      createWebSocket: () => socket,
      externalSessionId: "external-agent-session.abc",
      streams,
      url: "ws://127.0.0.1:3000/api/gateway/ws"
    });

    socket.emit("open");
    // Neither of these should throw or produce output.
    socket.deliver("not json at all");
    socket.deliver({ something: "that is neither an event nor a response" });
    expect(output()).toBe("");

    socket.emit("error", new Error("socket exploded"));
    await expect(exitCode).rejects.toThrow("socket exploded");
  });

  test("restores the terminal mode it changed", async () => {
    const socket = new FakeAttachSocket();
    const { streams } = createStreams();
    const rawModes: boolean[] = [];
    const stdin = streams.stdin as unknown as { isTTY: boolean; setRawMode: (value: boolean) => void };
    stdin.isTTY = true;
    stdin.setRawMode = (value: boolean) => {
      rawModes.push(value);
    };

    const exitCode = attachToExternalAgentSession({
      createWebSocket: () => socket,
      externalSessionId: "external-agent-session.abc",
      streams,
      url: "ws://127.0.0.1:3000/api/gateway/ws"
    });

    socket.emit("open");
    expect(rawModes).toEqual([true]);

    socket.emit("close");
    await expect(exitCode).resolves.toBe(0);
    // Leaving a terminal in raw mode makes the operator's shell unusable.
    expect(rawModes).toEqual([true, false]);
  });
});
