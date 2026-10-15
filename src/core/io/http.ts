/**
 * HTTP plumbing shared by every client aia runs: model providers
 * (src/core/lm/http.ts) and MCP servers (src/core/mcp/http.ts). One copy, so
 * what counts as worth retrying, and where a redirect may go, cannot drift
 * between them.
 */

export const MAX_SAME_ORIGIN_REDIRECTS = 10;

/**
 * Statuses that say "try again later": a timeout, rate limiting, or a server
 * (or proxy) that is overloaded or briefly down. Not 501 or 505, which no
 * retry fixes, and never 401/403: trying again cannot fix a credential.
 */
export const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/**
 * Network failures worth another attempt. Not ENOTFOUND (a misspelt host
 * stays misspelt; EAI_AGAIN is the transient DNS failure), and not undici's
 * header or body timeouts: those fire after a server took the request and
 * worked on it for minutes, so a retry repeats all of that work.
 */
export const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET"
]);

/**
 * The system error code behind a failure. Node's fetch reports every
 * connection failure as a bare TypeError("fetch failed") with the errno in
 * `cause`, sometimes a level or two down.
 */
export function readNetworkErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") {
      return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Whether a thrown error is a network failure worth another attempt: by its
 * code (on the error or its cause), or, for an error that only names it in
 * its message ("read ECONNRESET"), by the code spelled out there.
 */
export function isTransientNetworkError(error: unknown): boolean {
  const code = readNetworkErrorCode(error);
  if (code !== undefined) {
    return TRANSIENT_NETWORK_CODES.has(code);
  }
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const words = current.message.match(/\b[A-Z][A-Z_]{3,}\b/gu) ?? [];
    if (words.some((word) => TRANSIENT_NETWORK_CODES.has(word))) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * Fetches `url`, following redirects by hand and only within its origin, up
 * to ten. A server must not be able to send a request, and the credentials on
 * it, somewhere else: Node's fetch drops `Authorization` on a cross-origin
 * redirect but forwards every custom header (an `x-api-key`) and, on a 307 or
 * 308, the whole body. A different origin, an https-to-http downgrade
 * included, is refused. A 303, and a 301 or 302 answering a POST, continue as
 * a GET without a body, as browsers do.
 */
export async function fetchFollowingSameOriginRedirects(params: {
  fetchImpl: typeof fetch;
  init: RequestInit;
  /** Who is being called, for the error: "The MCP server", "LM Studio". */
  label: string;
  url: string | URL;
}): Promise<Response> {
  let url = params.url;
  let init: RequestInit = { ...params.init, redirect: "manual" };
  for (let redirects = 0; ; redirects += 1) {
    const response = await params.fetchImpl(url, init);
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || response.status === 304 || !location) {
      return response;
    }
    // Parsed only once there is a redirect to judge.
    const origin = new URL(String(params.url)).origin;
    if (redirects >= MAX_SAME_ORIGIN_REDIRECTS) {
      throw new Error(`${params.label} at ${origin} redirected more than ${MAX_SAME_ORIGIN_REDIRECTS} times.`);
    }
    const next = new URL(location, String(url));
    if (next.origin !== origin) {
      throw new Error(
        `${params.label} at ${origin} redirected to ${next.origin}; only redirects within the same origin are followed.`
      );
    }
    const method = (init.method ?? "GET").toUpperCase();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
      const withoutBody = new Headers(init.headers);
      withoutBody.delete("content-type");
      withoutBody.delete("content-length");
      init = { ...init, body: null, headers: withoutBody, method: "GET" };
    }
    // Drained so the connection can be reused.
    await response.body?.cancel().catch(() => undefined);
    url = next;
  }
}

/**
 * Waits `ms`, or less if a signal aborts first. A wait between retries must
 * not outlive the request it is retrying: a cancelled run (Ctrl-C, /exit) used
 * to sit out a server's whole `Retry-After`, up to a minute.
 */
export function sleepUnlessAborted(ms: number, signals: Array<AbortSignal | undefined>): Promise<void> {
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (active.some((signal) => signal.aborted)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      for (const signal of active) {
        signal.removeEventListener("abort", finish);
      }
      resolve();
    };
    const timer = setTimeout(finish, ms);
    for (const signal of active) {
      signal.addEventListener("abort", finish, { once: true });
    }
  });
}

/**
 * Replaces each of `secrets` (header values a request carried) in `text`.
 * Node's fetch puts an invalid header's whole value in its error ("Headers.append:
 * "Bearer sk-…" is an invalid header value"), and that message reaches logs,
 * the session's last error, and the operator's screen.
 */
export function redactValues(text: string, secrets: Iterable<string>): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length >= 4) {
      redacted = redacted.split(secret).join("<redacted>");
    }
  }
  return redacted;
}
