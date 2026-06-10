import path from "node:path";

import { z } from "zod";

import type { JsonSchemaDocument, ToolDefinition } from "@/core/contracts";
import { type WorkspaceBinaryMutationResult, type WorkspaceMutationResult, type WorkspaceMutationEngine } from "@/core/workspace";
import { runProcess } from "@/core/voice/utils";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";

import {
  decodeBase64Content,
  displayLocalPath,
  encodeBase64Content,
  inferMediaType,
  looksLikeTextFile,
  normalizeSlashes,
  resolveLocalPath
} from "@/core/tools/builtins/local-paths";

const localPathSchema = z.string().min(1).max(4096);

const readFileInputSchema = z
  .object({
    lineCount: z.number().int().positive().max(50_000).optional(),
    maxBytes: z.number().int().positive().max(5_000_000).optional(),
    path: localPathSchema,
    startLine: z.number().int().positive().max(50_000).optional()
  })
  .strict();

const listFilesInputSchema = z
  .object({
    includeHidden: z.boolean().optional(),
    maxEntries: z.number().int().positive().max(10_000).optional(),
    path: localPathSchema.optional(),
    recursive: z.boolean().optional()
  })
  .strict();

const searchPathsInputSchema = z
  .object({
    includeHidden: z.boolean().optional(),
    maxResults: z.number().int().positive().max(1_000).optional(),
    path: localPathSchema.optional(),
    query: z.string().min(1).max(2_000)
  })
  .strict();

const grepFilesInputSchema = z
  .object({
    caseSensitive: z.boolean().optional(),
    includeHidden: z.boolean().optional(),
    maxResults: z.number().int().positive().max(1_000).optional(),
    path: localPathSchema.optional(),
    query: z.string().min(1).max(2_000),
    regex: z.boolean().optional()
  })
  .strict();

const genericObjectSchema: JsonSchemaDocument = {
  type: "object"
};

const emptyObjectJsonSchema: JsonSchemaDocument = {
  additionalProperties: false,
  properties: {},
  type: "object"
};

const textOrBinaryJsonSchema: JsonSchemaDocument = {
  additionalProperties: false,
  properties: {
    base64Content: { type: "string" },
    content: { type: "string" },
    path: { type: "string" }
  },
  required: ["path"],
  type: "object"
};

const appendFileJsonSchema: JsonSchemaDocument = {
  additionalProperties: false,
  properties: {
    appendNewline: { type: "boolean" },
    base64Content: { type: "string" },
    content: { type: "string" },
    path: { type: "string" }
  },
  required: ["path"],
  type: "object"
};

const editFileJsonSchema: JsonSchemaDocument = {
  additionalProperties: false,
  properties: {
    edits: {
      items: {
        additionalProperties: false,
        properties: {
          newText: { type: "string" },
          oldText: { type: "string" },
          replaceAll: { type: "boolean" }
        },
        required: ["newText", "oldText"],
        type: "object"
      },
      type: "array"
    },
    path: { type: "string" }
  },
  required: ["edits", "path"],
  type: "object"
};

const applyPatchJsonSchema: JsonSchemaDocument = {
  additionalProperties: false,
  properties: {
    patches: {
      items: {
        additionalProperties: false,
        properties: {
          deleteLineCount: { type: "integer" },
          newText: { type: "string" },
          startLine: { type: "integer" }
        },
        required: ["deleteLineCount", "newText", "startLine"],
        type: "object"
      },
      type: "array"
    },
    path: { type: "string" }
  },
  required: ["patches", "path"],
  type: "object"
};

const textOrBinaryInputObjectSchema = z
  .object({
    base64Content: z.string().min(1).optional(),
    content: z.string().optional(),
    path: localPathSchema
  })
  .strict();

const textOrBinaryInputSchema = textOrBinaryInputObjectSchema
  .refine((value) => typeof value.content === "string" || typeof value.base64Content === "string", {
    message: "Provide either content or base64Content."
  })
  .refine((value) => !(typeof value.content === "string" && typeof value.base64Content === "string"), {
    message: "Provide content or base64Content, but not both."
  });

const appendFileInputSchema = textOrBinaryInputObjectSchema
  .extend({
    appendNewline: z.boolean().optional()
  })
  .refine((value) => typeof value.content === "string" || typeof value.base64Content === "string", {
    message: "Provide either content or base64Content."
  })
  .refine((value) => !(typeof value.content === "string" && typeof value.base64Content === "string"), {
    message: "Provide content or base64Content, but not both."
  });

