import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type DiscoveredSkill = {
  content: string;
  description: string;
  name: string;
  skillDirectory: string;
  skillFilePath: string;
  source: "extra" | "user" | "workspace";
};

export async function discoverSkills(params: {
  cwd: string;
  extraRoots?: string[];
  projectRootMarkers?: string[];
  userHomeDirectory?: string;
}): Promise<DiscoveredSkill[]> {
  const userHomeDirectory = params.userHomeDirectory ?? os.homedir();
  const projectRoot = await findProjectRoot(params.cwd, params.projectRootMarkers ?? [".git"]);
  const workspaceRoots = await collectWorkspaceSkillRoots(params.cwd, projectRoot);
  const userRoot = path.join(userHomeDirectory, ".aia", "skills");
  const searchRoots = [
    ...workspaceRoots.map((root) => ({ root, source: "workspace" as const })),
    { root: userRoot, source: "user" as const },
    ...(params.extraRoots ?? []).map((root) => ({ root: path.resolve(params.cwd, root), source: "extra" as const }))
  ];

  const discovered = new Map<string, DiscoveredSkill>();

  for (const entry of searchRoots) {
    const skills = await discoverSkillsInRoot(entry.root, entry.source);
    for (const skill of skills) {
      if (!discovered.has(skill.name)) {
        discovered.set(skill.name, skill);
      }
    }
  }

  return [...discovered.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function discoverSkillsInRoot(root: string, source: DiscoveredSkill["source"]): Promise<DiscoveredSkill[]> {
  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  const discovered: DiscoveredSkill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillDirectory = path.join(root, entry.name);
    const skillFilePath = await findSkillFile(skillDirectory);
    if (!skillFilePath) {
      continue;
    }

    const content = await fs.readFile(skillFilePath, "utf8");
    const parsed = parseSkillFile(content, entry.name);

    discovered.push({
      content,
      description: parsed.description,
      name: parsed.name,
      skillDirectory,
      skillFilePath,
      source
    });
  }

  return discovered;
}

async function findSkillFile(skillDirectory: string): Promise<string | null> {
  const entries = await fs.readdir(skillDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name.toLowerCase() === "skill.md") {
      return path.join(skillDirectory, entry.name);
    }
  }
  return null;
}

function parseSkillFile(content: string, fallbackName: string): { description: string; name: string } {
  const trimmed = content.trim();
  let name = fallbackName;
  let description = "";
  let body = trimmed;

  if (trimmed.startsWith("---")) {
    const end = trimmed.indexOf("\n---", 3);
    if (end > 0) {
      const frontmatter = trimmed.slice(3, end).trim();
      body = trimmed.slice(end + 4).trim();

      for (const rawLine of frontmatter.split("\n")) {
        const line = rawLine.trim();
        const separator = line.indexOf(":");
        if (separator <= 0) {
          continue;
        }
        const key = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
        if (key === "name" && value) {
          name = value;
        }
        if (key === "description" && value) {
          description = value;
        }
      }
    }
  }

  if (!description) {
    description =
      body
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith("#")) ?? "No description provided.";
  }

  return { description, name };
}

async function collectWorkspaceSkillRoots(cwd: string, projectRoot: string): Promise<string[]> {
  const roots: string[] = [];
  let current = path.resolve(cwd);

  while (true) {
    const candidate = path.join(current, "skills");
    if (await isDirectory(candidate)) {
      roots.push(candidate);
    }
    if (current === projectRoot) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return roots;
}

async function findProjectRoot(start: string, markers: string[]): Promise<string> {
  let current = path.resolve(start);

  while (true) {
    if (await hasAnyMarker(current, markers)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(start);
    }
    current = parent;
  }
}

async function hasAnyMarker(directory: string, markers: string[]): Promise<boolean> {
  for (const marker of markers) {
    if (await pathExists(path.join(directory, marker))) {
      return true;
    }
  }
  return false;
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}
