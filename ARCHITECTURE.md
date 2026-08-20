# Slack Agent Bridge — Architecture

*The original design was decided on 2026-07-21 after the
[Claude feasibility study](docs/claude-feasibility.md) and empirical spike.
Codex was added as a provider adapter on 2026-08-14, transactional
cross-provider handoff on 2026-08-17, and Pi on 2026-08-19. The daemon is modern
JavaScript (ESM, Node 20+, no build step); Pi loads one native TypeScript
extension through its own runtime.*

## Components

```
Slack (private channels, Socket Mode)
   ▲│
   │▼
┌────────────────────────── Mac Studio ──────────────────────────┐
│  daemon/daemon.mjs  ← launchd, owns the ONE Socket Mode conn   │
│    • HTTP 127.0.0.1:8877  (hooks, permissions, uploads, SSE)   │
│    • state.json  (channel lineage ↔ active/standby legs)       │
│    • handoffs/   (private summaries + reviewed patches, 0600)  │
│    • lifecycle, mirroring, status, resurrection, ./commands    │
│    ▲ POST /hook       ▲ /channel/stream       ▲ /pi/*         │
│  Claude/Codex hooks   Claude MCP Channel       Pi extension     │
│         │                    │                      │           │
│  Ghostty → tmux ─┬→ bin/sab-cc → Claude + MCP Channel          │
│                  ├→ bin/sab-codex → Codex + lifecycle hooks    │
│                  └→ bin/sab-pi → Pi + explicit SAB extension   │
│                         └→ bin/sab-upload → authorized artifact │
└────────────────────────────────────────────────────────────────┘
```

- **`bin/sab-cc`** — the Claude launcher. Always wraps the session in **tmux
  inside the terminal window**, exports `CCS_BRIDGE=1` + `CCS_TMUX=<name>`, then
  execs `claude --mcp-config <generated>
  --dangerously-load-development-channels server:slack-bridge [args]`. The MCP
  config is generated at launch into `~/.config/ccs/mcp.json` with the resolved
  install path, so nothing is hardcoded. `bin/ccs` forwards to this launcher.
- **`bin/sab-codex`** — the Codex launcher. It uses the same tmux invariant,
  exports `CCS_PROVIDER=codex`, and binds F12 to Codex `interrupt_turn`. It does
  not load Claude's MCP server or consent watcher. `bin/ccs-codex` forwards to it.
- **`bin/sab-pi`** — the Pi launcher. It exports `CCS_PROVIDER=pi`, preserves
  the shared tmux/Ghostty invariant, consumes bridge-only `--safe`, and loads
  `pi/sab-extension.ts` explicitly with Pi's `--extension`. It never installs
  or discovers a global bridge extension.
- **`pi/sab-extension.ts`** — Pi's native control plane. It opens an
  authenticated-by-local-process SSE stream to the loopback daemon, injects
  prompts and supported images with `sendUserMessage`, posts lifecycle/final
  text and native usage, controls model/thinking/abort, and optionally blocks
  tool calls pending Slack approval. Ordinary owner input is also intercepted
  for adaptive routing; extension-reinjected native prompts bypass the router
  exactly once. Pi session files are not parsed.
- **`pi/managed-run.ts`** — adaptive local-model orchestration controlled by
  `/pi-run`. It persists routing policy/pending decisions and a bounded
  goal/plan state through Pi's extension API,
  drives the parent worker across multiple turns, launches isolated child Pi
  planners/scouts/reviewers, and requires independent review before the final
  response. Planner/reviewer children explicitly load only
  `pi/managed-child-output.ts`, whose typed terminating tools return validated
  plan/review data without an extra prose turn. `pi/managed-core.mjs` contains
  the daemon-safe parser/state model.
- **`bin/sab-upload`** — a provider-neutral agent helper. It submits generated
  file paths to the loopback daemon with the session's provider/tmux identity
  and a one-use grant supplied only by an accepted Slack prompt. It cannot
  choose a channel or user.
