# Other Agent Comparisons

Last updated: 2026-04-03

## Scope

This document compares how the following repos implement agent behavior:

- `OpenHands`
- `Roo-Code`
- `aider`
- `codex`
- `mistral-vibe`
- `openai-agents-js`
- `openclaw`
- `opendev`
- `voltagent`
- `vscode-copilot-chat`

todo: Add Cline, OpenCode, and Hermes Agent for next iteration of AIA

The comparison focuses on:

- Agent loop structure
- Tool orchestration inside the loop
- How a turn is considered complete
- Agent-user chat/session handling
- Skills and subagents
- MCP discovery and invocation
- Tool inventories and descriptor quality
- Context and memory architecture
- Extensibility, reliability, and prompt effectiveness

## Methodology

- Local checked-out code was treated as the implementation source of truth.
- Upstream docs and public repos were used only where local code clearly represented a legacy or framework-only slice.
- `openai-agents-js` is judged as a framework, not as a finished assistant product.
- `voltagent` is judged as a framework, but its examples are considered collectively as if composed into one end-user assistant.
- `OpenHands` needs special handling:
  - The local checkout contains legacy V0 agent core paths.
  - Current OpenHands V1 agentic core lives in the external `software-agent-sdk` repo.

## Important Caveats

### OpenHands

The local `OpenHands` repo explicitly marks the inspected CodeAct implementation as legacy V0 and scheduled for removal. The repo itself and OpenHands upstream docs point to `software-agent-sdk` as the V1 agentic core. Any judgment here about `OpenHands` therefore distinguishes:

- local implementation truth: the checked-out V0 runtime
- current product direction: V1 moved into `software-agent-sdk`

### Frameworks vs products

These are not directly comparable on all axes:

- Framework-heavy: `codex`, `openai-agents-js`, `voltagent`, `openclaw`
- Product/end-user assistant-heavy: `Roo-Code`, `OpenDev`, `vscode-copilot-chat`, `mistral-vibe`, local `OpenHands`
- Narrower chat-editing tool: `aider`

## Executive Summary

| Repo | Type | Loop Completion Model | Tools | MCP | Skills/Subagents | Memory | Short Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `aider` | end-user coding chat | implicit end-of-reply | narrow edit/chat helpers | none | none | session summarization only | effective code-editing chat, not a full agent runtime |
| `Roo-Code` | end-user assistant | explicit `attempt_completion` | strong native tool loop | strong | strong | strong session + code index | one of the clearest coding assistant runtimes |
| `codex` | product/runtime hybrid | implicit no-follow-up | very broad, dynamic | very strong | very strong | very strong persistent pipeline | most extensible overall |
| `mistral-vibe` | end-user assistant | stop when latest item is not a tool result | clean built-ins | solid | solid | session compaction only | elegant mid-weight agent loop |
| `OpenHands` | legacy end-user assistant | explicit finish tool and controller stops | good V0 tools | solid | present | condensation-focused | local code is legacy; V1 moved elsewhere |
| `openclaw` | platform/runtime | lifecycle-driven | very broad platform tools | strong | very strong | strongest memory breadth | most ambitious platform, less simple as a coding assistant |
| `openai-agents-js` | framework | explicit runner next-step state machine | clean framework tools | strong | handoffs strong | pluggable sessions | excellent orchestration framework |
| `voltagent` | framework | AI SDK `stopWhen` / `maxSteps` | toolkit composition | strong | strong | very strong adapter-based memory | strong builder framework, less canonical assistant loop |
| `opendev` | end-user assistant | explicit `task_complete` | broad, practical built-ins | strong | strong | strong sessions, partial advanced memory integration | one of the best explicit ReAct runtimes |
| `vscode-copilot-chat` | end-user assistant | explicit internal completion gate | strongest descriptor quality | strong | strong subagents | strong multi-scope memory | strongest shipped assistant architecture in this set |

## Overall Rankings

These are cautious qualitative rankings, not benchmark claims.

### Extensibility

1. `codex`
2. `openclaw`
3. `voltagent`
4. `openai-agents-js`
5. `Roo-Code`
6. `OpenDev`
7. `vscode-copilot-chat`
8. `mistral-vibe`
9. `OpenHands` V0
10. `aider`

### Reliability and loop hardening

1. `vscode-copilot-chat`
2. `Roo-Code`
3. `OpenDev`
4. `codex`
5. `openai-agents-js`
6. `mistral-vibe`
7. `openclaw`
8. `voltagent`
9. `OpenHands` V0
10. `aider`

### Prompt and tool-description quality

1. `vscode-copilot-chat`
2. `OpenDev`
3. `OpenHands` V0
4. `voltagent`
5. `Roo-Code`
6. `codex`
7. `mistral-vibe`
8. `openai-agents-js`
9. `openclaw`
10. `aider`

### Memory architecture

1. `openclaw`
2. `voltagent`
3. `codex`
4. `vscode-copilot-chat`
5. `OpenDev`
6. `Roo-Code`
7. `mistral-vibe`
8. `OpenHands` V0
9. `aider`
10. `openai-agents-js`

## Repo-by-Repo Analysis

## `aider`

### Technology

- Python
- chat-driven coder abstractions
- history summarization via internal summarizer
- `/help` retrieval built on LlamaIndex + HuggingFace embeddings

### Agent loop

```text
User
  -> Coder.run / run_one
  -> preprocess input
  -> send_message
  -> model reply / edit handling
  -> optional reflection retry
  -> turn ends
```

- Main loop lives in `aider/coders/base_coder.py`.
- `run_one()` repeats only if `reflected_message` is set.
- There is no general tool-execute-result loop.

### Tool use and completion

- No first-class tool registry.
- This is primarily a chat + edit-format orchestrator.
- Shell/test/lint behavior exists, but not as a generalized autonomous tool runtime.
- Completion is effectively "the model is done replying/editing for this user turn."

### Chat and session handling

- Strong terminal chat experience.
- User input, command handling, and chat history are the core UX.

### Skills and subagents

- No skills system.
- No subagents.

### MCP

- No MCP discovery or MCP tool invocation path.

### Tools and descriptor quality

- Not meaningful to score against the full agent runtimes here.
- The "tooling" is mostly edit modes and command helpers, not model-visible tools.

### Context and memory

- Session memory uses current and completed message buffers.
- Summarization is handled in `aider/history.py`.
- `/help` uses a vector index over aider website docs with HuggingFace embeddings.
- There is no durable user/repo memory substrate in the agent-runtime sense.

### Verdict

`aider` is effective at its actual goal: interactive code editing chat with disciplined file-edit formats and lightweight summarization. It is much narrower than the other repos in this comparison and should not be mistaken for a full agent runtime with tools, subagents, MCP, and memory layers.

### Improvements

- Add a real model-visible tool registry.
- Add an explicit delegated-task model.
- Separate doc retrieval from persistent task or repo memory.

## `Roo-Code`

