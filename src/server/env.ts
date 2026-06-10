import { parseArgs } from "node:util";

import { z } from "zod";

import { DEFAULT_HOSTNAME, DEFAULT_PORT } from "@/core/runtime-metadata";

const runtimeSchema = z.object({
  dev: z.boolean(),
  hostname: z.string().min(1),
  port: z.coerce.number().int().positive()
});

export type ServerRuntimeConfig = z.infer<typeof runtimeSchema>;

export function resolveServerRuntimeConfig(
  argv: string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env
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
    hostname: values.hostname ?? environment.HOSTNAME ?? DEFAULT_HOSTNAME,
    port: values.port ?? environment.PORT ?? DEFAULT_PORT
  });
}

