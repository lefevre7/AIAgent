import fs from "node:fs/promises";
import path from "node:path";

/**
 * The project a directory belongs to: the nearest directory, from `start` up,
 * holding one of `markers` (`.git` by default), or `start` itself when none
 * does. AGENTS.md loading and skill discovery both find the project this way,
 * so they cannot disagree about where it ends.
 */
export async function findProjectRoot(start: string, markers: string[] = [".git"]): Promise<string> {
  let current = path.resolve(start);
  while (true) {
    for (const marker of markers) {
      if (
        await fs.access(path.join(current, marker)).then(
          () => true,
          () => false
        )
      ) {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(start);
    }
    current = parent;
  }
}

/** The directories from `start` up to `root`, closest first, both included (`start` alone when `root` is not above it). */
export function listDirectoriesUpTo(start: string, root: string): string[] {
  const directories: string[] = [];
  const stop = path.resolve(root);
  let current = path.resolve(start);
  while (true) {
    directories.push(current);
    if (current === stop) {
      return directories;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return directories;
    }
    current = parent;
  }
}
