#!/bin/bash
# ClaudeSlackProxy installer (macOS). Idempotent — safe to re-run.
#   One-liner:     curl -fsSL https://raw.githubusercontent.com/SergioTCG/ClaudeSlackProxy/main/install.sh | bash
#   From a clone:  ./install.sh
set -euo pipefail

REPO_URL="https://github.com/SergioTCG/ClaudeSlackProxy.git"
BRIDGE="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null && pwd)"
[ -n "$BRIDGE" ] || BRIDGE="$(pwd)"
# Piped via curl (or run outside a clone): clone to a standard spot, hand off.
if [ ! -f "$BRIDGE/daemon/daemon.mjs" ]; then
  DEST="${CCS_HOME:-$HOME/.claudeslackproxy}"
  echo "Cloning ClaudeSlackProxy to $DEST..."
  if [ -d "$DEST/.git" ]; then git -C "$DEST" pull --ff-only || true; else git clone "$REPO_URL" "$DEST"; fi
  exec bash "$DEST/install.sh"
fi
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
ln -sf "$BRIDGE/bin/ccs-spawn" "$BIN_DIR/ccs-spawn"
chmod +x "$BRIDGE/bin/ccs" "$BRIDGE/bin/ccs-consent" "$BRIDGE/bin/ccs-window" "$BRIDGE/bin/ccs-spawn" "$BRIDGE/hooks/hook.sh" \
         "$BRIDGE/daemon/daemon.mjs" "$BRIDGE/channel/server.mjs" 2>/dev/null || true
say "  linked $BIN_DIR/ccs"

# ---- 4. config + Slack app (pre-filled creation link, 2 tokens, no IDs) -----
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/env" ]; then
  if [ -r /dev/tty ]; then
    MANIFEST="$BRIDGE/spike/slack-app-manifest.json"
    APP_URL="https://api.slack.com/apps?new_app=1&manifest_yaml=$(node -e 'process.stdout.write(encodeURIComponent(require("fs").readFileSync(process.argv[1],"utf8")))' "$MANIFEST")"
    say ""
    say "Create your Slack app — the page opens PRE-FILLED, you just click through:"
    say "  1. Pick your workspace → Next → Create."
    say "  2. Left sidebar: Install App → Install to Workspace → Allow."
    say "     Copy the Bot User OAuth Token (xoxb-…)."
    say "  3. Basic Information → App-Level Tokens → Generate Token and Scopes:"
    say "     name it anything, add scope connections:write, Generate. Copy it (xapp-…)."
    open "$APP_URL" 2>/dev/null || say "  Open this URL: $APP_URL"
    read -r -p "  SLACK_BOT_TOKEN (xoxb-…): " BOT < /dev/tty
    read -r -p "  SLACK_APP_TOKEN (xapp-…): " APP < /dev/tty
    # Validate both tokens live and derive the team id — typos fail here, not at 2am.
    AUTH="$(curl -s -H "Authorization: Bearer $BOT" https://slack.com/api/auth.test)"
    [ "$(printf %s "$AUTH" | jq -r .ok)" = "true" ] || { say "  ✗ bot token rejected ($(printf %s "$AUTH" | jq -r .error)) — re-run install.sh"; exit 1; }
    STEAM="$(printf %s "$AUTH" | jq -r .team_id)"
    CONN="$(curl -s -X POST -H "Authorization: Bearer $APP" https://slack.com/api/apps.connections.open)"
    [ "$(printf %s "$CONN" | jq -r .ok)" = "true" ] || { say "  ✗ app token rejected ($(printf %s "$CONN" | jq -r .error)) — needs scope connections:write; re-run install.sh"; exit 1; }
    say "  ✓ tokens valid for workspace \"$(printf %s "$AUTH" | jq -r .team)\" (team $STEAM)"
    umask 177
    cat > "$CONFIG_DIR/env" <<EOF
SLACK_BOT_TOKEN=$BOT
SLACK_APP_TOKEN=$APP
SLACK_TEAM_ID=$STEAM
EOF
    say "  wrote $CONFIG_DIR/env — ownership is claimed from Slack afterwards (/cc-claim)"
  else
    say "  ! No TTY — create $CONFIG_DIR/env with SLACK_BOT_TOKEN / SLACK_APP_TOKEN, then re-run."
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
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin</string></dict>
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
say "✅ Installed — one step left, in Slack:"
say "   Run /cc-claim in any channel to become the bridge's owner."
say "   (You'll be invited to a private #claude-code-bridge control channel.)"
say ""
say "   Start a bridged session anywhere:   ccs --dangerously-skip-permissions"
say "   Logs:  tail -f $LOG"
