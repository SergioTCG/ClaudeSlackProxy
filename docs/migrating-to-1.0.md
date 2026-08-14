# Migrating to Slack Agent Bridge 1.0

Version 1.0 renames ClaudeSlackProxy to Slack Agent Bridge and makes Claude Code
and Codex explicit provider integrations. The migration is intentionally
in-place: it does not rename the installed protocol or create another Slack app.

## What remains unchanged

- Slack commands: `/cc-*` and `/codex-*`
- Local commands at 1.0: `ccs`, `ccs-codex`, `ccs-account`, and `ccs-spawn`.
  Starting in 1.1, `sab-cc` and `sab-codex` are canonical while the first two
  remain compatibility aliases.
- Environment variables: `CCS_*`
- Configuration and state: `~/.config/ccs`
- Local daemon port: `8877`
- LaunchAgent: `si.sergej.claudeslackproxy`
- Existing session and control channel IDs
- Slack bot/app tokens and OAuth scopes

Existing state records without `provider` continue to mean Claude.

## Before upgrading

1. Finish or pause active turns and make sure the Git checkout is clean.
2. Record the current release and installation path:

   ```bash
   BRIDGE_DIR="$HOME/.claudeslackproxy"
   git -C "$BRIDGE_DIR" describe --tags --always
   git -C "$BRIDGE_DIR" status --short
   launchctl print "gui/$(id -u)/si.sergej.claudeslackproxy" | head
   ```

3. Make a local, permission-preserving configuration backup:

   ```bash
   BACKUP_DIR="$HOME/.config/ccs-backup-before-1.0"
   mkdir -m 700 "$BACKUP_DIR"
   cp -p "$HOME/.config/ccs/env" "$BACKUP_DIR/env"
   cp -p "$HOME/.config/ccs/state.json" "$BACKUP_DIR/state.json"
   ```

The backup contains Slack credentials. Keep it mode `0700`, never commit it,
and remove it after the release is proven.

## Upgrade

After the GitHub repository has been renamed:

```bash
BRIDGE_DIR="$HOME/.claudeslackproxy"
git -C "$BRIDGE_DIR" remote set-url origin https://github.com/SergioTCG/SlackAgentBridge.git
git -C "$BRIDGE_DIR" pull --ff-only
cd "$BRIDGE_DIR"
./install.sh --provider both
```

Use `--provider claude` or `--provider codex` when only that CLI is installed.
The installer recognizes the old checkout, keeps the state directory, rewrites
the existing LaunchAgent rather than adding one, and reloads it once.

If Codex is being added before the maintenance window, `./install-codex.sh`
stages its launcher and hooks without touching the live LaunchAgent.

## Slack app and channels

An installation already using `v0.2.28` needs no Slack app update. If the app
does not yet expose `/codex-*`, apply `slack/app-manifest.json` to the existing
app. Do not create a second app and do not rotate tokens merely for the rename.

The bridge reuses the control channel ID stored in state. If that field is
missing, it searches for both `#slack-agent-bridge` and the historical
`#claude-code-bridge` before creating anything. Existing channels are not
renamed automatically.

## Acceptance checks

After the daemon returns:

1. Confirm exactly one `si.sergej.claudeslackproxy` service is loaded.
2. Run `/cc-health` and provider-specific `/cc-status` and `/codex-status`.
3. Send a prompt to one existing Claude session and one existing Codex session.
4. Start a fresh session for each installed provider.
5. Close each terminal, send a Slack prompt, and verify Ghostty opens and the
   pending prompt starts the resumed conversation.
6. Confirm no duplicate control or session channels were created.

## Roll back to v0.2.28

Only roll back a clean checkout. The 1.0 release candidate introduces no
required state-schema conversion, so the preserved state can be reused.

```bash
BRIDGE_DIR="$HOME/.claudeslackproxy"
git -C "$BRIDGE_DIR" switch --detach v0.2.28
npm -C "$BRIDGE_DIR" ci --omit=dev
launchctl kickstart -k "gui/$(id -u)/si.sergej.claudeslackproxy"
```

After diagnosing the release, return to the release branch with
`git switch main`, fast-forward it, reinstall, and restart during another maintenance
window. Restore the backed-up state only if it was independently corrupted;
blindly restoring it can discard sessions created after the backup.
