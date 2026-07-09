# Security Review — 2026-07-09

Status: **findings only, no code changed yet.** This document is the shared record of a
full-repo defensive security audit. It exists so the remediation work (and any future
audit) starts from a written baseline instead of re-deriving everything.

Method: seven parallel focused reviews (auth/network, command execution, filesystem,
approvals policy, MCP/SSRF/browser, web/channels, secrets/config/deps), with the
highest-severity claims re-verified by hand (regex behavior executed, containment flags
grepped, data flows traced). Line references were accurate at time of writing; re-confirm
before editing.

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

| # | Finding | Class | Severity | Approval-gated? |
|---|---------|-------|----------|-----------------|
| H1 | Default destructive-command deny rule is inert (regex over-escaping) | Policy fail-open | High | n/a |
| H2 | Loopback auth bypass via spoofable `X-Forwarded-For` | Auth bypass | High | n/a |
| H3 | Malicious-repo `aia.config.jsonc` → code execution on load (exec secret provider) | Config injection / RCE | High | No |
| H4 | External-agent argument injection → sub-agent sandbox/approval bypass | Argument injection | High | Prompt shown, but blind to args |
| H5 | `web_fetch` SSRF: redirects unre-validated + string-only private-host filter | SSRF | High | No |
| H6 | Channel `/approve` auto-resolves pending approvals with no sender identity check | Access control | High | Defeats the gate |
| H7 | Approval precedence is first-match-wins (allow can shadow deny) | Policy precedence | High | n/a |
| H8 | ReDoS via config/workspace approval patterns run on model strings | DoS | High | n/a |
| H9 | Approval path check/exec mismatch (`file://`, `~`, `..`, relative) | Normalization bypass | High | Defeats path denies |
| M1 | CSRF on control-plane state-changing endpoints (no Origin/token check) | CSRF | Medium | n/a |
| M2 | Non-constant-time token comparison (timing attack) | Crypto | Medium | n/a |
| M3 | Gateway token accepted via URL query string (log/referrer leak) | Secret leak | Medium | n/a |
| M4 | Arbitrary file read with NO approval (`/etc/passwd`, `~/.ssh/...`) | Info disclosure | Medium/High | No |
| M5 | Arbitrary file write outside workspace (approval-gated, unconfined) | Integrity | Medium | Ask |
| M6 | `exec_command` args invisible to command allowlist | Approval scope | Medium | Ask (bypassable) |
| M7 | Unauthenticated channel webhook endpoint (no signature) | Missing auth | Medium (latent) | No |
| M8 | Browser navigation SSRF (scheme-only check, `data:` allowed) | SSRF | Medium | Ask |
| M9 | Browser upload accepts arbitrary local paths (exfiltration) | Info disclosure | Medium | Ask |
| M10 | WhatsApp inbound `media.filePath` arbitrary file copy/disclosure | Path traversal | Medium (latent) | No |
| M11 | MCP config-write → auto-spawn; MCP HTTP/SSE URL unvalidated | RCE/SSRF (config) | Medium | No |
| M12 | `pdf-parse@1.1.1` unmaintained (old bundled pdf.js, malicious-PDF CVEs) | Dependency | Medium | No |
| M13 | Tunnel exposes surfaces but only *warns* about missing token | Insecure default | Medium | n/a |
| L* | Hygiene / defense-in-depth (see below) | — | Low | — |

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
JS string literal become two at runtime, so the regex engine reads `\\s`/`\\b` as *literal
backslash + letter*, not the `\s` whitespace class / `\b` word boundary. Verified by executing
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
that trusts the client-supplied `X-Forwarded-For` header *in preference to* the real socket
address:

```ts
const requestAddress = params.forwardedFor?.split(",")[0]?.trim() || params.remoteAddress;
if (isLoopbackAddress(requestAddress)) return { ok: true };
```

Any request carrying `X-Forwarded-For: 127.0.0.1` is treated as loopback. Out-of-the-box the
bind is `127.0.0.1` so it isn't remotely reachable, but the moment the server is bound to a
routable interface (`HOSTNAME`/`--hostname`), fronted by a proxy, or exposed via the tunnel
*without* a token, a remote attacker gets full unauthenticated access to the gateway,
control-plane, and WebSocket. Corollary: a reverse proxy/tunnel that forwards to the loopback
socket makes *every* remote request appear as loopback even without spoofing.