### Technology

- TypeScript
- VS Code extension runtime
- explicit task orchestration
- MCP hub and code-index service

### Agent loop

```text
User
  -> Task.startTask / resumeTaskFromHistory
  -> recursivelyMakeClineRequests
  -> model
  -> native/MCP/custom tools
  -> tool results
  -> recurse
  -> attempt_completion
  -> user approval / TaskCompleted
```

- The loop is explicit and easy to follow.
- The central runtime sits in `src/core/task/Task.ts`.

### Tool use and completion

Native tool inventory:

- `access_mcp_resource` - fetches a resource exposed by a connected MCP server.
- `apply_diff` - applies targeted edits from search/replace style blocks.
- `apply_patch` - applies file-oriented patches and can create, delete, update, or rename files.
- `ask_followup_question` - asks the user a structured clarification question and can steer follow-up flow or mode changes.
- `attempt_completion` - explicitly tries to finish the task and present the final result.
- `codebase_search` - semantic code search over the workspace.
- `edit` - exact string replacement tool for files.
- `edit_file` - more resilient file edit/create tool with fallback matching strategies.
- `execute_command` - runs shell commands with working-directory and timeout control.
- `generate_image` - generates or edits images from prompts and optional source images.
- `list_files` - lists directory contents, optionally recursively.
- `new_task` - spawns a new child task in a specified mode.
- `read_command_output` - paginates or searches full output from truncated command results.
- `read_file` - reads file slices or anchored regions and can also handle non-text assets where supported.
- `run_slash_command` - executes predefined slash-command workflows.
- `skill` - loads a `SKILL.md` workflow into context.
- `search_replace` - performs a tightly-scoped search/replace with strong uniqueness/context requirements.
- `search_files` - regex search across files.
- `switch_mode` - requests a mode switch, typically with user approval.
- `update_todo_list` - replaces the task todo checklist.
- `write_to_file` - creates or overwrites files, creating directories when needed.

Plus:

- MCP tools
- custom tools
- mode-specific tools

Completion model:

- explicit `attempt_completion`
- blocked if tools failed in the current turn
- can be blocked by open todos depending on settings
- user feedback can reopen the loop

Descriptor quality:

- generally good
- strong on `attempt_completion`, `new_task`, `skill`, `read_file`
- less verbose than `vscode-copilot-chat`, but still effective

### Chat and session handling

- Strong VS Code webview and task/session plumbing.
- History and UI state are tied to task lifecycle.

### Skills and subagents

- Skills via `SKILL.md` and `SkillsManager`.
- Subagents via `new_task`.
- Parent-child task metadata is part of the architecture, not a side channel.

### MCP

- Global + project `.roo/mcp.json` support
- discovery of tools/resources/templates
- supports stdio, SSE, and streamable HTTP
- disabled tools and per-server config supported

### Context and memory

- Strong session history management
- condensation and truncation fallback
- code-index search uses embeddings for `codebase_search`
- history repair logic handles malformed or orphaned tool results
- weaker on durable long-term user/repo memory than `codex`, `openclaw`, or `vscode-copilot-chat`

### Verdict

`Roo-Code` is one of the strongest end-user coding assistants in the set. Its loop is explicit, completion is disciplined, MCP is real, and delegation is part of the same task model rather than a detached add-on. It is one of the easiest repos here to reason about and extend without breaking core loop invariants.

### Improvements

- Add a first-class durable memory layer.
- Make more tool descriptors as explicit as Copilot Chat's long-form tool guidance.
- Reduce overlap between file-edit tools where possible.

## `codex`

### Technology

- Rust core
- custom tool registry and orchestrator
- approvals and sandboxing system
- multi-agent runtime
- MCP, dynamic tools, app tools, and memory pipeline

### Agent loop

```text
User
  -> run_turn
  -> model
  -> built-in / MCP / app / dynamic / agent tools
  -> follow-up needed?
     -> yes: continue loop
     -> no: end turn
```

- Turn handling lives in `codex-rs/core/src/codex.rs`.
- The completion condition is implicit: no further follow-up work requested.

### Tool use and completion

Built-in tools include:

- `shell` - command-array shell execution when `shell_type=Default`.
- `shell_command` - string-based shell execution when `shell_type=ShellCommand`.
- `exec_command` - PTY-backed command execution that can return output or a live session id when `shell_type=UnifiedExec`.
- `write_stdin` - writes to an existing unified exec session and returns fresh output.
- code-mode `wait` - waits on a yielded code-mode cell.
- `container.exec` - compatibility alias routed to the shell handler.
- `local_shell` - compatibility alias routed to the active shell handler.
- `list_mcp_resources` - lists MCP resources across servers or on a specific server.
- `list_mcp_resource_templates` - lists MCP resource templates.
- `read_mcp_resource` - reads a concrete MCP resource by server and URI.
- `update_plan` - structured plan/checklist update tool.
- `js_repl` - persistent Node.js kernel with top-level await when JS REPL support is enabled.
- `js_repl_reset` - resets the JS REPL kernel.
- `request_user_input` - asks one to three structured multiple-choice questions when the collaboration mode allows it.
- `request_permissions` - asks the user to grant additional filesystem or network permissions.
- `tool_search` - client-side search over available app tools when search-tool support is enabled.
- `tool_suggest` - suggests discoverable tools/plugins when discoverable tool metadata is available.
- `apply_patch` - patch application tool that can be exposed as a freeform or JSON-style tool depending on config.
- `list_dir` - absolute-path directory listing when the experimental `list_dir` surface is enabled.
- `view_image` - loads a local image into the model context.
- `spawn_agent` - creates a sub-agent, optionally with a canonical task name.
- `send_message` - adds a message to an existing agent without forcing a new turn.
- `assign_task` - adds a message and triggers work in the target agent.
- `wait_agent` - waits for one or more agents to reach a final status.
- `close_agent` - closes an agent and any open descendants.
- `list_agents` - lists live agents visible in the current root thread tree.
- `send_input` - legacy message/input tool for existing agents.
- `resume_agent` - reopens a previously closed legacy agent.
- `spawn_agents_on_csv` - fans out a CSV-backed batch job to worker agents.
- `report_agent_job_result` - worker-only result-reporting tool for CSV jobs.

Plus:

- hosted web search
- image generation
- code mode tool
- MCP-discovered tools
- connector/app tools
- persisted dynamic tools

Descriptor quality:

- generally strong
- especially good for `spawn_agent`, `request_user_input`, `tool_search`, and MCP resource tools
- less uniform than `vscode-copilot-chat`

### Chat and session handling

- Strong session model and persistent history
- collaboration modes influence prompt and tool surface
- multi-agent communication is first-class

### Skills and subagents

- Skills are first-class, but not as a direct "skill" tool
- `SKILL.md` roots are discovered and injected through the skills pipeline
- Subagents are first-class with multiple generations of tools supported

### MCP

