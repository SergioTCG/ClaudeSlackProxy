# Migrating artifact delivery to 1.3

Version 1.3 lets Claude Code and Codex return generated workspace files to the
Slack channel that requested them. It adds the shared `sab-upload` helper and a
grant-bound loopback daemon endpoint; agents invoke the helper automatically
when an accepted Slack prompt explicitly asks for a file.

## No Slack app update required

The canonical Slack manifest already declares `files:write`, and the bridge
already uses Slack's current `filesUploadV2` flow for oversized Markdown
responses. Version 1.3 adds no command, event subscription, scope, token, app,
channel, state migration, or second daemon. Do not create or install another
Slack app.

## Local upgrade

During a maintenance window, update the existing checkout and rerun its provider
installer so `sab-upload` is linked onto `PATH` and the daemon is reloaded:

```bash
git pull --ff-only
./install.sh --provider both
```

Choose `claude` or `codex` if only one provider is installed. Existing sessions,
channels, hooks, launch flags, configuration, and the historical LaunchAgent
identity are preserved. Upload grants are intentionally ephemeral, so resend an
artifact request made before a daemon restart.
