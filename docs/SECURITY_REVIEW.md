# Security Review — 2026-07-09

Status: **partially remediated (2026-09-14, extended 2026-09-22, 2026-09-28, 2026-09-30 and 2026-10-13)** — see "Remediation status" below for what
landed; the rest of this document is the original audit record. This document is the
shared record of a full-repo defensive security audit. It exists so the remediation work (and any future
audit) starts from a written baseline instead of re-deriving everything.

Method: seven parallel focused reviews (auth/network, command execution, filesystem,
approvals policy, MCP/SSRF/browser, web/channels, secrets/config/deps), with the
highest-severity claims re-verified by hand (regex behavior executed, containment flags
grepped, data flows traced). Line references were accurate at time of writing; re-confirm
before editing.

## Remediation status (2026-09-14)

Fixed in this repo, each with regression tests:

| #   | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Where                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| H1  | Default rule patterns use single-escaped `\s`/`\b` again, so the destructive-command deny actually fires; the deny set was broadened into separate `rule.command.destructive.{rm,disk,system,permissions,forkbomb}.deny` rules (root/home/cwd/glob recursive deletes, `--no-preserve-root`, `mkfs`, `dd`/`shred` to `/dev`, redirects onto disk devices, shutdown/reboot/halt/poweroff as the command, recursive chmod/chown of `/`, fork bomb). The read-allow rule matches flagged commands like `ls -la` again. | `src/core/config/schema.ts`, `tests/unit/approval-defaults.test.ts`                                                    |
| H5  | `web_fetch` follows redirects manually and re-validates every hop against the public-host rules; hostnames are resolved and refused when any address is loopback/private/link-local/CGNAT/multicast (including IPv4-mapped IPv6); IPv6 literals are bracket-stripped so `[::1]` is caught. Redirect chains are capped (5).                                                                                                                                                                                         | `src/core/research/fetch.ts`, `tests/unit/research-fetch.test.ts`                                                      |
| H7  | Policy precedence is now deny-wins: every deny rule is evaluated on every target before any allow/ask rule, regardless of rule/target order. Allow vs ask still follows target order (specific `command`/`path` before generic `tool`).                                                                                                                                                                                                                                                                            | `src/core/approvals/policy.ts` (`RegexApprovalPolicy.evaluateTargets`), `tests/unit/approval-policy.test.ts`           |
| H8  | Patterns are validated at parse time and at policy construction (max 512 chars, must compile, no quantified group containing a quantifier), compiled once and cached, and model-controlled values longer than 8,192 chars are matched on their prefix with `allow` downgraded to `ask`.                                                                                                                                                                                                                            | `src/core/contracts/approvals.ts` (`validateApprovalPattern`, `approvalPatternSchema`), `src/core/approvals/policy.ts` |
| H9  | Path targets are canonicalized with the same `resolveLocalPath` the file tools use (`file://`, `~`, relative, `..`) against the session cwd before matching, `file://` values are included, and path rules match case-insensitively on macOS/Windows.                                                                                                                                                                                                                                                              | `src/core/approvals/policy.ts` (`extractApprovalTargets` + `cwd` option), `tests/unit/approval-policy.test.ts`         |
| M6  | `exec_command` argv is appended to the `command` target (`git push --force 'my branch'`) so command allow/deny rules see the whole command line.                                                                                                                                                                                                                                                                                                                                                                   | `src/core/approvals/policy.ts` (`stringifyArgv`)                                                                       |

Fixed in the 2026-09-22 pass, each with regression tests:

| #   | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Where                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H2  | `X-Forwarded-For` is no longer consulted for its value; the peer address comes from the socket only, on both the gateway and the control-plane/web path. The header is client-supplied, so trusting it let any remote caller present `X-Forwarded-For: 127.0.0.1` and be treated as loopback. Forwarding headers still count against a request: an untokened request that carries one is refused, because a local proxy or tunnel relays remote clients over the loopback socket.                                                                                                                                     | `src/gateway/auth.ts`, `src/server/web-access.ts`, `tests/unit/gateway-auth.test.ts`                                                                                            |
| M13 | `assertGatewayExposureIsAuthenticated` now **refuses to start** an untokened gateway whenever the bind host is routable or unspecified (`0.0.0.0`/`::`), or a tunnel is enabled. This was previously only a warning, so the insecure configuration still came up and served traffic. It also closes the case header handling cannot: a tunnel terminating in front of us forwards to the loopback socket, so remote traffic _is_ genuinely loopback by the time we see it.                                                                                                                                            | `src/gateway/auth.ts`, `src/server/start.ts`                                                                                                                                    |
| H3  | Workspace configs must be explicitly trusted before their `exec`/`file` secret providers are honoured. Trust is keyed on the config file's path **and** the SHA-256 of its exact contents, recorded in `~/.aia/trust.json` (never in the workspace — a record stored there could be shipped pre-populated). Editing a trusted file revokes trust. Untrusted providers are withheld with an `AIA_UNTRUSTED_CONFIG` warning and the load continues; only a config value that actually _references_ one fails. `aia trust` shows what trusting would allow; `--grant` (or a y/N at a terminal) and `--revoke` change it. | `src/core/config/trust.ts`, `src/core/config/load.ts`, `src/core/config/secrets.ts`, `src/cli.ts`, `tests/unit/config-trust.test.ts`, `tests/integration/config-loader.test.ts` |
| H4  | The `command` approval target now renders the **full resolved argv**, including the model-supplied `args`, using the same `stringifyArgv` the M6 fix introduced. A model could previously pass `--dangerously-bypass-approvals-and-sandbox` while the operator saw only "run codex", and no deny rule written against the command line could match.                                                                                                                                                                                                                                                                   | `src/core/external-agents/service.ts`, `src/core/approvals/policy.ts`, `tests/integration/external-agent-tool.test.ts`                                                          |
| H6  | Channel control commands (`/approve`, `/deny`, `/cancel`, `/steer`) are refused unless the sender is listed in `channels.<kind>.operatorIdentities`. **Fails closed**: an empty allowlist authorizes nobody. The refusal names the setting, because the likeliest reader is an operator who has not configured it yet. Parsing and authorization were extracted into `src/gateway/channel-commands.ts` so the rule lives next to the parser it guards.                                                                                                                                                                | `src/gateway/channel-commands.ts`, `src/gateway/runtime.ts`, `src/core/config/schema.ts`, `tests/unit/channel-commands.test.ts`, `tests/integration/whatsapp-channel.test.ts`   |

