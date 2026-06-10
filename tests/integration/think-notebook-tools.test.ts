import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  createDefaultToolRuntime,
  sessionRecordSchema,
  toolCallRecordSchema,
  turnRecordSchema,
  type ToolRuntime
} from "@/core";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await fs.rm(root, { force: true, recursive: true });
    })
  );
});

const ORIGINAL_NOTEBOOK = {
  cells: [
    { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: ["print('a')\n"] },
    { cell_type: "markdown", metadata: {}, source: ["# Title\n"] }
  ],
  metadata: { language_info: { name: "python" } },
  nbformat: 4,
  nbformat_minor: 5
};

describe("think tool", () => {
  test("records a thought without side effects", async () => {
    const root = await createTempRoot();
    const runtime = createRuntime(root);

    const result = await executeApproved(runtime, root, "think", {
      thought: "Plan: read the file, then edit two call sites."
    });

    expect(result.toolCall.status).toBe("succeeded");
    expect(result.toolCall.result).toMatchObject({
      acknowledged: true,
      thought: "Plan: read the file, then edit two call sites."
    });
  });

  test("rejects an empty thought", async () => {
    const root = await createTempRoot();
    const runtime = createRuntime(root);

    const result = await executeApproved(runtime, root, "think", { thought: "" });
    expect(result.toolCall.status).toBe("failed");
  });

  test("is registered in the default runtime", async () => {
    const root = await createTempRoot();
    const runtime = createRuntime(root);
    const names = runtime.listDefinitions().map((definition) => definition.invocationName);
    expect(names).toContain("think");
    expect(names).toContain("notebook_edit");
  });
});

describe("notebook_edit tool", () => {
  test("replaces a cell's source while preserving cell type", async () => {
    const root = await createTempRoot();
    const runtime = createRuntime(root);
    await writeNotebook(root);

    const result = await executeApproved(runtime, root, "notebook_edit", {
      action: "replace",
      cellIndex: 0,
      path: "notebook.ipynb",
      source: "print('hello')\n"
    });

    expect(result.toolCall.status).toBe("succeeded");
    expect(result.toolCall.result).toMatchObject({ action: "replace", cellCount: 2, changed: true });

    const notebook = await readNotebook(root);
    expect(notebook.cells[0].cell_type).toBe("code");
    expect(joinSource(notebook.cells[0].source)).toBe("print('hello')\n");
  });

  test("inserts a typed cell at an index", async () => {
    const root = await createTempRoot();
    const runtime = createRuntime(root);
    await writeNotebook(root);

    const result = await executeApproved(runtime, root, "notebook_edit", {
      action: "insert",
      cellIndex: 0,
      cellType: "markdown",
      path: "notebook.ipynb",
      source: "# Intro\n"
    });

    expect(result.toolCall.status).toBe("succeeded");
    expect(result.toolCall.result).toMatchObject({ cellCount: 3 });

    const notebook = await readNotebook(root);
    expect(notebook.cells).toHaveLength(3);
    expect(notebook.cells[0].cell_type).toBe("markdown");
    expect(joinSource(notebook.cells[0].source)).toBe("# Intro\n");
  });

  test("deletes a cell by index", async () => {
    const root = await createTempRoot();
    const runtime = createRuntime(root);
    await writeNotebook(root);

    const result = await executeApproved(runtime, root, "notebook_edit", {
      action: "delete",
      cellIndex: 1,
      path: "notebook.ipynb"
    });

    expect(result.toolCall.status).toBe("succeeded");
    const notebook = await readNotebook(root);
    expect(notebook.cells).toHaveLength(1);
    expect(notebook.cells[0].cell_type).toBe("code");
  });

  test("fails on an out-of-range index", async () => {
    const root = await createTempRoot();
    const runtime = createRuntime(root);
    await writeNotebook(root);

    const result = await executeApproved(runtime, root, "notebook_edit", {
      action: "replace",
      cellIndex: 99,
      path: "notebook.ipynb",
      source: "x = 1\n"
    });

    expect(result.toolCall.status).toBe("failed");
    expect(result.toolCall.error?.message).toContain("out of range");
  });

  test("requires source for replace", async () => {
    const root = await createTempRoot();
    const runtime = createRuntime(root);
    await writeNotebook(root);

    const result = await executeApproved(runtime, root, "notebook_edit", {
      action: "replace",
      cellIndex: 0,
      path: "notebook.ipynb"
    });

    expect(result.toolCall.status).toBe("failed");
  });

  test("fails when the file is not a notebook", async () => {
    const root = await createTempRoot();
    const runtime = createRuntime(root);
    await fs.writeFile(path.join(root, "not-a-notebook.ipynb"), "{}", "utf8");

    const result = await executeApproved(runtime, root, "notebook_edit", {
      action: "delete",
      cellIndex: 0,
      path: "not-a-notebook.ipynb"
    });

    expect(result.toolCall.status).toBe("failed");
    expect(result.toolCall.error?.message).toContain("not a valid notebook");
  });

  test("writes notebooks through the undoable mutation pipeline", async () => {
    const root = await createTempRoot();
    const runtime = createRuntime(root);
    await writeNotebook(root);

    await executeApproved(runtime, root, "notebook_edit", {
      action: "replace",
      cellIndex: 0,
      path: "notebook.ipynb",
      source: "print('changed')\n"
    });

    const undo = await executeApproved(runtime, root, "undo_file_edit", { path: "notebook.ipynb" });
    expect(undo.toolCall.status).toBe("succeeded");

    const notebook = await readNotebook(root);
    expect(joinSource(notebook.cells[0].source)).toBe("print('a')\n");
  });
});

