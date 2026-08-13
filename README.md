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
curl -fsSL https://raw.githubusercontent.com/SergioTCG/ClaudeSlackProxy/main/install.sh | bash
```

Three steps, mostly clicking:

1. **The installer opens a pre-filled Slack app page** (your app, your workspace — nothing is shared). Click **Create**, then **Install App → Install to Workspace**, then generate an app-level token under **Basic Information → App-Level Tokens** (scope `connections:write`).
2. **Paste the two tokens** (`xoxb-…`, `xapp-…`) into the installer. It validates both live and figures out the team ID itself.
3. **Run `/cc-claim` in Slack.** The daemon records you as the owner — no digging your member ID out of your profile. Only the owner's messages are ever acted on (plus any [collaborators](#use) you whitelist per channel).

That's the whole setup. The installer also clones to `~/.claudeslackproxy` (or runs from your own clone), checks prerequisites, installs deps, symlinks `ccs`, registers hooks in `~/.claude/settings.json` (merging, never clobbering), and loads the daemon as a LaunchAgent. Idempotent — safe to re-run. From then on the bridge [keeps itself up to date](#operations).

> **Why isn't this a public "Add to Slack" app?** Socket Mode delivers an app's events over the app-level token — one shared stream per *app*, capped at 10 connections. A single public app would fan every workspace's events across every user's local daemon. Your own app means your tokens and your traffic never leave your machine, which is the point.

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
| `/cc-model [m]` / `/cc-effort [e]` | show the current value, or set it — `/cc-model` with no arg lists available models with their real versions (read from the `claude` binary); a family alias picks the 1M-context variant when one exists |
| `/cc-update` | update Claude Code (`claude update`) and restart this session with the same flags, resuming the conversation — how you pick up a new CLI build or a newly released model |
| `/cc-account [name]` | which Claude subscription pays for this session (see [Per-session subscriptions](#per-session-subscriptions)); switching restarts and resumes |
| `/cc-status` | session info + manage collaborators here, or all sessions from the control channel |
| `/cc-usage [days [n] \| models \| limits]` | token & cost usage ([ccusage](https://github.com/ryoppippi/ccusage), bundled) — project here / aggregate in control; `days` = per-day sheet (models, in/out, cache w/r), `models` = per-model totals, `limits` = live plan limits (5h session %, weekly %, reset times — same numbers as claude.ai/settings/usage) |
| `/cc-health` | bridge status |
| `/cc-stop` | interrupt the running turn |
| `/cc-kill [<id>]` | end a session (channel stays, resumable) |
| `/cc-cleanup` | archive dormant channels (from the control channel) |
| a pending tool prompt (non-`--dsp` sessions) | ✅ Approve / ⛔ Deny buttons, or `yes <id>` / `no <id>` |

**Collaborators.** From `/cc-status` in a session channel, a user-picker lets you allow specific Slack teammates to send prompts to that session (a Remove button revokes them; the current list is shown). Their prompts are injected labelled `[Slack collaborator <name>]`, so the transcript records who said what. Collaborators can send prompts only — not permission verdicts, `/cc-*` commands, or session resurrection — and only while the session is live. Everything else stays owner-only, and the whitelist is per channel and survives restarts.

While a turn runs, the terminal's spinner (verb, elapsed, tokens) mirrors into an edit-in-place status message, and the channel topic tracks `folder · branch · model · effort`. Responses over ~6,000 chars upload as a `response.md` file. Consent dialogs are auto-dismissed. Sessions never archive on their own — a dormant channel says "write here to resume," and doing so spawns a Ghostty window and continues where you left off.

## Per-session subscriptions

By default every session runs under the Mac's own Claude login. When you invite
collaborators, you can instead bind a session to **its owner's** subscription, so
each person's usage bills to their own account:

```bash
ccs-account add tina        # sign in as that person → mints a long-lived token
ccs-account list            # names, tokens masked
```

Then in the session's channel: `/cc-account tina` (restarts and resumes the same
conversation), or start one bound from the outset with
`/cc-new <folder> --account tina`. `/cc-account default` reverts to the machine's
own login. Bindings survive resume and daemon restarts.

Tokens live only in `~/.config/ccs/accounts` (mode 0600) and are resolved inside
`ccs` at launch — the command line carries only the account name, because `ps`
exposes argv to every user on the machine. A long-lived token is a bearer
credential for that subscription: treat the file like a password store, and note
that whoever administers the Mac necessarily holds it.

## Operations

- **Single Dock icon:** set `CCS_GHOSTTY_SINGLE=1` in `~/.config/ccs/env` and all
  bridge terminals live under one Ghostty icon (right-click lists every session).
  Needs a one-time Accessibility grant for the daemon's `node` binary; without it,
  spawns gracefully fall back to one instance per window. `CCS_GHOSTTY_HIDDEN=1`
  remains the dockless alternative.
- **Auto-update:** the daemon checks GitHub at startup and every 6 hours; when a
  new release lands it fast-forwards its clone, refreshes dependencies if needed,
  and restarts itself (sessions keep running — the daemon re-adopts them). It
  never touches an install with local changes or local commits. Opt out with
  `CCS_AUTO_UPDATE=0` in `~/.config/ccs/env`; update manually anytime with
  `git -C <clone> pull` + the restart command below.
- **Logs:** `tail -f daemon.log`
- **Restart the daemon:** `launchctl kickstart -k gui/$(id -u)/si.sergej.claudeslackproxy` — never `kill` by port (that also kills attached channel servers).
- **Uninstall:** `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/si.sergej.claudeslackproxy.plist`, then remove the symlink and the hooks block from `~/.claude/settings.json`.
- **Config/state:** `~/.config/ccs/` (`env`, `state.json`) — outside the repo, so `git pull` never touches your secrets.

## License

[MIT](LICENSE) © 2026 Sergej Berišaj
