import type { ExternalAgentConfig } from "@/core/config";

/**
 * Variables an external CLI needs before it can do anything at all.
 *
 * This is a floor, not a convenience list. Everything here changes whether the
 * process *runs*, not what it can reach: where to find binaries (`PATH`), where
 * its own config lives (`HOME`), how to render into a PTY (`TERM*`), how to
 * decode bytes (`LANG`/`LC_*`), where to put temp files, and how to get out
 * through a corporate proxy or trust a corporate CA. Omitting any of these
 * turns "restricted" into "broken", which is how allowlists get deleted.
 *
 * Anything an agent needs beyond this floor — API keys above all — is opt-in
 * through `passEnv`, either globally (`externalAgents.passEnv`) or per agent,
 * which is the point: the operator names the secrets a given CLI may see
 * instead of every child inheriting the whole shell.
 */
const BASE_ENVIRONMENT_ALLOWLIST: readonly string[] = [
  "COLORTERM",
  "HOME",
  "HOSTNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "PATH",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TERM",
  "TERMINFO",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  // Proxy configuration is case-sensitive in practice: curl-style tools read
  // the lowercase names, most runtimes read the uppercase ones, and a machine
  // behind a corporate proxy sets whichever its tooling expects.
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy"
];

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
  const source = params.processEnv ?? process.env;
  const env: Record<string, string> = {};

  for (const key of BASE_ENVIRONMENT_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }

  for (const key of [...(params.globalPassEnv ?? []), ...(params.config.passEnv ?? [])]) {
    const value = source[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(params.config.env ?? {})) {
    env[key] = typeof value === "string" ? value : JSON.stringify(value);
  }

  return { ...env, ...params.overrides };
}

/** Exposed so docs and tests can assert the floor without duplicating it. */
export function listBaseEnvironmentAllowlist(): readonly string[] {
  return BASE_ENVIRONMENT_ALLOWLIST;
}
