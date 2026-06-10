import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { writeJsonAtomic } from "@/core/io/files";

export type WorkspaceEntryType = "directory" | "file";
export type WorkspaceMutationKind = "append" | "edit" | "patch" | "undo" | "write";

export type WorkspaceFileEntry = {
  depth: number;
  path: string;
  type: WorkspaceEntryType;
};

export type WorkspaceGrepMatch = {
  column: number;
  line: number;
  path: string;
  text: string;
};

export type WorkspaceSearchMatch = {
  path: string;
};

export type WorkspaceTextEdit = {
  newText: string;
  oldText: string;
  replaceAll?: boolean;
};

export type WorkspaceRangePatchOperation = {
  end: number;
  start: number;
  text: string;
};

export type WorkspaceUndoEntry = {
  afterContentPath: string;
  beforeExists: boolean;
  beforeContentPath: string;
  contentEncoding?: "binary" | "text";
  createdAt: string;
  diffPreview: string;
  id: string;
  kind: WorkspaceMutationKind;
  path: string;
  restoredAt?: string;
};

export type WorkspaceMutationResult = {
  changed: boolean;
  content: string;
  diffPreview: string;
  path: string;
  undoEntry?: WorkspaceUndoEntry;
};

export type WorkspaceBinaryMutationResult = {
  byteLength: number;
  changed: boolean;
  diffPreview: string;
  path: string;
  undoEntry?: WorkspaceUndoEntry;
};

type WorkspaceMutationEngineOptions = {
  allowArbitraryPaths?: boolean;
  stateRoot?: string;
  workspaceRoot: string;
};

export class WorkspaceMutationEngine {
  private readonly stateRoot: string;

  constructor(private readonly options: WorkspaceMutationEngineOptions) {
    this.stateRoot = options.stateRoot ?? path.join(options.workspaceRoot, ".aia");
  }

  async readFile(targetPath: string): Promise<string> {
    return fs.readFile(this.resolveWorkspacePath(targetPath), "utf8");
  }

  async readFileBuffer(targetPath: string): Promise<Buffer> {
    return fs.readFile(this.resolveWorkspacePath(targetPath));
  }

  async listFiles(options: {
    includeHidden?: boolean;
    maxEntries?: number;
    path?: string;
    recursive?: boolean;
  } = {}): Promise<WorkspaceFileEntry[]> {
    const rootPath = this.resolveWorkspacePath(options.path ?? ".");
    const relativeRoot = this.toStoredPath(rootPath);
    const entries: WorkspaceFileEntry[] = [];

    const stats = await fs.stat(rootPath);
    if (stats.isFile()) {
      return [
        {
          depth: 0,
          path: relativeRoot,
          type: "file"
        }
      ];
    }

    await this.walkDirectory(rootPath, relativeRoot, 0, entries, {
      includeHidden: options.includeHidden ?? false,
      maxEntries: options.maxEntries ?? 1_000,
      recursive: options.recursive ?? true
    });

    return entries;
  }

  async searchPaths(
    query: string,
    options: {
      includeHidden?: boolean;
      maxResults?: number;
      path?: string;
    } = {}
  ): Promise<WorkspaceSearchMatch[]> {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return [];
    }

    const matches: WorkspaceSearchMatch[] = [];
    for (const entry of await this.listFiles({
      includeHidden: options.includeHidden,
      maxEntries: options.maxResults ? options.maxResults * 10 : undefined,
      path: options.path,
      recursive: true
    })) {
      if (entry.path.toLowerCase().includes(normalizedQuery)) {
        matches.push({
          path: entry.path
        });
      }

      if (matches.length >= (options.maxResults ?? 100)) {
        break;
      }
    }

