import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { WorkspaceMutationEngine } from "@/core";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

describe("workspace mutation engine", () => {
  test("reads, lists, searches, and greps the workspace", async () => {
    const root = await createTempRoot();
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "README.md"), "# AIAgent\n", "utf8");
    await fs.writeFile(path.join(root, "src", "app.ts"), "const value = 1;\n// TODO: tighten tool prompts\n", "utf8");
    await fs.writeFile(path.join(root, ".secret"), "hidden\n", "utf8");

    const engine = new WorkspaceMutationEngine({
      workspaceRoot: root
    });

    expect(await engine.readFile("README.md")).toContain("AIAgent");
    expect(await engine.listFiles()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "README.md",
          type: "file"
        }),
        expect.objectContaining({
          path: "src",
          type: "directory"
        }),
        expect.objectContaining({
          path: "src/app.ts",
          type: "file"
        })
      ])
    );
    expect((await engine.listFiles()).some((entry) => entry.path === ".secret")).toBe(false);

    expect(await engine.searchPaths("read")).toEqual([{ path: "README.md" }]);
    expect(await engine.grep("TODO")).toEqual([
      {
        column: 4,
        line: 2,
        path: "src/app.ts",
        text: "// TODO: tighten tool prompts"
      }
    ]);
  });

  test("routes write, edit, patch, and undo through one canonical mutation engine", async () => {
    const root = await createTempRoot();
    await fs.writeFile(path.join(root, "notes.txt"), "alpha\nbeta\ngamma\n", "utf8");

    const engine = new WorkspaceMutationEngine({
      workspaceRoot: root
    });

    const preview = await engine.previewWrite("notes.txt", "alpha\nBETA\ngamma\n");
    expect(preview).toContain("-beta");
    expect(preview).toContain("+BETA");

    const createdDraft = await engine.writeFile("draft.txt", "draft\n");
    expect(createdDraft.changed).toBe(true);
    expect(createdDraft.undoEntry?.beforeExists).toBe(false);
    expect(await fs.readFile(path.join(root, "draft.txt"), "utf8")).toBe("draft\n");

    const editedNotes = await engine.editFile("notes.txt", [
      {
        newText: "BETA",
        oldText: "beta"
      }
    ]);
    expect(editedNotes.changed).toBe(true);
    expect(await fs.readFile(path.join(root, "notes.txt"), "utf8")).toBe("alpha\nBETA\ngamma\n");

    const currentNotes = await engine.readFile("notes.txt");
    const patchStart = currentNotes.indexOf("gamma");
    const patchedNotes = await engine.applyPatch("notes.txt", [
      {
        end: patchStart + "gamma".length,
        start: patchStart,
        text: "delta"
      }
    ]);
    expect(patchedNotes.changed).toBe(true);
    expect(await fs.readFile(path.join(root, "notes.txt"), "utf8")).toBe("alpha\nBETA\ndelta\n");
    expect(await engine.listUndoEntries()).toHaveLength(3);
    expect(patchedNotes.undoEntry?.beforeContentPath).toContain(path.join(".aia", "undo", "snapshots"));

    const undoLatestNotesEdit = await engine.undoFileEdit("notes.txt");
    expect(undoLatestNotesEdit.diffPreview).toContain("-delta");
    expect(undoLatestNotesEdit.diffPreview).toContain("+gamma");
    expect(await fs.readFile(path.join(root, "notes.txt"), "utf8")).toBe("alpha\nBETA\ngamma\n");

    const undoLastEdit = await engine.undoLastEdit();
    expect(undoLastEdit.path).toBe("notes.txt");
    expect(await fs.readFile(path.join(root, "notes.txt"), "utf8")).toBe("alpha\nbeta\ngamma\n");

    await engine.undoFileEdit("draft.txt");
    await expect(fs.readFile(path.join(root, "draft.txt"), "utf8")).rejects.toThrow();
  });

  test("supports arbitrary local paths and binary-safe undo snapshots", async () => {
    const root = await createTempRoot();
    const externalRoot = await createTempRoot();
    const externalFile = path.join(externalRoot, "asset.bin");
    const payload = Buffer.from([0x00, 0x7f, 0x80, 0xff]);

    const engine = new WorkspaceMutationEngine({
      allowArbitraryPaths: true,
      workspaceRoot: root
    });

    const written = await engine.writeFileBytes(externalFile, payload);
    expect(written.changed).toBe(true);
    expect(written.byteLength).toBe(payload.byteLength);
    expect(written.diffPreview).toContain("Binary file");
    expect(await engine.readFileBuffer(externalFile)).toEqual(payload);
    expect(await engine.listFiles({ path: externalFile })).toEqual([
      {
        depth: 0,
        path: externalFile.replace(/\\/gu, "/"),
        type: "file"
      }
    ]);

    await engine.undoFileEdit(externalFile);
    await expect(fs.readFile(externalFile)).rejects.toThrow();
  });
});

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-workspace-engine-"));
  tempRoots.push(root);
  return root;
}
