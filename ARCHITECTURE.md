# ClaudeSlackProxy — Architecture (v1)

*Decided 2026-07-21 after the feasibility study + spike (see FEASIBILITY.md). Language: TypeScript-flavored modern JS (ESM, Node 24, no build step). All Slack mechanisms and the channel-injection path were empirically proven before this design was fixed.*

## Components

```
Slack (private channels, Socket Mode)
   ▲│
   │▼
┌────────────────────────── Mac Studio ──────────────────────────┐
│  daemon/daemon.mjs  ← launchd, owns the ONE Socket Mode conn   │
│    • HTTP 127.0.0.1:8877  (hooks in, channel-server SSE out)   │
│    • state.json  (session ↔ channel ↔ pid ↔ tmux ↔ cwd)        │
│    • lifecycle, mirroring, status, resurrection, ./commands    │
│         ▲ POST /hook              ▲ GET /channel/stream (SSE)  │
│  hooks/hook.sh (global,           channel/server.mjs           │
│  instant, CCS_BRIDGE-gated)       (per-session MCP subprocess) │
│         │                          │ notifications/claude/…    │
│  ┌─────────────────────────────────────────────┐               │
│  │ Ghostty window → tmux session → bin/ccs →   │  × N sessions │
│  │ claude --mcp-config … --dangerously-load-…  │               │
│  └─────────────────────────────────────────────┘               │
└────────────────────────────────────────────────────────────────┘
```

- **`bin/ccs`** — the launcher. Replaces `claude` (and any VibeTunnel `vt claude`). Always wraps the session in **tmux inside the terminal window** (terminal invariant preserved; tmux is what makes the session *drivable*), exports `CCS_BRIDGE=1` + `CCS_TMUX=<name>`, then execs `claude --mcp-config <generated> --dangerously-load-development-channels server:slack-bridge [args]`. The MCP config is generated at launch into `~/.config/ccs/mcp.json` with `ccs`'s resolved install path, so nothing is hardcoded.
- **`hooks/hook.sh`** — registered globally for `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `Stop`. Exits instantly unless `CCS_BRIDGE=1` (non-bridged sessions pay zero cost). Otherwise POSTs the hook JSON + `ppid` + `tmux` name to the daemon (curl, ≤2s cap, always exit 0 — hooks are synchronous).
- **`channel/server.mjs`** — MCP channel server, spawned per session by Claude Code. Declares `claude/channel`, connects outward to the daemon's SSE endpoint keyed by its claude PID, and forwards each pushed Slack message into the session as a channel event. No reply tool: outbound mirroring is done by hooks, so responses are verbatim and cost no extra model turns.
- **`daemon/daemon.mjs`** (+ `slackout.mjs`, `util.mjs`) — everything else.

## Key decisions

1. **Message-level bridge, not pty mirroring** — immune to TUI resize bugs (feasibility finding).
2. **JSON state file, not SQLite** — single-writer daemon, dozens of rows, human-inspectable, atomic tmp+rename. (Revised from the earlier SQLite suggestion; complexity wasn't buying anything.)
3. **PID is the join key.** Hooks and the channel server both report their parent PID; the daemon walks ancestry to the owning `claude` process. This is how a hook event, an SSE connection, and a tmux name all attach to the same session — and how `/clear` (new session id, same process) keeps the same channel.
4. **No archiving, ever** (design v2). Ended sessions → channel gets "💤 write here to resume". Message into a dormant channel → daemon spawns Ghostty+tmux+`ccs --resume <session-id>` in the stored cwd, queues the message, delivers it once the channel server reconnects.
5. **tmux everywhere** (inside the visible Ghostty window — the terminal invariant holds). This solves the two problems the Channels API can't: the research-preview **consent dialog** (daemon auto-acknowledges it in daemon-spawned windows via `send-keys`, since nobody is at the Mac to click it), and **in-session commands** — `/cc-model sonnet` in Slack becomes `tmux send-keys "/model sonnet" Enter`, and `/cc-stop` sends `Escape` to interrupt.
6. **Private channels only; single trusted sender.** The workspace has 35 people. Only messages from `SLACK_USER_ID` are processed; everyone else is silently ignored (and can't see the channels anyway).
7. **Mirroring is hook-driven and token-free.** `UserPromptSubmit` mirrors your terminal-typed prompts; `Stop` reads the transcript from a per-session byte offset and posts new assistant text (markdown → Block Kit, tables → native table blocks); `PreToolUse` maintains one edited-in-place status line (`⏺ Bash — npm test…`), deleted on Stop. Slack-injected messages are deduped so they don't echo back.
8. **Control channel** `#claude-code-bridge` — created by the daemon at startup for commands when no session channel exists yet: `/cc-new`, `/cc-status`, `/cc-help`. Session channels accept plain messages (→ injection) plus the session-scoped commands (`/cc-model`, `/cc-effort`, `/cc-status`, `/cc-stop`, `/cc-kill`).

## Command grammar (Slack)

Commands are native Slack slash commands (`slash_commands` events over Socket Mode), routed through a shared `dispatch()`. They were the `./`-prefixed messages before v0.2.0.

| Command | Where | Effect |
|---|---|---|
| plain text | session channel | injected into the session (resurrects it first if needed) |
| `/cc-new [folder] [--dsp] [--chrome]` | anywhere | project-picker dropdown, or spawn Ghostty+tmux+ccs in `<folder>` (allowlisted flags, under `$HOME`) |
| `/cc-model [m]`, `/cc-effort [e]` | session channel | show current value, or `tmux send-keys` the real slash command to set it |
| `/cc-stop` | session channel | interrupt the running turn (`tmux send-keys Escape`) |
| `/cc-status` | anywhere | session info in a session channel; table of all sessions from the control channel |
| `/cc-health`, `/cc-kill`, `/cc-cleanup`, `/cc-help` | anywhere | bridge status, end a session, archive dormant channels, command list |

## Lifecycle (channel naming: `{repo}-{branch}-{yyyymmdd}-{hhmm}`)

- `SessionStart(startup)` → create private channel, invite you, post header, set topic.
- `SessionStart(resume)` → reuse mapped channel, "▶️ resumed".
- `SessionStart(clear)` → rebind channel to the new session id (same pid), "🧹 cleared".
- `SessionEnd` / liveness sweep (30s, `kill -0`) → "💤 session ended — write here to resume".
- You may rename channels freely — mapping is by immutable channel id.

## Known taxes / deferred

- Consent dialog on every launch (research preview) — one keypress locally, auto-keyed for remote spawns. Goes away if the plugin ever reaches an allowlist.
- Deferred to v2: streaming responses (chat.startStream — proven, not wired), permission relay for non-dsp sessions, file upload for >40k outputs, worktree-registry integration for richer channel names (e.g. issue numbers).
