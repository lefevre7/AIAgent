import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const [mode, ...args] = process.argv.slice(2);

if (mode === "codex") {
  await runCodex(args);
} else if (mode === "vibe") {
  await runVibe(args);
} else if (mode === "claude") {
  await runClaude(args);
} else if (mode === "interactive") {
  await runInteractive(args);
} else {
  console.error(`Unsupported mock external-agent mode: ${mode}`);
  process.exit(1);
}

/**
 * A minimal stand-in for an agent TUI: it prints a banner and a prompt, then
 * answers each submitted line and reprints the prompt.
 *
 * It deliberately rewrites a spinner on the same line before answering, so the
 * tests prove that the service reports the *rendered screen* rather than the
 * raw byte stream.
 */
async function runInteractive(args) {
  const ready = "\r\n> ";
  process.stdout.write(`mock interactive agent ready (${args.join(" ")})${ready}`);

  let buffer = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let newline = buffer.search(/[\r\n]/u);
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.search(/[\r\n]/u);

      if (line.length === 0) {
        continue;
      }
      if (line === "/quit") {
        process.stdout.write("\r\nbye\r\n");
        process.exit(0);
      }

      // Rewrite the spinner in place (carriage return, no newline) so the
      // frames overwrite each other exactly as a real TUI's would.
      process.stdout.write("\r\n");
      for (const frame of ["-", "\\", "|"]) {
        process.stdout.write(`working ${frame}\r`);
        await sleep(10);
      }
      process.stdout.write(`\r\nanswer: ${line}${ready}`);
    }
  }
}

async function runClaude(args) {
  const resumeSessionId = readFlagValue(args, ["--resume"]);
  const isResume = Boolean(resumeSessionId);
  const prompt = readClaudePrompt(args);
  const normalizedPrompt = stripControlTags(prompt);
  const sleepMs = readSleepMs(prompt);
  const shouldInterrupt = prompt.includes("[interrupt]") && !isResume;
  // Claude reports its own failures (auth, refusals) in the JSON body with
  // `is_error: true` while still printing `subtype: "success"` and a session id,
  // then exiting non-zero.
  const shouldReportError = prompt.includes("[agent-error]");
  const sessionId = resumeSessionId ?? buildSessionId("claude", normalizedPrompt);

  if (sleepMs > 0) {
    await sleep(sleepMs);
  }

  if (shouldInterrupt) {
    process.exit(2);
  }

  if (shouldReportError) {
    process.stdout.write(
      `${JSON.stringify({
        api_error_status: 401,
        is_error: true,
        result: "Failed to authenticate. API Error: 401 OAuth access token has been revoked.",
        session_id: sessionId,
        subtype: "success",
        type: "result"
      })}\n`
    );
    process.exit(1);
  }

  const result = isResume ? `mock claude resumed: ${normalizedPrompt}` : `mock claude result: ${normalizedPrompt}`;
  process.stdout.write(
    `${JSON.stringify({
      is_error: false,
      result,
      session_id: sessionId,
      subtype: "success",
      type: "result"
    })}\n`
  );
}

function readClaudePrompt(args) {
  const positionals = [];

  for (let index = 0; index < args.length; index += 1) {
    const entry = args[index];
    if (!entry) {
      continue;
    }
    if (entry === "--print" || entry === "-p") {
      continue;
    }
    if (entry === "--output-format" || entry === "--resume") {
      index += 1;
      continue;
    }
    if (entry.startsWith("-")) {
      if (index + 1 < args.length && !args[index + 1]?.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    positionals.push(entry);
  }

  return positionals.at(-1) ?? "";
}

async function runCodex(args) {
  const isResume = args.includes("resume");
  const resumeIndex = args.indexOf("resume");
  const resumeSessionId = isResume ? args[resumeIndex + 1] : undefined;
  const outputPath = readFlagValue(args, ["--output-last-message", "-o"]);
  const schemaPath = readFlagValue(args, ["--output-schema"]);
  const prompt = readCodexPrompt(args, { isResume, resumeSessionId });
  const normalizedPrompt = stripControlTags(prompt);
  const sleepMs = readSleepMs(prompt);
  const shouldInterrupt = prompt.includes("[interrupt]") && !isResume;
  const sessionId = resumeSessionId ?? buildSessionId("codex", normalizedPrompt);

  console.log(JSON.stringify({ type: "thread.started", thread_id: sessionId }));

  if (sleepMs > 0) {
    await sleep(sleepMs);
  }

  if (shouldInterrupt) {
    process.exit(2);
  }

  let assistantText = `mock codex result: ${normalizedPrompt}`;
  if (schemaPath) {
    const payload = {
      message: `mock codex ${normalizedPrompt}`,
      mode: "codex"
    };
    if (outputPath) {
      await writeJson(outputPath, payload);
    }
    assistantText = `Structured result ready for ${normalizedPrompt}.`;
  } else if (outputPath) {
    await writeText(outputPath, assistantText);
  }

  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: assistantText } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 11, output_tokens: 7 } }));
}