- MCP tools
- MCP resources
- MCP resource templates
- dynamic app/connector loading
- tool discovery and suggestion support

This is one of the strongest MCP integrations in the comparison.

### Context and memory

- persistent append-only history
- byte-capped trimming
- auto-compaction
- startup memories pipeline
- phase 1 rollout extraction
- phase 2 global consolidation
- filesystem memory artifacts like `raw_memories.md` and rollout summaries

This is a strong persistent memory design, but it is not primarily vector-memory-driven.

### Verdict

`codex` is the most extensible system in the set. It behaves like both a product and a runtime platform: broad tool surfaces, central approvals, strong subagents, and an unusually serious memory pipeline. Its main tradeoff versus Roo/OpenDev/Copilot Chat is that completion is more implicit and the total behavior surface is more configuration-sensitive.

### Improvements

- Add an optional explicit completion tool or completion policy.
- Add more first-class semantic retrieval or vector-memory support.
- Normalize descriptor quality across all built-in tools.

## `mistral-vibe`

### Technology

- Python
- Pydantic tool schemas
- middleware-based agent loop
- Mistral web capabilities
- local tool discovery plus MCP proxies

### Agent loop

```text
User
  -> middleware checks
  -> LLM turn
  -> parse tool calls
  -> execute tools concurrently
  -> append tool results
  -> if latest role == tool, continue
  -> else stop
```

- The loop in `vibe/core/agent_loop.py` is simple and explicit.
- Middleware handles turn limits, price limits, compaction, and related concerns.

### Tool use and completion

Built-in tools:

- `ask_user_question`
- `bash`
- `exit_plan_mode`
- `grep`
- `read_file`
- `search_replace`
- `skill`
- `task`
- `todo`
- `webfetch`
- `websearch`
- `write_file`

Completion model:

- implicit
- loop stops when latest history item is not a tool result
- no dedicated finalization tool

Descriptor quality:

- concise and serviceable
- more dependent on system prompt + middleware than on very rich per-tool guidance

### Chat and session handling

- Interactive UI hooks are built in.
- Tool UI data and user-input callbacks are first-class.

### Skills and subagents

- Skills via `skill` tool and `SkillManager`
- Subagents via `task` tool
- Plan mode has an explicit exit mechanism

### MCP

- Tool manager discovers local tools from search paths
- MCP registry synthesizes MCP tools into the runtime
- supports multiple transports

### Context and memory

- per-session logs
- history cleanup for tool/message consistency
- auto-compaction middleware
- no strong built-in durable semantic memory or embeddings layer in core runtime

### Verdict

`mistral-vibe` is a clean mid-weight agent runtime. It has a readable loop, practical built-ins, MCP, skills, and subagents, but it is less hardened than the strongest repos on completion semantics, descriptor richness, and long-term memory design.

### Improvements

- Add durable memory and retrieval beyond compaction.
- Make completion policy more explicit.
- Strengthen tool descriptors for higher-ambiguity tools.

## `OpenHands`

### Technology

- Python
- LiteLLM tool schema usage in V0
- controller/action/event architecture
- BrowserGym browser tool
- MCP proxy utilities

### Agent loop

```text
User
  -> AgentController
  -> CodeActAgent.step
  -> build messages + tools
  -> LLM
  -> parse actions
  -> execute action
  -> observation
  -> repeat until finish / stop condition
```

- Local loop is in legacy V0 code under `openhands/agenthub/codeact_agent`.
- Controller stop conditions include finish, max iterations, budget, error, and `/exit`.

### Tool use and completion

V0 built-in tools inspected:

- `execute_bash`
- `think`
- `finish`
- `request_condensation`
- `browser`
- `execute_ipython_cell`
- `task_tracker`
- `str_replace_editor`
- `edit_file`
- dynamic MCP tools

Completion model:

- explicit `FinishTool`
- controller also enforces non-tool stop conditions

Descriptor quality:

- strong in local V0
- `bash`, `str_replace_editor`, `browser`, and `task_tracker` are unusually explicit and instructive

### Chat and session handling

- Strong event/controller model in the local assistant runtime.
- Controller coordinates actions, observations, and state updates.

### Skills and subagents

- Local checkout still reflects V0 microagent / delegate concepts.
- Skills story is split because current V1 moved to the external SDK.

### MCP

- MCP tool metadata is converted into chat tool definitions
- stdio and HTTP clients supported in local paths

### Context and memory

- short-term conversation memory with condensation
- no strong durable semantic memory in the local V0 runtime

### Verdict

The local checked-out `OpenHands` agent core is solid legacy code, especially on tool prompting, but it is not the current architecture. The repo itself points to the V1 `software-agent-sdk` as the current agentic core, so this local comparison should be read as a comparison of legacy OpenHands V0 behavior plus a note about current V1 direction.

### Improvements

- Make the V0/V1 split much clearer in repo docs.
- Centralize current skill, tool, and memory docs around V1.
- Add stronger persistent memory in the main product story.

## `openclaw`

### Technology

- TypeScript platform/runtime
- gateway + session lanes
- embedded `pi-agent-core` execution
- plugin system
- strong memory plugin model

### Agent loop

```text
Inbound message
  -> gateway / session lane
  -> runEmbeddedPiAgent
  -> pi-agent-core
  -> stream assistant + tools
  -> persist session
  -> lifecycle end/error
```

- The real agent loop is documented in `docs/concepts/agent-loop.md`.
- It is more of a platform execution lifecycle than a small explicit coding-agent loop.

### Tool use and completion

Core tool catalog includes:

- `read`
- `write`
- `edit`
- `apply_patch`
- `exec`
- `process`
- `web_search`
- `web_fetch`
- `memory_search`
- `memory_get`
- `sessions_list`
- `sessions_history`
- `sessions_send`
- `sessions_spawn`
- `sessions_yield`
- `subagents`
- `session_status`
- `browser`
- `canvas`
- `message`
- `cron`
- `gateway`
- `nodes`
- `agents_list`
- `image`
- `image_generate`
- `tts`

Additional first-class tools in the codebase include:

- `pdf`
- plugin and bundle MCP tools
- channel and gateway related tools

Completion model:

- lifecycle end/error driven
- not centered around a single mandatory finish tool

Descriptor quality:

- catalog-level descriptions are short
- individual tools often carry richer schemas or descriptions
- less uniform than Roo/OpenDev/Copilot Chat

### Chat and session handling

- very strong session/lifecycle architecture
- serialized runs per session
- event streams for lifecycle, assistant, and tool output

### Skills and subagents

- skills are per-agent `skills/` folders plus shared skill roots
- the system prompt tells the model to read `SKILL.md` when relevant
- subagents are first-class via session spawning and management tools

### MCP

- MCP integration is plugin and bundle friendly
- MCP can be surfaced as agent tools through the platform

### Context and memory

