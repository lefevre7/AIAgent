import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "aiagent";

export type PackageInfo = { root: string; version: string };

let cached: PackageInfo | null | undefined;

/**
 * aia's own package: its root directory (where `bundled-skills/` lives) and
 * version. Found by walking up from this module to the package.json named
 * "aiagent", which works from `src/` under tsx, from the bundled `dist/`, and
 * from a Next.js server bundle.
 */
export function findPackageInfo(): PackageInfo | null {
  if (cached !== undefined) {
    return cached;
  }
  cached = null;
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    const manifest = readManifest(path.join(current, "package.json"));
    if (manifest?.name === PACKAGE_NAME) {
      cached = { root: current, version: typeof manifest.version === "string" ? manifest.version : "unknown" };
      return cached;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return cached;
    }
    current = parent;
  }
}

/** The version other programs see: the MCP clientInfo, the User-Agent, `aia --version`. */
export function readPackageVersion(): string {
  return findPackageInfo()?.version ?? "unknown";
}

function readManifest(filePath: string): { name?: unknown; version?: unknown } | null {
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as { name?: unknown; version?: unknown };
  } catch {
    return null;
  }
}