    return matches;
  }

  async grep(
    query: string,
    options: {
      caseSensitive?: boolean;
      includeHidden?: boolean;
      maxResults?: number;
      path?: string;
      regex?: boolean;
    } = {}
  ): Promise<WorkspaceGrepMatch[]> {
    const matcher = buildMatcher(query, {
      caseSensitive: options.caseSensitive ?? false,
      regex: options.regex ?? false
    });
    const matches: WorkspaceGrepMatch[] = [];

    for (const entry of await this.listFiles({
      includeHidden: options.includeHidden,
      maxEntries: 10_000,
      path: options.path,
      recursive: true
    })) {
      if (entry.type !== "file") {
        continue;
      }

      const absolutePath = this.resolveWorkspacePath(entry.path);
      const content = await fs.readFile(absolutePath, "utf8");
      const lines = content.split(/\r?\n/u);

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const match = matcher(line);
        if (match === null) {
          continue;
        }

        matches.push({
          column: match + 1,
          line: index + 1,
          path: entry.path,
          text: line
        });

        if (matches.length >= (options.maxResults ?? 100)) {
          return matches;
        }
      }
    }

    return matches;
  }

  async previewWrite(targetPath: string, nextContent: string): Promise<string> {
    const currentContent = await this.readExistingFile(targetPath);
    return renderDiff(this.toStoredPath(targetPath), currentContent ?? "", nextContent);
  }

  async writeFile(targetPath: string, nextContent: string): Promise<WorkspaceMutationResult> {
    return this.commitMutation(targetPath, "write", async () => nextContent);
  }

  async writeFileBytes(targetPath: string, nextContent: Buffer): Promise<WorkspaceBinaryMutationResult> {
    return this.commitBinaryMutation(targetPath, "write", async () => nextContent);
  }

  async appendFileBytes(targetPath: string, chunk: Buffer): Promise<WorkspaceBinaryMutationResult> {
    return this.commitBinaryMutation(targetPath, "append", async (currentContent) => Buffer.concat([currentContent, chunk]));
  }

  async editFile(targetPath: string, edits: WorkspaceTextEdit[]): Promise<WorkspaceMutationResult> {
    return this.commitMutation(targetPath, "edit", async (currentContent) =>
      applyRangePatch(currentContent, buildOperationsFromEdits(currentContent, edits))
    );
  }

  async applyPatch(targetPath: string, operations: WorkspaceRangePatchOperation[]): Promise<WorkspaceMutationResult> {
    return this.commitMutation(targetPath, "patch", async (currentContent) => applyRangePatch(currentContent, operations));
  }

  async listUndoEntries(options: {
    includeRestored?: boolean;
    limit?: number;
    path?: string;
  } = {}): Promise<WorkspaceUndoEntry[]> {
    const root = this.undoEntriesRoot();
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      const relativeTarget = options.path ? this.toStoredPath(options.path) : null;
      const loaded = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
          .map(async (entry) => this.readUndoEntry(path.join(root, entry.name)))
      );

      return loaded
        .filter((entry): entry is WorkspaceUndoEntry => entry !== null)
        .filter((entry) => (options.includeRestored ? true : !entry.restoredAt))
        .filter((entry) => (relativeTarget ? entry.path === relativeTarget : true))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, options.limit ?? 100);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }

      throw error;
    }
  }

  async previewUndo(entryId: string): Promise<string> {
    const entry = await this.requireUndoEntry(entryId);
    if (entry.contentEncoding === "binary") {
      return entry.diffPreview;
    }

    const currentContent = await this.readExistingFile(entry.path);
    const beforeContent = await fs.readFile(entry.beforeContentPath, "utf8");
    return renderDiff(entry.path, currentContent ?? "", beforeContent);
  }

  async undoLastEdit(): Promise<WorkspaceMutationResult> {
    const entry = (await this.listUndoEntries({ limit: 1 }))[0];
    if (!entry) {
      throw new Error("There are no undo entries available.");
    }

    return this.restoreUndoEntry(entry);
  }

  async undoFileEdit(targetPath: string): Promise<WorkspaceMutationResult> {
    const entry = (await this.listUndoEntries({ limit: 1, path: targetPath }))[0];
    if (!entry) {
      throw new Error(`There are no undo entries available for "${targetPath}".`);
    }

    return this.restoreUndoEntry(entry);
  }

  private async commitMutation(
    targetPath: string,
    kind: Exclude<WorkspaceMutationKind, "undo">,
    buildNextContent: (currentContent: string) => Promise<string> | string
  ): Promise<WorkspaceMutationResult> {
    const absolutePath = this.resolveWorkspacePath(targetPath);
    const relativePath = this.toStoredPath(absolutePath);
    const currentContentRaw = await this.readExistingFile(relativePath);
    const beforeExists = currentContentRaw !== null;
    const currentContent = currentContentRaw ?? "";
    const nextContent = await buildNextContent(currentContent);
    const diffPreview = renderDiff(relativePath, currentContent, nextContent);

    if (nextContent === currentContent) {
      return {
        changed: false,
        content: nextContent,
        diffPreview,
        path: relativePath
      };
    }

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, nextContent, "utf8");

    const undoEntry = await this.createUndoEntry({
      afterContent: Buffer.from(nextContent, "utf8"),
      beforeContent: Buffer.from(currentContent, "utf8"),
      beforeExists,
      contentEncoding: "text",
      kind,
      path: relativePath
    });

    return {
      changed: true,
      content: nextContent,
      diffPreview,
      path: relativePath,
      undoEntry
    };
  }

  private async commitBinaryMutation(
    targetPath: string,
    kind: Exclude<WorkspaceMutationKind, "undo">,
    buildNextContent: (currentContent: Buffer) => Promise<Buffer> | Buffer
  ): Promise<WorkspaceBinaryMutationResult> {
    const absolutePath = this.resolveWorkspacePath(targetPath);
    const relativePath = this.toStoredPath(absolutePath);
    const currentContentRaw = await this.readExistingBuffer(relativePath);
    const beforeExists = currentContentRaw !== null;
    const currentContent = currentContentRaw ?? Buffer.alloc(0);
    const nextContent = await buildNextContent(currentContent);
    const diffPreview = renderBinaryDiff(relativePath, currentContent, nextContent);

    if (nextContent.equals(currentContent)) {
      return {
        byteLength: nextContent.byteLength,
        changed: false,
        diffPreview,
        path: relativePath
      };
    }

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, nextContent);

    const undoEntry = await this.createUndoEntry({
      afterContent: nextContent,
      beforeContent: currentContent,
      beforeExists,
      contentEncoding: "binary",
      kind,
      path: relativePath
    });

    return {
      byteLength: nextContent.byteLength,
      changed: true,
      diffPreview,
      path: relativePath,
      undoEntry
    };
  }

  private async createUndoEntry(params: {
    afterContent: Buffer;
    beforeContent: Buffer;
    beforeExists: boolean;
    contentEncoding: "binary" | "text";
    kind: Exclude<WorkspaceMutationKind, "undo">;
    path: string;
  }): Promise<WorkspaceUndoEntry> {
    const createdAt = new Date().toISOString();
    const id = `undo.${Date.now()}.${crypto.randomUUID()}`;
    const snapshotsRoot = this.undoSnapshotsRoot();
    const beforeContentPath = path.join(snapshotsRoot, `${id}.before.txt`);
    const afterContentPath = path.join(snapshotsRoot, `${id}.after.txt`);
    const entry: WorkspaceUndoEntry = {
      afterContentPath,
      beforeExists: params.beforeExists,
      beforeContentPath,
      contentEncoding: params.contentEncoding,
      createdAt,
      diffPreview:
        params.contentEncoding === "text"
          ? renderDiff(params.path, params.beforeContent.toString("utf8"), params.afterContent.toString("utf8"))
          : renderBinaryDiff(params.path, params.beforeContent, params.afterContent),
      id,
      kind: params.kind,
      path: params.path
    };

    await fs.mkdir(snapshotsRoot, { recursive: true });
    await Promise.all([
      fs.writeFile(beforeContentPath, params.beforeContent),
      fs.writeFile(afterContentPath, params.afterContent),
      writeJsonAtomic(path.join(this.undoEntriesRoot(), `${id}.json`), entry)
    ]);

    return entry;
  }

  private async restoreUndoEntry(entry: WorkspaceUndoEntry): Promise<WorkspaceMutationResult> {
    const absolutePath = this.resolveWorkspacePath(entry.path);
    const isBinary = entry.contentEncoding === "binary";
    const beforeContent = await fs.readFile(entry.beforeContentPath);
    const currentContent = (await this.readExistingBuffer(entry.path)) ?? Buffer.alloc(0);
    const diffPreview = isBinary
      ? renderBinaryDiff(entry.path, currentContent, beforeContent)
      : renderDiff(entry.path, currentContent.toString("utf8"), beforeContent.toString("utf8"));

    if (entry.beforeExists) {
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, beforeContent);
    } else {
      await fs.rm(absolutePath, { force: true });
    }

    const restoredEntry: WorkspaceUndoEntry = {
      ...entry,
      restoredAt: new Date().toISOString()
    };
    await writeJsonAtomic(path.join(this.undoEntriesRoot(), `${entry.id}.json`), restoredEntry);

    return {
      changed: !currentContent.equals(beforeContent),
      content: isBinary ? "" : beforeContent.toString("utf8"),
      diffPreview,
      path: entry.path,
      undoEntry: restoredEntry
    };
  }

  private async readExistingFile(targetPath: string): Promise<string | null> {
    try {
      return await fs.readFile(this.resolveWorkspacePath(targetPath), "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  private async readExistingBuffer(targetPath: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.resolveWorkspacePath(targetPath));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  private async readUndoEntry(filePath: string): Promise<WorkspaceUndoEntry | null> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      return JSON.parse(raw) as WorkspaceUndoEntry;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }

      throw error;
    }
  }

  private async requireUndoEntry(entryId: string): Promise<WorkspaceUndoEntry> {
    const entry = await this.readUndoEntry(path.join(this.undoEntriesRoot(), `${entryId}.json`));
    if (!entry) {
      throw new Error(`Undo entry "${entryId}" was not found.`);
    }

    return entry;
  }

  private resolveWorkspacePath(targetPath: string): string {
    const candidate = path.resolve(this.options.workspaceRoot, targetPath);
    const relativePath = path.relative(this.options.workspaceRoot, candidate);
    if (!this.options.allowArbitraryPaths && (relativePath.startsWith("..") || path.isAbsolute(relativePath))) {
      throw new Error(`Path "${targetPath}" escapes the workspace root.`);
    }

    return candidate;
  }

  private toStoredPath(targetPath: string): string {
    return toStoredPath(this.options.workspaceRoot, this.resolveWorkspacePath(targetPath));
  }

  private async walkDirectory(
    absoluteDirectory: string,
    relativeDirectory: string,
    depth: number,
    entries: WorkspaceFileEntry[],
    options: {
      includeHidden: boolean;
      maxEntries: number;
      recursive: boolean;
    }
  ): Promise<void> {
    if (entries.length >= options.maxEntries) {
      return;
    }

    const dirEntries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    for (const dirEntry of dirEntries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!options.includeHidden && dirEntry.name.startsWith(".")) {
        continue;
      }

      const absolutePath = path.join(absoluteDirectory, dirEntry.name);
      const relativePath = normalizeRelativePath(
        relativeDirectory === "." ? dirEntry.name : path.join(relativeDirectory, dirEntry.name)
      );

      entries.push({
        depth,
        path: relativePath,
        type: dirEntry.isDirectory() ? "directory" : "file"
      });

      if (entries.length >= options.maxEntries) {
        return;
      }

      if (dirEntry.isDirectory() && options.recursive) {
        await this.walkDirectory(absolutePath, relativePath, depth + 1, entries, options);
      }
    }
  }

  private undoEntriesRoot(): string {
    return path.join(this.stateRoot, "undo", "entries");
  }

  private undoSnapshotsRoot(): string {
    return path.join(this.stateRoot, "undo", "snapshots");
  }
}