Fixed in the 2026-09-28 pass (found by live testing), each with regression tests:

| #        | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Where                                                                                                                                                                          |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M1       | Without a token, a request that sends `Origin` must come from a loopback origin on the same port, so a form on another site can no longer post to `/api/control-plane` (create a session, resolve an approval, steer). With a token, the access cookie is `SameSite=Lax` and a cross-site POST never carries it.                                                                                                                                                                                                                                                                              | `src/gateway/auth.ts` (`checkTokenlessBrowserAccess`), `src/server/web-access.ts`, `tests/unit/web-access.test.ts`                                                             |
| (new)    | Cross-site WebSocket and DNS rebinding on the dev/prod server. Without a token, any loopback connection was accepted, and a page on another site opens its WebSocket from loopback; demonstrated live reading a local file through the gateway. Tokenless requests must now name this machine in `Host` and, when they send `Origin`, come from this server's own page, on the WebSocket, the gateway HTTP API, the control plane and the pages.                                                                                                                                              | `src/gateway/auth.ts`, `src/server/web-access.ts`, `tests/integration/gateway-websocket-server.test.ts`, `tests/unit/gateway-auth.test.ts`                                     |
| (new)    | Every non-gateway WebSocket upgrade was handed to Next unauthenticated (to its empty production handler, so unknown paths also hung). `/_next/` upgrades now get the page access check and a refused one is closed before Next's own listener sees it; any other path gets `404`.                                                                                                                                                                                                                                                                                                             | `src/gateway/websocket.ts`, `src/server/start.ts`                                                                                                                              |
| Critical | Compound shell commands skipped the approval gate: an allow rule matched the start of the line, so the read-only rule approved `ls; curl … \| sh`. Each command in a line (`;`, `&&`, `\|\|`, `\|`, `&`, newlines) is now matched on its own and all must be allowed; `$(…)`, backticks, process substitution and file-writing redirects never auto-allow; deny rules see each command too. The shipped read rule now asks for `sed -i`/`-f` or a sed script that writes or runs commands, `find -exec/-execdir/-ok/-okdir/-delete/-fprint*`, `rg --pre`, and `git diff --ext-diff/--output`. | `src/core/approvals/shell-command.ts`, `src/core/approvals/policy.ts`, `src/core/config/schema.ts`, `tests/unit/shell-command.test.ts`, `tests/unit/approval-defaults.test.ts` |
| (new)    | Approval prompts showed only the deciding target, so "Write File → write_file" never said which file, and `a` approved every write. Requests now carry every evaluated target (`metadata.evaluatedTargets`), which the CLI and the dashboard list, and `a` says what it covers.                                                                                                                                                                                                                                                                                                               | `src/core/approvals/policy.ts`, `src/core/contracts/approvals.ts`, `src/cli.ts`, `src/web/home-page.tsx`                                                                       |
| (new)    | `browser_upload_file` resolved relative paths against the server's own directory while the approval resolved them against the session's, so the file approved and the file uploaded could differ.                                                                                                                                                                                                                                                                                                                                                                                             | `src/core/tools/builtins/browser.ts`, `tests/integration/browser-tools.test.ts`                                                                                                |
| (new)    | An interactive external agent's `send` typed into whatever was on screen; a Codex update screen accepted "Update now" and ran `brew upgrade`. `send` now refuses while a consent or menu screen shows, and until the agent's named input prompt shows.                                                                                                                                                                                                                                                                                                                                        | `src/core/external-agents/sessions.ts`, `tests/integration/external-agent-sessions.test.ts`                                                                                    |

Fixed in the 2026-09-30 MCP-hardening pass, each with regression tests:

| #     | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Where                                                                                                                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M11   | A workspace config's MCP entries (`mcp.servers`, `mcp.imports`, `mcp.templates`) now need the same content-hash trust as its `exec`/`file` providers. An untrusted workspace layer is merged **without** them, so it can neither start a server (a stdio command ran the moment `aia` started) nor rewrite one from the user-global config (its command, url, or `trust`). Withheld servers are reported with state `untrusted` in `/mcp` and `mcp_status`, `aia trust` lists what trusting would run, and the REPL asks at a terminal before anything starts. Because the config watcher re-loads through the same gate, a model that edits `aia.config.jsonc` revokes the file's trust instead of gaining process execution. aia's own edits (`installTemplate`) keep trust only when the file was already the operator's. The URL half (any scheme was accepted) was closed in the 2026-10-13 pass below. | `src/core/config/trust.ts`, `src/core/config/load.ts`, `src/core/mcp/manager.ts`, `src/cli.ts`, `tests/integration/config-loader.test.ts`, `tests/integration/gateway-runtime-startup.test.ts`, `tests/e2e/cli.spec.ts` |
| (new) | `web_search` had `approvalMode: "never"` and ran **any** connected MCP tool with a `query`-like string field, with no approval and no deny rule. It is now approved exactly as a direct call to the MCP tool it selects (trusted server or allow rule runs it, otherwise it asks, deny always wins), and the approved tool is pinned on the call (`approvalBinding`) so an approval resolved after the catalog changed cannot run a different tool.                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `src/core/tools/builtins/web-search.ts`, `src/core/research/search.ts`, `src/core/tools/runtime.ts`, `tests/integration/web-tools.test.ts`                                                                              |
| (new) | `approvalMode: "never"` returned before the policy ran, so an operator deny rule on an MCP server did not reach `mcp_read_resource`/`mcp_read_resource_template`. Tools that act through a server now declare an approval scope; never-mode tools still never ask, but a deny rule on their targets refuses them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `src/core/approvals/policy.ts`, `src/core/tools/builtins/mcp-read-resource*.ts`, `tests/unit/approval-policy.test.ts`                                                                                                   |
| H3    | The workspace config was parsed from one read and fingerprinted from another, so a file changed in between could be trusted for contents that were never parsed. The loader now hashes the exact text it parsed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `src/core/config/jsonc.ts`, `src/core/config/load.ts`, `tests/unit/config-trust.test.ts`                                                                                                                                |

Agent Skills (added in the same pass, docs/SKILLS.md) were built against this threat
model rather than fixed after it:

- A skill is instructions, like `AGENTS.md`: both load from an untrusted checkout, since
  reading them runs nothing, and everything a skill leads the model to do goes through
  normal approval. Config trust keeps gating what runs code (exec secret providers, MCP
  servers).
- `allowed-tools` in a SKILL.md is recorded and never approves anything (Claude Code
  treats it as pre-approval; a cloned repository must not be able to grant itself tools).
- Project discovery follows a symlinked directory only when it stays inside the project,
  and never reads a symlinked `SKILL.md`, so a repository cannot aim the scan or the
  `skill` tool's file listing at the operator's home. Scans are bounded (depth 6, 2,000
  directories, 20,000 entries per root; 1 MiB per file).
- `$name` mentions load a skill only from the operator's own messages. A channel message
  counts only when its sender is in the channel's `operatorIdentities`, which the gateway
  records on the message after the adapter's metadata (so a sender cannot claim it), so a
  third party in a Discord server cannot start a `disable-model-invocation` skill such as
  a deploy.
- A project skill that shadows one of the operator's own is reported as a warning.

The MCP-robustness work of the same pass (docs/MCP.md) closed one more gap and added
the rest with these properties:

- **(new, fixed)** HTTP MCP transports followed redirects automatically. Node's fetch drops
  `Authorization`, `Proxy-Authorization`, and `Cookie` on a cross-origin redirect, but no other header, so a
  custom credential header (an `x-api-key` from config) was forwarded to wherever a server redirected. Redirects
  are now followed by hand, same origin only (no https→http downgrade), at most 10
  (`createMcpFetch`, `src/core/mcp/http.ts`).
- `mcp.passEnv` in a workspace config needs trust (`TRUST_GATED_MCP_KEYS`): it would hand the
  operator's environment variables to every stdio server, the user-global ones included.
  Stdio servers otherwise get only the base allowlist, `passEnv`, and `env`.
- OAuth tokens live in `~/.aia/mcp-credentials.json`: mode 0600, refused through a symlink
  or when not a regular file, keyed by server name and a hash of its URL (pointing a name at
  another URL does not hand over the tokens), and stored with the issuer SDK 1.31 stamps on
  them, so a refresh token is never presented to another authorization server. The login
  callback listens on 127.0.0.1 only, on a path derived from the server's URL, and the
  `state` must match. A running session never registers a client or opens a browser, and
  uses OAuth only for a server signed in or configured for it, never over a configured
  `Authorization` header.
- A server's mid-call question (elicitation) is declined at once when no one could answer it,
  is bounded by `mcp.elicitationTimeoutMs`, and is cancelled with the run. Over a channel it
  is answered through the existing operator-identity check on `/approve`.

Fixed in the 2026-10-13 review pass (a review of the uncommitted MCP, skills and provider work), each with regression tests:

| #     | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Where                                                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| (new) | A workspace `aia.approvals.jsonc` replaced the operator's settings wholesale (arrays replace on merge), so a cloned repo could drop the destructive-command deny rules and set `defaultMode: "allow"`. Its rules are now appended after the operator's, and untrusted only its deny and ask rules and a `defaultMode` at least as strict apply; allow rules and a looser default wait for `aia trust`, which covers both files.                                             | `src/core/config/trust.ts` (`evaluateApprovalsTextTrust`, `mergeWorkspaceApprovals`), `src/core/config/load.ts`, `src/cli.ts`    |
| (new) | An untrusted workspace config could still point model providers (`baseUrl`, `headers`, `apiKey`, `requestExtras`, `embeddingsBaseUrl`), image and voice providers, external agents, the gateway, the tunnel, channels, `skills.extraRoots` and `memory.extraPaths` wherever it liked, and copy any of the operator's environment variables into a setting with a `${NAME}` reference. All of these now wait for trust (`TRUST_GATED_SETTINGS`), and `aia trust` lists each. | `src/core/config/trust.ts` (`withoutTrustGatedEntries`), `src/core/config/secrets.ts`                                            |
| (new) | A `"__proto__"` key set an object's prototype while parsing, hiding what sat under it from the trust checks (which walk own keys) while Zod's record parsing still loaded it. Every config, approvals and import file now refuses `__proto__`, `constructor` and `prototype` keys.                                                                                                                                                                                          | `src/core/config/jsonc.ts`                                                                                                       |
| (new) | `mcp.imports` files were outside the trust fingerprint: editing an imported file after a grant started new servers. Imports are hashed into the grant, and `aia trust` lists the servers each one declares.                                                                                                                                                                                                                                                                 | `src/core/config/trust.ts` (`fingerprintWorkspaceConfigText`), `src/core/config/mcp-imports.ts`                                  |
| (new) | The trust prompt named a server's command but not its `env`, `passEnv`, `cwd`, headers or `trust: "trusted"`, and an empty `mcp.passEnv` (which replaces the operator's list) was not gated. The prompt shows each (values with secret-looking names hidden), and `mcp.passEnv` is gated whenever present.                                                                                                                                                                  | `src/cli.ts`, `src/core/config/trust.ts`                                                                                         |
| (new) | Trust was keyed on the resolved file, so a repository whose `aia.config.jsonc` was a symlink to a trusted file elsewhere inherited that grant while its relative paths resolved inside the repository. The key is now the real directory plus the file's own name.                                                                                                                                                                                                          | `src/core/config/trust.ts` (`canonicalConfigPath`)                                                                               |
| (new) | Names, URLs, arguments and messages from configs, SKILL.md files and MCP servers were printed raw, so an escape sequence could rewrite a trust prompt, disguise a link (OSC 8) or write the clipboard (OSC 52). One sanitizer renders control and bidi characters visibly on every surface that prints them: the trust prompts, `/mcp`, `aia mcp`, `/skills`, `aia skills list`, MCP questions and notices.                                                                 | `src/commands/io.ts` (`sanitizeForTerminal`), `src/cli.ts`, `src/commands/mcp.ts`, `src/commands/skills.ts`                      |
| (new) | Static MCP headers (an API key) went with every request through the transport's fetch, including OAuth discovery, registration and token requests to whichever authorization server the MCP server named. They now go only to the server's own origin.                                                                                                                                                                                                                      | `src/core/mcp/http.ts`                                                                                                           |
| (new) | `aia mcp login` opened whatever authorization URL a server returned (a `file:` or custom-scheme URL; on Windows `cmd /c start` reparsed `&`). Only http(s) URLs are opened, and Windows uses `rundll32 url.dll,FileProtocolHandler`.                                                                                                                                                                                                                                        | `src/commands/mcp.ts` (`browserCommandFor`)                                                                                      |
| (new) | An MCP form question with no fields (a confirmation) was accepted without asking. It is now an Accept/Decline question, and only an explicit yes accepts.                                                                                                                                                                                                                                                                                                                   | `src/gateway/elicitation.ts`                                                                                                     |
| (new) | A project skills root that was itself a symlink out of the project was scanned, and a workspace config's `skills.extraRoots` could name any folder. Project roots, and a trusted workspace config's extra roots, are searched only inside the project; every project skill that hides one of the operator's is a warning.                                                                                                                                                   | `src/core/skills/discovery.ts`                                                                                                   |
| (new) | A configured OAuth `clientSecret` was copied into `mcp-credentials.json`. Only the client id and the issuer it was bound to are stored.                                                                                                                                                                                                                                                                                                                                     | `src/core/mcp/oauth.ts`                                                                                                          |
| (new) | `web_search` lacked the `tool` target a direct call to its MCP tool carries, and `mcp_read_resource_template` the path target of the URI it expands to, so a `tool` or path deny rule could be stepped around.                                                                                                                                                                                                                                                              | `src/core/tools/builtins/web-search.ts`, `src/core/tools/builtins/mcp-read-resource-template.ts`, `src/core/approvals/policy.ts` |
| M11   | The URL half of M11: an MCP server `url` could have any scheme. Only http(s) is accepted, and plain http to another machine warns once (`AIA_MCP_INSECURE_URL`).                                                                                                                                                                                                                                                                                                            | `src/core/config/schema.ts`, `src/core/mcp/connection.ts`                                                                        |
| (new) | Model-provider requests followed redirects automatically (custom headers, and on a 307/308 the whole prompt, went to another origin), and fetch's invalid-header error printed the header's value. Redirects are followed within the origin only, and header values are redacted from errors.                                                                                                                                                                               | `src/core/io/http.ts`, `src/core/lm/http.ts`                                                                                     |
| (new) | A channel conversation could resolve another session's approval by its id, and an answer containing a dot (`/approve 3.5`) was taken for a request id. Approvals resolve only within their own conversation, and only an `approval.…` word is an id.                                                                                                                                                                                                                        | `src/gateway/runtime.ts`, `src/gateway/channel-commands.ts`                                                                      |
| (new) | Child processes got every `LC_*` variable (sshd forwards `LC_*` by default, a known carrier for other values); on Windows the allowlist matched case-sensitively, dropping `Path`; `passEnv` names were never checked. The locale categories are named, Windows names match in any case (with `SystemRoot`, `ComSpec`, `PATHEXT` and the profile directories on the floor), and every `passEnv` entry must be a variable name.                                              | `src/core/process/environment.ts`, `src/core/config/schema.ts`                                                                   |
| (new) | The rules a trusted MCP server adds were built once at startup, so a reload that withdrew its trust (a revoked workspace) kept auto-approving it. They now follow the MCP manager's reloads.                                                                                                                                                                                                                                                                                | `src/core/approvals/policy.ts` (`followMcpTrustRules`), `src/gateway/runtime.ts`                                                 |