- **`hooks/hook.sh`** — registered globally for `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `Stop`. Exits instantly unless `CCS_BRIDGE=1` (non-bridged sessions pay zero cost). Otherwise POSTs the hook JSON + `ppid` + `tmux` name to the daemon (curl, ≤2s cap, always exit 0 — hooks are synchronous).
- **`hooks/codex-hook.sh`** — separately registered and gated by `CCS_PROVIDER=codex`. Lifecycle events post to the daemon; `PermissionRequest` waits for a Slack verdict and emits the documented Codex decision JSON. Failure returns no decision, preserving the local approval flow.
- **Codex resurrection bootstrap** — `codex resume` receives the first queued
  Slack message through its optional `PROMPT` argument. This starts the first
  turn even when an idle resumed TUI has not emitted `SessionStart`; later
  messages remain queued and flush through the normal hook path.
- **`channel/server.mjs`** — MCP channel server, spawned per session by Claude Code. Declares `claude/channel`, connects outward to the daemon's SSE endpoint keyed by its claude PID, and forwards each pushed Slack message into the session as a channel event. No reply tool: outbound mirroring is done by hooks, so responses are verbatim and cost no extra model turns.
- **`daemon/daemon.mjs`** (+ `slackout.mjs`, `util.mjs`) — everything else.

## Key decisions

1. **Message-level bridge, not pty mirroring** — immune to TUI resize bugs (feasibility finding).
2. **JSON state file, not SQLite** — single-writer daemon, dozens of rows, human-inspectable, atomic tmp+rename. (Revised from the earlier SQLite suggestion; complexity wasn't buying anything.)
3. **Provider + PID is the live join key.** Hooks/extensions report their
   process PID; the daemon validates its ancestry and tmux claim for `claude`,
   `codex`, or `pi`. Claude and Pi inbound streams also join by PID. Persisted
   identity remains the raw native session ID, with missing provider fields
   interpreted as Claude for backward compatibility.
4. **No archiving, ever** (design v2). Ended sessions → channel gets "💤 write
   here to resume". A dormant-channel message makes the daemon spawn
   Ghostty+tmux with the provider's native resume form (`sab-cc --resume`,
   `sab-codex resume`, or `sab-pi --session`), queue the message, and deliver it
   after reconnection.
5. **tmux everywhere** (inside the visible Ghostty window — the terminal invariant holds). This solves the two problems the Channels API can't: the research-preview **consent dialog** (daemon auto-acknowledges it in daemon-spawned windows via `send-keys`, since nobody is at the Mac to click it), and **in-session commands** — `/cc-model sonnet` in Slack becomes `tmux send-keys "/model sonnet" Enter`, and `/cc-stop` sends `Escape` to interrupt.
6. **Private channels only; single trusted sender.** The workspace has 35 people. Only messages from `SLACK_USER_ID` are processed; everyone else is silently ignored (and can't see the channels anyway).
7. **Mirroring is provider-event-driven and token-free.** Claude keeps its byte-offset
   JSONL reader and TUI status/form parser. Its bounded poller also recognizes
   new failure-only authentication and overload records, because Claude can
   return immediately to idle without emitting `Stop`; these failures are
   delivered promptly and repeated identical failures are time-deduplicated.
   Codex uses the stable
   `Stop.last_assistant_message` hook field; the bridge never parses Codex's
   explicitly unstable transcript format. Usage and live token counters enter
   only through `ccusage`'s maintained Codex JSON adapter. Pi's native extension
   supplies final text and usage directly; its session JSONL is never read.
   Slack-injected messages are deduped for all providers.
8. **One control channel** — fresh 1.0 installs use
   `#slack-agent-bridge`; upgrades reuse `#claude-code-bridge`. Its immutable
   channel ID lives in state, so the public rename never creates a duplicate.
   It accepts `/cc-new`, `/codex-new`, or `/pi-new`, provider-filtered status,
   and help.
   Session channels accept plain messages plus their provider namespace.
