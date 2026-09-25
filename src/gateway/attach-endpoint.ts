import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer, type Server } from "node:http";

import { z } from "zod";

import { writeJsonAtomic } from "@/core/io/files";
import { checkProcessLiveness } from "@/core/process/liveness";
import { attachGatewayWebSocketServer } from "@/gateway/websocket";
import type { GatewayRuntimeLike } from "@/gateway/runtime";

/**
 * A loopback gateway listener owned by a short-lived surface (the interactive
 * CLI), so a terminal window spawned for an external-agent session has
 * something to attach to.
 *
 * Without this, `aia attach` only worked while `npm run dev` / `npm start` was
 * running: those are the only places that attach the gateway WebSocket. A
 * window opened from a bare `aia` REPL died on `ECONNREFUSED` before showing
 * anything, which made the shared-terminal feature useless exactly where the
 * agent is most often driven from.
 *
 * Deliberately reuses the existing gateway transport rather than inventing a
 * second one: the human's keystrokes travel the same authenticated path the
 * agent's do, and the window keeps working over a tunnel.
 */

const ATTACH_ENDPOINTS_DIRECTORY_NAME = "attach-endpoints";

const attachEndpointSchema = z
  .object({
    createdAt: z.string().min(1),
    pid: z.number().int().positive(),
    /** The per-launch token, present only when no gateway token is configured. */
    token: z.string().min(1).optional(),
    url: z.string().min(1)
  })
  .strict();

export type AttachEndpointRecord = z.infer<typeof attachEndpointSchema>;

export type ServedAttachEndpoint = {
  close(): Promise<void>;
  url: string;
};

export function attachEndpointsDirectory(stateRoot: string): string {
  return path.join(stateRoot, ATTACH_ENDPOINTS_DIRECTORY_NAME);
}

/**
 * One record per serving process, so two REPLs in the same workspace never
 * overwrite each other's endpoint (and token), or delete it on exit.
 */
export function attachEndpointFilePath(stateRoot: string, pid: number = process.pid): string {
  return path.join(attachEndpointsDirectory(stateRoot), `${pid}.json`);
}

/**
 * The URL an `aia attach` window should dial for a server bound to
 * `hostname:port`. An unspecified bind address also accepts on loopback, and is
 * not itself something a client can dial.
 */
export function serverAttachUrl(params: { hostname: string; port: number; websocketPath: string }): string {
  const host = params.hostname === "0.0.0.0" || params.hostname === "::" ? "127.0.0.1" : params.hostname;
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `ws://${authority}:${params.port}${params.websocketPath}`;
}

/**
 * Starts a loopback-only gateway WebSocket and publishes its URL.
 *
 * Binds an **ephemeral** port rather than the configured one: a dev server may
 * already hold that port, and a failure to start the listener must never stop
 * the CLI from running. The chosen URL is written to the state root so
 * `aia attach` — a separate process — can find it.
 *
 * With no configured gateway token the listener used to be unauthenticated, so
 * any local process could drive the whole gateway through it — and so could a
 * web page, because browsers do not apply CORS to WebSocket handshakes. It now
 * requires a token minted for this launch, published only in the
 * owner-readable (0600) record that `aia attach` reads.
 */
export async function serveAttachEndpoint(params: {
  requestTimeoutMs?: number;
  runtime: GatewayRuntimeLike;
  stateRoot: string;
  token?: string;
  websocketPath: string;
}): Promise<ServedAttachEndpoint | null> {
  const token = params.token ?? crypto.randomBytes(32).toString("base64url");
  // A configured token already reaches `aia attach` through config; only a
  // minted one needs publishing, and copying a configured secret into the
  // workspace would spread it.
  const publishToken = params.token === undefined;
  let server: Server | undefined;
  try {
    server = createServer((_request, response) => {
      // The listener exists only for the WebSocket upgrade. Anything else gets
      // a flat refusal rather than an accidental HTTP control surface.
      response.statusCode = 404;
      response.end();
    });

    const socket = attachGatewayWebSocketServer({
      auth: { token },
      ...(params.requestTimeoutMs ? { requestTimeoutMs: params.requestTimeoutMs } : {}),
      runtime: params.runtime,
      server,
      websocketPath: params.websocketPath
    });

    const listening = server;
    await new Promise<void>((resolve, reject) => {
      listening.once("error", reject);
      // Loopback only: this surface must not be reachable off this machine.
      listening.listen(0, "127.0.0.1", resolve);
    });

    const address = listening.address();
    if (!address || typeof address === "string") {
      throw new Error("The attach endpoint did not report a usable address.");
    }

    const url = `ws://127.0.0.1:${address.port}${params.websocketPath}`;
    const filePath = attachEndpointFilePath(params.stateRoot);
    await writeJsonAtomic(
      filePath,
      attachEndpointSchema.parse({
        createdAt: new Date().toISOString(),
        pid: process.pid,
        ...(publishToken ? { token } : {}),
        url
      }),
      { mode: 0o600 }
    );

    return {
      async close(): Promise<void> {
        await socket.close().catch(() => undefined);
        await new Promise<void>((resolve) => {
          listening.close(() => {
            resolve();
          });
        });
        await fs.rm(filePath, { force: true });
      },
      url
    };
  } catch (error) {
    server?.close();
    // Not fatal: the REPL is fully usable without a shared terminal. But never
    // silent, or a missing window reads as the feature being broken.
    const reason = error instanceof Error ? error.message : String(error);
    process.emitWarning(
      `The interactive CLI could not serve its gateway endpoint (${reason}), so external-agent terminal windows are unavailable this session.`,
      { code: "AIA_ATTACH_ENDPOINT_UNAVAILABLE" }
    );
    return null;
  }
}

/**
 * Reads an endpoint published by a running CLI, or null when there is none.
 *
 * Every record is untrusted input: the state root usually sits inside the
 * workspace, which a cloned repository controls, and `aia attach` sends the
 * gateway token to the URL it finds. A record is only honoured when it names a
 * live process of this user — EPERM means the pid now belongs to someone else,
 * so the CLI that wrote it is gone — and a loopback `ws://` URL.
 *
 * With `url`, returns the record for that exact listener (so its token can be
 * used); otherwise the most recently published one.
 */
export async function readAttachEndpoint(
  stateRoot: string,
  options: { url?: string } = {}
): Promise<AttachEndpointRecord | null> {
  const directory = attachEndpointsDirectory(stateRoot);
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch {
    return null;
  }

  const records: AttachEndpointRecord[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const record = await readAttachEndpointRecord(path.join(directory, name));
    if (record && checkProcessLiveness(record.pid) === "alive" && isLoopbackWebSocketUrl(record.url)) {
      records.push(record);
    }
  }

  if (options.url !== undefined) {
    return records.find((record) => record.url === options.url) ?? null;
  }
  return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

async function readAttachEndpointRecord(filePath: string): Promise<AttachEndpointRecord | null> {
  try {
    return attachEndpointSchema.parse(JSON.parse(await fs.readFile(filePath, "utf8")) as unknown);
  } catch {
    return null;
  }
}

function isLoopbackWebSocketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "ws:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  } catch {
    return false;
  }
}
