# Migrating to 1.5

Version 1.5 adds Pi as a third provider adapter. It preserves the established
Claude Code and Codex command namespaces, launchers, session state, bare switch
defaults, LaunchAgent label, local port, control channel, and Slack tokens.

## Stage the integration

Install and configure Pi normally on the Mac, then stage its bridge launcher
without touching the live daemon:

```bash
./install-pi.sh
```

For a fresh installation, `--provider pi` installs only Pi support and
`--provider all` installs Claude, Codex, and Pi. The historical
`--provider both` deliberately remains Claude+Codex so old automation does not
silently gain a third remote-execution surface.

`sab-pi` explicitly loads `pi/sab-extension.ts` on bridged runs. It does not
write Pi's global extension configuration, and ordinary `pi` sessions remain
unchanged.

## Update the existing Slack app

Apply [`slack/app-manifest.json`](../slack/app-manifest.json) to the **same Slack
app** once. This registers `/pi-model`, `/pi-effort`, `/pi-new`, `/pi-status`,
`/pi-usage`, `/pi-flags`, `/pi-update`, `/pi-stop`, `/pi-switch`, `/pi-kill`,
and `/pi-help`, and updates the older switch descriptions.

No OAuth scopes, event subscriptions, bot token, app token, second manifest,
second daemon, or second app are required. Existing channels are not renamed.

## State and command compatibility

No bulk migration runs. Missing `session.provider` still means Claude. Existing
two-provider lineage records acquire an empty Pi leg lazily when next touched.
The active mapping remains `state.channels[channel]`, and only its active leg
has `session.channel`.

Bare `/cc-switch` still targets Codex and bare `/codex-switch` still targets
Claude. To involve Pi, name the target explicitly. `/pi-switch` always requires
`claude` or `codex` because there is no unambiguous historical default.

Pi flags, model, thinking level, and native session ID stay on the Pi leg and
resume with it. No provider settings are translated during handoff.

## Safety choices

Pi built-in tools are unrestricted by default. A flagless `/pi-new` therefore
has unattended local privileges, analogous in effect—but not flag syntax—to the
other providers' dangerous defaults. Use `/pi-new <folder> --safe` or set
`CCS_PI_NEW_FLAGS=--safe` and `CCS_PI_RESUME_FLAGS=--safe` for fail-closed Slack
approval of Pi tool calls.

Pi `--approve` is different: it trusts project-local settings, extensions,
skills, and packages for the run. The bridge relays that trust prompt separately
and never treats it as tool approval.

## Controlled rollout

Follow [`release-checklist.md`](release-checklist.md). At minimum:

1. Record the previous release tag and back up `~/.config/ccs` privately.
2. Confirm `PI_OFFLINE=1 pi --extension ./pi/sab-extension.ts --list-models`
   loads the extension with the installed Pi version.
3. Apply the manifest to the existing Slack app.
4. Roll exactly one daemon in an idle maintenance window.
5. Canary local `sab-pi`, Slack `/pi-new`, inbound text, a supported image,
   final mirroring, working counters, model/thinking changes, interrupt, usage,
   artifact return, terminal-close resume, and `--safe` approval.
6. Canary Claude→Pi→Claude and Codex→Pi→Codex, then a three-way lineage, while
   confirming only one process and channel leg are active.
7. Force target startup failure and daemon restart during validation to prove
   rollback remains source-authoritative.

Do not promote the RC until those canaries pass without duplicate Slack
channels or a second Socket Mode connection.

## Rollback

Stop the daemon, restore the pre-upgrade state backup, return the checkout to
the recorded 1.4 tag, refresh dependencies if needed, and start the historical
LaunchAgent label. The Slack app may keep the extra `/pi-*` commands; the older
daemon will not service them. Never run old and new daemons simultaneously
against the same app token.
