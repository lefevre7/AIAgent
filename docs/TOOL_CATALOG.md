# Tool Catalog

Last updated: 2026-06-10

## Purpose

A deduped catalog of the LLM-callable **tools** exposed by sibling agent harnesses,
mapped against AIAgent's own tool registry. It is the reference for which tools
AIAgent should expose, which already exist, which were added, and which are
deliberately out of scope per the product boundaries in [`../AGENTS.md`](../AGENTS.md).

Sources surveyed (sibling repos under `AIAgents/`):
`aider`, `mistral-vibe`, `codex`, `opendev`, `OpenHands`, `openclaw`, `Roo-Code`,
`vscode-copilot-chat`, `openai-agents-js`, `voltagent`.

> Scope guardrails (from `AGENTS.md` "Product Boundaries"): no internal subagent
> runtime (external agents only via explicit adapters), no GitHub product
> integration, no editor/IDE-host-specific surface. Tools matching those are
> documented as **out of scope** rather than implemented.

## AIAgent canonical tools

| Family | Tools |
| --- | --- |
| Completion / meta | `attempt_complete`, `tool_search`, `think` |
| Plan / todo | `update_plan` |
| Files (read) | `read_file`, `list_files`, `search_paths` (alias `find_files`/`search_files`), `grep_files` |
| Files (write) | `write_file`, `append_file`, `edit_file` (atomic multi-edit), `apply_patch`, `diff_preview`, `undo_last_edit`, `undo_file_edit`, `notebook_edit` |
| Shell | `shell_command`, `exec_command`, `read_command_output`, `write_stdin`, `wait_command`, `kill_command`, `list_command_sessions` |
| Browser | `browser_open`, `browser_navigate`, `browser_click`, `browser_fill`, `browser_type`, `browser_select_option`, `browser_press_key`, `browser_snapshot`, `browser_screenshot`, `browser_list_pages`, `browser_close_page`, `browser_list_downloads`, `browser_upload_file`, `browser_wait` |
| Web research | `web_fetch`, `web_search` |
| Memory | `memory_search`, `memory_get`, `memory_status`, `memory_index`, `memory_write` |
| Voice | `voice_list_voices`, `voice_synthesize_text`, `voice_transcribe_audio` |
| Image | `image_generate` (text→image, image→image, inpaint) |
| External agents | `external_agent` (run/get/list/cancel/resume) |
| MCP | `mcp_search`, `mcp_read_resource`, `mcp_read_resource_template`, plus dynamic MCP server tools |

## Deduped capability matrix

Status legend: **Have** (already shipped) · **Added** (added in this pass) ·
**Covered** (an existing tool already satisfies it) · **Planned** (in scope, not yet
built — see notes) · **Out** (out of scope — rationale given).

