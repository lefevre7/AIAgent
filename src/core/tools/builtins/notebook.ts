import { z } from "zod";

import type { JsonSchemaDocument, ToolDefinition } from "@/core/contracts";
import type { WorkspaceMutationEngine } from "@/core/workspace";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";
import { resolveLocalPath } from "@/core/tools/builtins/local-paths";

type NotebookCell = {
  cell_type: string;
  metadata?: Record<string, unknown>;
  source: string[] | string;
  [key: string]: unknown;
};

type Notebook = {
  cells: NotebookCell[];
  [key: string]: unknown;
};

const notebookEditInputSchema = z
  .object({
    action: z.enum(["replace", "insert", "delete"]),
    cellIndex: z.number().int().min(0).max(100_000),
    cellType: z.enum(["code", "markdown"]).optional(),
    path: z.string().min(1).max(4096),
    source: z.string().max(1_000_000).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.action === "replace" || value.action === "insert") && value.source === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"source" is required when action is "${value.action}".`,
        path: ["source"]
      });
    }
  });

export function createNotebookEditTool(params: { workspaceEngine: WorkspaceMutationEngine }): RuntimeTool {
  return {
    definition: notebookEditToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = notebookEditInputSchema.parse(call.arguments as unknown);
      const targetPath = resolveLocalPath(input.path, context.session.cwd);

      const notebook = parseNotebook(await params.workspaceEngine.readFile(targetPath));

      if (input.action === "delete" || input.action === "replace") {
        if (input.cellIndex >= notebook.cells.length) {
          throw new Error(
            `Cell index ${input.cellIndex} is out of range; the notebook has ${notebook.cells.length} cell(s).`
          );
        }
      } else if (input.cellIndex > notebook.cells.length) {
        throw new Error(
          `Cell index ${input.cellIndex} is out of range; insert position must be between 0 and ${notebook.cells.length}.`
        );
      }

      switch (input.action) {
        case "delete":
          notebook.cells.splice(input.cellIndex, 1);
          break;
        case "insert":
          notebook.cells.splice(input.cellIndex, 0, buildCell(input.cellType ?? "code", input.source ?? ""));
          break;
        case "replace": {
          const existing = notebook.cells[input.cellIndex] as NotebookCell;
          const cellType = input.cellType ?? (existing.cell_type === "markdown" ? "markdown" : "code");
          notebook.cells[input.cellIndex] = {
            ...existing,
            ...buildCell(cellType, input.source ?? "")
          };
          break;
        }
      }

      const result = await params.workspaceEngine.writeFile(targetPath, serializeNotebook(notebook));

      return {
        display: [
          {
            kind: "status",
            state: result.changed ? "written" : "unchanged",
            summary: `${input.action} notebook cell ${input.cellIndex} in ${result.path}`
          }
        ],
        result: {
          action: input.action,
          cellCount: notebook.cells.length,
          cellIndex: input.cellIndex,
          changed: result.changed,
          diffPreview: result.diffPreview,
          path: result.path
        }
      };
    }
  };
}

function parseNotebook(raw: string): Notebook {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`The notebook is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as Notebook).cells)) {
    throw new Error('The file is not a valid notebook: expected a JSON object with a "cells" array.');
  }

  return parsed as Notebook;
}

function serializeNotebook(notebook: Notebook): string {
  // Jupyter notebooks are conventionally written with one-space indentation
  // and a trailing newline; matching that keeps diffs minimal on real files.
  return `${JSON.stringify(notebook, null, 1)}\n`;
}

function buildCell(cellType: "code" | "markdown", text: string): NotebookCell {
  if (cellType === "code") {
    return {
      cell_type: "code",
      execution_count: null,
      metadata: {},
      outputs: [],
      source: toSourceLines(text)
    };
  }

  return {
    cell_type: "markdown",
    metadata: {},
    source: toSourceLines(text)
  };
}

function toSourceLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  return text.split(/(?<=\n)/u);
}

const notebookEditOutputSchema: JsonSchemaDocument = {
  additionalProperties: false,
  properties: {
    action: { type: "string" },
    cellCount: { type: "integer" },
    cellIndex: { type: "integer" },
    changed: { type: "boolean" },
    diffPreview: { type: "string" },
    path: { type: "string" }
  },
  required: ["action", "cellCount", "cellIndex", "changed", "path"],
  type: "object"
};

export const notebookEditToolDefinition: ToolDefinition = {
  aliases: ["edit_notebook", "notebook_cell_edit"],
  annotations: {
    idempotentHint: false,
    meta: {
      family: "workspace"
    },
    openWorldHint: false,
    readOnlyHint: false,
    title: "Edit Notebook"
  },
  approvalMode: "ask",
  descriptor: {
    approvalNotes: "Operator approval is required because this tool overwrites a notebook file on disk.",
    examples: [
      "Replace the source of cell 0 with a corrected function.",
      "Insert a new markdown cell at the top of the notebook.",
      "Delete a stale cell by index."
    ],
    purpose: "Edit Jupyter notebook (.ipynb) cells by replacing, inserting, or deleting a cell by index.",
    sideEffectSummary: "Rewrites the target .ipynb file through the same mutation pipeline as other edits, so it is undoable.",
    whenNotToUse: [
      "Do not use it on non-notebook files; use edit_file or write_file instead.",
      "Do not use it to execute cells; it only edits cell content."
    ],
    whenToUse: [
      "Use to change a notebook cell's source without rewriting the whole file by hand.",
      "Use to add or remove a cell at a specific index."
    ]
  },
  description:
    "Edit a Jupyter notebook (.ipynb) by replacing, inserting, or deleting a cell at a given index. Notebook source is normalized to nbformat line arrays, and the write goes through the undoable mutation pipeline.",
  displayName: "Edit Notebook",
  execution: {
    inputMode: "json",
    resumable: false,
    taskSupport: "forbidden"
  },
  idempotent: false,
  inputSchema: {
    additionalProperties: false,
    properties: {
      action: {
        description: "replace, insert, or delete a cell.",
        enum: ["replace", "insert", "delete"],
        type: "string"
      },
      cellIndex: {
        description: "Zero-based cell index. For insert, the position to insert at (0..cellCount).",
        type: "integer"
      },
      cellType: {
        description: "Cell type for insert/replace. Defaults to code (or the existing type on replace).",
        enum: ["code", "markdown"],
        type: "string"
      },
      path: {
        description: "Path to the .ipynb file.",
        type: "string"
      },
      source: {
        description: "New cell source. Required for replace and insert.",
        type: "string"
      }
    },
    required: ["action", "cellIndex", "path"],
    type: "object"
  },
  invocationName: "notebook_edit",
  kind: "built_in",
  metadata: {},
  name: "notebook_edit",
  outputKind: "json",
  outputSchema: notebookEditOutputSchema,
  retryable: false,
  searchTags: ["cell", "edit", "ipynb", "jupyter", "notebook"],
  sideEffects: ["workspace_write"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.builtin.notebook_edit",
  usageGuidance:
    "Use this to edit notebook cells by index. Provide source for replace and insert. The change is undoable via the workspace undo tools.",
  version: "1.0.0"
};