const editFileInputSchema = z
  .object({
    edits: z
      .array(
        z
          .object({
            newText: z.string(),
            oldText: z.string().min(1),
            replaceAll: z.boolean().optional()
          })
          .strict()
      )
      .min(1)
      .max(64),
    path: localPathSchema
  })
  .strict();

const applyPatchInputSchema = z
  .object({
    path: localPathSchema,
    patches: z
      .array(
        z
          .object({
            deleteLineCount: z.number().int().min(0).max(50_000),
            newText: z.string(),
            startLine: z.number().int().positive().max(50_000)
          })
          .strict()
      )
      .min(1)
      .max(128)
  })
  .strict();

const diffPreviewInputSchema = z
  .object({
    cwd: localPathSchema.optional(),
    path: localPathSchema.optional(),
    staged: z.boolean().optional()
  })
  .strict();

const undoFileEditInputSchema = z
  .object({
    path: localPathSchema
  })
  .strict();

export function createWorkspaceTools(params: { workspaceEngine: WorkspaceMutationEngine }): RuntimeTool[] {
  return [
    createReadFileTool(params),
    createListFilesTool(params),
    createSearchPathsTool(params),
    createGrepFilesTool(params),
    createWriteFileTool(params),
    createAppendFileTool(params),
    createEditFileTool(params),
    createApplyPatchTool(params),
    createDiffPreviewTool(),
    createUndoLastEditTool(params),
    createUndoFileEditTool(params)
  ];
}

export function createReadFileTool(params: { workspaceEngine: WorkspaceMutationEngine }): RuntimeTool {
  return {
    definition: readFileToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = readFileInputSchema.parse(call.arguments as unknown);
      const absolutePath = resolveLocalPath(input.path, context.session.cwd);
      const storedPath = displayLocalPath(context.session.cwd, absolutePath);
      const raw = await params.workspaceEngine.readFileBuffer(absolutePath);
      const maxBytes = input.maxBytes ?? 64_000;
      const isBinary = !looksLikeTextFile(raw);
      const mediaType = inferMediaType(absolutePath, isBinary);

      if (isBinary) {
        if (input.startLine || input.lineCount) {
          throw new Error("Binary files do not support line-window reads.");
        }

        const sliced = raw.subarray(0, maxBytes);
        const result = {
          base64Content: encodeBase64Content(sliced),
          byteLength: raw.byteLength,
          content: null,
          isBinary: true,
          mediaType,
          path: storedPath,
          truncated: sliced.byteLength < raw.byteLength
        };

        return {
          display: [
            {
              kind: "status",
              state: result.truncated ? "truncated" : "read",
              summary: `Read binary file ${storedPath} (${raw.byteLength} bytes).`
            }
          ],
          result
        };
      }

      const slicedText = sliceTextForRead(raw.toString("utf8"), {
        lineCount: input.lineCount,
        maxBytes,
        startLine: input.startLine
      });

      return {
        display: [
          {
            kind: "text",
            text: slicedText.content
          }
        ],
        result: {
          byteLength: raw.byteLength,
          content: slicedText.content,
          endLine: slicedText.endLine,
          isBinary: false,
          mediaType,
          path: storedPath,
          startLine: slicedText.startLine,
          truncated: slicedText.truncated
        }
      };
    }
  };
}

export function createListFilesTool(params: { workspaceEngine: WorkspaceMutationEngine }): RuntimeTool {
  return {
    definition: listFilesToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = listFilesInputSchema.parse(call.arguments as unknown);
      const entries = await params.workspaceEngine.listFiles({
        includeHidden: input.includeHidden,
        maxEntries: input.maxEntries,
        path: input.path ? resolveLocalPath(input.path, context.session.cwd) : undefined,
        recursive: input.recursive
      });

      return {
        display: [
          {
            kind: "markdown",
            markdown: renderFileEntries(entries)
          }
        ],
        result: {
          entries
        }
      };
    }
  };
}

export function createSearchPathsTool(params: { workspaceEngine: WorkspaceMutationEngine }): RuntimeTool {
  return {
    definition: searchPathsToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = searchPathsInputSchema.parse(call.arguments as unknown);
      const matches = await params.workspaceEngine.searchPaths(input.query, {
        includeHidden: input.includeHidden,
        maxResults: input.maxResults,
        path: input.path ? resolveLocalPath(input.path, context.session.cwd) : undefined
      });

      return {
        display: [
          {
            kind: "markdown",
            markdown: renderPathMatches(input.query, matches)
          }
        ],
        result: {
          matches,
          query: input.query
        }
      };
    }
  };
}

