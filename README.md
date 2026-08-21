# Slack Agent Bridge

Control local [Claude Code](https://claude.com/claude-code),
[Codex CLI](https://developers.openai.com/codex/cli/), and
[Pi](https://github.com/earendil-works/pi) sessions from Slack. Each terminal
session gets a private Slack channel where prompts, responses, tables, and
attachments flow both ways. Close the terminal, write in Slack later, and the
bridge opens a new Ghostty window and resumes the same native conversation.

The providers deliberately have separate command namespaces: `/cc-*` is Claude
Code, `/codex-*` is Codex, and `/pi-*` is Pi. They share the reliable session,
Slack, tmux, and Ghostty infrastructure without pretending that
provider-specific capabilities are identical. A channel can safely hand work
between providers while preserving a separate resumable native conversation
for each one it has used.

> [!WARNING]
> **This is remote code execution by design.** Slack-spawned Claude sessions
> default to `--dangerously-skip-permissions`; Slack-spawned Codex sessions
> default to `--dangerously-bypass-approvals-and-sandbox` (`--yolo`). Pi's
> built-in tools are unrestricted by default; SAB's optional `--safe`
> flag adds fail-closed Slack approval per tool call. Anyone able to act as the
> bridge owner in Slack can steer processes on this Mac.
> Read [SECURITY.md](SECURITY.md) before installing. This project is not
> affiliated with Anthropic, OpenAI, or Slack.

> [!NOTE]
> **macOS only:** the current implementation uses launchd, Ghostty, and `open`.
> Claude uses the Channels research-preview API; Codex uses lifecycle hooks and
> tmux; Pi uses an explicitly loaded native extension. Linux support needs a
> service and terminal-spawn adapter.

## What is supported

| Capability | Claude Code | Codex CLI | Pi |
|---|---:|---:|---:|
| Private channel per terminal session | ✓ | ✓ | ✓ |
| Slack prompts and file attachments | ✓ | ✓ | ✓ |
| Native image input when the model supports it | Path | Path | ✓ |
| Return generated files to Slack | ✓ | ✓ | ✓ |
| Mirrored prompts and final responses | ✓ | ✓ | ✓ |
| Terminal-close detection and Slack resume | ✓ | ✓ | ✓ |
| Model and reasoning/thinking controls | ✓ | ✓ | ✓ |
| Approve/deny from Slack in permissioned mode | ✓ | ✓ | `--safe` |
| Default unattended mode | `--dangerously-skip-permissions` | `--yolo` | unrestricted tools |
| Live working status with time and token counters | ✓ | ✓ | ✓ |
| Token and cost usage | `ccusage` | `ccusage` | native event ledger |
| Handoff among providers in one Slack channel | ✓ | ✓ | ✓ |
| Persistent plan/goal/review orchestration | — | — | adaptive; `/pi-run` controls |
| Claude subscription switching | ✓ | — | — |
| Chrome integration flag | `--chrome` | No counterpart | No counterpart |
| Live web search flag | Provider-managed | `--search` | model/provider-managed |

While a turn is active, its live status remains the newest channel item: newer
messages, bridge output, artifact deliveries, and topic notices re-anchor the
timer without resetting its elapsed-time or token state.

Codex output uses stable hook fields and the bridge never parses its unstable
transcript JSONL directly; usage telemetry is delegated to `ccusage`'s public
Codex JSON adapter. Pi uses its native extension API for inbound messages,
lifecycle, settings, usage, and safe-mode decisions; the bridge does not parse
Pi session files. Claude retains its MCP Channel and transcript/status
integration. See [the architecture](ARCHITECTURE.md) and the
[Claude](docs/claude-feasibility.md) and
[Codex](docs/codex-feasibility.md) feasibility studies, plus the
[Pi integration study](docs/pi-feasibility.md). Pi's adaptive orchestration is
documented in [Managed Pi runs](docs/pi-managed-runs.md).

## Prerequisites

- macOS and [Ghostty](https://ghostty.org)
- Node.js 20 or later, `tmux`, `jq`, and `git`
- At least one configured provider CLI: Claude Code, Codex CLI, and/or Pi
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

# Pi only
curl -fsSL https://raw.githubusercontent.com/SergioTCG/SlackAgentBridge/main/install.sh | bash -s -- --provider pi

# Claude + Codex (the historical meaning of "both")
curl -fsSL https://raw.githubusercontent.com/SergioTCG/SlackAgentBridge/main/install.sh | bash -s -- --provider both

# Claude + Codex + Pi
curl -fsSL https://raw.githubusercontent.com/SergioTCG/SlackAgentBridge/main/install.sh | bash -s -- --provider all
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

### Add Pi to an existing installation

Stage the launcher and trusted extension without restarting the live daemon:

```bash
./install-pi.sh
```

Pi needs no global hook or extension registration. `sab-pi` explicitly loads
the versioned bridge extension from this checkout on every bridged launch, so
ordinary `pi` sessions remain untouched. Restart the daemon only in a
controlled maintenance window after the release checks pass.

Apps upgrading to 1.5 must apply the canonical
[Slack app manifest](slack/app-manifest.json) to the **same app** once to
register the `/pi-*` namespace and update the two older switch commands for an
explicit Pi target. Older apps also receive any previously missing commands.
This does not change tokens or OAuth scopes and never requires a second Slack
app. Applying it again only updates command registrations, metadata, and
descriptions.

## Use

Start a bridged terminal locally:

```bash
sab-cc [Claude flags]
sab-codex [Codex flags]
sab-pi [Pi flags]
```

The pre-1.1 commands `ccs` and `ccs-codex` remain silent compatibility aliases
throughout the 1.x release line.

A private channel named from the repository, branch, and timestamp appears and
you are invited. You may rename it; the bridge stores the immutable channel ID.

| In Slack | Effect |
|---|---|
| Any message in a session channel | Inject into that session; owner Pi prompts are adaptively routed by default |
| File or image attachment | Download locally and provide the path to the agent |
| “Create/export … and send it here” | Generate files and attach them back to this channel or thread |
| `/cc-new [folder] [flags]` / `/codex-new …` / `/pi-new …` | Start the selected provider |
| `/cc-model [model]` / `/codex-model …` / `/pi-model [provider/model]` | Show or change the provider model |
| `/cc-effort [level]` / `/codex-effort …` / `/pi-effort …` | Show or change reasoning/thinking effort |
| `/pi-run [plan] <goal> [budgets]` | Force a persistent planner → worker → independent-reviewer run; omit the goal for status |
| `/pi-run mode [auto\|always\|native]` / `/pi-run direct <prompt>` | Persist the Pi routing policy or bypass it once |
| `/cc-flags [flags]` / `/codex-flags …` / `/pi-flags …` | Show or replace allowlisted launch flags |
| `/cc-update` / `/codex-update` / `/pi-update` | Update the selected CLI and resume the session |
| `/cc-status` / `/codex-status` / `/pi-status` | Session details or a provider-filtered list |
| `/cc-stop` / `/codex-stop` / `/pi-stop` | Interrupt the current turn; Codex confirms idle or reports that the interrupt is still pending |
| `/cc-switch [codex\|pi] [new]` / `/codex-switch [claude\|pi] [new]` / `/pi-switch <claude\|codex> [new]` | Hand this channel to another provider; `new` explicitly replaces a missing saved leg |
| `/cc-kill [id]` / `/codex-kill [id]` / `/pi-kill [id]` | End the process; keep its resumable channel |
| `/cc-help` / `/codex-help` / `/pi-help` | Show commands for that provider |
| `/cc-account [name]` | Bind a Claude session to a stored Claude subscription |
| `/cc-usage [days [n] \| models \| limits]` | Claude token, cost, model, and plan-limit usage via `ccusage` |
| `/codex-usage [days [n] \| models]` | Codex session/project or aggregate token and cost usage via `ccusage` |
| `/pi-usage [days [n] \| models]` | Pi session/project token, cost, model, and current-context usage from native events |
| `/cc-health` / `/cc-cleanup` / `/cc-claim` | Bridge-wide operations |

With no explicit Slack flags, `/cc-new` uses
`--dangerously-skip-permissions` and `/codex-new` uses Codex's canonical
dangerous flag. Explicit flags replace that default. Operator overrides are
available through `CCS_NEW_FLAGS`, `CCS_CODEX_NEW_FLAGS`, `CCS_RESUME_FLAGS`,
`CCS_CODEX_RESUME_FLAGS`, `CCS_PI_NEW_FLAGS`, and `CCS_PI_RESUME_FLAGS`. Pi
needs no dangerous-mode flag because its built-in tools are already
unrestricted; use SAB `--safe` for fail-closed Slack approval of each Pi tool
call. Pi's native `--approve` trusts project-local settings/extensions/skills
for that run and is not a tool-permission flag.

Claude's `--chrome` has no Codex or Pi equivalent. Codex `--search` controls
live web search, not a Chrome browser; Pi capabilities come from its selected
provider/model and configured extensions/tools. Browser automation requires a
separately configured integration.

### Switch providers without changing channels

Run the source provider's switch command in an active, idle session channel and
name the target: `/cc-switch pi`, `/codex-switch pi`, or
`/pi-switch claude`, for example. The historical bare `/cc-switch` and
`/codex-switch` forms still default to Codex and Claude respectively; Pi always
requires an explicit target. The command namespace identifies the source. The
bridge previews the target leg and its provider-native flags, then waits for
owner confirmation.

The source first produces a private, structured handoff. The bridge stores it
under `~/.config/ccs/handoffs` with restrictive permissions, stops the source,
starts or resumes the target's own native conversation, and runs a read-only
readiness turn. The Slack channel changes hands only after that turn succeeds.
Owner messages arriving during the transaction are queued and receive fresh
artifact grants after commit; collaborators are blocked until it finishes. On
failure or daemon restart, the provisional target is discarded and the source
mapping is restored.

A provisional target does not receive its private validation prompt merely
because tmux exists. Claude and Codex wait for their visible input surfaces; Pi
waits for its authenticated native extension stream. The bridge reports any
local trust gate in Slack and requires the target adapter to claim the native
session before commit. The channel topic intentionally remains on the source
provider throughout this private validation window.

Each channel may therefore have one active leg and up to two preserved standby
legs. Models, effort, launch flags, and Claude subscription choice stay with
their native provider and are never translated. A round trip resumes the
original native conversation. If a saved state record is missing, the bridge
refuses to replace it silently and asks for the source provider's explicit
`-switch <target> new` form.

Before the first switch, the bridge inspects only repository-root `AGENTS.md`
and `CLAUDE.md`; it never imports provider-global memory or `MEMORY.md`. When
they need alignment, an auxiliary provider returns bounded document sections
from a private neutral directory; the bridge constructs the constrained Git
patch itself. The owner reviews the complete proposal before it is applied as
ordinary uncommitted work. Applying is protected by file hashes, path and
symlink validation, `git apply --check`, and Codex's 32 KiB project instruction
budget. Progress is reported every minute. Generation defaults to a bounded
ten-minute ceiling; set `CCS_INSTRUCTION_TIMEOUT_SECONDS` in
`~/.config/ccs/env` to choose a value from 60 through 1800 seconds. Switching
without changing instructions remains available.

### Collaborators

`/cc-status`, `/codex-status`, or `/pi-status` in the matching session channel
provides a user-picker for collaborators. Allowed teammates may send labelled
prompts to a live session, but cannot run slash commands, answer permission
prompts, or resurrect it. All other actions remain owner-only. The per-channel
allowlist is persisted across daemon restarts.

### Return generated files to Slack

Ask naturally in a session channel, for example: “Export `report.html` as a PDF
and send it here.” The accepted prompt gives that agent turn a short-lived,
one-use capability to invoke `sab-upload`; the bot then attaches the generated
file to the same Slack channel or existing thread.

The destination is daemon-controlled. Files must resolve inside the session's
workspace, be regular files, and total no more than 100 MiB across at most ten
files. Path traversal and symlink escapes are rejected. The owner and explicitly
allowed channel collaborators may request artifacts; messages from everyone
else are ignored before an upload grant exists. If the daemon restarts before
delivery, resend the Slack request to obtain a fresh grant.

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

- `/cc-*` remains Claude and `/codex-*` remains Codex; 1.5 adds `/pi-*` without
  changing either established namespace or their bare-switch defaults.
- `sab-cc`, `sab-codex`, and `sab-pi` are canonical; `sab-upload` is their
  shared, grant-bound artifact helper; `ccs` and `ccs-codex` remain aliases.
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
For the new Codex usage command and its one-time manifest refresh, see the
[1.2 migration guide](docs/migrating-to-1.2.md).
Generated-file delivery requires no Slack app change; see the
[1.3 migration guide](docs/migrating-to-1.3.md).
Provider handoff requires the same-app command refresh described in the
[1.4 migration guide](docs/migrating-to-1.4.md).
Pi activation and the one-time `/pi-*` manifest refresh are covered in the
[1.5 migration guide](docs/migrating-to-1.5.md).

## Operations

- **Logs:** `tail -f daemon.log`
- **Config/state:** `~/.config/ccs/` (`env`, `state.json`, accounts, and private handoffs)
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
