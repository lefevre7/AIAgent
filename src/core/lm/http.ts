import type { JsonValue, StructuredError } from "@/core/contracts";
import {
  fetchFollowingSameOriginRedirects,
  isTransientNetworkError,
  redactValues,
  sleepUnlessAborted,
  TRANSIENT_HTTP_STATUSES
} from "@/core/io/http";

/** Retries after a model request's first attempt, unless a provider's `maxRetries` says otherwise. */
export const DEFAULT_PROVIDER_MAX_RETRIES = 3;

/** Attempts in all for a provider's request: the first and its `maxRetries`. */
export function providerMaxAttempts(maxRetries: number | undefined): number {
  return 1 + (maxRetries ?? DEFAULT_PROVIDER_MAX_RETRIES);
}

export class ProviderRequestError extends Error {
  constructor(readonly structuredError: StructuredError) {
    super(structuredError.message);
    this.name = "ProviderRequestError";
  }
}

export type FetchLike = typeof fetch;

export type JsonHttpResult<T> = {
  data: T;
  headers: Record<string, string>;
  rawText: string;
  status: number;
};

type JsonRequestOptions = {
  body?: unknown;
  // The caller's cancellation (a cancelled run). It is combined with each
  // attempt's own timeout or stream guard, and a cancelled request is never
  // retried.
  cancelSignal?: AbortSignal;
  fetchImpl?: FetchLike;
  headers?: Record<string, string>;
  maxAttempts?: number;
  method?: "GET" | "POST";
  /**
   * How long, counted from the first attempt, a 503 may keep being retried
   * beyond `maxAttempts`. A llama.cpp server answers every endpoint with 503
   * "Loading model" until its model is in memory, which takes minutes for a
   * large one: that is a wait, not a failure. Omitted, a 503 is an ordinary
   * retriable 5xx.
   */
  retryUnavailableForMs?: number;
  // When provided (streaming), this signal governs aborts instead of an absolute
  // deadline, so an inactivity timer can keep a healthy long stream alive.
  signal?: AbortSignal;
  /** Test seam: waits between attempts. */
  sleepImpl?: (ms: number) => Promise<void>;
  timeoutMs: number;
  url: string;
};

// Retry spacing follows Codex's provider client: exponential from 200ms with
// ±10% jitter so clients that failed together do not retry together.
const RETRY_BASE_DELAY_MS = 200;
const RETRY_MAX_DELAY_MS = 8_000;
// A server's Retry-After is honoured, but a buggy or hostile value cannot park
// a run for an hour.
const RETRY_AFTER_MAX_MS = 60_000;
// While a server is loading its model, poll it at least this often.
const UNAVAILABLE_POLL_MAX_DELAY_MS = 2_000;

type StreamRequestOptions = JsonRequestOptions;

export async function fetchJson<T>(options: JsonRequestOptions): Promise<JsonHttpResult<T>> {
  const response = await fetchWithRetries(options);
  const rawText = await response.text();
  const data = rawText.trim().length === 0 ? (null as T) : (JSON.parse(rawText) as T);

  return {
    data,
    headers: normalizeHeaders(response.headers),
    rawText,
    status: response.status
  };
}

export async function fetchStream(options: StreamRequestOptions): Promise<Response> {
  return fetchWithRetries(options);
}

export function normalizeUnknownProviderError(
  error: unknown,
  defaults: Partial<StructuredError> = {}
): StructuredError {
  if (error instanceof ProviderRequestError) {
    return error.structuredError;
  }

  if (error instanceof Error) {
    // Node's fetch reports every connection failure as a bare "fetch failed"
    // with the errno in `cause`; the shared classifier reads it there, and
    // leaves out undici's header and body timeouts, which fire after a server
    // has already worked on the request for minutes.
    const retriable = error.name === "AbortError" || isTransientNetworkError(error);
    return {
      code: defaults.code ?? "provider_request_error",
      details: {
        cause: error.name,
        ...defaults.details
      },
      message: defaults.message ?? error.message,
      retriable: defaults.retriable ?? retriable
    };
  }

  return {
    code: defaults.code ?? "provider_unknown_error",
    details: defaults.details ?? {},
    message: defaults.message ?? String(error),
    retriable: defaults.retriable ?? false
  };
}

function buildHeaders(headers: Record<string, string> | undefined): HeadersInit {
  return {
    "content-type": "application/json",
    ...headers
  };
}

