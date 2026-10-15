import type { ExternalAgentConfig } from "@/core/config";
import { buildChildProcessEnvironment } from "@/core/process/environment";

export { listBaseEnvironmentAllowlist } from "@/core/process/environment";

export type ExternalAgentEnvironmentConfig = Pick<ExternalAgentConfig, "env" | "passEnv">;

/**
 * Builds the environment an external agent CLI is spawned with.
 *
 * Deliberately an allowlist rather than `{ ...process.env }`: an external agent
 * runs with its own approvals bypassed (see `docs/EXTERNAL_AGENTS.md`), so it
 * should not also inherit every credential that happens to be exported in the
 * operator's shell. Precedence is base allowlist, then the global
 * `externalAgents.passEnv`, then the agent's own `passEnv`, then the agent's
 * explicit `env`, then per-call overrides — most specific wins.
 *
 * Used by both the one-shot job path and the interactive session path so the
 * two cannot drift; they did, and the interactive path silently honoured
 * neither `env` nor `passEnv`.
 */
export function buildExternalAgentEnvironment(params: {
  config: ExternalAgentEnvironmentConfig;
  /**
   * `externalAgents.passEnv` — names every agent may read. Applied before the
   * agent's own list so a per-agent entry still wins.
   */
  globalPassEnv?: readonly string[];
  overrides?: Record<string, string>;
  // Not `NodeJS.ProcessEnv`: Next.js augments that with required keys, so a
  // caller (or a test) could not supply a plain map.
  processEnv?: Record<string, string | undefined>;
}): Record<string, string> {
  const env = buildChildProcessEnvironment({
    env: Object.fromEntries(
      Object.entries(params.config.env ?? {}).map(([key, value]) => [
        key,
        typeof value === "string" ? value : JSON.stringify(value)
      ])
    ),
    passEnv: [...(params.globalPassEnv ?? []), ...(params.config.passEnv ?? [])],
    ...(params.processEnv ? { processEnv: params.processEnv } : {})
  });
  return { ...env, ...params.overrides };
}
