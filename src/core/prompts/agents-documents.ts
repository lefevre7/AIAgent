import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type AgentsInstructionDocument = {
  content: string;
  path: string;
  scope: "project" | "user";
};

export async function loadAgentsInstructionDocuments(params: {
  cwd: string;
  projectRootMarkers?: string[];
  userHomeDirectory?: string;
}): Promise<{
  project: AgentsInstructionDocument[];
  user: AgentsInstructionDocument | null;
}> {
  const userHomeDirectory = params.userHomeDirectory ?? os.homedir();
  const projectRoot = await findProjectRoot(params.cwd, params.projectRootMarkers ?? [".git"]);
  const projectDocuments = await loadProjectDocuments(projectRoot, params.cwd);
  const userDocument = await readAgentsDocument(path.join(userHomeDirectory, ".aia", "AGENTS.md"), "user");

  return {
    project: projectDocuments,
    user: userDocument
  };
}

async function loadProjectDocuments(projectRoot: string, cwd: string): Promise<AgentsInstructionDocument[]> {
  const directories = buildDirectoryChain(projectRoot, cwd);
  const documents: AgentsInstructionDocument[] = [];

  for (const directory of directories) {
    const document = await readAgentsDocument(path.join(directory, "AGENTS.md"), "project");
    if (document) {
      documents.push(document);
    }
  }

  return documents;
}

function buildDirectoryChain(projectRoot: string, cwd: string): string[] {
  const directories: string[] = [];
  let current = path.resolve(cwd);

  while (true) {
    directories.push(current);
    if (current === path.resolve(projectRoot)) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return directories.reverse();
}

async function readAgentsDocument(filePath: string, scope: "project" | "user"): Promise<AgentsInstructionDocument | null> {
  try {
    const content = (await fs.readFile(filePath, "utf8")).trim();
    if (!content) {
      return null;
    }
    return {
      content,
      path: filePath,
      scope
    };
  } catch {
    return null;
  }
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
    try {
      await fs.access(path.join(directory, marker));
      return true;
    } catch {
      continue;
    }
  }
  return false;
}
