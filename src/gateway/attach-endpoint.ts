import fs from "node:fs/promises";
import path from "node:path";
import { createServer, type Server } from "node:http";

import { z } from "zod";

import { writeJsonAtomic } from "@/core/io/files";
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

const ATTACH_ENDPOINT_FILE_NAME = "attach-endpoint.json";

const attachEndpointSchema = z
  .object({
    createdAt: z.string().min(1),
    pid: z.number().int().positive(),
    url: z.string().min(1)
  })
  .strict();

export type AttachEndpointRecord = z.infer<typeof attachEndpointSchema>;

export type ServedAttachEndpoint = {
  close(): Promise<void>;
  url: string;
};

export function attachEndpointFilePath(stateRoot: string): string {
  return path.join(stateRoot, ATTACH_ENDPOINT_FILE_NAME);
}

/**
 * Starts a loopback-only gateway WebSocket and publishes its URL.
 *
 * Binds an **ephemeral** port rather than the configured one: a dev server may
 * already hold that port, and a failure to start the listener must never stop
 * the CLI from running. The chosen URL is written to the state root so
 * `aia attach` — a separate process — can find it.
 */
export async function serveAttachEndpoint(params: {
  requestTimeoutMs?: number;
  runtime: GatewayRuntimeLike;
  stateRoot: string;
  token?: string;
  websocketPath: string;
}): Promise<ServedAttachEndpoint | null> {
  let server: Server | undefined;
  try {
    server = createServer((_request, response) => {
      // The listener exists only for the WebSocket upgrade. Anything else gets
      // a flat refusal rather than an accidental HTTP control surface.
      response.statusCode = 404;
      response.end();
    });

    const socket = attachGatewayWebSocketServer({
      ...(params.token ? { auth: { token: params.token } } : {}),
      ...(params.requestTimeoutMs ? { requestTimeoutMs: params.requestTimeoutMs } : {}),
      runtime: params.runtime,
      server,
      websocketPath: params.websocketPath
    });

    const listening = server;
    await new Promise<void>((resolve, reject) => {
      listening.once("error", reject);
      // Loopback only. This surface is unauthenticated when no token is
      // configured, exactly like the dev server's, so it must not be reachable
      // off this machine.
      listening.listen(0, "127.0.0.1", resolve);
    });

    const address = listening.address();
    if (!address || typeof address === "string") {
      throw new Error("The attach endpoint did not report a usable address.");
    }

    const url = `ws://127.0.0.1:${address.port}${params.websocketPath}`;
    const filePath = attachEndpointFilePath(params.stateRoot);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await writeJsonAtomic(
      filePath,
      attachEndpointSchema.parse({
        createdAt: new Date().toISOString(),
        pid: process.pid,
        url
      })
    );

    return {
      async close(): Promise<void> {
        await socket.close().catch(() => undefined);
        await new Promise<void>((resolve) => {
          listening.close(() => {
            resolve();
          });
        });
        // Only remove the file if it still describes this process; another CLI
        // may have started meanwhile and published its own.
        const current = await readAttachEndpoint(params.stateRoot);
        if (current?.pid === process.pid) {
          await fs.rm(filePath, { force: true });
        }
      },
      url
    };
  } catch {
    server?.close();
    return null;
  }
}

/**
 * Reads the endpoint published by a running CLI, or null when there is none.
 *
 * A record naming a process that is no longer alive is treated as absent: a
 * crashed CLI leaves its file behind, and attaching to a dead listener would
 * fail with a confusing connection error instead of a clear one.
 */
export async function readAttachEndpoint(stateRoot: string): Promise<AttachEndpointRecord | null> {
  try {
    const raw = await fs.readFile(attachEndpointFilePath(stateRoot), "utf8");
    const record = attachEndpointSchema.parse(JSON.parse(raw) as unknown);
    return isProcessAlive(record.pid) ? record : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering it.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user, which still counts.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
