# ClaudeSlackProxy

Bidirectional bridge between Slack and **local** Claude Code sessions on this Mac. Every session maps to a private Slack channel; you drive it from Slack (mirrored prompts, responses, live status, native tables), and a session with no live terminal is transparently resurrected in a Ghostty window when you write to its channel.

See `ARCHITECTURE.md` for the design and `FEASIBILITY.md` for why it's built this way.

## Status: working, deployed under launchd (2026-07-21)

Proven end-to-end on this machine: channel-per-session creation, prompt/response mirroring (with the transcript-flush race fixed), native table blocks, live status line, channel-server attach + reconnect across daemon restarts, Ghostty spawn, launchd persistence. Deferred: response streaming, permission relay for non-`--dsp` sessions, >40k file upload, Barrique registry names.

## Install (already done here, recorded for reproducibility)

1. `npm install` (MCP SDK + Slack SDKs).
2. `tmux` via Homebrew (`ccs` wraps sessions in tmux so the daemon can drive them).
3. Slack app from `spike/slack-app-manifest.yaml`; tokens + your user/team IDs in `.env` (git-ignored).
4. Global hooks in `~/.claude/settings.json` (`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `Stop`) → `hooks/hook.sh`. They no-op instantly unless `CCS_BRIDGE=1`, so non-bridged sessions cost nothing.
5. Daemon as a LaunchAgent: `~/Library/LaunchAgents/si.25seven.claudeslackproxy.plist` (`RunAtLoad`, `KeepAlive`).
6. Put `ccs` on PATH: `ln -s "$PWD/bin/ccs" /opt/homebrew/bin/ccs`.

## Use

Start a bridged session instead of `claude`:

```bash
ccs --dangerously-skip-permissions      # any claude flags pass through
```

A private channel `#{repo}-{branch}-{yyyymmdd}-{hhmm}` appears; you're invited. Rename it freely — mapping is by channel ID. Then, from Slack:

| In Slack | Effect |
|---|---|
| any message in a session channel | injected into that session (resurrects it first if the terminal is gone) |
| `./new <dir> [--dsp] [--chrome] [--model X]` | spawn a new Ghostty+tmux session (dirs under `$HOME`, allowlisted flags) |
| `./model <m>` / `./effort <e>` | sent to the session as the real slash command via tmux |
| `./status` | table of all sessions |
| `./help` | commands |

Session ends → channel gets "💤 write here to resume". Writing there spawns a Ghostty window running `claude --resume <id>` in the original cwd and rebinds. The daemon auto-clears the research-preview consent dialog for windows it spawns.

## Operations

- **Logs:** `daemon.log` (repo root). Watch: `tail -f daemon.log`.
- **Restart the daemon:** `launchctl kickstart -k gui/$(id -u)/si.25seven.claudeslackproxy`.
  **Never** `lsof -ti :8877 | xargs kill` — that also kills every attached channel server (they hold ESTABLISHED connections to 8877). Kill by PID or use launchctl.
- **Stop entirely:** `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/si.25seven.claudeslackproxy.plist`.
- **State:** `state.json` (session ↔ channel ↔ pid ↔ tmux ↔ cwd), rewritten atomically.
- **Security:** only messages from your `SLACK_USER_ID` are processed; channels are private; `./new` restricts dirs to `$HOME` and flags to an allowlist.

## Barrique integration

`scripts/run-claude-vt.sh` currently ends in `vt claude --dangerously-skip-permissions`. Replace that line with:

```bash
ccs --dangerously-skip-permissions
```

The worktree number/branch already give meaningful channel names via git. (A later step can pull the Barrique registry's issue number into the channel name.)
