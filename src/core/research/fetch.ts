import { lookup } from "node:dns/promises";
import net from "node:net";

import { StructuredError } from "@/core/contracts";
import { extractHtmlTitle, htmlToMarkdown } from "@/core/research/html";

const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_CONTENT_CHARS = 24_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_USER_AGENT = "AIAgent/0.1 (+https://local.aia)";
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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

// Resolves a hostname to the addresses a request would connect to.
export type HostAddressResolver = (hostname: string) => Promise<string[]>;

export type WebPageFetcherOptions = {
  fetchImpl?: typeof fetch;
  maxContentChars?: number;
  maxRedirects?: number;
  // Guards against SSRF through DNS: a public-looking hostname that resolves to
  // a loopback/private address is refused before any request is made. Defaults
  // to a real DNS lookup when the built-in fetch is used. When a custom
  // fetchImpl is injected (tests, scripted examples) no network is involved, so
  // the lookup is skipped unless a resolver is passed explicitly. Pass null to
  // disable it deliberately.
  resolveHost?: HostAddressResolver | null;
  timeoutMs?: number;
};

export class WebPageFetcher {
  private readonly fetchImpl: typeof fetch;
  private readonly maxContentChars: number;
  private readonly maxRedirects: number;
  private readonly resolveHost: HostAddressResolver | null;
  private readonly timeoutMs: number;

  constructor(options: WebPageFetcherOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.resolveHost =
      options.resolveHost === undefined ? (options.fetchImpl ? null : defaultResolveHost) : options.resolveHost;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  async fetch(request: WebFetchRequest): Promise<WebFetchResult> {
    const target = validatePublicHttpUrl(request.url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const { finalUrl, response } = await this.fetchFollowingRedirects(target, controller.signal);

      if (!response.ok) {
        throw toStructuredFetchError(
          `web_fetch received HTTP ${response.status} ${response.statusText} from ${finalUrl}.`,
          "web_fetch_http_error"
        );
      }

      const rawBody = await response.text();
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

  // Redirects are followed manually so every hop is re-validated: a public URL
  // may 302 to localhost, a link-local metadata endpoint, or a private address
  // (security review H5). `redirect: "follow"` would have trusted them blindly.
  private async fetchFollowingRedirects(
    initial: URL,
    signal: AbortSignal
  ): Promise<{ finalUrl: string; response: Response }> {
    let current = initial;

    for (let hop = 0; hop <= this.maxRedirects; hop += 1) {
      await this.assertResolvesToPublicAddress(current);

      const response = await this.fetchImpl(current.toString(), {
        headers: {
          Accept: "text/html,application/xhtml+xml,text/markdown,text/plain,application/json;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": DEFAULT_USER_AGENT
        },
        redirect: "manual",
        signal
      });

      if (!REDIRECT_STATUSES.has(response.status)) {
        return {
          finalUrl: response.url || current.toString(),
          response
        };
      }

      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw toStructuredFetchError(
          `web_fetch received HTTP ${response.status} from ${current.toString()} without a Location header.`,
          "web_fetch_redirect_failed"
        );
      }

      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw toStructuredFetchError(
          `web_fetch received an invalid redirect target "${location}" from ${current.toString()}.`,
          "web_fetch_redirect_failed"
        );
      }
      current = validatePublicHttpUrl(next.toString());
    }

    throw toStructuredFetchError(
      `web_fetch followed more than ${this.maxRedirects} redirects starting from ${initial.toString()}.`,
      "web_fetch_too_many_redirects"
    );
  }

  private async assertResolvesToPublicAddress(url: URL): Promise<void> {
    if (!this.resolveHost) {
      return;
    }

    const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
    if (net.isIP(hostname)) {
      // Literal addresses were already vetted by validatePublicHttpUrl.
      return;
    }

    let addresses: string[];
    try {
      addresses = await this.resolveHost(hostname);
    } catch (error) {
      throw toStructuredFetchError(
        `web_fetch could not resolve host "${hostname}": ${error instanceof Error ? error.message : String(error)}`,
        "web_fetch_dns_failed"
      );
    }

    const blocked = addresses.find((address) => isPrivateIpAddress(address));
    if (blocked) {
      throw toStructuredFetchError(
        `Refusing to fetch "${hostname}": it resolves to the non-public address ${blocked}.`,
        "web_fetch_private_host_blocked"
      );
    }
  }
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true });
  return records.map((record) => record.address);
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
  const normalized = stripIpv6Brackets(hostname.trim().toLowerCase());
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal")
  ) {
    return true;
  }

  return net.isIP(normalized) !== 0 && isPrivateIpAddress(normalized);
}

// Loopback, unspecified, link-local, RFC 1918/6598 private ranges, multicast,
// and reserved space for IPv4; loopback, unspecified, unique-local, link-local,
// multicast, and IPv4-mapped forms for IPv6.
export function isPrivateIpAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(address.trim().toLowerCase());

  if (net.isIPv4(normalized)) {
    return isPrivateIpv4(normalized);
  }

  if (!net.isIPv6(normalized)) {
    return false;
  }

  if (normalized === "::" || normalized === "::1") {
    return true;
  }

  const mappedDotted = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized);
  if (mappedDotted?.[1]) {
    return isPrivateIpv4(mappedDotted[1]);
  }
  const mappedHex = /^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(normalized);
  if (mappedHex?.[1] && mappedHex[2]) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isPrivateIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }

  return (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    /^fe[89ab]/u.test(normalized) ||
    normalized.startsWith("ff")
  );
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map((part) => Number.parseInt(part, 10));
  const [first, second] = octets;
  if (first === undefined || second === undefined) {
    return true;
  }
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && octets[2] === 0) ||
    (first === 192 && second === 168) ||
    first >= 224
  );
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
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
