# Slack Agent Bridge

Control local [Claude Code](https://claude.com/claude-code) and
[Codex CLI](https://developers.openai.com/codex/cli/) sessions from Slack. Each
terminal session gets a private Slack channel where prompts, responses, tables,
and attachments flow both ways. Close the terminal, write in Slack later, and
the bridge opens a new Ghostty window and resumes the same conversation.

The two providers deliberately have separate command namespaces: `/cc-*` is
Claude Code and `/codex-*` is Codex. They share the reliable session, Slack,
tmux, and Ghostty infrastructure without pretending that provider-specific
capabilities are identical.

> [!WARNING]
> **This is remote code execution by design.** Slack-spawned Claude sessions
> default to `--dangerously-skip-permissions`; Slack-spawned Codex sessions
> default to `--dangerously-bypass-approvals-and-sandbox` (`--yolo`). Anyone
> able to act as the bridge owner in Slack can steer processes on this Mac.
> Read [SECURITY.md](SECURITY.md) before installing. This project is not
> affiliated with Anthropic, OpenAI, or Slack.

> [!NOTE]
> **macOS only:** the current implementation uses launchd, Ghostty, and `open`.
> Claude uses the Channels research-preview API; Codex uses lifecycle hooks and
> tmux. Linux support needs a service and terminal-spawn adapter.

## What is supported

| Capability | Claude Code | Codex CLI |
|---|---:|---:|
| Private channel per terminal session | ✓ | ✓ |
| Slack prompts and file attachments | ✓ | ✓ |
| Mirrored prompts and final responses | ✓ | ✓ |
| Terminal-close detection and Slack resume | ✓ | ✓ |
| Model and reasoning-effort controls | ✓ | ✓ |
| Approve/deny from Slack in permissioned mode | ✓ | ✓ |
| Default unattended mode | `--dangerously-skip-permissions` | `--yolo` |
| Claude subscription switching and `ccusage` | ✓ | — |
| Chrome integration flag | `--chrome` | No direct counterpart |
| Live web search flag | Provider-managed | `--search` |

Codex output uses stable hook fields and never parses its unstable transcript
JSONL. Claude retains its MCP Channel and transcript/status integration. See
[the architecture](ARCHITECTURE.md) and the original
[Claude](docs/claude-feasibility.md) and
[Codex](docs/codex-feasibility.md) feasibility studies.

## Prerequisites

- macOS and [Ghostty](https://ghostty.org)
- Node.js 20 or later, `tmux`, `jq`, and `git`
- At least one signed-in provider CLI: Claude Code, Codex CLI, or both
- A Slack workspace where you may create an app

With Homebrew, the common command-line dependencies are:

```bash
brew install node tmux jq git
```

## Install

Choose the provider set when installing. A flagless installation remains
Claude-only for compatibility with pre-1.0 behavior.

```bash
# Claude Code only (the backward-compatible default)
curl -fsSL https://raw.githubusercontent.com/SergioTCG/SlackAgentBridge/main/install.sh | bash

# Codex only
curl -fsSL https://raw.githubusercontent.com/SergioTCG/SlackAgentBridge/main/install.sh | bash -s -- --provider codex

# Both providers
curl -fsSL https://raw.githubusercontent.com/SergioTCG/SlackAgentBridge/main/install.sh | bash -s -- --provider both
```

The installer opens a pre-filled Slack app page. Create the app, install it to
the workspace, then paste its bot token (`xoxb-…`) and an app-level Socket Mode
token (`xapp-…`, scope `connections:write`). It validates both tokens, installs
the selected hooks and launchers, and loads one local LaunchAgent. Run
`/cc-claim` in Slack to bind the bridge to your Slack user.

Fresh installations use `~/.slack-agent-bridge`. An upgrade keeps an existing
`~/.claudeslackproxy` checkout, `~/.config/ccs` state, Slack channels, and the
historical launchd label. The installer will not create a second daemon or move
a working installation underneath running sessions.

### Add Codex to an existing Claude installation

The compatibility installer stages Codex without restarting the live daemon:

```bash
./install-codex.sh
```

During a safe maintenance window, restart the bridge and launch `sab-codex`.
In that first Codex session, run `/hooks` and explicitly trust the user hook,
then exit and launch it again. Hook trust is hash-based and is never bypassed.

Existing apps already configured for `v0.2.28` need no Slack changes for 1.0.
Older apps that do not have `/codex-*` must apply the canonical
[Slack app manifest](slack/app-manifest.json) to the **same app** once. This
does not change tokens or OAuth scopes and never requires a second Slack app.
Applying it again only updates metadata and command descriptions.

## Use

Start a bridged terminal locally:

```bash
sab-cc [Claude flags]
sab-codex [Codex flags]
```

The pre-1.1 commands `ccs` and `ccs-codex` remain silent compatibility aliases
throughout the 1.x release line.

A private channel named from the repository, branch, and timestamp appears and
you are invited. You may rename it; the bridge stores the immutable channel ID.

| In Slack | Effect |
|---|---|
| Any message in a session channel | Inject into that session; resume it first if dormant |
| File or image attachment | Download locally and provide the path to the agent |
| `/cc-new [folder] [flags]` / `/codex-new [folder] [flags]` | Start the selected provider |
| `/cc-model [model]` / `/codex-model [model]` | Show or change the provider model |
| `/cc-effort [level]` / `/codex-effort [level]` | Show or change reasoning effort |
| `/cc-flags [flags]` / `/codex-flags [flags]` | Show or replace allowlisted launch flags |
| `/cc-update` / `/codex-update` | Update the selected CLI and resume the session |
| `/cc-status` / `/codex-status` | Session details or a provider-filtered list |
| `/cc-stop` / `/codex-stop` | Interrupt the current turn |
| `/cc-kill [id]` / `/codex-kill [id]` | End the process; keep its resumable channel |
| `/cc-help` / `/codex-help` | Show commands for that provider |
| `/cc-account [name]` | Bind a Claude session to a stored Claude subscription |
| `/cc-usage [days [n] \| models \| limits]` | Claude usage via `ccusage`; use Codex `/usage` locally |
| `/cc-health` / `/cc-cleanup` / `/cc-claim` | Bridge-wide operations |

With no explicit Slack flags, `/cc-new` uses
`--dangerously-skip-permissions` and `/codex-new` uses Codex's canonical
dangerous flag. Explicit flags replace that default. Operator overrides are
available through `CCS_NEW_FLAGS`, `CCS_CODEX_NEW_FLAGS`, `CCS_RESUME_FLAGS`,
and `CCS_CODEX_RESUME_FLAGS`.

Claude's `--chrome` has no Codex CLI equivalent. Codex `--search` controls live
web search, not a Chrome browser; browser automation requires a separately
configured MCP server or plugin.

### Collaborators

`/cc-status` or `/codex-status` in the matching session channel provides a
user-picker for collaborators. Allowed teammates may send labelled prompts to
a live session, but cannot run slash commands, answer permission prompts, or
resurrect it. All other actions remain owner-only. The per-channel allowlist is
persisted across daemon restarts.

### Per-session Claude subscriptions

```bash
ccs-account add tina
ccs-account list
```

Use `/cc-account tina` in a Claude session or start one with
`/cc-new <folder> --account tina`. Tokens remain in
`~/.config/ccs/accounts` with mode `0600`; the launcher resolves them through
the environment so bearer tokens never appear in process arguments.

## Compatibility and upgrades

The public name and canonical launchers changed without replacing the installed
protocol:

- `/cc-*` and `/codex-*` Slack commands are unchanged.
- `sab-cc` and `sab-codex` are canonical; `ccs` and `ccs-codex` remain aliases.
- `CCS_*`, `~/.config/ccs`, state records, and port `8877` are unchanged.
- Existing `~/.claudeslackproxy` installations remain in place.
- `si.sergej.claudeslackproxy` remains the sole LaunchAgent label.
- Existing `#claude-code-bridge` control channels are reused. Fresh installs
  use `#slack-agent-bridge`.
- The installer updates only the historical upstream Git remote; contributor
  forks are left untouched.

See [the 1.0 migration guide](docs/migrating-to-1.0.md) before rolling a live
installation forward or back. Existing 1.0 installations can follow the
[1.1 launcher migration](docs/migrating-to-1.1.md) to put `sab-*` on `PATH`.

## Operations

- **Logs:** `tail -f daemon.log`
- **Config/state:** `~/.config/ccs/` (`env`, `state.json`, and accounts)
- **Restart:** `launchctl kickstart -k gui/$(id -u)/si.sergej.claudeslackproxy`
- **Disable self-update:** set `CCS_AUTO_UPDATE=0` in `~/.config/ccs/env`
- **Dockless Ghostty windows:** set `CCS_GHOSTTY_HIDDEN=1`
- **Uninstall:** boot out `~/Library/LaunchAgents/si.sergej.claudeslackproxy.plist`, then remove the launchers and exact hook entries

The daemon self-updater fast-forwards only a clean checkout with no local
commits. It refreshes dependencies when `package.json` changes, waits for active
turns when possible, exits, and lets launchd restart it. Sessions continue in
tmux and are re-adopted after restart.

## Development

Read [AGENTS.md](AGENTS.md) before changing runtime behavior. The release and
migration invariants are tested with:

```bash
npm ci
npm run audit
npm test
npm run check
```

## License

[MIT](LICENSE) © 2026 Sergej Berišaj