type ParsedNotebook = {
  cells: Array<{ cell_type: string; source: string[] | string }>;
};

function joinSource(source: string[] | string): string {
  return Array.isArray(source) ? source.join("") : source;
}

async function writeNotebook(root: string): Promise<void> {
  await fs.writeFile(path.join(root, "notebook.ipynb"), `${JSON.stringify(ORIGINAL_NOTEBOOK, null, 1)}\n`, "utf8");
}

async function readNotebook(root: string): Promise<ParsedNotebook> {
  return JSON.parse(await fs.readFile(path.join(root, "notebook.ipynb"), "utf8")) as ParsedNotebook;
}

function createRuntime(root: string): ToolRuntime {
  return createDefaultToolRuntime({
    stateRoot: path.join(root, ".aia"),
    workspaceRoot: root
  });
}

async function executeApproved(runtime: ToolRuntime, cwd: string, toolName: string, args: Record<string, unknown>) {
  return runtime.executeApproved(
    toolCallRecordSchema.parse({
      arguments: args,
      id: `tool-call.gap.${toolName}.${Math.random().toString(36).slice(2, 10)}`,
      metadata: {},
      sessionId: "session.integration.gap-tools",
      startedAt: "2026-03-27T12:00:00.000Z",
      status: "pending",
      toolName,
      turnId: `turn.integration.${toolName}`
    }),
    {
      session: buildSession(cwd),
      turn: buildTurn(toolName)
    }
  );
}

function buildSession(cwd: string) {
  return sessionRecordSchema.parse({
    createdAt: "2026-03-27T12:00:00.000Z",
    cwd,
    goal: "Exercise think and notebook built-ins",
    id: "session.integration.gap-tools",
    lastActiveAt: "2026-03-27T12:00:00.000Z",
    metadata: {},
    status: "running_model",
    tags: [],
    title: "Think and Notebook Tools",
    updatedAt: "2026-03-27T12:00:00.000Z"
  });
}

function buildTurn(toolName: string) {
  return turnRecordSchema.parse({
    approvalRequestIds: [],
    executedToolCallIds: [],
    id: `turn.integration.${toolName}`,
    inputMessageIds: [],
    metadata: {},
    outputMessageIds: [],
    requestedToolCallIds: [],
    sequence: 0,
    sessionId: "session.integration.gap-tools",
    startedAt: "2026-03-27T12:00:00.000Z",
    status: "running",
    trigger: "user"
  });
}

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-gap-tools-"));
  tempRoots.push(root);
  return root;
}
