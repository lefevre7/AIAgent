import crypto from "node:crypto";

export function sanitizeMcpInvocationName(serverName: string, toolName: string): string {
  const serverSlug = slugify(serverName);
  const toolSlug = slugify(toolName);
  const prefix = `mcp_${serverSlug}_${toolSlug}`.replace(/_+/g, "_");

  if (prefix.length <= 64) {
    return prefix;
  }

  const hash = crypto.createHash("sha1").update(`${serverName}:${toolName}`).digest("hex").slice(0, 10);
  const base = prefix.slice(0, Math.max(1, 64 - hash.length - 1));
  return `${base}_${hash}`.slice(0, 64);
}

/**
 * An MCP tool's name in approval rules and tool definitions: the configured
 * server name and the tool's own name as the server lists it (`docs.lookup`
 * for the `lookup` tool of server `docs`).
 */
export function formatMcpToolName(serverName: string, rawToolName: string): string {
  return `${serverName}.${rawToolName}`;
}

const ENTITY_ID_SEGMENT = /^[A-Za-z0-9._:-]{1,64}$/u;

/**
 * A name from config or from a server (a server, tool, prompt, or template
 * name, a resource URI) as one segment of an entity id, whose characters are
 * limited to letters, digits, ".", "_", ":", and "-" (`entityIdSchema`). A name
 * that fits is used as is; any other ("brave search", "@playwright/mcp", a
 * URI) is slugged, with a short hash of the original so two names that slug
 * alike stay apart. Config accepts any server name, and an id that failed the
 * schema crashed the gateway (an `mcp.updated` event) or made a session
 * unreadable (a tool call's `toolId` is checked when the session is read).
 */
export function toMcpIdSegment(name: string): string {
  if (ENTITY_ID_SEGMENT.test(name)) {
    return name;
  }
  const slug = name
    .replace(/[^A-Za-z0-9._:-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  const hash = crypto.createHash("sha256").update(name).digest("hex").slice(0, 8);
  return slug.length > 0 ? `${slug}-${hash}` : hash;
}

/** `mcp.<kind>.<server>.<name>`, each name an id segment (see `toMcpIdSegment`). */
export function buildMcpCapabilityId(kind: string, serverName: string, name: string): string {
  return `mcp.${kind}.${toMcpIdSegment(serverName)}.${toMcpIdSegment(name)}`;
}

export function slugify(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

  return normalized.length > 0 ? normalized : "mcp";
}

// slugify is lossy (case-folding + punctuation collapse), so two distinct
// tool/server names can produce the same invocation name. Left unhandled this
// is fatal: the tool registry throws on a duplicate invocation name, and since
// the MCP registry is rebuilt on every lookup that throw takes down the whole
// catalog (built-ins included). This disambiguator makes assignment injective
// by appending "-2", "-3", … to later collisions (staying within the 64-char
// invocation-name cap), and records the winner in `used`.
export function disambiguateInvocationName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  for (let suffix = 2; ; suffix += 1) {
    const marker = `-${suffix}`;
    const trimmed = base.slice(0, Math.max(1, 64 - marker.length));
    const candidate = `${trimmed}${marker}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}