export function createGrepFilesTool(params: { workspaceEngine: WorkspaceMutationEngine }): RuntimeTool {
  return {
    definition: grepFilesToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = grepFilesInputSchema.parse(call.arguments as unknown);
      const matches = await params.workspaceEngine.grep(input.query, {
        caseSensitive: input.caseSensitive,
        includeHidden: input.includeHidden,
        maxResults: input.maxResults,
        path: input.path ? resolveLocalPath(input.path, context.session.cwd) : undefined,
        regex: input.regex
      });

      return {
        display: [
          {
            kind: "markdown",
            markdown: renderGrepMatches(matches)
          }
        ],
        result: {
          matches,
          query: input.query,
          regex: input.regex ?? false
        }
      };
    }
  };
}

export function createWriteFileTool(params: { workspaceEngine: WorkspaceMutationEngine }): RuntimeTool {
  return {
    definition: writeFileToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = textOrBinaryInputSchema.parse(call.arguments as unknown);
      const targetPath = resolveLocalPath(input.path, context.session.cwd);
      const result =
        typeof input.base64Content === "string"
          ? await params.workspaceEngine.writeFileBytes(targetPath, decodeBase64Content(input.base64Content))
          : await params.workspaceEngine.writeFile(targetPath, input.content ?? "");

      return renderMutationResult(result, typeof input.base64Content === "string");
    }
  };
}

export function createAppendFileTool(params: { workspaceEngine: WorkspaceMutationEngine }): RuntimeTool {
  return {
    definition: appendFileToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = appendFileInputSchema.parse(call.arguments as unknown);
      const targetPath = resolveLocalPath(input.path, context.session.cwd);

      if (typeof input.base64Content === "string") {
        const result = await params.workspaceEngine.appendFileBytes(targetPath, decodeBase64Content(input.base64Content));
        return renderMutationResult(result, true);
      }

      const currentContent = await params.workspaceEngine.readFile(targetPath).catch((error: unknown) => {
        if (typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          return "";
        }

        throw error;
      });
      const nextContent = `${currentContent}${input.content ?? ""}${input.appendNewline ? "\n" : ""}`;
      const result = await params.workspaceEngine.writeFile(targetPath, nextContent);

      return renderMutationResult(result, false);
    }
  };
}

export function createEditFileTool(params: { workspaceEngine: WorkspaceMutationEngine }): RuntimeTool {
  return {
    definition: editFileToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = editFileInputSchema.parse(call.arguments as unknown);
      const result = await params.workspaceEngine.editFile(
        resolveLocalPath(input.path, context.session.cwd),
        input.edits.map((edit) => ({
          newText: edit.newText,
          oldText: edit.oldText,
          replaceAll: edit.replaceAll
        }))
      );

      return renderMutationResult(result, false);
    }
  };
}

export function createApplyPatchTool(params: { workspaceEngine: WorkspaceMutationEngine }): RuntimeTool {
  return {
    definition: applyPatchToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = applyPatchInputSchema.parse(call.arguments as unknown);
      const targetPath = resolveLocalPath(input.path, context.session.cwd);
      const currentContent = await params.workspaceEngine.readFile(targetPath);
      const result = await params.workspaceEngine.applyPatch(
        targetPath,
        buildRangeOperationsFromLinePatches(currentContent, input.patches)
      );

      return renderMutationResult(result, false);
    }
  };
}