- strongest memory breadth in this set
- markdown memory files as source of truth
- vector search and hybrid search
- multiple embedding providers
- MMR and temporal ranking options
- pre-compaction memory flush reminder

### Verdict

`openclaw` is the most ambitious platform here. It is exceptional on memory, plugin architecture, and agent isolation, but it is less straightforward than Roo/OpenDev/Copilot Chat when the specific goal is "understand the coding assistant loop quickly."

### Improvements

- Ship a simpler canonical coding-assistant profile.
- Improve catalog-level tool descriptions.
- Expose a clearer assistant-facing completion contract.

## `openai-agents-js`

### Technology

- TypeScript
- OpenAI Agents SDK
- zod and JSON-schema-based tool definitions
- handoffs, sessions, MCP, guardrails

### Agent loop

```text
Runner.run
  -> resolve turn
  -> tools / handoffs / interruptions
  -> next step:
     -> final output
     -> handoff
     -> interruption
     -> run again
```

- The framework uses an explicit runner state machine.
- This is one of the cleanest orchestration designs in the comparison.

### Tool use and completion

Default framework tool surfaces include:

- generic `tool(...)` function tools
- `computer_use_preview`
- `shell`
- `apply_patch`
- `hosted_mcp`
- handoff tools named `transfer_to_<agent>`
- agent-as-tool through `Agent.asTool(...)`
- MCP-converted tools via `mcpToFunctionTool(...)`

Completion model:

- explicit runner state machine
- final output only when no more handoffs, tools, or interruptions require follow-up

Descriptor quality:

- clean but framework-oriented
- MCP descriptors preserve server-provided descriptions
- less opinionated than product repos

### Chat and session handling

- no end-user chat shell
- the integrator owns UX, persistence choice, and surrounding prompt policy

### Skills and subagents

- no built-in skills concept
- handoffs are first-class
- agent composition is a core pattern

### MCP

- strong MCP server abstractions
- server lifecycle management through `MCPServers`
- MCP resource APIs and MCP tool conversion are first-class

### Context and memory

- pluggable `Session` interface
- `MemorySession`
- `OpenAIConversationsSession`
- `OpenAIResponsesCompactionSession`
- resumable runs and approvals integrate cleanly with sessions

This is strong session memory, but not a full opinionated long-term memory system.

### Verdict

`openai-agents-js` is an excellent orchestration framework. It has cleaner state transitions than many finished assistants, but by design it leaves product-level concerns like assistant personality, long-term memory policy, and canonical tool prompts to the integrator.

### Improvements

- Provide a canonical coding-assistant reference composition.
- Offer stronger default tool description templates.
- Publish a first-party long-term memory recipe beyond session persistence.

## `voltagent`

### Technology

- TypeScript
- Vercel AI SDK
- modular toolkits
- storage / vector / embedding adapters
- MCP registry and examples

### Agent loop

```text
App or example
  -> VoltAgent
  -> AI SDK step loop
  -> tools / MCP / subagents / memory
  -> stopWhen or maxSteps
  -> finish
```

- VoltAgent delegates a large part of turn stepping to the AI SDK.
- This makes it flexible, but less explicit than the hand-written loops in Roo/OpenDev/Copilot Chat.

### Tool use and completion

If the shipped pieces are composed into one coding assistant, key tools include:

- `get_working_memory` - returns the current working-memory content.
- `update_working_memory` - appends to or replaces working memory.
- `clear_working_memory` - clears working memory.
- `workspace_list_skills` - lists available workspace skills.
- `workspace_search_skills` - searches skill metadata/content.
- `workspace_read_skill` - reads the main skill definition.
- `workspace_activate_skill` - marks a skill active for the current assistant context.
- `workspace_deactivate_skill` - removes an active skill from the current assistant context.
- `workspace_read_skill_reference` - reads a skill reference file.
- `workspace_read_skill_script` - reads a skill script implementation.
- `workspace_read_skill_asset` - reads a bundled skill asset.
- `workspace_index` - builds or refreshes workspace indexing metadata.
- `workspace_index_content` - indexes file content for workspace search.
- `workspace_search` - searches indexed workspace content.
- `delegate_task` - delegates work to one or more configured subagents and aggregates their results.

Plus:

- MCP-derived tools
- any additional toolkit tools added by the integrator

Completion model:

- AI SDK `stopWhen` or `maxSteps`
- less explicit than mandatory finish-tool systems

Descriptor quality:

- generally strong
- especially good on working memory and workspace skill tools

### Chat and session handling

- no single canonical product shell
- examples cover assistant UI, streaming, auth, memory APIs, and retrieval-backed apps

### Skills and subagents

- strong workspace skill toolkit
- `delegate_task` is first-class
- subagent manager exists in core

### MCP

- MCP registry and client abstractions are real
- examples demonstrate MCP-backed assistants

### Context and memory

- one of the strongest memory architectures here
- storage adapters
- embedding adapters
- vector adapters
- working memory
- semantic search
- managed memory package
- persistence queue and workflow state support

### Verdict

`voltagent` is a strong framework for building assistants, especially if memory and extensibility are priorities. It is less coherent as an out-of-the-box coding assistant than Roo/OpenDev/Copilot Chat because its "assistant" behavior is distributed across composable modules and examples rather than one canonical shipped runtime.

### Improvements

- Publish one official coding-assistant composition.
- Make completion semantics more explicit than default AI SDK stepping.
- Ship a stronger default prompt/tool-routing profile.

## `opendev`

### Technology

- Rust
- explicit ReAct loop
- tool registry
- MCP manager and bridge
- session manager
- separate advanced memory crate

### Agent loop

```text
User
  -> ReAct execution loop
  -> checks: interrupts / compaction / doom-loop
  -> model
  -> parse text + tool calls
  -> run tools / subagents
  -> continue
  -> task_complete
```

- The loop is explicit and robust.
- It includes protections that many assistants omit.

### Tool use and completion

Default built-ins:

- `bash` - executes shell commands with timeout, streaming output, background support, optional workdir, and audit descriptions.
- `read_file` - reads a file or lists directory entries, supports line ranges, and suggests similar names on misses.
- `write_file` - atomically writes or creates files.
- `edit_file` - edits files by replacing matched text with a fuzzy fallback chain.
- `multi_edit` - applies multiple sequential edits to one file atomically.
- `list_files` - lists files matching a glob, typically sorted by modification time.
- `grep` - regex search over files via ripgrep.
- `ast_grep` - structural code search using AST patterns.
- `patch` - applies unified or structured patches.
- `web_fetch` - fetches URL content and can normalize HTML for LLM use.
- `web_search` - web search over DuckDuckGo-style results.
- `web_screenshot` - captures a webpage screenshot, with fallback behavior if capture fails.
- `browser` - interactive browser automation.
- `open_browser` - opens a URL in the system browser.
- `ask_user` - asks the user a question and waits for the response.
- `memory` - reads, writes, or searches persistent memory files.
- `past_sessions` - browses prior project sessions.
- `message` - sends a message through configured channels/webhooks.
- `schedule` - creates, lists, or removes scheduled tasks.
- `notebook_edit` - edits Jupyter notebook cells.
- `task_complete` - explicit completion tool used to end the task.
- `vlm` - analyzes images with a vision-language model.
- `diff_preview` - generates a unified diff preview.
- `present_plan` - presents a completed plan file for approval.
- `write_todos` - replaces the entire todo list.
- `update_todo` - updates a todo item's title or status.
- `complete_todo` - marks a todo item complete.
- `list_todos` - lists todos.
- `clear_todos` - clears todos.
- `todo` - legacy aggregate todo tool kept for backward compatibility.
- `agents` - lists available subagent types and their allowed tools.

