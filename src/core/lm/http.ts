import type { JsonValue, StructuredError } from "@/core/contracts";
import { sleep } from "@/core/io/files";

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
  fetchImpl?: FetchLike;
  headers?: Record<string, string>;
  maxAttempts?: number;
  method?: "GET" | "POST";
  // When provided (streaming), this signal governs aborts instead of an absolute
  // deadline, so an inactivity timer can keep a healthy long stream alive.
  signal?: AbortSignal;
  timeoutMs: number;
  url: string;
};

type StreamRequestOptions = JsonRequestOptions;

export async function fetchJson<T>(
  options: JsonRequestOptions
): Promise<JsonHttpResult<T>> {
  const response = await fetchWithRetries(options);
  const rawText = await response.text();
  const data =
    rawText.trim().length === 0 ? (null as T) : (JSON.parse(rawText) as T);

  return {
    data,
    headers: normalizeHeaders(response.headers),
    rawText,
    status: response.status
  };
}

export async function fetchStream(
  options: StreamRequestOptions
): Promise<Response> {
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
    const retriable =
      error.name === "AbortError" ||
      /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT/u.test(error.message);
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

function buildHeaders(
  headers: Record<string, string> | undefined,
  body: unknown
): HeadersInit {
  return {
    "content-type":
      body === undefined ? "application/json" : "application/json",
    ...headers
  };
}

async function fetchWithRetries(
  options: JsonRequestOptions
): Promise<Response> {
  const maxAttempts = options.maxAttempts ?? 2;
  let lastError: ProviderRequestError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await (options.fetchImpl ?? fetch)(options.url, {
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        headers: buildHeaders(options.headers, options.body),
        method: options.method ?? (options.body === undefined ? "GET" : "POST"),
        signal: options.signal ?? AbortSignal.timeout(options.timeoutMs)
      });

      if (!response.ok) {
        const rawText = await response.text();
        throw new ProviderRequestError(
          buildHttpError(response.status, options.url, rawText)
        );
      }

      return response;
    } catch (error) {
      const normalizedError = normalizeUnknownProviderError(error, {
        code: "provider_request_error",
        details: {
          attempt,
          method:
            options.method ?? (options.body === undefined ? "GET" : "POST"),
          url: options.url
        }
      });
      lastError = new ProviderRequestError(normalizedError);

      if (attempt >= maxAttempts || !normalizedError.retriable) {
        throw lastError;
      }

      await sleep(Math.min(250 * attempt, 1_000));
    }
  }

  throw (
    lastError ??
    new ProviderRequestError({
      code: "provider_request_error",
      details: {
        url: options.url
      },
      message: `Request to ${options.url} failed.`,
      retriable: false
    })
  );
}

function buildHttpError(
  status: number,
  url: string,
  rawText: string
): StructuredError {
  const bodyDetails = tryParseJson(rawText);
  const message =
    extractErrorMessage(bodyDetails) ??
    `Provider request failed with HTTP ${status}${rawText.trim().length > 0 ? `: ${rawText.slice(0, 500)}` : ""}`;

  return {
    code: "provider_http_error",
    details: {
      response: bodyDetails ?? rawText,
      status,
      url
    },
    message,
    retriable: status === 408 || status === 429 || status >= 500
  };
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