Still open: M2–M5, M7–M10, M12, and the low-severity items. The Kotlin port
(`AIAgentCompact-Kotlin`) drops the gateway/web/channel/browser surfaces, which removes
M1–M3, M7–M10 from that codebase by construction.

**Behaviour changes an operator will notice:**

- An untokened gateway bound to anything but loopback, or with a tunnel enabled, now
  refuses to start instead of warning.
- A workspace config that declares an `exec` or `file` secret provider needs `aia trust`
  once before those providers work.
- Channel `/approve` and friends stop working until `operatorIdentities` is configured
  for that channel.
- A workspace `aia.approvals.jsonc` adds to your approval rules instead of replacing them;
  its allow rules and a looser `defaultMode` need `aia trust`.
- A workspace config's provider endpoints and headers, image and voice providers, external
  agents, gateway, tunnel, channels, skill roots, memory paths and `${NAME}` references need
  `aia trust`, like its MCP servers.
- Editing a file a trusted workspace config imports MCP servers from revokes the grant, and a
  symlinked workspace config needs a grant of its own.
- A config, approvals or import file with a `__proto__`, `constructor` or `prototype` key no
  longer loads, and an MCP server `url` must be http(s).

## Threat model (assumed, pending confirmation)

The findings are rated against a conservative posture:

1. The **driving model can be adversarial** (prompt injection via web/pdf/tool output, or a
   malicious local model). Anything the model can do without an operator prompt is
   "unauthenticated" from the model's side.
2. The **workspace/repo may be untrusted** (a coding agent is routinely pointed at cloned
   code). Files discovered by walking up from cwd are therefore attacker-influenceable.
3. **Remote/tunnel exposure is in scope** per `AGENTS.md` (items 20/23), so the network
   surface matters even though the default bind is loopback.

Several findings collapse to "not a problem" under a stricter trust model (single local
user, trusted repo, trusted model). Which posture is authoritative is the first open
question for the maintainer — see the end of this doc.

---

## Severity summary

| #   | Finding                                                                           | Class                  | Severity        | Approval-gated?                 |
| --- | --------------------------------------------------------------------------------- | ---------------------- | --------------- | ------------------------------- |
| H1  | Default destructive-command deny rule is inert (regex over-escaping)              | Policy fail-open       | High            | n/a                             |
| H2  | Loopback auth bypass via spoofable `X-Forwarded-For`                              | Auth bypass            | High            | n/a                             |
| H3  | Malicious-repo `aia.config.jsonc` → code execution on load (exec secret provider) | Config injection / RCE | High            | No                              |
| H4  | External-agent argument injection → sub-agent sandbox/approval bypass             | Argument injection     | High            | Prompt shown, but blind to args |
| H5  | `web_fetch` SSRF: redirects unre-validated + string-only private-host filter      | SSRF                   | High            | No                              |
| H6  | Channel `/approve` auto-resolves pending approvals with no sender identity check  | Access control         | High            | Defeats the gate                |
| H7  | Approval precedence is first-match-wins (allow can shadow deny)                   | Policy precedence      | High            | n/a                             |
| H8  | ReDoS via config/workspace approval patterns run on model strings                 | DoS                    | High            | n/a                             |
| H9  | Approval path check/exec mismatch (`file://`, `~`, `..`, relative)                | Normalization bypass   | High            | Defeats path denies             |
| M1  | CSRF on control-plane state-changing endpoints (no Origin/token check)            | CSRF                   | Medium          | n/a                             |
| M2  | Non-constant-time token comparison (timing attack)                                | Crypto                 | Medium          | n/a                             |
| M3  | Gateway token accepted via URL query string (log/referrer leak)                   | Secret leak            | Medium          | n/a                             |
| M4  | Arbitrary file read with NO approval (`/etc/passwd`, `~/.ssh/...`)                | Info disclosure        | Medium/High     | No                              |
| M5  | Arbitrary file write outside workspace (approval-gated, unconfined)               | Integrity              | Medium          | Ask                             |
| M6  | `exec_command` args invisible to command allowlist                                | Approval scope         | Medium          | Ask (bypassable)                |
| M7  | Unauthenticated channel webhook endpoint (no signature)                           | Missing auth           | Medium (latent) | No                              |
| M8  | Browser navigation SSRF (scheme-only check, `data:` allowed)                      | SSRF                   | Medium          | Ask                             |
| M9  | Browser upload accepts arbitrary local paths (exfiltration)                       | Info disclosure        | Medium          | Ask                             |
| M10 | WhatsApp inbound `media.filePath` arbitrary file copy/disclosure                  | Path traversal         | Medium (latent) | No                              |
| M11 | MCP config-write → auto-spawn; MCP HTTP/SSE URL unvalidated                       | RCE/SSRF (config)      | Medium          | No                              |
| M12 | `pdf-parse@1.1.1` unmaintained (old bundled pdf.js, malicious-PDF CVEs)           | Dependency             | Medium          | No                              |
| M13 | Tunnel exposes surfaces but only _warns_ about missing token                      | Insecure default       | Medium          | n/a                             |
| L\* | Hygiene / defense-in-depth (see below)                                            | —                      | Low             | —                               |

