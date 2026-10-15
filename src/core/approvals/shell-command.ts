/**
 * What an approval rule needs to know about a shell command line: the separate
 * commands it runs, and whether it does something no rule can vouch for by
 * reading the line (command or process substitution, a redirect that writes
 * a file).
 *
 * An allow rule used to be matched against the whole line, so a rule for `ls`
 * also approved `ls; rm -rf ~/work` and `ls && curl … | sh`. Each command is
 * now matched on its own.
 *
 * Deliberately conservative: anything it cannot follow (an unclosed quote,
 * say) counts as opaque, which can only turn an automatic allow into a
 * question.
 */
export type ShellCommandAnalysis = {
  // True when the line runs something not visible as a plain command, or
  // writes a file through a redirect.
  opaque: boolean;
  // The commands it runs, split on `;`, `&&`, `||`, `|`, `|&`, `&` and line
  // breaks outside quotes, with wrapping `( )`, `{ }` and a leading `!` removed.
  segments: string[];
};

export function analyzeShellCommand(command: string): ShellCommandAnalysis {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let opaque = false;
  const finishSegment = (): void => {
    const segment = normalizeSegment(current);
    if (segment.length > 0) {
      segments.push(segment);
    }
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string;
    const next = command[index + 1];

    if (quote === "'") {
      current += char;
      if (char === "'") {
        quote = null;
      }
      continue;
    }
    if (char === "\\") {
      current += char + (next ?? "");
      index += 1;
      continue;
    }
    if (quote === '"') {
      current += char;
      if (char === '"') {
        quote = null;
      } else if (char === "`" || (char === "$" && next === "(")) {
        opaque = true;
      }
      continue;
    }

    switch (char) {
      case "'":
      case '"':
        quote = char;
        current += char;
        break;
      case "`":
        opaque = true;
        current += char;
        break;
      case "$":
      case "<":
        // $(…) and $((…)) run or compute something; <(…) is process substitution.
        if (next === "(") {
          opaque = true;
        }
        current += char;
        break;
      case ">": {
        if (next === "(") {
          opaque = true;
          current += char;
          break;
        }
        const redirect = readOutputRedirect(command, index);
        opaque ||= !redirect.harmless;
        current += command.slice(index, redirect.end);
        index = redirect.end - 1;
        break;
      }
      case ";":
      case "\n":
      case "\r":
        finishSegment();
        break;
      case "&":
        if (next === "&") {
          finishSegment();
          index += 1;
        } else if (next === ">") {
          // &> and &>> send both streams to a file.
          const redirect = readOutputRedirect(command, index + 1);
          opaque ||= !redirect.harmless;
          current += command.slice(index, redirect.end);
          index = redirect.end - 1;
        } else if (current.endsWith("<") || current.endsWith(">")) {
          current += char;
        } else {
          // A background job: another command follows.
          finishSegment();
        }
        break;
      case "|":
        if (next === "|" || next === "&") {
          index += 1;
        }
        finishSegment();
        break;
      default:
        current += char;
    }
  }

  if (quote !== null) {
    opaque = true;
  }
  finishSegment();
  return { opaque, segments };
}

/**
 * Reads the redirect starting at the `>` at `index`. Duplicating or closing a
 * descriptor (`2>&1`, `>&2`, `>&-`) and discarding output (`>/dev/null`)
 * write nothing; any other target is a file the command writes.
 */
function readOutputRedirect(command: string, index: number): { end: number; harmless: boolean } {
  let cursor = index + 1;
  if (command[cursor] === ">" || command[cursor] === "|") {
    cursor += 1;
  }
  if (command[cursor] === "&") {
    cursor += 1;
    const start = cursor;
    while (cursor < command.length && /[0-9-]/u.test(command[cursor] as string)) {
      cursor += 1;
    }
    // `>&word` is bash for "both streams to the file word".
    return { end: cursor, harmless: cursor > start };
  }
  while (cursor < command.length && /[ \t]/u.test(command[cursor] as string)) {
    cursor += 1;
  }
  const start = cursor;
  while (cursor < command.length && !/[\s;&|<>()]/u.test(command[cursor] as string)) {
    cursor += 1;
  }
  return { end: cursor, harmless: command.slice(start, cursor) === "/dev/null" };
}

// Grouping and negation wrap a command without changing what runs:
// `(rm -rf x)` is still `rm -rf x`, and `{ ls; }` is still `ls`.
function normalizeSegment(segment: string): string {
  let text = segment.trim();
  for (;;) {
    const stripped = text
      .replace(/^[({!]\s*/u, "")
      .replace(/\s*[)}]$/u, "")
      .trim();
    if (stripped === text) {
      return text;
    }
    text = stripped;
  }
}