async function runVibe(args) {
  const prompt = readFlagValue(args, ["--prompt"]) ?? "";
  const resumeSessionId = readFlagValue(args, ["--resume"]);
  const normalizedPrompt = stripControlTags(prompt);
  const sessionId = resumeSessionId ?? buildSessionId("vibe", normalizedPrompt);
  const sleepMs = readSleepMs(prompt);
  const shouldInterrupt = prompt.includes("[interrupt]") && !resumeSessionId;
  const vibeHome = process.env.VIBE_HOME ?? path.join(process.cwd(), ".mock-vibe-home");
  const sessionRoot = path.join(vibeHome, "logs", "session", sessionId);

  await fs.mkdir(sessionRoot, { recursive: true });
  await writeJson(path.join(sessionRoot, "meta.json"), {
    session_id: sessionId
  });

  if (sleepMs > 0) {
    await sleep(sleepMs);
  }

  if (shouldInterrupt) {
    process.exit(2);
  }

  const transcript = [
    {
      role: "assistant",
      content: `mock vibe result: ${normalizedPrompt}`
    }
  ];

  await fs.writeFile(path.join(sessionRoot, "messages.jsonl"), `${JSON.stringify(transcript[0])}\n`, "utf8");

  // "[logsonly]" simulates a run that writes its transcript to the session log
  // but emits nothing on stdout, exercising the log-based summary fallback.
  if (!prompt.includes("[logsonly]")) {
    process.stdout.write(`${JSON.stringify(transcript)}\n`);
  }
}

function readCodexPrompt(args, params) {
  const positionals = [];

  for (let index = 0; index < args.length; index += 1) {
    const entry = args[index];
    if (!entry) {
      continue;
    }
    if (entry === "exec" || entry === "resume") {
      continue;
    }
    if (params.isResume && params.resumeSessionId && entry === params.resumeSessionId) {
      continue;
    }
    if (entry === "--json" || entry === "--skip-git-repo-check") {
      continue;
    }
    if (entry === "--output-last-message" || entry === "-o" || entry === "--output-schema") {
      index += 1;
      continue;
    }
    if (entry.startsWith("-")) {
      if (index + 1 < args.length && !args[index + 1]?.startsWith("-")) {
        index += 1;
      }
      continue;
    }
    positionals.push(entry);
  }

  return positionals.at(-1) ?? "";
}

function readFlagValue(args, names) {
  for (let index = 0; index < args.length; index += 1) {
    if (!names.includes(args[index])) {
      continue;
    }
    return args[index + 1];
  }
  return undefined;
}

function readSleepMs(value) {
  const matched = value.match(/\[sleep:(\d+)\]/u);
  return matched ? Number.parseInt(matched[1], 10) : 0;
}

function stripControlTags(value) {
  return value.replace(/\[(?:interrupt|logsonly|sleep:\d+)\]\s*/gu, "").trim() || "ok";
}

function buildSessionId(prefix, seed) {
  return `mock-${prefix}-session-${crypto.createHash("sha1").update(seed).digest("hex").slice(0, 10)}`;
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${value}\n`, "utf8");
}

async function sleep(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
