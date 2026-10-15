import fs from "node:fs/promises";

import { applyEdits, modify, parse, printParseErrorCode, visit, type ParseError } from "jsonc-parser";

/**
 * Keys no aia file may use. jsonc-parser builds objects by assignment, so a
 * `"__proto__"` key sets the object's prototype instead of adding a property:
 * `Object.entries` (what the trust checks walk) does not see what is under it,
 * while Zod's record parsing (`for...in`) does. A workspace config could hide an
 * MCP server or an `exec` provider from the trust checks that way and still
 * have it loaded. None of these is ever a legitimate setting name.
 */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export class JsoncParseError extends Error {
  constructor(
    public readonly filePath: string,
    public readonly details: string[]
  ) {
    super(`Failed to parse JSONC file at ${filePath}:\n${details.join("\n")}`);
    this.name = "JsoncParseError";
  }
}

export async function readJsoncFileIfExists(filePath: string): Promise<unknown | null> {
  const read = await readJsoncFileWithTextIfExists(filePath);
  return read === null ? null : read.value;
}

/**
 * Reads and parses a JSONC file once, returning the exact text alongside the
 * value. Callers that fingerprint a file must hash the bytes they parsed: a
 * second read can see a file that changed in between.
 */
export async function readJsoncFileWithTextIfExists(
  filePath: string
): Promise<{ text: string; value: unknown } | null> {
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  return { text, value: parseJsoncText(text, filePath) };
}

export function parseJsoncText(text: string, filePath = "<inline>"): unknown {
  const errors: ParseError[] = [];
  const value = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false
  });

  if (errors.length > 0) {
    const details = errors.map((entry) => {
      const location = formatOffset(text, entry.offset);
      return `- ${printParseErrorCode(entry.error)} at ${filePath}:${location.line}:${location.column}`;
    });
    throw new JsoncParseError(filePath, details);
  }

  const forbidden: string[] = [];
  visit(text, {
    onObjectProperty(property, offset) {
      if (FORBIDDEN_KEYS.has(property)) {
        const location = formatOffset(text, offset);
        forbidden.push(`- the key "${property}" is not allowed, at ${filePath}:${location.line}:${location.column}`);
      }
    }
  });
  if (forbidden.length > 0) {
    throw new JsoncParseError(filePath, forbidden);
  }

  return value;
}

/**
 * Sets one value in a JSONC document and returns the new text. Comments and
 * layout elsewhere survive: only the edited value is rewritten.
 */
export function applyJsoncEdit(document: string, pathSegments: (string | number)[], value: unknown): string {
  const edits = modify(document, pathSegments, value, {
    formattingOptions: {
      insertSpaces: true,
      tabSize: 2
    }
  });
  return applyEdits(document, edits);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function formatOffset(text: string, offset: number): { column: number; line: number } {
  const prefix = text.slice(0, offset);
  const lines = prefix.split("\n");
  return {
    column: lines[lines.length - 1].length + 1,
    line: lines.length
  };
}