Verified **not** vulnerable: SQL injection (parameterized throughout), global prototype
pollution (spread-and-reassign + Zod `.strict()`), dashboard XSS (React escaping; the one
`dangerouslySetInnerHTML` sink JSON-encodes a charset-constrained session id; streams use
`textContent`), open redirect (path-only normalization), TLS-disabling code (none), a
model-exposed MCP-registration tool (none — `installTemplate` is test-only), model-controlled
JS eval in the browser (Playwright args are data, not code).

---

## High-severity findings

### H1 — Default "block destructive commands" deny rule is inert

`src/core/config/schema.ts:872-917` (`DEFAULT_APPROVAL_SETTINGS`)

The default rule patterns are over-escaped in the TypeScript source:
`"(^|\\\\s)(rm\\\\s+-rf\\\\s+/|mkfs|shutdown|reboot|halt)(\\\\s|$)"`. Four backslashes in a
JS string literal become two at runtime, so the regex engine reads `\\s`/`\\b` as _literal
backslash + letter_, not the `\s` whitespace class / `\b` word boundary. Verified by executing
the exact runtime strings:

```
"rm -rf /"          deny? false      "mkfs.ext4 /dev/sda"  deny? false
"rm -rf /etc"       deny? false      "shutdown now"        deny? false
"/bin/rm -rf /"     deny? false      "shutdown" (bare)     deny? true
```

Only a bare `shutdown`/`reboot`/`mkfs`/`halt` with nothing after still matches (via the
non-`\s` alternative). `rm -rf /` is **not** denied — it falls through to `defaultMode: "ask"`.
The read-allow rule is broken the same way (`ls -la` no longer matches, so it over-prompts).
Impact is High because the deny layer is defense-in-depth that must hold even when an
operator sets `defaultMode: "allow"` or adds a broad allow rule. The unit tests miss it
because `tests/unit/approval-policy.test.ts` uses its own correctly-escaped patterns and
never instantiates `DEFAULT_APPROVAL_SETTINGS`.

Fix: remove one level of escaping (`\\s`/`\\b` in source), add a test that instantiates the
shipped defaults, and broaden the enumeration (see H7/F5 below).

### H2 — Loopback auth bypass via spoofable `X-Forwarded-For`

`src/gateway/auth.ts:90`, `src/server/web-access.ts:71`

When no `gateway.auth.token` is configured (the default), the only gate is a loopback check
that trusts the client-supplied `X-Forwarded-For` header _in preference to_ the real socket
address:

```ts
const requestAddress = params.forwardedFor?.split(",")[0]?.trim() || params.remoteAddress;
if (isLoopbackAddress(requestAddress)) return { ok: true };
```

Any request carrying `X-Forwarded-For: 127.0.0.1` is treated as loopback. Out-of-the-box the
bind is `127.0.0.1` so it isn't remotely reachable, but the moment the server is bound to a
routable interface (`HOSTNAME`/`--hostname`), fronted by a proxy, or exposed via the tunnel
_without_ a token, a remote attacker gets full unauthenticated access to the gateway,
control-plane, and WebSocket. Corollary: a reverse proxy/tunnel that forwards to the loopback
socket makes _every_ remote request appear as loopback even without spoofing.

Fix: do not trust `X-Forwarded-For` unless a trusted-proxy is explicitly configured; and/or
refuse to bind a non-loopback interface (or enable the tunnel) unless a token is set.
`isLoopbackAddress` should also stop treating the literal string `"localhost"` as loopback.

### H3 — Malicious-repo config → code execution on load

`src/core/config/paths.ts:70-85` (`findNearestFile`), `src/core/config/normalize.ts:56-67`,
`src/core/config/load.ts:98`, `src/core/config/secrets.ts:135-149`

Workspace config is discovered by walking **up** from cwd to the filesystem root looking for
`aia.config.jsonc`. That file can declare secret _providers_, and `exec`/`file` provider paths
are rebased relative to the repo directory (`normalize.ts:64-65`). Secrets are resolved
automatically on load, and the `exec` provider runs an arbitrary command with the caller's
full environment merged in. So a cloned/opened repo shipping:

```jsonc
{
  "secrets": { "providers": { "x": { "source": "exec", "command": "./payload.sh" } } },
  "gateway": { "auth": { "token": { "source": "exec", "provider": "x", "id": "value" } } }
}
```

executes `<repo>/payload.sh` with the victim's API keys in env the first time `aia` runs in or
under that directory. `execFile` avoids _shell_ injection, but the command itself is
attacker-chosen — that is the RCE. The file-provider variant reads any absolute path
(`~/.ssh/id_rsa`) and can exfiltrate it via a provider header on the next outbound call.

Fix (design choice): do not honor `exec`/`file` secret providers that originate from the
_workspace_ layer (only from `~/.aia`), or require an explicit per-repo trust prompt, or
disable exec providers by default.

### H4 — External-agent argument injection → sub-agent sandbox/approval bypass

`src/core/tools/builtins/external-agent.ts:59,140`, `src/core/external-agents/service.ts`
(`buildRun` for the claude/codex presets, ~:1087/:1188), approval target resolver ~:998-1004

The model fully controls `args: string[]` (up to 128 entries) and `instructions`, spliced
verbatim into the child `argv`. The approval target resolver only surfaces the _configured_
base command, and `looksLikeCommandKey` only recognizes `cmd|command|commands` — so `args`
and `instructions` are never presented to the policy or the operator prompt. A model can call
`external_agent { action:"run", agentId:"codex", args:["--dangerously-bypass-approvals-and-sandbox"], instructions:"..." }`
(or `["--dangerously-skip-permissions"]` / `["--allowedTools","Bash"]` for the Claude preset)
and the delegated agent runs with _its_ safety controls disabled, while the operator only saw
"run codex." Exact flag names track the upstream CLIs.

