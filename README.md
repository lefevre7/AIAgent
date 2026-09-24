# AIAgent

Local-first AI agent runtime with a shared CLI, SDK, web control plane, and gateway.

## Requirements

- Node `>=22.14.0`
- `npm`

## Install

```bash
npm install
```

## Run The CLI

The fastest way to run the CLI from source is:

```bash
npm run cli -- --help
```

That uses `src/cli.ts` directly through `tsx`, so you do not need to build first during development.

### Interactive mode

Running the CLI with no `--prompt` starts an interactive session:

```bash
npm run cli
# or, after building + linking: aia
```

It creates a session and keeps prompting for input. The loop stays open until you type `/exit` or `/quit` (or stdin reaches end-of-input); `/help` lists the commands. Anything else is sent to the agent as a message.

While the model works, the CLI shows a `Thinking…` indicator and then streams the response live, along with tool-activity lines. When a tool needs approval (file writes, shell commands, etc.) it prompts inline — `Approve <tool> → <target>? [y/N/a/e]` — and only runs the tool if you approve:

- `y` approves this request once.
- `a` approves it and auto-approves the same target (same tool, command, path, or MCP server) for the rest of this CLI session.
- `e` denies it and asks what the agent should do instead; your note is queued as steering so it adapts on the resumed turn rather than retrying the same action.
- anything else (including a bare Enter) denies it.

Anything you typed _before_ a prompt appeared is discarded rather than used as the answer — an impatient Enter pressed while the agent was working used to be consumed as a silent "no", which made a subsequent `a` look like it had been rejected.

When the agent asks you a question (`ask_user_question`), the CLI prints the question and its options and sends your typed reply straight back to the agent.

When the agent starts an interactive external-agent session, a real terminal window opens on your desktop running `aia attach <id>`, so you and the agent drive the same terminal at once (Ctrl-] detaches without killing the session). The interactive CLI serves the gateway on loopback to make that possible — see [docs/EXTERNAL_AGENTS.md](docs/EXTERNAL_AGENTS.md). Set `externalAgents.interactive.autoAttachOnStart` to `false` to keep sessions headless.

Interactive commands: `/help`, `/compact` (summarize the transcript so far into `chat-session-memory/` and stop replaying it to the model, useful when the context-window percentage climbs), `/mcp` (list configured MCP servers and their tools), and `/exit` / `/quit`.

> If you use the linked `aia` command, it runs the built `dist/cli.js`. Rebuild after changing source (`npm run build:node`); `npm install`/`npm link` rebuild it automatically via the `prepare` script.

Use `aia info` to print the runtime surfaces and providers without starting a session.

The interactive session needs a reachable chat model (the configured default provider, e.g. LM Studio or Ollama). If it isn't running, `aia` prints a clear message and exits rather than opening a session that fails on every turn. If only the embedding provider is down, memory degrades to lexical search (with a warning) and the session still opens.

### One-shot prompt mode

Use `--prompt` for a single run that creates a real session, waits for it to finish, and prints the final status plus the agent's final answer (the `attempt_complete` summary, which the runtime persists as an assistant message).

```bash
npm run cli -- --prompt "Summarize this repository" --cwd .
```

Optional flags:

- `--cwd <path>`: workspace root for the session
- `--goal <text>`: override the session goal
- `--title <text>`: override the session title

Example:

```bash
npm run cli -- --prompt "Implement item 21" --cwd /path/to/workspace --goal "Finish item 21" --title "Item 21 run"
```

### Other ways to run the CLI

After building the Node package:

```bash
npm run build:node
node dist/cli.js --help
```

If you want the `aia` shell command locally:

```bash
npm run build:node
npm link
aia --help
aia --version
```

## Run The Control Plane

Start the local server and web control plane with:

```bash
npm run dev
```

## Examples

Runnable examples:

```bash
npm run example:coding
npm run example:research
npm run example:memory-mcp
```

## Testing

Common validation commands:

```bash
npm run typecheck
npm run lint
npm run test:deterministic
npm run test:live
```

More test and live-suite details are documented in [docs/TESTING.md](docs/TESTING.md).
