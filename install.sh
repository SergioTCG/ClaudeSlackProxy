#!/bin/bash
# ClaudeSlackProxy installer (macOS). Idempotent — safe to re-run.
#   ./install.sh            interactive install
#   curl -fsSL <raw>/install.sh | bash   (clones nothing; run from a clone)
set -euo pipefail

BRIDGE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${CCS_CONFIG_DIR:-$HOME/.config/ccs}"
BIN_DIR="/opt/homebrew/bin"
LABEL="si.sergej.claudeslackproxy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SETTINGS="$HOME/.claude/settings.json"
LOG="$BRIDGE/daemon.log"

say() { printf '%s\n' "$*"; }

say "Installing ClaudeSlackProxy from $BRIDGE"

# ---- 1. prerequisites -------------------------------------------------------
missing=0
for cmd in node npm tmux git jq claude; do
  if command -v "$cmd" >/dev/null 2>&1; then say "  ✓ $cmd"; else say "  ✗ missing: $cmd"; missing=1; fi
done
[ -d /Applications/Ghostty.app ] || say "  ! Ghostty not found — remote spawn/resume needs it (https://ghostty.org)"
if [ "$missing" = 1 ]; then say "Install the missing prerequisites and re-run."; exit 1; fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || { say "Node >= 18 required (have $(node -v))"; exit 1; }

# ---- 2. dependencies --------------------------------------------------------
say "Installing dependencies…"
( cd "$BRIDGE" && { npm ci --omit=dev >/dev/null 2>&1 || npm install --omit=dev >/dev/null 2>&1; } )

# ---- 3. link ccs + make scripts executable ----------------------------------
mkdir -p "$BIN_DIR"
ln -sf "$BRIDGE/bin/ccs" "$BIN_DIR/ccs"
chmod +x "$BRIDGE/bin/ccs" "$BRIDGE/bin/ccs-consent" "$BRIDGE/hooks/hook.sh" \
         "$BRIDGE/daemon/daemon.mjs" "$BRIDGE/channel/server.mjs" 2>/dev/null || true
say "  linked $BIN_DIR/ccs"

# ---- 4. config + Slack tokens ----------------------------------------------
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/env" ]; then
  if [ -t 0 ]; then
    say "Slack tokens (create an app from spike/slack-app-manifest.yaml first):"
    read -r -p "  SLACK_BOT_TOKEN (xoxb-…): " BOT
    read -r -p "  SLACK_APP_TOKEN (xapp-…): " APP
    read -r -p "  SLACK_USER_ID  (U…): " SUSER
    read -r -p "  SLACK_TEAM_ID  (T…): " STEAM
    umask 177
    cat > "$CONFIG_DIR/env" <<EOF
SLACK_BOT_TOKEN=$BOT
SLACK_APP_TOKEN=$APP
SLACK_USER_ID=$SUSER
SLACK_TEAM_ID=$STEAM
EOF
    say "  wrote $CONFIG_DIR/env"
  else
    say "  ! No TTY — create $CONFIG_DIR/env yourself with SLACK_BOT_TOKEN / SLACK_APP_TOKEN / SLACK_USER_ID / SLACK_TEAM_ID, then re-run."
    exit 1
  fi
else
  say "  $CONFIG_DIR/env exists — keeping it"
fi

# ---- 5. register hooks in settings.json (non-destructive, idempotent) -------
mkdir -p "$(dirname "$SETTINGS")"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
HOOK="$BRIDGE/hooks/hook.sh"
for ev in SessionStart SessionEnd UserPromptSubmit PreToolUse Stop; do
  tmp="$(mktemp)"
  jq --arg ev "$ev" --arg cmd "$HOOK" '
    .hooks = (.hooks // {}) |
    .hooks[$ev] = ((.hooks[$ev] // []) as $arr |
      if ([$arr[].hooks[]?.command] | index($cmd)) then $arr
      else $arr + [{matcher: ".*", hooks: [{type: "command", command: $cmd}]}] end)
  ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
done
say "  registered hooks in $SETTINGS"

# ---- 6. LaunchAgent ---------------------------------------------------------
NODE_BIN="$(command -v node)"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$BRIDGE/daemon/daemon.mjs</string></array>
  <key>WorkingDirectory</key><string>$BRIDGE</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>ProcessType</key><string>Interactive</string>
</dict></plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
say "  loaded LaunchAgent $LABEL"

say ""
say "✅ Installed. The daemon is running; it creates a private #claude-code-bridge control channel."
say "   Start a bridged session anywhere:   ccs --dangerously-skip-permissions"
say "   Logs:  tail -f $LOG"