Dynamic / optional:

- `spawn_subagent`
- MCP bridge tools

Completion model:

- explicit `task_complete`
- mandatory for normal completion
- forced wind-down exists for max-iteration conditions

Descriptor quality:

- very strong
- tool descriptions are concrete and practical
- `task_complete`, `spawn_subagent`, `memory`, `browser`, and file tools stand out

### Chat and session handling

- persistent session management is strong
- transcript and metadata integrity are first-class concerns

### Skills and subagents

- subagents are real and can execute concurrently
- skill code exists, but the assistant-facing skill story is less central than in Roo/Codex/OpenClaw

### MCP

- strong MCP manager
- config merge and health/restart behaviors
- namespaced MCP bridge tools

### Context and memory

- default runtime includes persistent memory files and past-session search
- separate ACE memory crate includes:
  - embeddings
  - semantic session search
  - playbooks
  - summarizers
  - reflector/selector concepts

The ambitious memory substrate appears stronger than what the default assistant path fully exposes today.

### Verdict

`OpenDev` is one of the best explicit coding-agent runtimes in this comparison. It combines a readable ReAct loop, strong tool descriptions, and real subagent execution without turning into a framework-only skeleton.

### Improvements

- Surface more ACE memory capabilities into the default assistant runtime.
- Make the skill model more explicit to users and contributors.
- Reduce overlap between old and new todo/plan surfaces over time.

## `vscode-copilot-chat`

### Technology

- TypeScript
- VS Code extension platform
- language model tool contributions
- internal tool-calling loop
- VS Code MCP gateway integration

### Agent loop

```text
User
  -> ToolCallingLoop
  -> model
  -> built-in / MCP / subagent tools
  -> if no completion, inject continuation pressure
  -> stop hooks
  -> task complete
```

- The loop is reusable and strongly completion-aware.
- It nudges or blocks the model when it tries to stop incorrectly.

### Tool use and completion

Contributed model-visible tools:

- `copilot_searchCodebase`
- `execution_subagent`
- `search_subagent`
- `copilot_searchWorkspaceSymbols`
- `copilot_getVSCodeAPI`
- `copilot_findFiles`
- `copilot_findTextInFiles`
- `copilot_applyPatch`
- `copilot_readFile`
- `copilot_viewImage`
- `copilot_listDirectory`
- `copilot_getErrors`
- `copilot_readProjectStructure`
- `copilot_getChangedFiles`
- `copilot_testFailure`
- `copilot_createNewWorkspace`
- `copilot_getProjectSetupInfo`
- `copilot_installExtension`
- `copilot_runVscodeCommand`
- `copilot_createNewJupyterNotebook`
- `copilot_insertEdit`
- `copilot_createFile`
- `copilot_createDirectory`
- `copilot_replaceString`
- `copilot_multiReplaceString`
- `copilot_editNotebook`
- `copilot_runNotebookCell`
- `copilot_getNotebookSummary`
- `copilot_readNotebookCellOutput`
- `copilot_fetchWebPage`
- `copilot_findTestFiles`
- `copilot_getSearchResults`
- `copilot_githubRepo`
- `copilot_toolReplay`
- `copilot_switchAgent`
- `copilot_memory`
- `copilot_resolveMemoryFileUri`
- `copilot_editFiles`

Completion model:

- explicit internal completion gate
- loop can continue if the model stops without proper completion
- stop hooks can veto premature termination

Descriptor quality:

- strongest in the set
- many tools include detailed "when to use / when not to use" guidance
- tool descriptions carry a major share of prompt policy

### Chat and session handling

- product-grade transcript and session plumbing
- subagent trajectories and transcript linkage are treated as first-class product concerns

### Skills and subagents

- no `SKILL.md` model
- dedicated `search_subagent` and `execution_subagent`
- plan-mode switching also exists as a model-visible tool

### MCP

- uses VS Code MCP gateway
- integrated into product flow rather than exposed as a bare raw manager

### Context and memory

- transcript persistence
- summarized conversation history
- explicit memory tools with user/session/repo scopes
- optional cloud-backed repository memory integration

### Verdict

`vscode-copilot-chat` is the strongest shipped end-user assistant architecture in this group. It combines the best tool-descriptor quality, very strong completion discipline, and a mature product-level handling of sessions, subagents, and memory scopes.

### Improvements

- Reduce tool overlap among editing primitives.
- Document internal completion gating more plainly for contributors.
- Make repo-memory retrieval behavior more locally inspectable when cloud services are involved.

## Cross-Repo Takeaways

### Best explicit assistant loops

- `vscode-copilot-chat`
- `Roo-Code`
- `OpenDev`

These have the clearest completion contracts and best loop hardening.

### Best extensibility platforms

- `codex`
- `openclaw`
- `voltagent`
- `openai-agents-js`

These are best thought of as runtime foundations rather than only end-user assistants.

### Best memory architectures

- `openclaw` for breadth of memory features
- `voltagent` for adapter-driven memory architecture
- `codex` for persistent memory pipeline design
- `vscode-copilot-chat` for practical end-user memory scopes

### Best tool-descriptor strategy

- `vscode-copilot-chat` is the strongest example of pushing policy into tool descriptions.
- `OpenDev` is close behind and often more concise.
- `OpenHands` V0 has notably strong verbose tool descriptions.
- `mistral-vibe` and parts of `codex` rely more on the surrounding prompt/runtime context.

## Practical Recommendations

If the goal is to design an end-user coding assistant:

- borrow loop discipline from `vscode-copilot-chat`, `Roo-Code`, or `OpenDev`
- borrow extensibility and approvals from `codex`
- borrow memory breadth from `openclaw` or adapter design from `voltagent`
- borrow tool descriptor style from `vscode-copilot-chat`

If the goal is to build a reusable agent framework:

- `openai-agents-js` provides the cleanest orchestration state machine
- `voltagent` provides strong modular composition and memory adapters
- `codex` provides the most ambitious product-runtime hybrid

## External current-state sources used

These were used only to clarify current architecture where local code alone would have been misleading:

- OpenHands main repo: <https://github.com/OpenHands/OpenHands>
- OpenHands Software Agent SDK: <https://github.com/OpenHands/software-agent-sdk>
- OpenAI Agents SDK sessions guide: <https://openai.github.io/openai-agents-js/guides/sessions/>

## Appendix: Verified Tool Inventories

This appendix is the code-backed inventory requested for every compared repo. Treat it as authoritative whenever it is more specific than the earlier high-level tool lists in this document.

Inventory rules used here:

- fixed built-in: declared directly in the repo's default runtime or framework core
- config-gated: implemented in code, but only exposed when a feature, mode, or profile is enabled
- dynamic: names or availability depend on MCP servers, plugins, user-defined tools, or integrator composition

### `aider`

Authoritative sources: `aider/coders/editblock_func_coder.py`, `aider/coders/wholefile_func_coder.py`, `aider/coders/single_wholefile_func_coder.py`.

Function-style surfaces present in current code:

- `replace_lines` - deprecated multi-file edit-block function tool that replaces exact `original_lines` stretches with `updated_lines` and requires an `explanation` plus an `edits[]` array.
- `write_file` (multi-file) - deprecated whole-file function tool that creates or updates multiple files from a `files[]` payload and an `explanation`.
- `write_file` (single-file) - single-file whole-file write helper for the current file; defined but not active in the current main coder list.

Important note:

- Current modern aider primarily uses text edit formats rather than active model-visible function tools. The function coders above are historical/deprecated, and the main loop is still best understood as a chat-plus-edit-format system rather than a broad tool runtime.

### `Roo-Code`

Authoritative source: `src/core/prompts/tools/native-tools/index.ts` plus the referenced native tool implementations.

Fixed native tools:

- `access_mcp_resource` - fetches a resource exposed by a connected MCP server.
- `apply_diff` - applies targeted edits from search/replace style blocks.
- `apply_patch` - applies file-oriented patches and can create, delete, update, or rename files.
- `ask_followup_question` - asks the user a structured clarification question and can steer follow-up flow or mode changes.
- `attempt_completion` - explicitly tries to finish the task and present the final result.
- `codebase_search` - semantic code search over the workspace.
- `edit` - exact string replacement tool for files.
- `edit_file` - more resilient file edit/create tool with fallback matching strategies.
- `execute_command` - runs shell commands with working-directory and timeout control.
- `generate_image` - generates or edits images from prompts and optional source images.
- `list_files` - lists directory contents, optionally recursively.
- `new_task` - spawns a new child task in a specified mode.
- `read_command_output` - paginates or searches full output from truncated command results.
- `read_file` - reads file slices or anchored regions and can also handle non-text assets where supported.
- `run_slash_command` - executes predefined slash-command workflows.
- `skill` - loads a `SKILL.md` workflow into context.
- `search_replace` - performs a tightly-scoped search/replace with strong uniqueness/context requirements.
- `search_files` - regex search across files.
- `switch_mode` - requests a mode switch, typically with user approval.
- `update_todo_list` - replaces the task todo checklist.
- `write_to_file` - creates or overwrites files, creating directories when needed.

Dynamic surfaces:

- MCP server tools are discovered at runtime and are not part of the fixed native list.
- Custom tools and mode-specific tool filtering can add or remove tool availability from a given session.

### `codex`

Authoritative sources: `codex-rs/core/src/tools/spec.rs`, `router.rs`, `registry.rs`, and the handler modules under `tools/handlers/`.

Fixed or config-gated built-ins:

- `shell` - command-array shell execution when `shell_type=Default`.
- `shell_command` - string-based shell execution when `shell_type=ShellCommand`.
- `exec_command` - PTY-backed command execution that can return output or a live session id when `shell_type=UnifiedExec`.
- `write_stdin` - writes to an existing unified exec session and returns fresh output.
- `exec` - code-mode freeform execution tool when code mode is enabled.
- `wait` - waits on a yielded code-mode cell.
- `js_repl` - persistent Node.js kernel with top-level await when JS REPL support is enabled.
- `js_repl_reset` - resets the JS REPL kernel.
- `update_plan` - structured plan/checklist update tool.
- `request_user_input` - asks one to three structured multiple-choice questions when the collaboration mode allows it.
- `request_permissions` - asks the user to grant additional filesystem or network permissions.
- `apply_patch` - patch application tool; can be exposed as a freeform or JSON-style tool depending on config.
- `list_dir` - absolute-path directory listing when the experimental `list_dir` surface is enabled.
- `view_image` - loads a local image into the model context.
- `tool_search` - client-side search over available app tools when search-tool support is enabled.
- `tool_suggest` - suggests discoverable tools/plugins when discoverable tool metadata is available.
- `web_search` - built-in web search surface when web search is enabled.
- `image_generation` - built-in image generation surface when enabled.
- `list_mcp_resources` - lists MCP resources across servers or on a specific server.
- `list_mcp_resource_templates` - lists MCP resource templates.
- `read_mcp_resource` - reads a concrete MCP resource by server and URI.

Multi-agent v2 surfaces (`collab_tools=true` and `multi_agent_v2=true`):

- `spawn_agent` - creates a sub-agent, optionally with a canonical task name.
- `send_message` - adds a message to an existing agent without forcing a new turn.
- `assign_task` - adds a message and triggers work in the target agent.
- `wait_agent` - waits for one or more agents to reach a final status.
- `list_agents` - lists live agents visible in the current root thread tree.
- `close_agent` - closes an agent and any open descendants.

Multi-agent v1 surfaces (`collab_tools=true` and `multi_agent_v2=false`):

- `spawn_agent` - legacy spawn tool without the v2 task-name surface.
- `send_input` - legacy message/input tool for existing agents.
- `resume_agent` - reopens a previously closed legacy agent.
- `wait_agent` - legacy wait tool.
- `close_agent` - legacy close tool.

Agent-job surfaces:

- `spawn_agents_on_csv` - fans out a CSV-backed batch job to worker agents.
- `report_agent_job_result` - worker-only result-reporting tool for CSV jobs.

Dynamic and discoverable surfaces:

- Converted MCP tool names are injected per connected MCP server.
- Runtime `DynamicToolSpec` definitions can add more model-visible tools.
- App/connector tools are searchable through `tool_search` when present.

Compatibility handlers that are not generally model-visible specs:

- `local_shell` - alias routed to the active shell handler.
- `container.exec` - compatibility alias routed to the shell handler.

### `mistral-vibe`

Authoritative sources: `vibe/core/tools/builtins/`, `vibe/core/tools/base.py`, and `vibe/core/tools/manager.py`.

Canonical built-ins, using `BaseTool.get_name()` snake-case names:

- `ask_user_question` - asks one or more interactive questions and waits for the user's answers.
- `bash` - runs a one-off bash command and captures its output.
- `exit_plan_mode` - signals that planning is complete and asks the user whether to switch into implementation mode.
- `grep` - regex search over files using `rg` or `grep`, with ignore-pattern support.
- `read_file` - reads file content with offset/limit support and byte caps.
- `search_replace` - applies SEARCH/REPLACE blocks with fuzzy matching and error reporting.
- `skill` - loads a skill and injects its instructions and bundled assets into context.
- `task` - delegates a task to a subagent for independent execution.
- `todo` - reads or overwrites the todo list.
- `web_fetch` - fetches a URL and converts HTML to markdown when needed.
- `web_search` - uses Mistral's web-search capability for current information.
- `write_file` - creates or overwrites a UTF-8 file.

Dynamic surfaces:

- The tool manager also discovers tools from project paths, user paths, and configured tool paths.
- Configured MCP servers can inject additional runtime tools through the MCP registry.

### `OpenHands`

Authoritative sources: `openhands/events/serialization/action.py`, `openhands/events/action/*.py`, and `openhands/core/schema/action.py`.

This appendix inventories the local checked-out V0 action surface, which is legacy code.

Runnable task actions in the V0 action registry:

- `read` - reads file content, optionally over a specific line range.
- `write` - writes file content, optionally over a specific line range.
- `edit` - edits files either through LLM-style range edits or OH_ACI command-style file operations.
- `run` - executes shell commands.
- `run_ipython` - executes Python code in an IPython kernel.
- `browse` - opens a URL.
- `browse_interactive` - performs structured browser interactions.
- `call_tool_mcp` - invokes a dynamic MCP tool by name and arguments.

Controller and meta actions in the same local registry:

- `message` - sends a message to the user or UI.
- `think` - records agent reasoning.
- `finish` - declares task completion.
- `reject` - declares task rejection.
- `delegate` - delegates work to another agent.
- `recall` - retrieves content from workspace or memory sources.
- `change_agent_state` - notifies the client of a state transition.
- `condensation` - condenses prior history into a summary / forgotten-event set.
- `condensation_request` - requests condensation.
- `task_tracking` - views or updates the task list.
- `loop_recovery` - exposes loop-recovery options.
- `system` - emits system/session metadata.
- `null` - no-op placeholder action.

Important nuance:

- `ActionType` defines extra enum values such as `start`, `pause`, `resume`, `stop`, `push`, and `send_pr`, but those are not included in the inspected local V0 action-serialization registry and therefore are not part of the normal model-visible action surface in this checkout.

### `openclaw`

Authoritative sources: `src/agents/openclaw-tools.ts`, `src/agents/pi-tools.ts`, `src/agents/tool-catalog.ts`, and `src/agents/tools/memory-tool.ts`.

Coding/runtime tools:

- `read` - workspace-guarded file reads with truncation and image sanitization support.
- `write` - creates or overwrites workspace files.
- `edit` - performs precise file edits.
- `apply_patch` - applies patches inside the workspace for supported OpenAI model/config combinations.
- `exec` - shell execution with sandboxing, safe-bin policy, and approval hooks.
- `process` - manages background processes.

Web and memory tools:

- `web_search` - searches the web.
- `web_fetch` - fetches web content.
- `memory_search` - semantically searches `MEMORY.md` and `memory/*.md` for prior work or decisions.
- `memory_get` - reads a small snippet from a memory file.

Session and subagent tools:

- `sessions_list` - lists sessions.
- `sessions_history` - reads session history.
- `sessions_send` - sends a message to another session.
- `sessions_spawn` - spawns a sub-agent/session.
- `sessions_yield` - yields control so parent/session orchestration can continue.
- `subagents` - manages sub-agent lifecycle.
- `session_status` - reports current session state.

Platform and media tools:

- `browser` - browser automation.
- `canvas` - canvas/UI control.
- `message` - sends messages with channel/thread routing.
- `cron` - schedules tasks.
- `gateway` - gateway control / gateway-subagent entry surface.
- `nodes` - node/device discovery and invocation.
- `agents_list` - lists available agents.
- `image` - image understanding.
- `image_generate` - image generation.
- `tts` - text-to-speech conversion.
- `pdf` - PDF reading when the agent directory/context allows it.

Dynamic surfaces:

- Plugin tools can be appended at runtime.
- Bundle MCP tools and runtime-specific web tools can be injected.
- Channel agent tools are added from gateway/channel config.
- Profile, policy, sandbox, provider, and ownership filters can shrink the effective surface for a given run.

### `openai-agents-js`

Authoritative sources: `packages/agents-openai/src/tools.ts`, `packages/agents-core/src/tool.ts`, `packages/agents-core/src/agent.ts`, and the MCP conversion helpers.

Fixed hosted/OpenAI tool factories:

- `web_search` - hosted web search with location, domain-filter, and context-size options.
- `file_search` - vector-store-backed retrieval with ranking and filtering controls.
- `code_interpreter` - hosted code interpreter / container execution.
- `tool_search` - hosted deferred-tool loader.
- `image_generation` - hosted image generation.

Fixed framework-core tool factories:

- `computer_use_preview` - computer/desktop control tool.
- `shell` - local or hosted shell execution tool.
- `apply_patch` - editor-backed patch application tool.
- `hosted_mcp` - direct remote MCP/connector surface.

Generated and dynamic surfaces:

- `tool(...)` creates integrator-defined function tools with arbitrary names and descriptions.
- `Agent.asTool(...)` exposes an agent as a function tool with an arbitrary tool name.
- Handoffs generate `transfer_to_<agent>` function tools.
- `mcpToFunctionTool(...)` converts external MCP tools into function tools using server-provided names and schemas.

### `OpenDev`

Authoritative sources: `crates/opendev-cli/src/runtime/tools.rs`, `crates/opendev-cli/src/runtime/mod.rs`, `crates/opendev-cli/src/runtime/query.rs`, and `crates/opendev-tools-impl/src/*`.

Built-ins registered by the default runtime:

- `run_command` - executes shell commands with timeout, streaming output, background support, optional workdir, and audit descriptions.
- `read_file` - reads a file or lists directory entries, supports line ranges, and suggests similar names on misses.
- `write_file` - atomically writes or creates files.
- `edit_file` - edits files by replacing matched text with a fuzzy fallback chain.
- `multi_edit` - applies multiple sequential edits to one file atomically.
- `list_files` - lists files matching a glob, typically sorted by modification time.
- `grep` - regex search over files via ripgrep.
- `ast_grep` - structural code search using AST patterns.
- `patch` - applies unified or structured patches.
- `web_fetch` - fetches URL content and can normalize HTML for LLM use.
- `web_search` - web search over DuckDuckGo-style results.
- `web_screenshot` - captures a webpage screenshot, with fallback behavior if capture fails.
- `browser` - interactive browser automation.
- `open_browser` - opens a URL in the system browser.
- `ask_user` - asks the user a question and waits for the response.
- `memory` - reads, writes, or searches persistent memory files.
- `past_sessions` - browses prior project sessions.
- `message` - sends a message through configured channels/webhooks.
- `schedule` - creates, lists, or removes scheduled tasks.
- `notebook_edit` - edits Jupyter notebook cells.
- `task_complete` - explicit completion tool used to end the task.
- `vlm` - analyzes images with a vision-language model.
- `diff_preview` - generates a unified diff preview.
- `present_plan` - presents a completed plan file for approval.
- `write_todos` - replaces the entire todo list.
- `update_todo` - updates a todo item's title or status.
- `complete_todo` - marks a todo item complete.
- `list_todos` - lists todos.
- `clear_todos` - clears todos.
- `todo` - legacy aggregate todo tool kept for backward compatibility.
- `agents` - lists available subagent types and their allowed tools.

