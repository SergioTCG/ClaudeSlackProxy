# ClaudeSlackProxy

Drive local [Claude Code](https://claude.com/claude-code) sessions from Slack. Every session maps to its own private Slack channel — your prompts, Claude's responses, live tool-status, native tables, and file attachments all flow both ways. Close your laptop and a session keeps running on your Mac; write in its channel later and it's transparently resurrected in a new terminal window.

It's the missing piece for managing many parallel Claude Code sessions when you're away from your machine — a channel per session, from your phone.

> [!WARNING]
> **This is remote code execution by design.** Bridged sessions run with `--dangerously-skip-permissions`, so anyone who can post as you in your Slack workspace can run commands on your computer. Read [SECURITY.md](SECURITY.md) before installing. Not affiliated with Anthropic.

> [!NOTE]
> **macOS only** (launchd, Ghostty, `open`). Built on Claude Code's **Channels** research-preview API via `--dangerously-load-development-channels` — that flag and contract can change and break this at any time. Linux support (systemd + a terminal-agnostic spawner) is a welcome contribution.

## How it works

A launchd daemon owns one Slack [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/) connection (outbound only — no inbound ports). Global Claude Code hooks mirror each session to its channel; a small per-session MCP "channel" server injects Slack messages back into the running session. `ccs` is a launcher that wraps `claude` in tmux so the daemon can drive it. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design and [FEASIBILITY.md](FEASIBILITY.md) for why it's built this way.

## Prerequisites

- macOS with [Homebrew](https://brew.sh)
- [Claude Code](https://claude.com/claude-code) (`claude`), signed in — a plan with the Channels research preview
- `node` ≥ 18, `tmux`, `jq`, `git` — `brew install node tmux jq git`
- [Ghostty](https://ghostty.org) (for remote session spawn/resume)
- A Slack workspace where you can create an app

## Install

```bash
git clone https://github.com/SergioTCG/ClaudeSlackProxy.git
cd ClaudeSlackProxy
./install.sh
```

The installer checks prerequisites, installs deps, symlinks `ccs` into `/opt/homebrew/bin`, registers the hooks in `~/.claude/settings.json` (merging, never clobbering), writes your tokens to `~/.config/ccs/env`, and loads the daemon as a LaunchAgent. It's idempotent — safe to re-run.

### Set up the Slack app first

1. At [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From a manifest**, pick your workspace, and paste [`spike/slack-app-manifest.yaml`](spike/slack-app-manifest.yaml).
2. **Basic Information → App-Level Tokens**: generate a token with `connections:write` → this is your `xapp-…` (`SLACK_APP_TOKEN`).
3. **Install App** → install to the workspace → copy the **Bot User OAuth Token** → `xoxb-…` (`SLACK_BOT_TOKEN`).
4. Your `SLACK_USER_ID` (`U…`) and `SLACK_TEAM_ID` (`T…`) are visible in your Slack profile / workspace details. Only messages from that one user ID are ever acted on.

`install.sh` prompts for these four values.

## Use

```bash
ccs --dangerously-skip-permissions        # any claude flags pass through
```

A private channel `#{repo}-{branch}-{timestamp}` appears and you're invited. Rename it freely — the mapping is by channel ID. Then, from Slack:

Commands are native Slack slash commands — type `/cc-` and Slack autocompletes them:

| In Slack | Effect |
|---|---|
| any message in a session channel | injected into that session (resurrects it if the terminal is gone) |
| a file / image attachment | downloaded and handed to Claude as a local path to read |
| `/cc-new [folder] [--dsp] [--chrome]` | start a session — no argument shows a project picker (dirs under `$HOME`) |
| `/cc-model [m]` / `/cc-effort [e]` | show the current value, or set it |
| `/cc-status` | session info here (folder, branch, git, model, effort), or all sessions from the control channel |
| `/cc-health` | bridge status |
| `/cc-stop` | interrupt the running turn |
| `/cc-kill [<id>]` | end a session (channel stays, resumable) |
| `/cc-cleanup` | archive dormant channels (from the control channel) |
| a pending tool prompt (non-`--dsp` sessions) | ✅ Approve / ⛔ Deny buttons, or `yes <id>` / `no <id>` |

While a turn runs, the terminal's spinner (verb, elapsed, tokens) mirrors into an edit-in-place status message, and the channel topic tracks `folder · branch · model · effort`. Responses over ~6,000 chars upload as a `response.md` file. Consent dialogs are auto-dismissed. Sessions never archive on their own — a dormant channel says "write here to resume," and doing so spawns a Ghostty window and continues where you left off.

## Operations

- **Logs:** `tail -f daemon.log`
- **Restart the daemon:** `launchctl kickstart -k gui/$(id -u)/si.sergej.claudeslackproxy` — never `kill` by port (that also kills attached channel servers).
- **Uninstall:** `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/si.sergej.claudeslackproxy.plist`, then remove the symlink and the hooks block from `~/.claude/settings.json`.
- **Config/state:** `~/.config/ccs/` (`env`, `state.json`) — outside the repo, so `git pull` never touches your secrets.

## License

[MIT](LICENSE) © 2026 Sergej Berišaj
