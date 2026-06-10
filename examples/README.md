# Examples

These examples exercise the real prompt-pack and runtime surfaces without requiring live model credentials by default.

Commands:

```bash
npm run example:coding
npm run example:research
npm run example:memory-mcp
```

What each example covers:

- `coding-task.ts`: AGENTS-aware prompt-pack loading, task-state updates through `update_plan`, and normal session completion.
- `research-web-task.ts`: public-web research flow through `web_fetch` with a local fake fetch backend.
- `memory-skills-mcp-task.ts`: durable memory lookup, workspace skill discovery, MCP catalog search, and MCP executable tool calls.

Notes:

- Set `AIA_KEEP_EXAMPLE_STATE=1` if you want the temporary example workspace to remain on disk after the script exits.
- The examples intentionally use scripted local model adapters so they can expose prompt and tool surfaces deterministically.