Additional runtime registrations performed after initial tool setup:

- `invoke_skill` - loads a named skill or lists available skills; intended for explicitly named skills, not general exploration.
- `spawn_subagent` - launches an isolated ReAct subagent for exploration, analysis, planning, and other bounded delegated tasks.

Dynamic surfaces:

- Connected MCP servers register bridge tools named like `mcp__<server>__<tool>` using server-provided descriptions.

Optional/non-default exported surfaces worth knowing about:

- `lsp_query` exists as an exported tool implementation for definitions, references, hover, and document symbols, but it is not part of the default registration path inspected here.

### `voltagent`

Authoritative sources: `packages/core/src/tool/reasoning/tools.ts`, `packages/core/src/agent/agent.ts`, `packages/core/src/agent/subagent/index.ts`, `packages/core/src/workspace/search/index.ts`, `packages/core/src/workspace/filesystem/index.ts`, `packages/core/src/workspace/sandbox/toolkit.ts`, and `packages/core/src/workspace/skills/index.ts`.

Framework-core reasoning tools:

- `think` - structured reasoning scratchpad for decomposing work and recording confidence/action hints.
- `analyze` - evaluates prior reasoning/tool output and decides whether to continue, validate, or finalize.

Auto-generated subagent surface:

- `delegate_task` - delegates work to one or more configured subagents and aggregates their results.

Auto-generated working-memory surface when memory support is present:

- `get_working_memory` - returns the current working-memory content.
- `update_working_memory` - appends to or replaces working memory.
- `clear_working_memory` - clears working memory.

Auto-generated workspace filesystem toolkit when a `Workspace` is attached and filesystem tools are enabled:

- `ls` - lists files and directories in a workspace directory.
- `read_file` - reads file content with optional offset/limit.
- `write_file` - writes file content.
- `edit_file` - exact-text file edit tool.
- `delete_file` - deletes a file or directory.
- `stat` - returns file/directory metadata.
- `mkdir` - creates a directory.
- `rmdir` - removes a directory.
- `list_tree` - recursive directory tree listing.
- `list_files` - alias-style recursive listing with the same basic behavior.
- `glob` - finds files by glob pattern.
- `grep` - regex search across workspace files.

Auto-generated workspace sandbox toolkit:

- `execute_command` - executes a command inside the configured workspace sandbox.

Auto-generated workspace search toolkit:

- `workspace_index` - indexes workspace files by path and optional glob.
- `workspace_index_content` - indexes raw content under a provided path key.
- `workspace_search` - searches indexed workspace content using BM25, vector, or hybrid search.

Auto-generated workspace skills toolkit:

- `workspace_list_skills` - lists available skills.
- `workspace_search_skills` - searches skill instructions.
- `workspace_read_skill` - reads a skill's main instructions.
- `workspace_activate_skill` - activates a skill.
- `workspace_deactivate_skill` - deactivates a skill.
- `workspace_read_skill_reference` - reads a skill reference file.
- `workspace_read_skill_script` - reads a skill script file.
- `workspace_read_skill_asset` - reads a skill asset file.

Dynamic surfaces:

- Additional AI SDK tools, MCP tools, toolkit tools, and integrator-defined tools can all be composed into an agent.
- Tool-routing helpers exist internally, but the stable model-visible surface is still determined by the agent's configured toolkits and attached tools.

### `vscode-copilot-chat`

Authoritative source: `package.json` `languageModelTools` contributions.

Search and exploration tools:

- `copilot_searchCodebase` - natural-language search for relevant code or comments in the workspace.
- `execution_subagent` - execution-focused subagent for running commands, tests, or installs.
- `search_subagent` - search-focused subagent for rapid codebase exploration.
- `copilot_searchWorkspaceSymbols` - language-service symbol search.
- `copilot_getVSCodeAPI` - VS Code extension API documentation lookup.
- `copilot_findFiles` - glob-based file search.
- `copilot_findTextInFiles` - exact or regex text search.
- `copilot_readFile` - line-range file reader.
- `copilot_viewImage` - image viewer for supported image formats.
- `copilot_listDirectory` - directory listing.
- `copilot_getErrors` - compile or lint errors.
- `copilot_readProjectStructure` - project tree overview.
- `copilot_getChangedFiles` - git changes and diffs.
- `copilot_testFailure` - test-failure context.

Editing and filesystem tools:

- `copilot_applyPatch` - V4A diff-style text file patching.
- `copilot_insertEdit` - inserts code into an existing file.
- `copilot_createFile` - creates a new file.
- `copilot_createDirectory` - creates a directory tree.
- `copilot_replaceString` - exact string replacement in a file.
- `copilot_multiReplaceString` - batch string replacements across files.
- `copilot_editFiles` - placeholder tool; current manifest explicitly marks it as not for use.

Project/setup tools:

- `copilot_createNewWorkspace` - scaffolds a new workspace/project.
- `copilot_getProjectSetupInfo` - returns setup guidance for a supported project type.
- `copilot_installExtension` - installs a VS Code extension during setup.
- `copilot_runVscodeCommand` - runs a VS Code command during setup.

Notebook tools:

- `copilot_createNewJupyterNotebook` - creates a new notebook.
- `copilot_editNotebook` - edits notebook cells.
- `copilot_runNotebookCell` - executes a code cell.
- `copilot_getNotebookSummary` - lists notebook cell ids and metadata.
- `copilot_readNotebookCellOutput` - reads stored or latest cell output.

Web, test, repo, and session tools:

- `copilot_fetchWebPage` - fetches and extracts relevant webpage content.
- `copilot_findTestFiles` - maps source files to tests and vice versa.
- `copilot_getSearchResults` - reads the current search-view results.
- `copilot_githubRepo` - searches a GitHub repo for relevant code snippets.
- `copilot_toolReplay` - replays a prior tool call; diagnostic-only and currently disabled in the manifest.
- `copilot_switchAgent` - switches to another chat agent mode.
- `copilot_memory` - manages user/session/repo memory scopes.
- `copilot_resolveMemoryFileUri` - resolves a memory file path to a URI.

Important note:

- This inventory is stricter than the earlier high-level summary. The manifest is the canonical model-visible tool surface, and several of the detailed `when to use / when not to use` behaviors live directly in those tool descriptions rather than only in prompts.
