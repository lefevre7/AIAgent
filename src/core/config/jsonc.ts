import fs from "node:fs/promises";

import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

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
  try {
    const text = await fs.readFile(filePath, "utf8");
    return parseJsoncText(text, filePath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
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

  return value;
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
