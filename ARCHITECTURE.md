# Slack Agent Bridge — Architecture

*The original design was decided on 2026-07-21 after the
[Claude feasibility study](docs/claude-feasibility.md) and empirical spike.
Codex was added as a provider adapter on 2026-08-14. The implementation is
modern JavaScript (ESM, Node 20+, no build step).*

## Components

```
Slack (private channels, Socket Mode)
   ▲│
   │▼
┌────────────────────────── Mac Studio ──────────────────────────┐
│  daemon/daemon.mjs  ← launchd, owns the ONE Socket Mode conn   │
│    • HTTP 127.0.0.1:8877  (hooks, permissions, uploads, SSE)   │
│    • state.json  (session ↔ provider ↔ channel ↔ pid ↔ tmux)   │
│    • lifecycle, mirroring, status, resurrection, ./commands    │
│         ▲ POST /hook              ▲ GET /channel/stream (SSE)  │
│  hooks/hook.sh (global,           channel/server.mjs           │
│  instant, CCS_BRIDGE-gated)       (per-session MCP subprocess) │
│         │                          │ notifications/claude/…    │
│  Ghostty → tmux ─┬→ bin/sab-cc → Claude + MCP Channel          │
│                  └→ bin/sab-codex → Codex + lifecycle hooks    │
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
3. **Provider + PID is the live join key.** Hooks report their parent PID; the daemon walks ancestry to the owning `claude` or `codex` process. Claude's channel SSE also joins by PID. Persisted identity remains the raw session ID, with missing provider fields interpreted as Claude for backward compatibility.
4. **No archiving, ever** (design v2). Ended sessions → channel gets "💤 write
   here to resume". A dormant-channel message makes the daemon spawn
   Ghostty+tmux with `sab-cc --resume <session-id>` or `sab-codex resume
   <session-id>`, queue the message, and deliver it after reconnection.
5. **tmux everywhere** (inside the visible Ghostty window — the terminal invariant holds). This solves the two problems the Channels API can't: the research-preview **consent dialog** (daemon auto-acknowledges it in daemon-spawned windows via `send-keys`, since nobody is at the Mac to click it), and **in-session commands** — `/cc-model sonnet` in Slack becomes `tmux send-keys "/model sonnet" Enter`, and `/cc-stop` sends `Escape` to interrupt.
6. **Private channels only; single trusted sender.** The workspace has 35 people. Only messages from `SLACK_USER_ID` are processed; everyone else is silently ignored (and can't see the channels anyway).
7. **Mirroring is hook-driven and token-free.** Claude keeps its byte-offset
   JSONL reader and TUI status/form parser. Codex uses the stable
   `Stop.last_assistant_message` hook field; the bridge never parses Codex's
   explicitly unstable transcript format. Usage and live token counters enter
   only through `ccusage`'s maintained Codex JSON adapter. Slack-injected
   messages are deduped for both.
8. **One control channel** — fresh 1.0 installs use
   `#slack-agent-bridge`; upgrades reuse `#claude-code-bridge`. Its immutable
   channel ID lives in state, so the public rename never creates a duplicate.
   It accepts `/cc-new` or `/codex-new`, provider-filtered status, and help.
   Session channels accept plain messages plus their provider namespace.
9. **Capability-bound artifact return.** Every accepted owner or per-channel
   collaborator prompt receives an opaque two-hour grant in the injected agent
   context. `sab-upload` proves live process/tmux ownership; the daemon binds
   the grant to the sender, session, provider, channel, message, and canonical
   workspace. A successful upload consumes the grant. Up to ten regular files
   totaling 100 MiB may be sent in one call; realpath containment rejects
   traversal and symlink escapes. Slack failures and path corrections remain
   retryable until expiry. Grants intentionally do not survive daemon restarts.

## Command grammar (Slack)

Commands are native Slack slash commands (`slash_commands` events over Socket Mode), routed through a shared `dispatch()`. The ingress prefix is authoritative: `/cc-*` selects Claude and `/codex-*` selects Codex. A mismatched provider command is rejected before it can affect a session. The old commands were `./`-prefixed messages before v0.2.0.

| Command | Where | Effect |
|---|---|---|
| plain text | session channel | injected into the session (resurrects it first if needed); explicit requests may return generated workspace files |
| `/cc-new [folder] [flags]`, `/codex-new [folder] [flags]` | anywhere | provider-specific project picker or Ghostty+tmux spawn (allowlisted flags, under `$HOME`) |
| `/cc-model`, `/cc-effort`, `/cc-flags`, `/cc-update` | Claude session | inspect/change Claude settings; restart/resume where required |
| `/codex-model`, `/codex-effort`, `/codex-flags`, `/codex-update` | Codex session | inspect/change Codex settings; restart/resume where required |
| `/cc-stop`, `/codex-stop` | matching session | interrupt the running turn (Claude Escape; Codex F12 binding) |
| `/cc-status`, `/codex-status` | anywhere | session info here; provider-filtered table from control |
| `/cc-kill`, `/codex-kill` | matching session or control | end a session in the selected provider namespace |
| `/cc-health`, `/cc-cleanup`, `/cc-claim` | anywhere | bridge-wide operations, intentionally singular |
| `/cc-usage`, `/codex-usage` | matching session/control | Provider-filtered usage through `ccusage`; Claude also exposes plan limits |
| `/cc-account` | Claude session/control | Claude-only subscription selection |
| `/cc-help`, `/codex-help` | anywhere | provider-specific command list |

## Lifecycle (channel naming: `{repo}-{branch}-{yyyymmdd}-{hhmm}`)

- `SessionStart(startup)` → create private channel, invite you, post header, set topic.
- `SessionStart(resume)` → reuse mapped channel, "▶️ resumed".
- `SessionStart(clear)` → rebind channel to the new session id (same pid), "🧹 cleared".
- `SessionEnd` / liveness sweep (30s, `kill -0`) → "💤 session ended — write here to resume".
- Topic synchronization reads Slack's current value after daemon boot and writes
  only on a real folder/branch/model/effort change.
- You may rename channels freely — mapping is by immutable channel id.

## Known limitations

- Consent dialog on every launch (research preview) — one keypress locally, auto-keyed for remote spawns. Goes away if the plugin ever reaches an allowlist.
- Codex does not expose Claude's whimsical spinner verbs. Its stable working
  status combines hook timing with bounded `ccusage` token snapshots instead.
- Ghostty on macOS has no reliable IPC for adding windows to one running app
  instance. Dockless accessory windows are supported; single-icon mode remains
  best-effort.
- Streaming response APIs are proven but not wired; long responses are uploaded
  as Markdown files.
