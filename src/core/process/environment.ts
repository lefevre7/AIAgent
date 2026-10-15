/**
 * Variables a child process needs before it can do anything at all.
 *
 * This is a floor, not a convenience list. Everything here changes whether the
 * process *runs*, not what it can reach: where to find binaries (`PATH`), where
 * its own config lives (`HOME`), how to render into a PTY (`TERM*`), how to
 * decode bytes (`LANG` and the locale categories, and macOS's `__CF_USER_TEXT_ENCODING`), where
 * to put temp files, and how to get out through a corporate proxy or trust a
 * corporate CA. Omitting any of these turns "restricted" into "broken", which
 * is how allowlists get deleted.
 *
 * Anything a child needs beyond this floor, API keys above all, is opt-in
 * through `passEnv`: the operator names the secrets a given process may see
 * instead of every child inheriting the whole shell. External agents and
 * stdio MCP servers both start from this list.
 */
const BASE_ENVIRONMENT_ALLOWLIST: readonly string[] = [
  "COLORTERM",
  "HOME",
  "HOSTNAME",
  "LANG",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TEMP",
  "TERM",
  "TERMINFO",
  "TMP",
  "TMPDIR",
  "TZ",
  "USER",
  "__CF_USER_TEXT_ENCODING",
  // Proxy configuration is case-sensitive in practice: curl-style tools read
  // the lowercase names, most runtimes read the uppercase ones, and a machine
  // behind a corporate proxy sets whichever its tooling expects.
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  // A corporate CA bundle, under the name each ecosystem reads (Codex's list).
  "BUNDLE_SSL_CA_CERT",
  "CARGO_HTTP_CAINFO",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "NODE_EXTRA_CA_CERTS",
  "NPM_CONFIG_CAFILE",
  "PIP_CERT",
  "REQUESTS_CA_BUNDLE",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "npm_config_cafile"
];

// The POSIX and glibc locale categories, by name. Not every `LC_` variable:
// sshd forwards `LC_*` by default (AcceptEnv), which is a known way to carry
// other values, a token included, into a session.
const LOCALE_VARIABLES: readonly string[] = [
  "LANGUAGE",
  "LC_ADDRESS",
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_IDENTIFICATION",
  "LC_MEASUREMENT",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NAME",
  "LC_NUMERIC",
  "LC_PAPER",
  "LC_TELEPHONE",
  "LC_TIME"
];

// What a Windows process needs to start at all: the system directory
// (`SystemRoot`, `windir`), the shell and executable extensions an `npx.cmd`
// shim runs through (`ComSpec`, `PATHEXT`), and the profile directories (the
// list the MCP SDK itself passes there). Only on Windows.
const WINDOWS_VARIABLES: readonly string[] = [
  "APPDATA",
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "USERNAME",
  "USERPROFILE",
  "WINDIR"
];

function floorFor(platform: NodeJS.Platform): readonly string[] {
  return platform === "win32"
    ? [...BASE_ENVIRONMENT_ALLOWLIST, ...LOCALE_VARIABLES, ...WINDOWS_VARIABLES]
    : [...BASE_ENVIRONMENT_ALLOWLIST, ...LOCALE_VARIABLES];
}

/**
 * The environment for a child process: the base allowlist, then the `passEnv`
 * names (copied only when set), then explicit `env` values, most specific
 * last. Deliberately an allowlist rather than `{ ...process.env }`.
 */
export function buildChildProcessEnvironment(params: {
  env?: Record<string, string>;
  passEnv?: readonly string[];
  /** Defaults to this process's. On Windows, variable names match in any case. */
  platform?: NodeJS.Platform;
  // Not `NodeJS.ProcessEnv`: Next.js augments that with required keys, so a
  // caller (or a test) could not supply a plain map.
  processEnv?: Record<string, string | undefined>;
}): Record<string, string> {
  const source = params.processEnv ?? process.env;
  const platform = params.platform ?? process.platform;
  // Windows variable names are case-insensitive, and `process.env` lists them
  // as they were set: `Path`, not `PATH`. An exact match dropped PATH there,
  // and every external agent then failed to start.
  const fold = platform === "win32" ? (name: string) => name.toUpperCase() : (name: string) => name;
  const floor = new Set(floorFor(platform).map(fold));
  const passEnv = new Set((params.passEnv ?? []).map(fold));
  const env: Record<string, string> = {};

  // On Windows every name is written in one case: the SDK's stdio transport
  // (used there) adds its own defaults (`PATH`) to what it is given, and a
  // `Path` beside it made two variables a child would see either of.
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && (floor.has(fold(key)) || passEnv.has(fold(key)))) {
      env[fold(key)] = value;
    }
  }
  for (const [key, value] of Object.entries(params.env ?? {})) {
    env[fold(key)] = value;
  }
  return env;
}

/** Exposed so docs and tests can assert the floor without duplicating it. */
export function listBaseEnvironmentAllowlist(platform: NodeJS.Platform = process.platform): readonly string[] {
  return floorFor(platform);
}
