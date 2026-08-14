# Migrating launchers to 1.1

Version 1.1 gives the provider launchers names derived from Slack Agent Bridge:

| Provider | Canonical command | Compatibility alias |
|---|---|---|
| Claude Code | `sab-cc` | `ccs` |
| Codex CLI | `sab-codex` | `ccs-codex` |

The aliases are silent argument-preserving wrappers and remain supported for
the entire 1.x line. Slack commands, `CCS_*`, `~/.config/ccs`, tmux names,
session state, hooks, tokens, and the LaunchAgent do not change.

The daemon uses the canonical launchers directly after updating. Existing
installations should rerun the installer once to create the new `PATH` symlinks:

```bash
# Use the checkout that already serves this machine:
cd "$HOME/.claudeslackproxy"   # legacy installation
# cd "$HOME/.slack-agent-bridge" # neutral installation
./install.sh --provider both
command -v sab-cc sab-codex ccs ccs-codex
```

Choose `claude` or `codex` instead of `both` if only one provider is installed.
No Slack app, manifest, command, token, or scope update is required.