Fix: do not trust `X-Forwarded-For` unless a trusted-proxy is explicitly configured; and/or
refuse to bind a non-loopback interface (or enable the tunnel) unless a token is set.
`isLoopbackAddress` should also stop treating the literal string `"localhost"` as loopback.

### H3 — Malicious-repo config → code execution on load
`src/core/config/paths.ts:70-85` (`findNearestFile`), `src/core/config/normalize.ts:56-67`,
`src/core/config/load.ts:98`, `src/core/config/secrets.ts:135-149`

Workspace config is discovered by walking **up** from cwd to the filesystem root looking for
`aia.config.jsonc`. That file can declare secret *providers*, and `exec`/`file` provider paths
are rebased relative to the repo directory (`normalize.ts:64-65`). Secrets are resolved
automatically on load, and the `exec` provider runs an arbitrary command with the caller's
full environment merged in. So a cloned/opened repo shipping:

```jsonc
{ "secrets": { "providers": { "x": { "source": "exec", "command": "./payload.sh" } } },
  "gateway": { "auth": { "token": { "source": "exec", "provider": "x", "id": "value" } } } }
```

executes `<repo>/payload.sh` with the victim's API keys in env the first time `aia` runs in or
under that directory. `execFile` avoids *shell* injection, but the command itself is
attacker-chosen — that is the RCE. The file-provider variant reads any absolute path
(`~/.ssh/id_rsa`) and can exfiltrate it via a provider header on the next outbound call.

Fix (design choice): do not honor `exec`/`file` secret providers that originate from the
*workspace* layer (only from `~/.aia`), or require an explicit per-repo trust prompt, or
disable exec providers by default.

### H4 — External-agent argument injection → sub-agent sandbox/approval bypass
`src/core/tools/builtins/external-agent.ts:59,140`, `src/core/external-agents/service.ts`
(`buildRun` for the claude/codex presets, ~:1087/:1188), approval target resolver ~:998-1004

The model fully controls `args: string[]` (up to 128 entries) and `instructions`, spliced
verbatim into the child `argv`. The approval target resolver only surfaces the *configured*
base command, and `looksLikeCommandKey` only recognizes `cmd|command|commands` — so `args`
and `instructions` are never presented to the policy or the operator prompt. A model can call
`external_agent { action:"run", agentId:"codex", args:["--dangerously-bypass-approvals-and-sandbox"], instructions:"..." }`
(or `["--dangerously-skip-permissions"]` / `["--allowedTools","Bash"]` for the Claude preset)
and the delegated agent runs with *its* safety controls disabled, while the operator only saw
"run codex." Exact flag names track the upstream CLIs.

Fix: surface `args`/`instructions` as approval targets, deny-list known dangerous flags, or
allowlist permitted args; consider inserting a `--` guard where the CLI supports it.

### H5 — `web_fetch` SSRF
`src/core/research/fetch.ts:44,55,199` — `web_fetch` is `approvalMode: "never"`

Two independent bypasses of the "public URL only" intent, both unapproved:
- **Redirect bypass:** only the *initial* URL is validated; the fetch uses `redirect: "follow"`
  and `finalUrl` is never re-checked. A public URL that 302s to
  `http://169.254.169.254/latest/meta-data/...` (cloud metadata) or an internal service is
  followed and its body returned to the model.
- **Filter bypass:** `isPrivateNetworkHost` is string-only with no DNS resolution. It misses
  DNS names that resolve to private IPs (also enabling DNS rebinding), alternate IPv4
  encodings (`2130706433`, `0x7f000001`, `127.1`), and IPv6 forms (`[::ffff:169.254.169.254]`,
  `[::]`). Literal `169.254.169.254`/RFC1918/`localhost`/`::1` *are* blocked.

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

`evaluateTargets` returns on the *first* matching rule, with no "deny overrides allow" pass.
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

The policy matches the *raw* argument string and **drops** any value with a URL scheme
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
