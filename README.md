# ClaudeSlackProxy

Drive local [Claude Code](https://claude.com/claude-code) sessions from Slack, with opt-in [Codex CLI](https://learn.chatgpt.com/docs/developer-commands?surface=cli) terminal support. Every session maps to its own private Slack channel — prompts, responses, tables, and file attachments flow both ways. Close your laptop and a session keeps running on your Mac; write in its channel later and it is transparently resurrected in a new terminal window.

It's the missing piece for managing many parallel Claude Code sessions when you're away from your machine — a channel per session, from your phone.

> [!WARNING]
> **This is remote code execution by design.** Claude sessions run with `--dangerously-skip-permissions` by default; Codex sessions use their configured sandbox/approval policy. Anyone who can post as you in your Slack workspace can steer them. Read [SECURITY.md](SECURITY.md) before installing. Not affiliated with Anthropic or OpenAI.

> [!NOTE]
> **macOS only** (launchd, Ghostty, `open`). The Claude path uses the **Channels** research-preview API via `--dangerously-load-development-channels`; Codex uses lifecycle hooks plus tmux. Linux support (systemd + a terminal-agnostic spawner) is a welcome contribution.

## How it works

A launchd daemon owns one Slack [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/) connection (outbound only — no inbound ports). Claude uses global hooks plus a per-session MCP Channel server; Codex uses its lifecycle hooks for outbound events and tmux for inbound prompts. `ccs` and `ccs-codex` wrap their respective CLIs in tmux so the daemon can drive them. See [ARCHITECTURE.md](ARCHITECTURE.md), the original [Claude feasibility study](FEASIBILITY.md), and the [Codex feasibility study](CODEX-FEASIBILITY.md).

## Prerequisites

- macOS with [Homebrew](https://brew.sh)
- [Claude Code](https://claude.com/claude-code) (`claude`), signed in — a plan with the Channels research preview
- Optional: Codex CLI (`codex`), signed in, for Codex terminal sessions
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

Codex activation is deliberately separate so a Claude-only install is unchanged:

```bash
./install-codex.sh
# during a safe maintenance window:
launchctl kickstart -k gui/$(id -u)/si.sergej.claudeslackproxy
ccs-codex
```

In that first Codex session, run `/hooks` and trust the new user hook, then exit and run `ccs-codex` again. Hook trust is hash-based and is never bypassed automatically. The Codex installer merges `~/.codex/hooks.json`, links `ccs-codex`, and does **not** restart the daemon.

Existing installations must also apply the updated [Slack app manifest](spike/slack-app-manifest.json) to their existing app once. This registers the `/codex-*` command names; it does not create a second app or change the bot/app tokens or OAuth scopes.

> **Why isn't this a public "Add to Slack" app?** Socket Mode delivers an app's events over the app-level token — one shared stream per *app*, capped at 10 connections. A single public app would fan every workspace's events across every user's local daemon. Your own app means your tokens and your traffic never leave your machine, which is the point.

## Use

```bash
ccs --dangerously-skip-permissions        # any claude flags pass through
ccs-codex                                 # opt-in Codex terminal session
```

A private channel `#{repo}-{branch}-{timestamp}` appears and you're invited. Rename it freely — the mapping is by channel ID. Then, from Slack:

Commands are native Slack slash commands. `/cc-*` always means Claude Code;
`/codex-*` always means Codex. Type either prefix and Slack autocompletes it.

| In Slack | Effect |
|---|---|
| any message in a session channel | injected into that session (resurrects it if the terminal is gone) |
| a file / image attachment | downloaded and handed to the active agent as a local path to read |
| `/cc-new [folder] [flags]` / `/codex-new [folder] [flags]` | start a Claude or Codex session; no folder shows that provider's project picker; defaults come from `CCS_NEW_FLAGS` / `CCS_CODEX_NEW_FLAGS` |
| `/cc-model [m]` / `/codex-model [m]` | show or set that provider's model |
| `/cc-effort [e]` / `/codex-effort [e]` | show or set reasoning effort; Codex changes restart/resume the conversation |
| `/cc-update` / `/codex-update` | update the selected CLI and restart/resume the session with the same flags |
| `/cc-flags [flags…]` / `/codex-flags [flags…]` | show or change provider-allowlisted launch flags — restarts and resumes |
| `/cc-account [name]` | Claude-only subscription binding (see [Per-session subscriptions](#per-session-subscriptions)) |
| `/cc-status` / `/codex-status` | session info + collaborators here, or provider-filtered sessions in control |
| `/cc-stop` / `/codex-stop` | interrupt that provider's running turn |
| `/cc-kill [<id>]` / `/codex-kill [<id>]` | end that provider's session (channel stays, resumable) |
| `/cc-help` / `/codex-help` | list commands for that provider |
| `/cc-usage [days [n] \| models \| limits]` | Claude-only token/cost usage via [ccusage](https://github.com/ryoppippi/ccusage); use Codex terminal `/usage` for Codex |
| `/cc-health` / `/cc-cleanup` / `/cc-claim` | bridge-wide commands; intentionally not duplicated under `/codex-*` |
| a pending tool prompt (non-`--dsp` sessions) | ✅ Approve / ⛔ Deny buttons, or `yes <id>` / `no <id>` |

**Collaborators.** From `/cc-status` or `/codex-status` in its matching session channel, a user-picker lets you allow specific Slack teammates to send prompts to that session (a Remove button revokes them; the current list is shown). Their prompts are injected labelled `[Slack collaborator <name>]`, so the transcript records who said what. Collaborators can send prompts only — not permission verdicts, slash commands, or session resurrection — and only while the session is live. Everything else stays owner-only, and the whitelist is per channel and survives restarts.

While a Claude turn runs, the terminal's spinner (verb, elapsed, tokens) mirrors into an edit-in-place status message. Codex shows a generic working status and mirrors its stable final hook text; its unstable JSONL is never parsed. The channel topic tracks `folder · branch · model · effort`. Responses over ~6,000 chars upload as a `response.md` file. Claude consent dialogs are auto-dismissed; Codex hook trust remains an explicit local action. Sessions never archive on their own — a dormant channel says "write here to resume," and doing so spawns a Ghostty window and continues where you left off.

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

- **Dock clutter:** each session's window is its own Ghostty instance (macOS
  Ghostty has no IPC to open windows in a running one), so by default each adds a
  Dock icon. Set `CCS_GHOSTTY_HIDDEN=1` in `~/.config/ccs/env` to run them as
  accessory windows instead — fully visible and titled with the channel topic,
  but **no Dock icons at all**; reach them via Mission Control or `tmux attach`.
  (`CCS_GHOSTTY_SINGLE=1` aimed to put every window under one shared icon via UI
  scripting; current Ghostty ignores programmatic window creation, so it degrades
  to one instance per session after a restart — see the 0.2.25 changelog.)
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
