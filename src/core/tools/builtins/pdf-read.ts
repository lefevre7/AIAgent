import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { JsonSchemaDocument, ToolDefinition } from "@/core/contracts";
import type { RuntimeTool, RuntimeToolResult } from "@/core/tools/runtime";
import { displayLocalPath, resolveLocalPath } from "@/core/tools/builtins/local-paths";

const DEFAULT_MAX_CHARS = 24_000;

export type PdfTextExtractor = (buffer: Buffer) => Promise<{ pageCount: number; text: string }>;

const pdfReadInputSchema = z
  .object({
    maxChars: z.number().int().positive().max(200_000).optional(),
    path: z.string().min(1).max(4096)
  })
  .strict();

async function defaultExtractPdfText(buffer: Buffer): Promise<{ pageCount: number; text: string }> {
  // Lazy import keeps pdf-parse out of the startup path; it is only loaded when
  // a PDF is actually read. The inner module path avoids pdf-parse's index-file
  // debug branch that reads a sample file when run as the main module.
  const { default: pdfParse } = await import("pdf-parse/lib/pdf-parse.js");
  const result = await pdfParse(buffer);
  return { pageCount: result.numpages, text: result.text };
}

export function createPdfReadTool(params: { extractText?: PdfTextExtractor } = {}): RuntimeTool {
  const extractText = params.extractText ?? defaultExtractPdfText;

  return {
    definition: pdfReadToolDefinition,
    async execute(call, context): Promise<RuntimeToolResult> {
      const input = pdfReadInputSchema.parse(call.arguments as unknown);
      const absolutePath = resolveLocalPath(input.path, context.session.cwd);
      if (path.extname(absolutePath).toLowerCase() !== ".pdf") {
        throw new Error(`"${input.path}" is not a .pdf file.`);
      }

      const buffer = await fs.readFile(absolutePath);

      let extracted: { pageCount: number; text: string };
      try {
        extracted = await extractText(buffer);
      } catch (error) {
        throw new Error(
          `Could not extract text from PDF "${input.path}" (it may be encrypted, scanned, or corrupt): ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }

      const displayPath = displayLocalPath(context.session.cwd, absolutePath);
      const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
      const trimmed = extracted.text.trim();
      const truncated = trimmed.length > maxChars;
      const text = truncated ? `${trimmed.slice(0, Math.max(0, maxChars - 16)).trimEnd()}\n\n...[truncated]` : trimmed;

      return {
        display: [
          {
            kind: "status",
            state: truncated ? "truncated" : "read",
            summary: `Read PDF ${displayPath} (${extracted.pageCount} page(s), ${trimmed.length} chars).`
          }
        ],
        result: {
          pageCount: extracted.pageCount,
          path: displayPath,
          text,
          truncated
        }
      };
    }
  };
}

const pdfReadOutputSchema: JsonSchemaDocument = {
  additionalProperties: false,
  properties: {
    pageCount: { type: "integer" },
    path: { type: "string" },
    text: { type: "string" },
    truncated: { type: "boolean" }
  },
  required: ["pageCount", "path", "text", "truncated"],
  type: "object"
};

export const pdfReadToolDefinition: ToolDefinition = {
  aliases: ["read_pdf", "pdf_extract"],
  annotations: {
    idempotentHint: true,
    meta: {
      family: "workspace"
    },
    openWorldHint: false,
    readOnlyHint: true,
    title: "Read PDF"
  },
  approvalMode: "never",
  descriptor: {
    approvalNotes: "No operator approval is required because this tool only reads a local PDF file.",
    examples: ["Extract the text of a local report.pdf before summarizing it.", "Read a spec PDF to answer a question about it."],
    purpose: "Extract text content from a local PDF file for reading and analysis.",
    sideEffectSummary: "Reads a local PDF file only.",
    whenNotToUse: [
      "Do not use it on non-PDF files; use read_file or view_image.",
      "Do not expect reliable text from scanned/image-only PDFs (no OCR)."
    ],
    whenToUse: ["Use to read the text of a local PDF.", "Use before summarizing or answering questions about a PDF."]
  },
  description:
    "Extract text from a local PDF file (text-based PDFs; no OCR for scanned images). Returns extracted text, page count, and a truncation flag. Fails clearly on encrypted or corrupt PDFs.",
  displayName: "Read PDF",
  execution: {
    inputMode: "json",
    resumable: false,
    taskSupport: "forbidden"
  },
  idempotent: true,
  inputSchema: {
    additionalProperties: false,
    properties: {
      maxChars: {
        description: "Maximum characters of extracted text to return (default 24000).",
        type: "integer"
      },
      path: {
        description: "Path to a local .pdf file.",
        type: "string"
      }
    },
    required: ["path"],
    type: "object"
  },
  invocationName: "pdf_read",
  kind: "built_in",
  metadata: {},
  name: "pdf_read",
  outputKind: "json",
  outputSchema: pdfReadOutputSchema,
  retryable: true,
  searchTags: ["document", "extract", "pdf", "read", "text"],
  sideEffects: ["workspace_read"],
  source: {
    displayName: "Built-in Tools",
    kind: "built_in"
  },
  streamingMode: "none",
  toolId: "tool.builtin.pdf_read",
  usageGuidance:
    "Use this to extract text from a local PDF. It does not OCR scanned images and returns a clear error for encrypted or corrupt files. Request a smaller maxChars for very large PDFs.",
  version: "1.0.0"
};