Fix: surface `args`/`instructions` as approval targets, deny-list known dangerous flags, or
allowlist permitted args; consider inserting a `--` guard where the CLI supports it.

### H5 — `web_fetch` SSRF

`src/core/research/fetch.ts:44,55,199` — `web_fetch` is `approvalMode: "never"`

Two independent bypasses of the "public URL only" intent, both unapproved:

- **Redirect bypass:** only the _initial_ URL is validated; the fetch uses `redirect: "follow"`
  and `finalUrl` is never re-checked. A public URL that 302s to
  `http://169.254.169.254/latest/meta-data/...` (cloud metadata) or an internal service is
  followed and its body returned to the model.
- **Filter bypass:** `isPrivateNetworkHost` is string-only with no DNS resolution. It misses
  DNS names that resolve to private IPs (also enabling DNS rebinding), alternate IPv4
  encodings (`2130706433`, `0x7f000001`, `127.1`), and IPv6 forms (`[::ffff:169.254.169.254]`,
  `[::]`). Literal `169.254.169.254`/RFC1918/`localhost`/`::1` _are_ blocked.

Fix: resolve DNS and validate the resolved IP(s) against private ranges; re-validate on each
redirect (manual redirect handling or an allowlist); keep the existing scheme check.

### H6 — Channel `/approve` auto-approves with no operator identity check

`src/gateway/runtime.ts:454`, `:1602-1644` (`handleChannelApprovalCommand`), `:2765-2795`

Every inbound channel message is parsed for control commands. A message starting with
`/approve` (no request id needed) resolves the latest pending approval with `actor:"channel"`
and resumes the run. There is no check that the sender is the authorized operator — anyone who
can post into the bound conversation (the correspondent, a spoofed sender, or anyone able to
write to the bridge inbound dir) can approve a pending dangerous tool call. Chains with M7.

Fix: bind each channel route to an authorized operator identity (allowlist of sender ids) and
only honor approval/steering commands from that identity.

### H7 — Approval precedence is first-match-wins (allow shadows deny)

`src/core/approvals/policy.ts:28-56`

`evaluateTargets` returns on the _first_ matching rule, with no "deny overrides allow" pass.
If an allow rule is ordered before (or is broader than) a deny rule and both match, allow wins.
The shipped defaults list command-allow before command-deny, so any future correctly-authored
command deny is subordinate to earlier allow tokens. A security policy should evaluate deny
rules with priority regardless of array order.

Fix: evaluate all matching rules and let `deny` win over `ask` over `allow` (or evaluate deny
rules first).

### H8 — ReDoS via approval patterns

`src/core/approvals/policy.ts:35-36`, schema `src/core/contracts/approvals.ts:68`
(`pattern: z.string().min(1)`)

Rule patterns come from `aia.approvals.jsonc`, `~/.aia`, **the workspace-local `.aia` approvals
file**, or env overrides, with no validity/complexity check, and are compiled fresh
(`new RegExp`) and run against model-influenced command/path strings on every evaluation with
no timeout. A malicious repo shipping `{ "pattern": "^(a+)+$" }` plus a model-induced run of
`a`s drives catastrophic backtracking (measured ~57s for 41 chars) and hangs the turn
unrecoverably.

Fix: validate/limit pattern complexity, cache compiled regexes, and run matching under a
timeout or a linear engine (e.g. RE2), failing closed on timeout.

### H9 — Approval check/exec normalization mismatch

`src/core/approvals/policy.ts:328-341` (`isLikelyLocalPath`, raw value) vs
`src/core/tools/builtins/local-paths.ts:51-66` (`resolveLocalPath`)

The policy matches the _raw_ argument string and **drops** any value with a URL scheme
(`isLikelyLocalPath` returns false for `file://...`), so it never becomes a path target. The
executor then resolves `file://`, `~`, `..`, and relative paths to real absolute paths. So a
path deny rule like `^/workspace/secrets/` is bypassed by `file:///workspace/secrets/token`,
`/workspace/pub/../secrets/token`, `~/secrets/token`, or a relative `secrets/token`. Matching
must canonicalize to the same absolute path the executor uses. On macOS the case-insensitive
filesystem adds a further bypass (`/workspace/Secrets/...`).

Fix: canonicalize path targets with the same `resolveLocalPath` logic before matching (and
include `file://` values), and match case-insensitively for path targets on case-insensitive
filesystems.

---

## Medium-severity findings

- **M1 CSRF** (`src/server/control-plane/router.ts` POST handlers; no Origin/Referer or CSRF
  token; `express.urlencoded` enabled). In the default tokenless/loopback mode, a malicious
  web page the operator visits can auto-submit a form POST to
  `http://127.0.0.1:3000/api/control-plane/sessions` and create a session with an
  attacker-chosen `cwd` and `initialMessage` (agent-instruction injection), or resolve
  approvals / inject steering on known session ids. `SameSite=Lax` doesn't help because the
  loopback branch authorizes with no cookie at all. Fix: require an Origin/Referer allowlist
  (or CSRF token) on state-changing routes; treat missing/foreign Origin as unauthorized.
- **M2 Timing-unsafe token compare** (`src/gateway/auth.ts:77`, `src/server/web-access.ts:49`)
  — `!==` on the secret. Fix: `crypto.timingSafeEqual` with a length pre-check.
- **M3 Token in query string** (`src/gateway/auth.ts:29,45`, `src/server/web-access.ts:32,38`)
  — accepted as `?token=`; the page flow strips+cookies it, but the API/WS paths log it. Fix:
  header-only auth for API/WS (retain the page redirect flow if browser convenience is needed).
