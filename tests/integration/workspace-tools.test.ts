import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { WorkspaceMutationEngine, createWorkspaceTools, type RuntimeTool } from "@/core";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-workspace-tools-"));
  tempRoots.push(root);
  return root;
}

type Tool = RuntimeTool;

function toolsByName(root: string): Map<string, Tool> {
  const engine = new WorkspaceMutationEngine({ workspaceRoot: root });
  const map = new Map<string, Tool>();
  for (const tool of createWorkspaceTools({ workspaceEngine: engine })) {
    map.set(tool.definition.invocationName, tool);
  }
  return map;
}

function call(args: Record<string, unknown>) {
  return { arguments: args } as unknown as Parameters<Tool["execute"]>[0];
}

function context(cwd: string) {
  return { session: { cwd } } as unknown as Parameters<Tool["execute"]>[1];
}

async function run(tool: Tool | undefined, args: Record<string, unknown>, cwd: string) {
  if (!tool) {
    throw new Error("tool not registered");
  }
  return tool.execute(call(args), context(cwd));
}

describe("workspace tools", () => {
  test("reads text with line windows and binary files as base64", async () => {
    const root = await createTempRoot();
    await fs.writeFile(path.join(root, "doc.txt"), "line1\nline2\nline3\nline4\n", "utf8");
    await fs.writeFile(path.join(root, "blob.bin"), Buffer.from([0, 1, 2, 0, 255, 10]));
    const tools = toolsByName(root);

    const full = await run(tools.get("read_file"), { path: "doc.txt" }, root);
    expect((full.result as { content: string }).content).toContain("line1");

    const windowed = await run(tools.get("read_file"), { lineCount: 2, path: "doc.txt", startLine: 2 }, root);
    expect((windowed.result as { content: string }).content).toBe("line2\nline3");

    const binary = await run(tools.get("read_file"), { path: "blob.bin" }, root);
    expect((binary.result as { isBinary: boolean }).isBinary).toBe(true);
    expect((binary.result as { base64Content: string }).base64Content.length).toBeGreaterThan(0);

    await expect(run(tools.get("read_file"), { lineCount: 1, path: "blob.bin" }, root)).rejects.toThrow(
      /Binary files do not support/u
    );
  });

  test("lists, searches paths, and greps", async () => {
    const root = await createTempRoot();
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "README.md"), "# Title\n", "utf8");
    await fs.writeFile(path.join(root, "src", "app.ts"), "const x = 1;\n// TODO: refine\n", "utf8");
    const tools = toolsByName(root);

    const listed = await run(tools.get("list_files"), {}, root);
    expect((listed.result as { entries: Array<{ path: string }> }).entries.some((entry) => entry.path === "README.md")).toBe(true);

    const paths = await run(tools.get("search_paths"), { query: "app" }, root);
    expect((paths.result as { matches: Array<{ path: string }> }).matches.some((match) => match.path === "src/app.ts")).toBe(true);

    const grep = await run(tools.get("grep_files"), { query: "TODO" }, root);
    expect((grep.result as { matches: Array<{ path: string }> }).matches[0]?.path).toBe("src/app.ts");
  });

  test("writes, appends, edits, patches, and undoes files", async () => {
    const root = await createTempRoot();
    const tools = toolsByName(root);

    await run(tools.get("write_file"), { content: "alpha\nbeta\n", path: "notes.txt" }, root);
    expect(await fs.readFile(path.join(root, "notes.txt"), "utf8")).toBe("alpha\nbeta\n");

    // base64 write path
    await run(tools.get("write_file"), { base64Content: Buffer.from("hi").toString("base64"), path: "raw.bin" }, root);
    expect(await fs.readFile(path.join(root, "raw.bin"), "utf8")).toBe("hi");

    // no-op writes (identical content) report changed:false for text and binary
    const noopText = await run(tools.get("write_file"), { content: "alpha\nbeta\n", path: "notes.txt" }, root);
    expect((noopText.result as { changed?: boolean }).changed).toBe(false);
    const noopBinary = await run(tools.get("write_file"), { base64Content: Buffer.from("hi").toString("base64"), path: "raw.bin" }, root);
    expect((noopBinary.result as { changed?: boolean }).changed).toBe(false);

    // append to existing + to a brand-new file (ENOENT → empty base)
    await run(tools.get("append_file"), { appendNewline: true, content: "gamma", path: "notes.txt" }, root);
    expect(await fs.readFile(path.join(root, "notes.txt"), "utf8")).toBe("alpha\nbeta\ngamma\n");
    await run(tools.get("append_file"), { content: "fresh", path: "new.txt" }, root);
    expect(await fs.readFile(path.join(root, "new.txt"), "utf8")).toBe("fresh");
    await run(tools.get("append_file"), { base64Content: Buffer.from("!").toString("base64"), path: "new.txt" }, root);

    // edit (find/replace)
    await run(tools.get("edit_file"), { edits: [{ newText: "ALPHA", oldText: "alpha" }], path: "notes.txt" }, root);
    expect(await fs.readFile(path.join(root, "notes.txt"), "utf8")).toContain("ALPHA");

    // apply_patch via line ranges
    await run(
      tools.get("apply_patch"),
      { patches: [{ deleteLineCount: 1, newText: "BETA\n", startLine: 2 }], path: "notes.txt" },
      root
    );
    expect(await fs.readFile(path.join(root, "notes.txt"), "utf8")).toContain("BETA");

    // undo the most recent edit, then undo by path
    const undoLast = await run(tools.get("undo_last_edit"), {}, root);
    expect(undoLast.result).toBeTruthy();
    const undoPath = await run(tools.get("undo_file_edit"), { path: "notes.txt" }, root);
    expect(undoPath.result).toBeTruthy();
  });

  test("fails invalid edits, patches, and path escapes", async () => {
    const root = await createTempRoot();
    const tools = toolsByName(root);
    await run(tools.get("write_file"), { content: "alpha\nbeta\ngamma\n", path: "doc.txt" }, root);

    await expect(
      run(tools.get("edit_file"), { edits: [{ newText: "X", oldText: "zzz-not-present" }], path: "doc.txt" }, root)
    ).rejects.toThrow(/Could not find/u);

    await expect(
      run(tools.get("edit_file"), { edits: [{ newText: "X", oldText: "a" }], path: "doc.txt" }, root)
    ).rejects.toThrow(/ambiguous/u);

    await expect(
      run(tools.get("apply_patch"), { patches: [{ deleteLineCount: 50, newText: "Z\n", startLine: 99 }], path: "doc.txt" }, root)
    ).rejects.toThrow(/outside the file/u);

    await expect(
      run(
        tools.get("apply_patch"),
        {
          patches: [
            { deleteLineCount: 2, newText: "A\n", startLine: 1 },
            { deleteLineCount: 2, newText: "B\n", startLine: 2 }
          ],
          path: "doc.txt"
        },
        root
      )
    ).rejects.toThrow(/overlap/u);

    await expect(run(tools.get("read_file"), { path: "../escape.txt" }, root)).rejects.toThrow(/escapes the workspace root/u);
  });

  test("diff_preview reports clean repos, changes, and non-git directories", async () => {
    const repo = await createTempRoot();
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
    execFileSync("git", ["init", "-q"], { cwd: repo, env: gitEnv });
    await fs.writeFile(path.join(repo, "tracked.txt"), "one\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repo, env: gitEnv });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo, env: gitEnv });
    const tools = toolsByName(repo);

    const clean = await run(tools.get("diff_preview"), {}, repo);
    expect((clean.result as { available: boolean; diff: string }).diff).toBe("");

    await fs.writeFile(path.join(repo, "tracked.txt"), "one\ntwo\n", "utf8");
    const changed = await run(tools.get("diff_preview"), { path: "tracked.txt" }, repo);
    expect((changed.result as { diff: string }).diff).toContain("two");

    const nonGit = await createTempRoot();
    const nonGitResult = await run(tools.get("diff_preview"), {}, nonGit);
    expect((nonGitResult.result as { available: boolean }).available).toBe(false);
  });
});