export function createDiffPreviewTool(): RuntimeTool {
  return {
    definition: diffPreviewToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = diffPreviewInputSchema.parse(call.arguments as unknown);
      const cwd = resolveGitDiffCwd(input.cwd, input.path, context.session.cwd);
      const args = ["--no-pager", "diff", "--no-ext-diff"];

      if (input.staged) {
        args.push("--staged");
      }

      if (input.path) {
        const absolutePath = resolveLocalPath(input.path, context.session.cwd);
        args.push("--", path.relative(cwd, absolutePath) || ".");
      }

      const result = await runProcess("git", args, {
        cwd
      });
      const combinedOutput = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim();

      if (result.exitCode !== 0) {
        if (combinedOutput.toLowerCase().includes("not a git repository")) {
          return {
            display: [
              {
                kind: "status",
                state: "unavailable",
                summary: `No git repository found at ${normalizeSlashes(cwd)}.`
              }
            ],
            result: {
              available: false,
              cwd: normalizeSlashes(cwd),
              diff: "",
              reason: "not_a_git_repository"
            }
          };
        }

        throw new Error(combinedOutput || "git diff failed.");
      }

      if (result.stdout.trim().length === 0) {
        return {
          display: [
            {
              kind: "status",
              state: "clean",
              summary: `No git diff available for ${normalizeSlashes(cwd)}.`
            }
          ],
          result: {
            available: true,
            cwd: normalizeSlashes(cwd),
            diff: ""
          }
        };
      }

      return {
        display: [
          {
            kind: "markdown",
            markdown: `\`\`\`diff\n${result.stdout.trimEnd()}\n\`\`\``
          }
        ],
        result: {
          available: true,
          cwd: normalizeSlashes(cwd),
          diff: result.stdout
        }
      };
    }
  };
}

export function createUndoLastEditTool(params: { workspaceEngine: WorkspaceMutationEngine }): RuntimeTool {
  return {
    definition: undoLastEditToolDefinition,
    async execute(): Promise<RuntimeToolResult> {
      const result = await params.workspaceEngine.undoLastEdit();
      return renderMutationResult(result, result.content.length === 0 && result.diffPreview.startsWith("Binary file"));
    }
  };
}

export function createUndoFileEditTool(params: { workspaceEngine: WorkspaceMutationEngine }): RuntimeTool {
  return {
    definition: undoFileEditToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = undoFileEditInputSchema.parse(call.arguments as unknown);
      const result = await params.workspaceEngine.undoFileEdit(resolveLocalPath(input.path, context.session.cwd));
      return renderMutationResult(result, result.content.length === 0 && result.diffPreview.startsWith("Binary file"));
    }
  };
}

const readFileToolDefinition: ToolDefinition = createWorkspaceDefinition({
  aliases: ["view_file"],
  approvalMode: "never",
  definitionName: "read_file",
  description: "Read a local file from the workspace or any other local path. Text files can be sliced by line range, and binary files are returned as base64 with media metadata.",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only reads local files.",
    examples: [
      "Read the first 80 lines of a source file before editing it.",
      "Inspect a binary asset as base64 when you need local bytes, not text."
    ],
    purpose: "Read local files safely, including binary files, while keeping large outputs bounded.",
    sideEffectSummary: "Reads local files only.",
    whenNotToUse: [
      "Do not use it to discover candidate files; use list_files or search_paths first.",
      "Do not use it to mutate files."
    ],
    whenToUse: [
      "Use when you already know the file you need to inspect.",
      "Use line windows for large text files to keep context focused."
    ]
  },
  displayName: "Read File",
  inputSchema: {
    additionalProperties: false,
    properties: {
      lineCount: { type: "integer" },
      maxBytes: { type: "integer" },
      path: { type: "string" },
      startLine: { type: "integer" }
    },
    required: ["path"],
    type: "object"
  },
  outputKind: "json",
  outputSchema: genericObjectSchema,
  searchTags: ["binary", "file", "local", "read", "view"],
  sideEffects: ["workspace_read"],
  usageGuidance: "Use this when you already know the file path. For large text files, request a line window. For binary files, expect base64 output instead of text."
});

const listFilesToolDefinition: ToolDefinition = createWorkspaceDefinition({
  aliases: ["list_directory", "ls"],
  approvalMode: "never",
  definitionName: "list_files",
  description: "List files or directories under a local path, optionally recursively and with hidden files included.",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only inspects local filesystem structure.",
    examples: ["List the current project tree.", "Inspect a specific folder before choosing a file to read."],
    purpose: "Inspect local directory structure before reading, editing, or searching files.",
    sideEffectSummary: "Reads directory metadata only.",
    whenNotToUse: ["Do not use it when you already know the exact file path.", "Do not use it for content search."],
    whenToUse: ["Use to inspect a directory or a single file path.", "Use before read_file when the exact target is uncertain."]
  },
  displayName: "List Files",
  inputSchema: {
    additionalProperties: false,
    properties: {
      includeHidden: { type: "boolean" },
      maxEntries: { type: "integer" },
      path: { type: "string" },
      recursive: { type: "boolean" }
    },
    type: "object"
  },
  outputKind: "json",
  outputSchema: genericObjectSchema,
  searchTags: ["directory", "files", "folders", "list", "tree"],
  sideEffects: ["workspace_read"],
  usageGuidance: "Use this to inspect directories or confirm a file target before deeper actions. Recursive listing is useful, but keep maxEntries bounded on large trees."
});

