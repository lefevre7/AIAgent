import { parseArgs } from "node:util";

import { z } from "zod";

import { DEFAULT_HOSTNAME, DEFAULT_PORT } from "@/core/runtime-metadata";

const runtimeSchema = z.object({
  dev: z.boolean(),
  hostname: z.string().min(1),
  port: z.coerce.number().int().positive()
});

export type ServerRuntimeConfig = z.infer<typeof runtimeSchema>;

/**
 * Where the server listens. Precedence, most specific first: `--hostname` /
 * `--port`, then the `HOSTNAME` / `PORT` environment variables, then the
 * config's `gateway.hostname` / `gateway.port` (which `AIA_GATEWAY_HOST` /
 * `AIA_GATEWAY_PORT` already feed), then the built-in defaults.
 *
 * The config used to be skipped entirely, so `gateway.port: 4000` changed what
 * `aia info` reported and where `aia attach` dialled, while the server kept
 * listening on 3000.
 */
export function resolveServerRuntimeConfig(
  argv: string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
  gatewayDefaults: { hostname?: string; port?: number } = {}
): ServerRuntimeConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      dev: {
        type: "boolean"
      },
      hostname: {
        type: "string"
      },
      port: {
        type: "string"
      }
    }
  });

  return runtimeSchema.parse({
    dev: values.dev ?? environment.NODE_ENV !== "production",
    hostname: values.hostname ?? environment.HOSTNAME ?? gatewayDefaults.hostname ?? DEFAULT_HOSTNAME,
    port: values.port ?? environment.PORT ?? gatewayDefaults.port ?? DEFAULT_PORT
  });
}
