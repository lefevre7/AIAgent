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
