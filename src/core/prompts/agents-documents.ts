import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { findProjectRoot, listDirectoriesUpTo } from "@/core/io/project-root";

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
  // Root first: the closer a document is to the working directory, the later it comes.
  const directories = listDirectoriesUpTo(cwd, projectRoot).reverse();
  const documents: AgentsInstructionDocument[] = [];

  for (const directory of directories) {
    const document = await readAgentsDocument(path.join(directory, "AGENTS.md"), "project");
    if (document) {
      documents.push(document);
    }
  }

  return documents;
}

async function readAgentsDocument(
  filePath: string,
  scope: "project" | "user"
): Promise<AgentsInstructionDocument | null> {
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