const searchPathsToolDefinition: ToolDefinition = createWorkspaceDefinition({
  aliases: ["find_files", "search_files"],
  approvalMode: "never",
  definitionName: "search_paths",
  description: "Search local path names by substring and return matching files or directories.",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only searches local path names.",
    examples: ["Find files with 'config' in the name.", "Search for test files under a specific folder."],
    purpose: "Locate candidate local files or directories when you know part of the path but not the exact target.",
    sideEffectSummary: "Reads local path names only.",
    whenNotToUse: ["Do not use it for content search inside files.", "Do not use it when list_files already narrowed the directory."],
    whenToUse: ["Use when the exact file path is unknown.", "Use before grep_files when you first need candidate files."]
  },
  displayName: "Search Paths",
  inputSchema: {
    additionalProperties: false,
    properties: {
      includeHidden: { type: "boolean" },
      maxResults: { type: "integer" },
      path: { type: "string" },
      query: { type: "string" }
    },
    required: ["query"],
    type: "object"
  },
  outputKind: "json",
  outputSchema: genericObjectSchema,
  searchTags: ["files", "find", "names", "paths", "search"],
  sideEffects: ["workspace_read"],
  usageGuidance: "Use this for path discovery only. If you need content search inside files, use grep_files instead."
});

const grepFilesToolDefinition: ToolDefinition = createWorkspaceDefinition({
  aliases: ["grep"],
  approvalMode: "never",
  definitionName: "grep_files",
  description: "Search text inside local files using plain-text or regex matching and return matching lines with locations.",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only reads local file contents.",
    examples: ["Find all TODO markers.", "Regex-search imports under a specific folder."],
    purpose: "Search file contents precisely and return line-oriented matches you can inspect or edit next.",
    sideEffectSummary: "Reads local file contents only.",
    whenNotToUse: ["Do not use it to find files by name only.", "Do not use it when you need semantic code search across the repo."] ,
    whenToUse: ["Use for exact text or regex search across local files.", "Use before edit_file or apply_patch when locating exact text to change."]
  },
  displayName: "Grep Files",
  inputSchema: {
    additionalProperties: false,
    properties: {
      caseSensitive: { type: "boolean" },
      includeHidden: { type: "boolean" },
      maxResults: { type: "integer" },
      path: { type: "string" },
      query: { type: "string" },
      regex: { type: "boolean" }
    },
    required: ["query"],
    type: "object"
  },
  outputKind: "json",
  outputSchema: genericObjectSchema,
  searchTags: ["content", "grep", "regex", "search", "text"],
  sideEffects: ["workspace_read"],
  usageGuidance: "Use this to find exact text or regex matches inside files. Keep maxResults bounded, and scope path when the search space is large."
});

const writeFileToolDefinition: ToolDefinition = createWorkspaceDefinition({
  aliases: ["create_file"],
  approvalMode: "ask",
  definitionName: "write_file",
  description: "Create or overwrite a local file with UTF-8 text or base64-decoded binary content.",
  descriptor: {
    approvalNotes: "Approval is required because this tool can create or overwrite local files.",
    examples: ["Write a new config file.", "Replace an image asset from base64 content."],
    purpose: "Create or fully replace a local file in one step.",
    sideEffectSummary: "Writes local files and records an undo snapshot.",
    whenNotToUse: ["Do not use it for small in-place edits when edit_file or apply_patch is more precise.", "Do not use it for appending content; use append_file."],
    whenToUse: ["Use when creating a new file.", "Use when replacing the entire file content is simpler than patching."]
  },
  displayName: "Write File",
  inputSchema: textOrBinaryJsonSchema,
  outputKind: "json",
  outputSchema: genericObjectSchema,
  searchTags: ["binary", "create", "overwrite", "save", "write"],
  sideEffects: ["workspace_write"],
  usageGuidance: "Use this to create or fully overwrite a file. Prefer apply_patch or edit_file when a smaller targeted change is safer."
});