| Capability | Seen in | AIAgent | Status |
| --- | --- | --- | --- |
| Read file | all | `read_file` | Have |
| Write / create file | all | `write_file`, `append_file` | Have |
| String/replace edit | all | `edit_file` | Have |
| Multiple atomic edits to one file | opendev, vscode | `edit_file` (`edits[]`) | Covered |
| Apply unified-diff patch | codex, openai, Roo, opendev, vscode, aider | `apply_patch` | Have |
| Diff preview | opendev | `diff_preview` | Have |
| Undo edit | aider | `undo_last_edit`, `undo_file_edit` | Have |
| List files / dir | all | `list_files` | Have |
| Find files by name / glob | Roo, vscode, opendev | `search_paths`, `list_files` | Covered |
| Grep / regex content search | all | `grep_files` | Have |
| Shell / bash exec | all | `shell_command`, `exec_command` | Have |
| Interactive/persistent shell (stdin, wait, kill) | codex | `exec_command`, `write_stdin`, `wait_command`, `kill_command`, `list_command_sessions` | Have |
| Read prior command output | Roo, vscode | `read_command_output` | Have |
| Web fetch (URL→markdown) | all | `web_fetch` | Have |
| Web search | all | `web_search` | Have |
| Browser automation | Roo, opendev, openclaw, OpenHands | `browser_*` | Have |
| Web screenshot | opendev | `browser_screenshot` | Covered |
| Image generation | codex, openai, Roo, openclaw | `image_generate` | Have |
| Memory read / write / search | aider, openclaw, opendev, vscode | `memory_*` | Have |
| Plan / todo management | all | `update_plan` | Have |
| Finish / attempt completion | all | `attempt_complete` | Have |
| Tool discovery / search | codex, openai, mistral-vibe, vscode | `tool_search` | Have |
| MCP tool use + resources | all | `mcp_*` + dynamic | Have |
| Voice TTS / STT | openclaw | `voice_*` | Have |
| Run external agent CLI | codex, mistral-vibe | `external_agent` | Have |
| **Think / reasoning scratchpad** | OpenHands | `think` | **Added** |
| **Edit notebook cells** | vscode, opendev | `notebook_edit` | **Added** |
| **Ask the operator a question** | codex, Roo, opendev, mistral-vibe | `ask_user_question` | **Added** |
| **View / analyze an image (vision)** | codex, openclaw, opendev, vscode | `view_image` | **Added** |
| **Search / browse past sessions** | openclaw, opendev | `sessions_search` | **Added** |
| **Send a message to a channel** | opendev, openclaw | `channel_send` | **Added** |
| **Analyze a PDF** | openclaw | `pdf_read` | **Added** |
| Structural (AST) search | opendev | — | Out (needs `ast-grep` binary) |
| LSP query (defs/refs/rename) | opendev | — | Out (needs language servers) |
| Code interpreter / JS REPL | codex, openai | `exec_command` (general) | Out (covered by shell; dedicated kernel deferred) |
| Schedule / cron jobs | openclaw, opendev | — | Out (no scheduler in MVP) |
| Internal subagent / spawn / handoff / agent-as-tool | codex, opendev, openclaw, openai, voltagent | `external_agent` | Out (product boundary: no internal subagent runtime) |
| Request OS/network permissions | codex | (approval policy) | Out (handled by the approval policy, not a model tool) |
| Switch mode / new task / slash command | Roo | — | Out (mode/IDE-specific) |
| VS Code API / commands / extensions / SCM | vscode | — | Out (not an IDE host) |
| GitHub repo integration | vscode | — | Out (product boundary: no GitHub product integration) |
| Gateway / nodes / canvas control | openclaw | (gateway is infra) | Out (owner-only infra, not a model tool) |

## Added in this pass

- **`think`** — record a reasoning/plan note with no side effects. Read-only,
  `approvalMode: never`. Mirrors OpenHands' `think`.
- **`notebook_edit`** — replace/insert/delete a Jupyter `.ipynb` cell by index.
  Normalizes source to nbformat line arrays and writes through the existing
  undoable `WorkspaceMutationEngine`, so notebook edits get diff + undo for free.
  `approvalMode: ask`, `sideEffects: ["workspace_write"]`.
- **`ask_user_question`** — ask the operator a question (optionally with suggested
  options) and pause until they answer. Implemented on the existing approval
  pause/resume machinery: `approvalMode: "always"` surfaces a `question`-kind
  approval whose justification is the question and whose metadata carries the
  options; the operator's resolution **comment is the answer**, threaded back into
  the resumed tool call so the result the model sees contains it. Works on every
  surface that can resolve an approval (CLI, web, gateway, SDK, channels).
- **`view_image`** — load a local image file as an `image` message artifact so a
  vision-capable model can see it. Read-only; the LM serializers already forward
  image parts as base64/data-urls, so no model-layer changes were needed.
- **`sessions_search`** — read-only tool over `FileSessionStore` that lists recent
  sessions or searches titles/goals/transcripts and returns summaries + snippets
  (wired via the new `sessions` option on `createDefaultToolRegistry`).
- **`channel_send`** — sends a message to the channel the current session is bound
  to (via `ChannelService.getRouteForSession` → `send`). `approvalMode: "ask"`,
  `sideEffects: ["channel_io"]`; fails clearly when the session has no bound channel.
