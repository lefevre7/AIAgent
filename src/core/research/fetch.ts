import { StructuredError } from "@/core/contracts";
import { extractHtmlTitle, htmlToMarkdown } from "@/core/research/html";

const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_CONTENT_CHARS = 24_000;
const DEFAULT_USER_AGENT = "AIAgent/0.1 (+https://local.aia)";

export type WebFetchRequest = {
  maxChars?: number;
  query?: string;
  url: string;
};

export type WebFetchResult = {
  contentMarkdown: string;
  contentType: string;
  finalUrl: string;
  query: string | null;
  queryMatchCount: number;
  snippets: string[];
  title: string | null;
  truncated: boolean;
  url: string;
};

export type WebPageFetcherOptions = {
  fetchImpl?: typeof fetch;
  maxContentChars?: number;
  timeoutMs?: number;
};

export class WebPageFetcher {
  private readonly fetchImpl: typeof fetch;
  private readonly maxContentChars: number;
  private readonly timeoutMs: number;

  constructor(options: WebPageFetcherOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  async fetch(request: WebFetchRequest): Promise<WebFetchResult> {
    const target = validatePublicHttpUrl(request.url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(target.toString(), {
        headers: {
          Accept: "text/html,application/xhtml+xml,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": DEFAULT_USER_AGENT
        },
        redirect: "follow",
        signal: controller.signal
      });

      if (!response.ok) {
        throw toStructuredFetchError(
          `web_fetch received HTTP ${response.status} ${response.statusText} from ${target.toString()}.`,
          "web_fetch_http_error"
        );
      }

      const rawBody = await response.text();
      const finalUrl = response.url || target.toString();
      const contentType = (response.headers.get("content-type") || "text/plain").split(";")[0]?.trim().toLowerCase() || "text/plain";
      const title = contentType.includes("html") ? extractHtmlTitle(rawBody) ?? null : null;
      const contentMarkdown = normalizeFetchedContent(rawBody, contentType);
      const truncatedContent = truncateContent(contentMarkdown, request.maxChars ?? this.maxContentChars);
      const query = request.query?.trim() || null;
      const snippets = query ? extractRelevantSnippets(truncatedContent.content, query) : [];

      return {
        contentMarkdown: truncatedContent.content,
        contentType,
        finalUrl,
        query,
        queryMatchCount: snippets.length,
        snippets,
        title,
        truncated: truncatedContent.truncated,
        url: target.toString()
      };
    } catch (error) {
      if (isStructuredError(error)) {
        throw error;
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw toStructuredFetchError(`web_fetch timed out after ${this.timeoutMs}ms for ${target.toString()}.`, "web_fetch_timeout");
      }
      throw toStructuredFetchError(
        error instanceof Error ? error.message : String(error),
        "web_fetch_failed"
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

function normalizeFetchedContent(body: string, contentType: string): string {
  if (contentType.includes("html")) {
    return htmlToMarkdown(body);
  }
  if (contentType.includes("json")) {
    return `\`\`\`json\n${safeJsonPrettyPrint(body)}\n\`\`\``;
  }
  if (contentType.includes("markdown")) {
    return body.trim();
  }
  return body.replace(/\r/g, "").trim();
}

function safeJsonPrettyPrint(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value.trim();
  }
}

function truncateContent(content: string, maxChars: number): { content: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return {
      content,
      truncated: false
    };
  }

  return {
    content: `${content.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n\n...[truncated]`,
    truncated: true
  };
}

function extractRelevantSnippets(content: string, query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3)
    .slice(0, 5);

  if (terms.length === 0) {
    return [];
  }

  const snippets: string[] = [];
  const normalizedContent = content.toLowerCase();

  for (const term of terms) {
    let start = 0;
    while (snippets.length < 5) {
      const index = normalizedContent.indexOf(term, start);
      if (index === -1) {
        break;
      }

      const snippetStart = Math.max(0, index - 120);
      const snippetEnd = Math.min(content.length, index + term.length + 180);
      const snippet = content
        .slice(snippetStart, snippetEnd)
        .replace(/\s+/g, " ")
        .trim();
      if (snippet && !snippets.includes(snippet)) {
        snippets.push(snippet);
      }
      start = index + term.length;
    }
  }

  return snippets;
}

function validatePublicHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw toStructuredFetchError(`"${value}" is not a valid URL.`, "web_fetch_invalid_url");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw toStructuredFetchError("web_fetch only supports http:// and https:// URLs.", "web_fetch_unsupported_protocol");
  }

  if (isPrivateNetworkHost(url.hostname)) {
    throw toStructuredFetchError(
      `Refusing to fetch non-public host "${url.hostname}". Use a public URL instead.`,
      "web_fetch_private_host_blocked"
    );
  }

  return url;
}

function isPrivateNetworkHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized === "0.0.0.0" ||
    normalized === "::1"
  ) {
    return true;
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(normalized)) {
    const [first, second] = normalized.split(".").map((part) => Number.parseInt(part, 10));
    return (
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }

  return normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

function toStructuredFetchError(message: string, code: StructuredError["code"]): StructuredError {
  return {
    code,
    details: {},
    message,
    retriable: false
  };
}

function isStructuredError(value: unknown): value is StructuredError {
  return typeof value === "object" && value !== null && "code" in value && "message" in value && "retriable" in value;
}
