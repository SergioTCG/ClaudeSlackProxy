# Migrating usage and status support to 1.2

Version 1.2 adds `/codex-usage`, live Codex time/token status, and restart-safe
topic deduplication. It does not migrate local configuration or session state.

## Slack app update required

Apply the canonical [`slack/app-manifest.json`](../slack/app-manifest.json) to
the existing Slack app once. This registers `/codex-usage`; it does not request
new OAuth scopes, replace tokens, create another app, or create another daemon.

After saving the manifest, `/codex-usage` may be used in a Codex session channel
for session/project totals or in the control channel for provider-wide totals:

```text
/codex-usage
/codex-usage days 7
/codex-usage models
```

## Local upgrade

Update the checkout that already serves the machine and rerun the same provider
installer during a maintenance window:

```bash
git pull --ff-only
./install.sh --provider both
```

Choose `claude` or `codex` instead of `both` if only one provider is installed.
The installer preserves `CCS_*`, `~/.config/ccs`, channels, hooks, tokens, tmux
names, launchers, and `si.sergej.claudeslackproxy`.