9. **Capability-bound artifact return.** Every accepted owner or per-channel
   collaborator prompt receives an opaque two-hour grant in the injected agent
   context. `sab-upload` proves live process/tmux ownership; the daemon binds
   the grant to the sender, session, provider, channel, message, and canonical
   workspace. A successful upload consumes the grant. Up to ten regular files
   totaling 100 MiB may be sent in one call; realpath containment rejects
   traversal and symlink escapes. Slack failures and path corrections remain
   retryable until expiry. Grants intentionally do not survive daemon restarts.
10. **One logical channel, separate native provider legs.** A lineage is created
    lazily on the first provider switch; legacy sessions are not
    bulk migrated. `state.channels[channel]` remains the authoritative active
    session mapping. Only the active leg carries `session.channel`; up to two
    other provider-native session IDs remain dormant and resumable.
11. **Journaled two-phase provider handoff.** The source stays authoritative
    while instruction alignment is reviewed and a private SAB v1 handoff is
    captured. The bridge then stops it, starts or resumes the exact target leg
    in a provisional tmux, waits for the visible input surface or Pi extension
    stream, and
    intercepts a read-only readiness turn. Trust gates remain local and are
    never keyed by the daemon. Only a valid response from a hook-claimed target
    session atomically moves the channel mapping. Crash recovery and failures
    reap the exact provisional tmux and restore the source.
12. **Instruction files, not provider memory.** Switch preflight inspects only
    repository-root `AGENTS.md` and `CLAUDE.md`. Global Claude/Codex memory and
    `MEMORY.md` never enter automatic consolidation. A credential-scrubbed
    auxiliary process runs from a private neutral directory and returns bounded
    document sections; the bridge constructs the Git patch deterministically.
    Owner review plus fingerprint, path, symlink, binary, mode, apply, and size
    validation remain mandatory.
13. **Pi trust has two independent layers.** Pi's `--approve` chooses whether
    project-local resources may load. SAB `--safe` is an extension-owned,
    fail-closed per-tool Slack gate. The bridge never describes one as the
    other, and Pi's unrestricted default does not receive a fictional
    Claude/Codex flag alias.
14. **Managed Pi orchestration is adaptive and bounded.** Ordinary owner prompts
    default to `auto`: an isolated no-tools, low-thinking router chooses native
    delivery or a persisted planning/execution/review state machine. Ambiguous
    or failed classifications promote to managed; collaborators stay native.
    `always` and `native` policies are session-persistent, `/pi-run direct`
    bypasses once, and `/pi-run <goal>` always forces the managed state machine.
    Child processes receive the selected model/thinking setting and role-bound
    tools, but no bridge/session/upload identity, inherited extensions, skills,
    themes, or project-resource approval. Planner/reviewer output uses one
    bridge-owned terminating submission extension; malformed legacy output gets
    at most one no-tools repair attempt. Read-only review is reserved in the
    subagent budget and must pass before the final response is mirrored.

## Command grammar (Slack)

Commands are native Slack slash commands (`slash_commands` events over Socket Mode), routed through a shared `dispatch()`. The ingress prefix is authoritative: `/cc-*` selects Claude, `/codex-*` selects Codex, and `/pi-*` selects Pi. A mismatched provider command is rejected before it can affect a session. The old commands were `./`-prefixed messages before v0.2.0.