async function fetchWithRetries(options: JsonRequestOptions): Promise<Response> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  // A wait between attempts ends early on a cancel (or a stream guard giving
  // up): the next attempt then fails at once with the reason.
  const pause = options.sleepImpl ?? ((ms: number) => sleepUnlessAborted(ms, [options.cancelSignal, options.signal]));
  const startedAt = Date.now();
  const headerValues = Object.values(options.headers ?? {});

  for (let attempt = 1; ; attempt += 1) {
    const attemptSignal = options.signal ?? AbortSignal.timeout(options.timeoutMs);
    try {
      const response = await fetchFollowingSameOriginRedirects({
        fetchImpl: options.fetchImpl ?? fetch,
        init: {
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          headers: buildHeaders(options.headers),
          method: options.method ?? (options.body === undefined ? "GET" : "POST"),
          signal: options.cancelSignal ? AbortSignal.any([options.cancelSignal, attemptSignal]) : attemptSignal
        },
        label: "The model provider",
        url: options.url
      });

      if (!response.ok) {
        const rawText = await response.text();
        throw new ProviderRequestError(
          buildHttpError(response.status, options.url, rawText, parseRetryAfterMs(response.headers.get("retry-after")))
        );
      }

      return response;
    } catch (error) {
      if (options.cancelSignal?.aborted) {
        throw cancelledRequestError(options.url);
      }
      const networkFailure = describeNetworkFailure(error, options.url);
      const normalizedError = normalizeUnknownProviderError(error, {
        code: "provider_request_error",
        details: {
          attempt,
          method: options.method ?? (options.body === undefined ? "GET" : "POST"),
          url: options.url
        },
        ...(networkFailure ? { message: networkFailure } : {})
      });
      // An invalid header's value lands in fetch's own message, and from
      // there in logs and on the operator's screen: an API key included.
      normalizedError.message = redactValues(normalizedError.message, headerValues);
      const failure = new ProviderRequestError(normalizedError);

      // A stream guard that fired has given up on this request already, and
      // every later attempt would inherit its aborted signal.
      if (!normalizedError.retriable || options.signal?.aborted) {
        throw failure;
      }
      const stillLoading =
        normalizedError.details.status === 503 &&
        options.retryUnavailableForMs !== undefined &&
        Date.now() - startedAt < options.retryUnavailableForMs;
      if (attempt >= maxAttempts && !stillLoading) {
        throw failure;
      }

      // A Retry-After of 0 (or a date in the past) still waits a little, or a
      // server that is loading its model would be polled in a hot loop.
      const retryAfterMs = readRetryAfterMs(normalizedError);
      const delay =
        retryAfterMs !== undefined
          ? Math.max(retryAfterMs, RETRY_BASE_DELAY_MS)
          : attempt >= maxAttempts
            ? UNAVAILABLE_POLL_MAX_DELAY_MS
            : computeBackoffDelay(attempt);
      await pause(stillLoading ? Math.min(delay, UNAVAILABLE_POLL_MAX_DELAY_MS) : delay);
      // A cancel that ended the wait ends the request too, before another
      // attempt goes out.
      if (options.cancelSignal?.aborted) {
        throw cancelledRequestError(options.url);
      }
    }
  }
}

function cancelledRequestError(url: string): ProviderRequestError {
  return new ProviderRequestError({
    code: "provider_request_cancelled",
    details: { url },
    message: "The request was cancelled.",
    retriable: false
  });
}

/** Exponential backoff with ±10% jitter: ~200ms, ~400ms, ~800ms, … capped at 8s. */
export function computeBackoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1), RETRY_MAX_DELAY_MS);
  return Math.round(base * (0.9 + random() * 0.2));
}

/** A `Retry-After` header (delay-seconds or an HTTP-date) in ms, capped; undefined when absent or unusable. */
export function parseRetryAfterMs(value: string | null, now: number = Date.now()): number | undefined {
  if (!value || value.trim().length === 0) {
    return undefined;
  }
  const trimmed = value.trim();
  const seconds = /^\d+(\.\d+)?$/u.test(trimmed) ? Number(trimmed) * 1_000 : Date.parse(trimmed) - now;
  return Number.isFinite(seconds) ? Math.min(Math.max(0, Math.round(seconds)), RETRY_AFTER_MAX_MS) : undefined;
}

function readRetryAfterMs(error: StructuredError): number | undefined {
  const value = error.details.retryAfterMs;
  return typeof value === "number" ? value : undefined;
}

/**
 * Node's fetch reports every connection-level failure as a bare
 * "fetch failed", with the useful part (ECONNREFUSED, ENOTFOUND, …) hidden in
 * `cause`. That text reached sessions verbatim, naming neither the address
 * nor what went wrong.
 */
function describeNetworkFailure(error: unknown, url: string): string | null {
  if (!(error instanceof TypeError) || !/fetch failed/iu.test(error.message)) {
    return null;
  }
  const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
  const reason =
    typeof cause?.code === "string" ? cause.code : typeof cause?.message === "string" ? cause.message : error.message;
  return `Could not reach ${url} (${reason}). Check that the provider is running and that its base URL is right.`;
}

function buildHttpError(status: number, url: string, rawText: string, retryAfterMs?: number): StructuredError {
  const bodyDetails = tryParseJson(rawText);
  const message =
    extractErrorMessage(bodyDetails) ??
    `Provider request failed with HTTP ${status}${rawText.trim().length > 0 ? `: ${rawText.slice(0, 500)}` : ""}`;

  // What kind of failure it is (a context overflow, say) is the adapter's to
  // say, from its provider's spelling (see classifyContextOverflow).
  return {
    code: "provider_http_error",
    details: {
      response: bodyDetails ?? rawText,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      status,
      url
    },
    message,
    retriable: TRANSIENT_HTTP_STATUSES.has(status)
  };
}

/**
 * An error a provider reported inside a response stream (llama.cpp sends
 * `data: {"error": {…}}` and ends the stream without `[DONE]`), in the same
 * shape as an HTTP error: what was reported is kept in `details.response`, for
 * the adapter to classify.
 */
export function buildStreamedProviderError(payload: unknown, providerId: string): StructuredError {
  const record = isRecord(payload) ? payload : {};
  const message = extractErrorMessage(payload) ?? `${providerId} reported an error in its response stream.`;
  return {
    code: "provider_stream_error",
    details: {
      provider: providerId,
      ...(payload !== undefined ? { response: payload as JsonValue } : {}),
      ...(typeof record.type === "string" ? { type: record.type } : {})
    },
    message,
    retriable: true
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractErrorMessage(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  if (typeof value !== "object" || value === null) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.error === "string" && record.error.trim().length > 0) {
    return record.error;
  }
  if (typeof record.message === "string" && record.message.trim().length > 0) {
    return record.message;
  }
  if (typeof record.error === "object" && record.error !== null) {
    return extractErrorMessage(record.error);
  }

  return null;
}

function normalizeHeaders(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function tryParseJson(value: string): JsonValue | null {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return null;
  }
}