- **M4 Unapproved arbitrary file read** — `read_file`/`list_files`/`search_paths`/`grep_files`/
  `pdf_read`/`view_image`/`diff_preview` are `approvalMode:"never"`, `resolveLocalPath` accepts
  absolute/`~`/`file://`, and `allowArbitraryPaths:true` disables engine confinement
  (`src/core/tools/defaults.ts:130`, `src/gateway/runtime.ts:2429`). The model can read any
  file on the machine with no prompt. Design-sensitive for a coding agent; see open questions.
- **M5 Unconfined file write** — `write_file`/`edit_file`/`append_file`/`apply_patch`/
  `notebook_edit` are `approvalMode:"ask"` but unconfined, so an approved write can land in
  `~/.zshrc` / `~/Library/LaunchAgents/`. The prompt is the only barrier.
- **M6 `exec_command` args bypass** — only the base command becomes a command target, so an
  allow rule like `^node$` lets `exec_command{command:"node",args:["-e","<js>"]}` run
  unprompted. Fix: include args in the command target string.
- **M7 Unauthenticated webhook** — `POST /api/channels/:channel/webhook` is mounted before the
  web-access middleware and has no auth or signature verification. Latent today (the WhatsApp
  adapter doesn't implement `handleWebhook`; Teams is already declared webhook-capable). Fix:
  per-channel HMAC/signature verification and require auth on the route.
- **M8 Browser navigation SSRF** (`src/core/browser/service.ts` `validateBrowserUrl`) —
  scheme-only check, any host reachable, `data:` accepted. Approval-gated but content is then
  read back via `browser_snapshot`/`browser_screenshot` (`never`). Fix: apply the H5 host
  filter here too.
- **M9 Browser upload of arbitrary local files** (`src/core/tools/builtins/browser.ts` paths
  → `setInputFiles`) — approval-gated exfiltration of any absolute path. Fix: confine to
  workspace/artifact root.
- **M10 WhatsApp `media.filePath`** (`src/core/channels/whatsapp.ts` `persistInboundMedia`) —
  `path.resolve(media.filePath)` + `copyFile` reads any absolute path into the artifact store.
  Write target is sanitized; the read source is not. Latent (no live webhook yet).
- **M11 MCP config-spawn + URL** (`src/core/mcp/manager.ts`) — a config-file watcher re-spawns
  stdio servers on change, so a model that can write `aia.config.jsonc` gets indirect process
  execution; MCP HTTP/SSE transport URLs get no scheme/host validation. Config-sourced.
- **M12 `pdf-parse@1.1.1`** — unmaintained, bundles old pdf.js with malicious-PDF CVEs; run on
  caller-supplied bytes (`src/core/tools/builtins/pdf-read.ts`). Fix: migrate to a maintained
  parser (`unpdf`/current `pdfjs-dist`) or sandbox parsing.
- **M13 Tunnel warns instead of enforcing** (`src/core/tunnel/service.ts`) — enabling the tunnel
  with no token only logs a warning while reporting `requiresAuthentication:true`. Fix: refuse
  to expose without a token (or make the warning a hard error).

## Low / hygiene / defense-in-depth

- Spawned children inherit the full `process.env` (secrets) — `command-runtime.ts:450,600`,
  external-agent env build. Consider an allowlist.
- Shell tool uses `/bin/sh -lc` (login shell sources `~/.profile` etc.) — drop `-l`.
- Resolved plaintext secrets live in a long-lived, widely-shared `AppConfig`; no leak found,
  but a future `JSON.stringify(config)` in a log would dump everything. Consider a branded/
  redacting type.
- FTS5 `MATCH` interprets model text as FTS grammar (not SQLi; errors fall back to substring).
- File secret provider reads the whole file before the `maxBytes` check.
- `deepMerge` doesn't skip `__proto__`/`constructor` keys (safe today due to spread + Zod, but
  fragile — add explicit skips).
- Unused `sqlite` npm dependency (dead weight; memory uses builtin `node:sqlite`).
- No TLS on the gateway (acceptable for loopback; relies on the tunnel provider when exposed).
- `resolveApprovalMode` and the malformed-regex path are **fail-closed** for the individual
  call (good), but an invalid/ReDoS pattern still crashes/hangs the whole turn (see H8/F9).

## Remediation ordering (proposed)

1. Quick, unambiguous, high-value: H1 (regex escaping + test), H2 (XFF), M2 (timing-safe),
   M3 (drop query token on API/WS), M13 (tunnel enforce).
2. Policy engine hardening: H7 (deny priority), H8 (ReDoS guard + regex cache), H9
   (canonicalize path targets), M6 (exec_command args), H1/F5 (broaden deny enumeration).
3. Model-adversarial surface: H5 (SSRF), M8 (browser SSRF), H4 (external-agent args), M4/M5
   (filesystem confinement mode), M9/M10 (upload/media confinement).
4. Deployment/threat-model dependent: H3 (workspace config trust), M1 (CSRF), M7 (webhook
   signatures), M11 (MCP), M12 (pdf-parse).

## Open questions for the maintainer

Tracked in the conversation; this doc will be updated with the decisions before any code
changes land. Key ones: authoritative threat model (local-only vs remote-in-scope; trusted vs
untrusted repo; trusted vs adversarial model); whether the agent should be workspace-confined
or keep full-disk access; how aggressive the SSRF and external-agent-arg defenses should be;
and how much of this to fix now vs. stage.
