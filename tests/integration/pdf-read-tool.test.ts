import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  createDefaultToolRuntime,
  createPdfReadTool,
  sessionRecordSchema,
  toolCallRecordSchema,
  turnRecordSchema,
  type PdfTextExtractor,
  type RuntimeToolContext
} from "@/core";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aiagent-pdf-read-"));
  tempRoots.push(root);
  return root;
}

function context(cwd: string): RuntimeToolContext {
  return { session: buildSession(cwd), turn: buildTurn() } as unknown as RuntimeToolContext;
}

async function runDirect(extractText: PdfTextExtractor, cwd: string, args: Record<string, unknown>) {
  const tool = createPdfReadTool({ extractText });
  return tool.execute(
    toolCallRecordSchema.parse({
      arguments: args,
      id: "tool-call.pdf.1",
      metadata: {},
      sessionId: "session.pdf.1",
      startedAt: "2026-06-10T12:00:00.000Z",
      status: "pending",
      toolName: "pdf_read",
      turnId: "turn.pdf.1"
    }),
    context(cwd)
  );
}

describe("pdf_read tool logic", () => {
  test("returns extracted text and page count", async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, "doc.pdf"), Buffer.from("%PDF-1.4 fake"));
    const result = await runDirect(async () => ({ pageCount: 3, text: "  Document body text  " }), root, { path: "doc.pdf" });
    expect(result.result).toMatchObject({ pageCount: 3, text: "Document body text", truncated: false });
  });

  test("truncates long text", async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, "big.pdf"), Buffer.from("%PDF-1.4 fake"));
    const result = await runDirect(async () => ({ pageCount: 1, text: "x".repeat(500) }), root, {
      maxChars: 50,
      path: "big.pdf"
    });
    expect((result.result as { truncated: boolean }).truncated).toBe(true);
    expect((result.result as { text: string }).text.endsWith("...[truncated]")).toBe(true);
  });

  test("rejects non-pdf paths before reading", async () => {
    const root = await tempRoot();
    await expect(runDirect(async () => ({ pageCount: 1, text: "" }), root, { path: "notes.txt" })).rejects.toThrow(
      /is not a \.pdf file/u
    );
  });

  test("wraps extractor failures in a clear error", async () => {
    const root = await tempRoot();
    await fs.writeFile(path.join(root, "bad.pdf"), Buffer.from("%PDF-1.4 fake"));
    await expect(
      runDirect(async () => {
        throw new Error("encrypted");
      }, root, { path: "bad.pdf" })
    ).rejects.toThrow(/Could not extract text/u);
  });
});

describe("pdf_read default backend (pdf-parse)", () => {
  const samplePdf = path.resolve("node_modules/pdf-parse/test/data/04-valid.pdf");

  test.skipIf(!existsSync(samplePdf))("extracts text from a real PDF via the default extractor", async () => {
    const root = await tempRoot();
    const runtime = createDefaultToolRuntime({ stateRoot: path.join(root, ".aia"), workspaceRoot: root });

    const outcome = await runtime.executeApproved(
      toolCallRecordSchema.parse({
        arguments: { maxChars: 2000, path: samplePdf },
        id: "tool-call.pdf.real",
        metadata: {},
        sessionId: "session.pdf.real",
        startedAt: "2026-06-10T12:00:00.000Z",
        status: "pending",
        toolName: "pdf_read",
        turnId: "turn.pdf.real"
      }),
      { session: buildSession(root), turn: buildTurn() }
    );

    expect(outcome.toolCall.status).toBe("succeeded");
    const result = outcome.toolCall.result as { pageCount: number; text: string };
    expect(result.pageCount).toBeGreaterThanOrEqual(1);
    expect(result.text.length).toBeGreaterThan(0);
  });
});

function buildSession(cwd: string) {
  return sessionRecordSchema.parse({
    createdAt: "2026-06-10T12:00:00.000Z",
    cwd,
    goal: "Read a PDF",
    id: "session.pdf.1",
    lastActiveAt: "2026-06-10T12:00:00.000Z",
    metadata: {},
    status: "running_model",
    tags: [],
    title: "PDF",
    updatedAt: "2026-06-10T12:00:00.000Z"
  });
}

function buildTurn() {
  return turnRecordSchema.parse({
    approvalRequestIds: [],
    executedToolCallIds: [],
    id: "turn.pdf.1",
    inputMessageIds: [],
    metadata: {},
    outputMessageIds: [],
    requestedToolCallIds: [],
    sequence: 0,
    sessionId: "session.pdf.1",
    startedAt: "2026-06-10T12:00:00.000Z",
    status: "running",
    trigger: "user"
  });
}