function applyRangePatch(content: string, operations: WorkspaceRangePatchOperation[]): string {
  const sortedOperations = [...operations].sort((left, right) => right.start - left.start);
  let nextContent = content;
  let lastStart = Number.POSITIVE_INFINITY;

  for (const operation of sortedOperations) {
    if (operation.start < 0 || operation.end < operation.start || operation.end > content.length) {
      throw new Error(`Invalid patch range ${operation.start}-${operation.end}.`);
    }
    if (operation.end > lastStart) {
      throw new Error("Patch operations must not overlap.");
    }

    nextContent = `${nextContent.slice(0, operation.start)}${operation.text}${nextContent.slice(operation.end)}`;
    lastStart = operation.start;
  }

  return nextContent;
}

function buildOperationsFromEdits(content: string, edits: WorkspaceTextEdit[]): WorkspaceRangePatchOperation[] {
  const operations: WorkspaceRangePatchOperation[] = [];

  for (const edit of edits) {
    if (!edit.oldText) {
      throw new Error("Edit operations require a non-empty oldText value.");
    }

    const matches = findAllMatches(content, edit.oldText);
    if (matches.length === 0) {
      throw new Error(`Could not find the requested text to edit: "${truncateForError(edit.oldText)}".`);
    }

    if (!edit.replaceAll && matches.length > 1) {
      throw new Error(`Edit is ambiguous because "${truncateForError(edit.oldText)}" appears multiple times.`);
    }

    for (const start of edit.replaceAll ? matches : [matches[0] as number]) {
      operations.push({
        end: start + edit.oldText.length,
        start,
        text: edit.newText
      });
    }
  }

  return operations.sort((left, right) => left.start - right.start);
}

