function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge<T>(base: T, ...overlays: unknown[]): T {
  let current = structuredClone(base);

  for (const overlay of overlays) {
    current = mergeValues(current, overlay) as T;
  }

  return current;
}

function mergeValues(base: unknown, overlay: unknown): unknown {
  if (overlay === undefined) {
    return base;
  }

  if (Array.isArray(overlay)) {
    return structuredClone(overlay);
  }

  if (isPlainObject(base) && isPlainObject(overlay)) {
    const merged: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(overlay)) {
      merged[key] = mergeValues(merged[key], value);
    }

    return merged;
  }

  return structuredClone(overlay);
}