const appendFileToolDefinition: ToolDefinition = createWorkspaceDefinition({
  aliases: ["append_to_file"],
  approvalMode: "ask",
  definitionName: "append_file",
  description: "Append UTF-8 text or base64-decoded binary data to a local file, creating it if needed.",
  descriptor: {
    approvalNotes: "Approval is required because this tool mutates local files.",
    examples: ["Append a log line to a text file.", "Append binary bytes to an existing asset from base64 input."],
    purpose: "Append new content to the end of a local file without replacing its existing body.",
    sideEffectSummary: "Writes local files and records an undo snapshot.",
    whenNotToUse: ["Do not use it when the change belongs in the middle of a file.", "Do not use it to replace whole-file contents."],
    whenToUse: ["Use for end-of-file additions.", "Use when you explicitly need append semantics instead of overwrite semantics."]
  },
  displayName: "Append File",
  inputSchema: appendFileJsonSchema,
  outputKind: "json",
  outputSchema: genericObjectSchema,
  searchTags: ["append", "binary", "file", "log", "write"],
  sideEffects: ["workspace_write"],
  usageGuidance: "Use this only for end-of-file additions. For targeted edits elsewhere in a file, prefer edit_file or apply_patch."
});

const editFileToolDefinition: ToolDefinition = createWorkspaceDefinition({
  aliases: ["replace_text"],
  approvalMode: "ask",
  definitionName: "edit_file",
  description: "Apply minimal exact-text replacements to a UTF-8 file. This is the lightweight in-place editor, while apply_patch handles broader line-oriented changes.",
  descriptor: {
    approvalNotes: "Approval is required because this tool mutates local files.",
    examples: ["Replace one exact import path.", "Swap a specific string in a file without rewriting nearby lines."],
    purpose: "Perform small exact-text replacements in a text file.",
    sideEffectSummary: "Writes local files and records an undo snapshot.",
    whenNotToUse: ["Do not use it on binary files.", "Do not use it when the change is easier to express as line patches."],
    whenToUse: ["Use for precise exact-text replacements.", "Use when you already know the exact text span to replace."]
  },
  displayName: "Edit File",
  inputSchema: editFileJsonSchema,
  outputKind: "json",
  outputSchema: genericObjectSchema,
  searchTags: ["edit", "replace", "text", "update"],
  sideEffects: ["workspace_write"],
  usageGuidance: "Use this for exact string replacements in text files. If the change is broader or line-oriented, prefer apply_patch."
});

const applyPatchToolDefinition: ToolDefinition = createWorkspaceDefinition({
  aliases: ["patch_file"],
  approvalMode: "ask",
  definitionName: "apply_patch",
  description: "Apply one or more line-oriented patches to a UTF-8 file. This is the main structured editor for broader local file changes.",
  descriptor: {
    approvalNotes: "Approval is required because this tool mutates local files.",
    examples: ["Replace a function body by line range.", "Insert new lines at a specific location without rewriting the whole file."],
    purpose: "Apply structured line-based patches to a text file.",
    sideEffectSummary: "Writes local files and records an undo snapshot.",
    whenNotToUse: ["Do not use it on binary files.", "Do not use it for tiny exact-text replacements when edit_file is enough."],
    whenToUse: ["Use for broader multi-line text changes.", "Use when you want one canonical patch-style editing path."]
  },
  displayName: "Apply Patch",
  inputSchema: applyPatchJsonSchema,
  outputKind: "json",
  outputSchema: genericObjectSchema,
  searchTags: ["apply", "diff", "patch", "replace", "update"],
  sideEffects: ["workspace_write"],
  usageGuidance: "Use this as the main structured editor for multi-line text changes. Provide clear start lines and delete counts, and keep edits scoped to one file per call."
});

const diffPreviewToolDefinition: ToolDefinition = createWorkspaceDefinition({
  aliases: ["git_diff"],
  approvalMode: "never",
  definitionName: "diff_preview",
  description: "Show the current git diff for a repository or a specific path without mutating anything.",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only runs a read-only git diff.",
    examples: ["Preview the current working-tree diff.", "Show only the staged diff for one file."],
    purpose: "Inspect git changes before or after file edits.",
    sideEffectSummary: "Reads local git state only.",
    whenNotToUse: ["Do not use it as a substitute for apply_patch or edit_file.", "Do not use it outside a git-backed workflow when you only need current file contents."],
    whenToUse: ["Use when reviewing current git changes.", "Use when you need a patch-style preview of working tree or staged edits."]
  },
  displayName: "Diff Preview",
  inputSchema: {
    additionalProperties: false,
    properties: {
      cwd: { type: "string" },
      path: { type: "string" },
      staged: { type: "boolean" }
    },
    type: "object"
  },
  outputKind: "json",
  outputSchema: genericObjectSchema,
  searchTags: ["diff", "git", "patch", "preview", "review"],
  sideEffects: ["none"],
  usageGuidance: "Use this to inspect git changes, not to propose hypothetical edits. If the target is not in a git repository, the tool will tell you that directly."
});