function findAllMatches(content: string, needle: string): number[] {
  const matches: number[] = [];
  let startIndex = 0;

  while (true) {
    const matchIndex = content.indexOf(needle, startIndex);
    if (matchIndex === -1) {
      break;
    }

    matches.push(matchIndex);
    startIndex = matchIndex + needle.length;
  }

  return matches;
}

function buildMatcher(
  query: string,
  options: {
    caseSensitive: boolean;
    regex: boolean;
  }
): (line: string) => number | null {
  if (options.regex) {
    const matcher = new RegExp(query, options.caseSensitive ? "u" : "iu");
    return (line) => {
      const match = line.match(matcher);
      return match?.index ?? null;
    };
  }

  const normalizedQuery = options.caseSensitive ? query : query.toLowerCase();
  return (line) => {
    const haystack = options.caseSensitive ? line : line.toLowerCase();
    const index = haystack.indexOf(normalizedQuery);
    return index === -1 ? null : index;
  };
}

function renderDiff(filePath: string, before: string, after: string): string {
  if (before === after) {
    return `--- a/${normalizeRelativePath(filePath)}\n+++ b/${normalizeRelativePath(filePath)}\n@@\n`;
  }

  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const diffLines = diffLineSequences(beforeLines, afterLines).map((entry) => `${entry.prefix}${entry.text}`);
  return [`--- a/${normalizeRelativePath(filePath)}`, `+++ b/${normalizeRelativePath(filePath)}`, "@@", ...diffLines].join("\n");
}