- **`pdf_read`** — extract text from a local PDF (text-based; no OCR). Uses an
  injectable extractor defaulting to a lazily-imported `pdf-parse`; truncation,
  page count, `.pdf` guard, and clear errors on encrypted/corrupt files.

## Planned (in scope, not yet built)

All in-scope sibling capabilities are now implemented. Remaining capabilities are
the **Out** rows in the matrix above (out of scope per Product Boundaries) and
non-tool framework concerns (handoffs, RAG pipelines, workflow engines).

## Appendix: raw per-harness inventories

Condensed from source surveys; names are as the model sees them where possible.

- **aider** (edit-format, not formal tools): SEARCH/REPLACE blocks, unified-diff,
  patch, whole-file; `write_file`/`replace_lines` for function-calling models;
  advisory shell suggestions. User commands: `/add` `/drop` `/code` `/ask`
  `/architect` `/git` `/commit` `/diff` `/undo` `/lint` `/test` `/run` `/web` `/map`.
- **mistral-vibe** (13 tools): Bash, ReadFile, WriteFile, SearchReplace, Grep,
  WebFetch, WebSearch, AskUserQuestion, Skill, Task (subagent), Todo, ExitPlanMode, MCP.
- **codex**: exec_command, write_stdin, shell, shell_command, update_plan,
  apply_patch, view_image, js_repl/js_repl_reset, spawn_agent (+agent mgmt:
  send_input/assign_task/wait_agent/close_agent/list_agents…), request_user_input,
  request_permissions, tool_search, tool_suggest, list_dir, list/read MCP resources,
  web_search, image_generation, dynamic MCP tools.
- **opendev**: FileRead/Write/Edit/List, MultiEdit, NotebookEdit, Grep, AstGrep,
  LspQuery, WebSearch, Bash, AskUser, Message, Patch, DiffPreview, Vlm (vision),
  Browser, WebScreenshot, WebFetch, OpenBrowser, InsertBefore/AfterSymbol,
  PresentPlan, Todo suite, TaskComplete, SpawnSubagent, Agents, Memory,
  PastSessions, Schedule, InvokeSkill, CustomTool, McpBridge.
- **OpenHands** (~14 + MCP): execute_bash, execute_ipython_cell, str_replace_editor,
  edit_file, browser (15 actions), finish, think, request_condensation,
  task_tracker, view/glob/grep (read-only agent), search_repo/search_entity/
  explore_tree_structure (loc agent), MCP tools.
- **openclaw** (~22): agents_list, browser, canvas, cron, gateway, image (vision),
  image_generate, memory_get, memory_search, message, nodes, pdf, session_status,
  sessions_history, sessions_list, sessions_send, sessions_spawn, sessions_yield,
  subagents, tts, web_fetch, web_search.
- **Roo-Code** (~24): read_file, write_to_file, apply_diff, apply_patch, edit/
  search_replace, codebase_search, search_files, list_files, execute_command,
  read_command_output, generate_image, new_task, run_slash_command, skill,
  switch_mode, update_todo_list, ask_followup_question, attempt_completion,
  use_mcp_tool, access_mcp_resource.
- **vscode-copilot-chat** (~44): semantic_search, grep_search, read_file, view_image,
  insert_edit_into_file, create_file, replace_string_in_file, multi_replace…,
  apply_patch, file_search, list_dir, create_directory, run_in_terminal,
  get_terminal_output, manage_todo_list, tool_search, notebook tools (create/edit/
  run/summary/read output), get_errors, test_failure, run_task/get_task_output,
  fetch_webpage, memory, runSubagent/search_subagent/execution_subagent/switch_agent,
  plus VS Code/SCM/GitHub/extension tools.
- **openai-agents-js** (framework): hosted web_search, file_search, code_interpreter,
  image_generation, computer use, shell, apply_patch, hosted MCP; abstractions:
  function tools, agent-as-tool, handoffs, tool approval/guardrails, tool_search.
- **voltagent** (framework): workspace filesystem/search/sandbox/skills toolkits,
  function tools (Vercel AI SDK), MCP server support, tool manager, embedding-based
  tool routing, subagents/A2A, workflows, voice I/O, RAG components.