| Command | Where | Effect |
|---|---|---|
| plain text | session channel | injected into the session (resurrects it first if needed); explicit requests may return generated workspace files |
| `/cc-new [folder] [flags]`, `/codex-new …`, `/pi-new …` | anywhere | provider-specific project picker or Ghostty+tmux spawn (allowlisted flags, under `$HOME`) |
| `/cc-model`, `/cc-effort`, `/cc-flags`, `/cc-update` | Claude session | inspect/change Claude settings; restart/resume where required |
| `/codex-model`, `/codex-effort`, `/codex-flags`, `/codex-update` | Codex session | inspect/change Codex settings; restart/resume where required |
| `/pi-model`, `/pi-effort`, `/pi-flags`, `/pi-update` | Pi session | inspect/change native Pi model/thinking/launch settings |
| `/pi-run [plan] <goal> [--minutes=N --turns=N --agents=N --reviews=N]` | live Pi session | start a managed goal; `plan` pauses after planning; no arguments shows status |
| `/pi-run mode [auto\|always\|native]`, `/pi-run direct <prompt>` | live Pi session | inspect/change persistent adaptive routing or bypass it once |
| `/pi-run approve\|pause\|continue\|cancel` | live Pi session | control the persisted managed run |
| `/cc-stop`, `/codex-stop`, `/pi-stop` | matching session | interrupt the running turn through the provider adapter |
| provider `-switch <target> [new]` | matching active, idle session | preview and transactionally hand the channel to another provider; `new` explicitly replaces missing saved-leg state |
| `/cc-status`, `/codex-status`, `/pi-status` | anywhere | session info here; provider-filtered table from control |
| `/cc-kill`, `/codex-kill`, `/pi-kill` | matching session or control | end a session in the selected provider namespace |
| `/cc-health`, `/cc-cleanup`, `/cc-claim` | anywhere | bridge-wide operations, intentionally singular |
| `/cc-usage`, `/codex-usage`, `/pi-usage` | matching session/control | provider-filtered usage; Pi uses native events, Claude/Codex use `ccusage` |
| `/cc-account` | Claude session/control | Claude-only subscription selection |
| `/cc-help`, `/codex-help`, `/pi-help` | anywhere | provider-specific command list |

## Lifecycle (channel naming: `{repo}-{branch}-{yyyymmdd}-{hhmm}`)

- `SessionStart(startup)` → create private channel, invite you, post header, set topic.
- Concurrent startup hooks share one single-flight channel binding; boot removes
  stale aliases that disagree with the session's authoritative channel ID.
- `SessionStart(resume)` → reuse mapped channel, "▶️ resumed".
- `SessionStart(clear)` → rebind channel to the new session id (same pid), "🧹 cleared".
- `SessionEnd` / liveness sweep (30s, `kill -0`) → "💤 session ended — write here to resume".
- Managed Pi run → read-only child plan → optional approval → repeated parent
  turns and scoped subagents → read-only independent review → fixes/re-review
  or one final mirrored response. Pause, interruption, process exit, and daemon
  restart leave a resumable state entry in the native Pi session.
- Provider switch → preflight → optional reviewed instruction patch → private
  source handoff → provisional target readiness → atomic channel commit. Owner
  messages queue by channel in the private transition journal; collaborators
  are rejected during the transition.
- Switch failure/restart → kill the exact provisional target, restore the source
  mapping, and deliver queued owner work to the restored source.
- A standby leg's late or manual hooks are fenced: it cannot create a duplicate
  channel or become live without the matching provider-switch transaction.
- Topic synchronization reads Slack's current value after daemon boot and writes
  only on a real folder/branch/model/effort change.
- You may rename channels freely — mapping is by immutable channel id.

## Known limitations

- Consent dialog on every launch (research preview) — one keypress locally, auto-keyed for remote spawns. Goes away if the plugin ever reaches an allowlist.
- Codex does not expose Claude's whimsical spinner verbs. Its stable working
  status combines hook timing with bounded `ccusage` token snapshots instead.
- Pi capabilities depend on its installed version and selected model. Native
  image delivery is rejected visibly for text-only models; Pi has no Chrome
  flag counterpart.
- Managed Pi subagents are sequential and normally use the same configured
  local model as the parent. The bridge supplies orchestration and budgets; it
  cannot make a weak model reason like a stronger one or provide hardware-level
  parallelism on a single inference server.
- Ghostty on macOS has no reliable IPC for adding windows to one running app
  instance. Dockless accessory windows are supported; single-icon mode remains
  best-effort.
- Streaming response APIs are proven but not wired; long responses are uploaded
  as Markdown files.
- Provider switching transfers an explicit summary and repository state, not
  hidden reasoning or a byte-identical context window. Provider-global memory
  remains native and intentionally unmerged.