function diffLineSequences(
  beforeLines: string[],
  afterLines: string[]
): Array<{
  prefix: " " | "+" | "-";
  text: string;
}> {
  const heights = beforeLines.length + 1;
  const widths = afterLines.length + 1;
  const matrix = Array.from({ length: heights }, () => Array.from({ length: widths }, () => 0));

  for (let row = beforeLines.length - 1; row >= 0; row -= 1) {
    for (let column = afterLines.length - 1; column >= 0; column -= 1) {
      if (beforeLines[row] === afterLines[column]) {
        matrix[row]![column] = (matrix[row + 1]?.[column + 1] ?? 0) + 1;
      } else {
        matrix[row]![column] = Math.max(matrix[row + 1]?.[column] ?? 0, matrix[row]?.[column + 1] ?? 0);
      }
    }
  }

  const entries: Array<{ prefix: " " | "+" | "-"; text: string }> = [];
  let row = 0;
  let column = 0;

  while (row < beforeLines.length && column < afterLines.length) {
    if (beforeLines[row] === afterLines[column]) {
      entries.push({
        prefix: " ",
        text: beforeLines[row] as string
      });
      row += 1;
      column += 1;
      continue;
    }

    if ((matrix[row + 1]?.[column] ?? 0) >= (matrix[row]?.[column + 1] ?? 0)) {
      entries.push({
        prefix: "-",
        text: beforeLines[row] as string
      });
      row += 1;
      continue;
    }

    entries.push({
      prefix: "+",
      text: afterLines[column] as string
    });
    column += 1;
  }

  while (row < beforeLines.length) {
    entries.push({
      prefix: "-",
      text: beforeLines[row] as string
    });
    row += 1;
  }

  while (column < afterLines.length) {
    entries.push({
      prefix: "+",
      text: afterLines[column] as string
    });
    column += 1;
  }

  return entries;
}

function splitLines(value: string): string[] {
  if (!value) {
    return [];
  }

  return value.replace(/\r\n/gu, "\n").split("\n");
}

function toStoredPath(workspaceRoot: string, absolutePath: string): string {
  const relativePath = path.relative(workspaceRoot, absolutePath);
  if (!relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return relativePath.length === 0 ? "." : normalizeRelativePath(relativePath);
  }

  return normalizeRelativePath(path.resolve(absolutePath));
}

function renderBinaryDiff(filePath: string, before: Buffer, after: Buffer): string {
  if (before.equals(after)) {
    return `Binary file ${normalizeRelativePath(filePath)} unchanged (${before.byteLength} bytes).`;
  }

  return `Binary file ${normalizeRelativePath(filePath)} changed (${before.byteLength} -> ${after.byteLength} bytes).`;
}

function normalizeRelativePath(value: string): string {
  return value.split(path.sep).join("/");
}

function truncateForError(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
