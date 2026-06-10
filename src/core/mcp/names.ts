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
