#!/bin/bash
# Opt-in Codex bridge activation. This does not restart the live Slack daemon.
set -euo pipefail

BRIDGE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${CCS_BIN_DIR:-/opt/homebrew/bin}"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
HOOKS_FILE="$CODEX_DIR/hooks.json"
HOOK="$BRIDGE/hooks/codex-hook.sh"

for cmd in codex tmux jq; do
  command -v "$cmd" >/dev/null 2>&1 || { printf 'Missing prerequisite: %s\n' "$cmd" >&2; exit 1; }
done

mkdir -p "$BIN_DIR" "$CODEX_DIR"
ln -sf "$BRIDGE/bin/ccs-codex" "$BIN_DIR/ccs-codex"
chmod +x "$BRIDGE/bin/ccs-codex" "$HOOK"
[ -f "$HOOKS_FILE" ] || printf '{}\n' > "$HOOKS_FILE"

for ev in SessionStart SessionEnd UserPromptSubmit Stop; do
  tmp="$(mktemp)"
  jq --arg ev "$ev" --arg cmd "$HOOK" '
    .hooks = (.hooks // {}) |
    .hooks[$ev] = ((.hooks[$ev] // []) as $arr |
      if ([$arr[].hooks[]?.command] | index($cmd)) then $arr
      else $arr + [{hooks: [{type: "command", command: $cmd, timeout: 3}]}] end)
  ' "$HOOKS_FILE" > "$tmp" && mv "$tmp" "$HOOKS_FILE"
done

tmp="$(mktemp)"
jq --arg cmd "$HOOK" '
  .hooks = (.hooks // {}) |
  .hooks.PermissionRequest = ((.hooks.PermissionRequest // []) as $arr |
    if ([$arr[].hooks[]?.command] | index($cmd)) then $arr
    else $arr + [{matcher: ".*", hooks: [{type: "command", command: $cmd, timeout: 590, statusMessage: "Waiting for Slack approval"}]}] end)
' "$HOOKS_FILE" > "$tmp" && mv "$tmp" "$HOOKS_FILE"

printf 'Codex bridge files installed. The live daemon was not restarted.\n'
printf 'After deploying/restarting the daemon during a safe window:\n'
printf '  1. Run: ccs-codex\n'
printf '  2. In Codex, run /hooks and trust the new user hook.\n'
printf '  3. Exit and run ccs-codex once more so SessionStart is bridged.\n'
printf '  4. Apply the updated Slack app manifest once to register /codex-* commands.\n'
printf '  5. Start later sessions from Slack with: /codex-new <folder>\n'