const undoLastEditToolDefinition: ToolDefinition = createWorkspaceDefinition({
  aliases: [],
  approvalMode: "ask",
  definitionName: "undo_last_edit",
  description: "Restore the most recent local file mutation recorded by the canonical undo system.",
  descriptor: {
    approvalNotes: "Approval is required because this tool mutates local files by restoring prior snapshots.",
    examples: ["Undo the last local edit after a bad patch.", "Roll back the most recent file mutation before trying a safer approach."],
    purpose: "Restore the latest recorded file mutation from the local undo log.",
    sideEffectSummary: "Writes local files by restoring a prior snapshot.",
    whenNotToUse: ["Do not use it when you need a git revert or repository-wide reset.", "Do not use it if you need to undo a specific older change by id."] ,
    whenToUse: ["Use immediately after a bad local mutation.", "Use when the latest recorded workspace change should be reverted."]
  },
  displayName: "Undo Last Edit",
  inputSchema: emptyObjectJsonSchema,
  outputKind: "json",
  outputSchema: genericObjectSchema,
  searchTags: ["revert", "rollback", "undo"],
  sideEffects: ["workspace_write"],
  usageGuidance: "Use this to revert the most recent recorded local file mutation. It is not a git operation and only affects the built-in undo history."
});

const undoFileEditToolDefinition: ToolDefinition = createWorkspaceDefinition({
  aliases: [],
  approvalMode: "ask",
  definitionName: "undo_file_edit",
  description: "Restore the most recent recorded local mutation for one specific file path.",
  descriptor: {
    approvalNotes: "Approval is required because this tool mutates local files by restoring a prior snapshot.",
    examples: ["Undo the last change to one file while keeping other recent edits.", "Roll back the latest mutation for a binary asset."],
    purpose: "Restore the latest recorded undo snapshot for one local file.",
    sideEffectSummary: "Writes local files by restoring a prior snapshot.",
    whenNotToUse: ["Do not use it when you want to revert the latest global edit regardless of file.", "Do not use it for git history operations."],
    whenToUse: ["Use when only one file should be rolled back.", "Use after a failed mutation to a specific file while preserving other newer edits."]
  },
  displayName: "Undo File Edit",
  inputSchema: {
    additionalProperties: false,
    properties: {
      path: { type: "string" }
    },
    required: ["path"],
    type: "object"
  },
  outputKind: "json",
  outputSchema: genericObjectSchema,
  searchTags: ["file", "revert", "rollback", "undo"],
  sideEffects: ["workspace_write"],
  usageGuidance: "Use this to revert the latest recorded mutation for a specific file path. It uses the built-in undo history, not git history."
});

function createWorkspaceDefinition(params: {
  aliases: string[];
  approvalMode: ToolDefinition["approvalMode"];
  definitionName: string;
  description: string;
  descriptor: ToolDefinition["descriptor"];
  displayName: string;
  inputSchema: JsonSchemaDocument;
  outputKind: ToolDefinition["outputKind"];
  outputSchema: JsonSchemaDocument;
  searchTags: string[];
  sideEffects: ToolDefinition["sideEffects"];
  usageGuidance: string;
}): ToolDefinition {
  return {
    aliases: params.aliases,
    annotations: {
      destructiveHint: params.definitionName.startsWith("undo_"),
      idempotentHint: params.sideEffects.every((effect) => effect === "none" || effect === "workspace_read"),
      meta: {
        family: "workspace"
      },
      openWorldHint: false,
      readOnlyHint: params.sideEffects.every((effect) => effect === "none" || effect === "workspace_read"),
      title: params.displayName
    },
    approvalMode: params.approvalMode,
    descriptor: params.descriptor,
    description: params.description,
    displayName: params.displayName,
    execution: {
      inputMode: "json",
      resumable: false,
      taskSupport: "forbidden"
    },
    idempotent: params.sideEffects.every((effect) => effect === "none" || effect === "workspace_read"),
    inputSchema: params.inputSchema,
    invocationName: params.definitionName,
    kind: "built_in",
    metadata: {},
    name: params.definitionName,
    outputKind: params.outputKind,
    outputSchema: params.outputSchema,
    retryable: true,
    searchTags: params.searchTags,
    sideEffects: params.sideEffects,
    source: {
      displayName: "Built-in Tools",
      kind: "built_in"
    },
    streamingMode: "none",
    toolId: `tool.workspace.${params.definitionName}`,
    usageGuidance: params.usageGuidance,
    version: "1.0.0"
  };
}

