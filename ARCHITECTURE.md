# ClaudeSlackProxy — Architecture (v2, multi-provider)

*Decided 2026-07-21 after the feasibility study + spike (see FEASIBILITY.md). Language: TypeScript-flavored modern JS (ESM, Node 24, no build step). All Slack mechanisms and the channel-injection path were empirically proven before this design was fixed.*

## Components

```
Slack (private channels, Socket Mode)
   ▲│
   │▼
┌────────────────────────── Mac Studio ──────────────────────────┐
│  daemon/daemon.mjs  ← launchd, owns the ONE Socket Mode conn   │
│    • HTTP 127.0.0.1:8877  (hooks/permissions in, Claude SSE)   │
│    • state.json  (session ↔ provider ↔ channel ↔ pid ↔ tmux)   │
│    • lifecycle, mirroring, status, resurrection, ./commands    │
│         ▲ POST /hook              ▲ GET /channel/stream (SSE)  │
│  hooks/hook.sh (global,           channel/server.mjs           │
│  instant, CCS_BRIDGE-gated)       (per-session MCP subprocess) │
│         │                          │ notifications/claude/…    │
│  Ghostty → tmux ─┬→ bin/ccs → Claude + MCP Channel             │
│                  └→ bin/ccs-codex → Codex + lifecycle hooks    │
└────────────────────────────────────────────────────────────────┘
```

- **`bin/ccs`** — the launcher. Replaces `claude` (and any VibeTunnel `vt claude`). Always wraps the session in **tmux inside the terminal window** (terminal invariant preserved; tmux is what makes the session *drivable*), exports `CCS_BRIDGE=1` + `CCS_TMUX=<name>`, then execs `claude --mcp-config <generated> --dangerously-load-development-channels server:slack-bridge [args]`. The MCP config is generated at launch into `~/.config/ccs/mcp.json` with `ccs`'s resolved install path, so nothing is hardcoded.
- **`bin/ccs-codex`** — opt-in Codex launcher. It uses the same tmux invariant, exports `CCS_PROVIDER=codex`, and binds F12 to Codex `interrupt_turn`. It does not load Claude's MCP server or consent watcher.
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
4. **No archiving, ever** (design v2). Ended sessions → channel gets "💤 write here to resume". Message into a dormant channel → daemon spawns Ghostty+tmux+`ccs --resume <session-id>` in the stored cwd, queues the message, delivers it once the channel server reconnects.
5. **tmux everywhere** (inside the visible Ghostty window — the terminal invariant holds). This solves the two problems the Channels API can't: the research-preview **consent dialog** (daemon auto-acknowledges it in daemon-spawned windows via `send-keys`, since nobody is at the Mac to click it), and **in-session commands** — `/cc-model sonnet` in Slack becomes `tmux send-keys "/model sonnet" Enter`, and `/cc-stop` sends `Escape` to interrupt.
6. **Private channels only; single trusted sender.** The workspace has 35 people. Only messages from `SLACK_USER_ID` are processed; everyone else is silently ignored (and can't see the channels anyway).
7. **Mirroring is hook-driven and token-free.** Claude keeps its byte-offset JSONL reader and TUI status/form parser. Codex uses the stable `Stop.last_assistant_message` hook field and never parses its explicitly unstable transcript format. Slack-injected messages are deduped for both.
8. **Control channel** `#claude-code-bridge` — created by the daemon at startup for commands when no session channel exists yet: `/cc-new` or `/codex-new`, provider-filtered status, and help. Session channels accept plain messages (→ injection) plus the matching provider namespace's session commands.

## Command grammar (Slack)

Commands are native Slack slash commands (`slash_commands` events over Socket Mode), routed through a shared `dispatch()`. The ingress prefix is authoritative: `/cc-*` selects Claude and `/codex-*` selects Codex. A mismatched provider command is rejected before it can affect a session. The old commands were `./`-prefixed messages before v0.2.0.

| Command | Where | Effect |
|---|---|---|
| plain text | session channel | injected into the session (resurrects it first if needed) |
| `/cc-new [folder] [flags]`, `/codex-new [folder] [flags]` | anywhere | provider-specific project picker or Ghostty+tmux spawn (allowlisted flags, under `$HOME`) |
| `/cc-model`, `/cc-effort`, `/cc-flags`, `/cc-update` | Claude session | inspect/change Claude settings; restart/resume where required |
| `/codex-model`, `/codex-effort`, `/codex-flags`, `/codex-update` | Codex session | inspect/change Codex settings; restart/resume where required |
| `/cc-stop`, `/codex-stop` | matching session | interrupt the running turn (Claude Escape; Codex F12 binding) |
| `/cc-status`, `/codex-status` | anywhere | session info here; provider-filtered table from control |
| `/cc-kill`, `/codex-kill` | matching session or control | end a session in the selected provider namespace |
| `/cc-health`, `/cc-cleanup`, `/cc-claim` | anywhere | bridge-wide operations, intentionally singular |
| `/cc-account`, `/cc-usage` | Claude/control | Claude-only subscription and usage reporting |
| `/cc-help`, `/codex-help` | anywhere | provider-specific command list |

## Lifecycle (channel naming: `{repo}-{branch}-{yyyymmdd}-{hhmm}`)

- `SessionStart(startup)` → create private channel, invite you, post header, set topic.
- `SessionStart(resume)` → reuse mapped channel, "▶️ resumed".
- `SessionStart(clear)` → rebind channel to the new session id (same pid), "🧹 cleared".
- `SessionEnd` / liveness sweep (30s, `kill -0`) → "💤 session ended — write here to resume".
- You may rename channels freely — mapping is by immutable channel id.

## Known taxes / deferred

- Consent dialog on every launch (research preview) — one keypress locally, auto-keyed for remote spawns. Goes away if the plugin ever reaches an allowlist.
- Deferred to v2: streaming responses (chat.startStream — proven, not wired), permission relay for non-dsp sessions, file upload for >40k outputs, worktree-registry integration for richer channel names (e.g. issue numbers).
