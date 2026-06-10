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

### One-shot prompt mode

Use `--prompt` for a single run that creates a real session, waits for it to finish, and prints the final status plus the latest assistant summary.

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