function renderMutationResult(result: WorkspaceMutationResult | WorkspaceBinaryMutationResult, isBinary: boolean): RuntimeToolResult {
  return {
    display: [
      {
        kind: "status",
        state: result.changed ? "mutated" : "unchanged",
        summary: `${result.changed ? "Updated" : "Inspected"} ${result.path}`
      },
      ...(result.diffPreview.trim().length > 0
        ? [
            isBinary || result.diffPreview.startsWith("Binary file")
              ? ({ kind: "text", text: result.diffPreview } as const)
              : ({ kind: "markdown", markdown: `\`\`\`diff\n${result.diffPreview.trimEnd()}\n\`\`\`` } as const)
          ]
        : [])
    ],
    result: {
      ...("byteLength" in result ? { byteLength: result.byteLength } : { content: result.content }),
      changed: result.changed,
      diffPreview: result.diffPreview,
      path: result.path,
      undoEntryId: result.undoEntry?.id ?? null
    }
  };
}

function sliceTextForRead(
  content: string,
  options: {
    lineCount?: number;
    maxBytes: number;
    startLine?: number;
  }
): {
  content: string;
  endLine: number;
  startLine: number;
  truncated: boolean;
} {
  const normalized = content.replace(/\r\n/gu, "\n");
  const lines = normalized.split("\n");
  const startLine = options.startLine ?? 1;
  const startIndex = Math.max(0, startLine - 1);
  const endIndex = options.lineCount ? Math.min(lines.length, startIndex + options.lineCount) : lines.length;
  const joined = lines.slice(startIndex, endIndex).join("\n");
  const truncatedByBytes = Buffer.byteLength(joined, "utf8") > options.maxBytes;
  const sliced = truncatedByBytes ? Buffer.from(joined, "utf8").subarray(0, options.maxBytes).toString("utf8") : joined;

  return {
    content: sliced,
    endLine: endIndex,
    startLine,
    truncated: truncatedByBytes || endIndex < lines.length
  };
}

function renderFileEntries(entries: Array<{ depth: number; path: string; type: string }>): string {
  if (entries.length === 0) {
    return "No files matched.";
  }

  return entries.map((entry) => `${"  ".repeat(entry.depth)}- ${entry.path}${entry.type === "directory" ? "/" : ""}`).join("\n");
}

function renderPathMatches(query: string, matches: Array<{ path: string }>): string {
  if (matches.length === 0) {
    return `No path matches for ${query}.`;
  }

  return [`Matches for ${query}:`, ...matches.map((match) => `- ${match.path}`)].join("\n");
}

function renderGrepMatches(matches: Array<{ column: number; line: number; path: string; text: string }>): string {
  if (matches.length === 0) {
    return "No content matches found.";
  }

  return matches
    .map((match) => `- ${match.path}:${match.line}:${match.column} ${match.text}`)
    .join("\n");
}

function buildRangeOperationsFromLinePatches(
  content: string,
  patches: Array<{
    deleteLineCount: number;
    newText: string;
    startLine: number;
  }>
): Array<{
  end: number;
  start: number;
  text: string;
}> {
  const lineStarts = buildLineStartOffsets(content);

  return patches.map((patch) => {
    const startIndex = lineStarts[patch.startLine - 1];
    if (startIndex === undefined) {
      throw new Error(`startLine ${patch.startLine} is outside the file.`);
    }

    const endLineIndex = patch.startLine - 1 + patch.deleteLineCount;
    const endIndex = lineStarts[endLineIndex] ?? content.length;

    return {
      end: endIndex,
      start: startIndex,
      text: patch.newText
    };
  });
}

function buildLineStartOffsets(content: string): number[] {
  const offsets = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") {
      offsets.push(index + 1);
    }
  }

  if (content.length > 0 && content[content.length - 1] !== "\n") {
    offsets.push(content.length);
  }

  return offsets;
}

function resolveGitDiffCwd(cwd: string | undefined, targetPath: string | undefined, fallbackCwd: string): string {
  if (cwd) {
    return resolveLocalPath(cwd, fallbackCwd);
  }
  if (targetPath) {
    return path.dirname(resolveLocalPath(targetPath, fallbackCwd));
  }
  return fallbackCwd;
}
