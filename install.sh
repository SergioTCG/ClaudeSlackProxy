#!/bin/bash
# Slack Agent Bridge installer (macOS). Idempotent and upgrade-safe.
#   One-liner: curl -fsSL https://raw.githubusercontent.com/SergioTCG/SlackAgentBridge/main/install.sh | bash
#   Providers: ./install.sh --provider claude|codex|pi|both|all
set -euo pipefail

REPO_URL="https://github.com/SergioTCG/SlackAgentBridge.git"
INSTALL_PROVIDER="${CCS_INSTALL_PROVIDER:-claude}"
RELOAD_DAEMON=1

usage() {
  cat <<'EOF'
Usage: ./install.sh [--provider claude|codex|pi|both|all] [--no-daemon-reload]

  --provider             Install one CLI integration, Claude+Codex (`both`),
                         or every provider (`all`; default: claude).
  --no-daemon-reload     Stage files and hooks without touching the live daemon.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --provider)
      [ "$#" -ge 2 ] || { printf 'Missing value for --provider\n' >&2; exit 2; }
      INSTALL_PROVIDER="$2"; shift 2 ;;
    --no-daemon-reload) RELOAD_DAEMON=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done
case "$INSTALL_PROVIDER" in
  claude|codex|pi|both|all) ;;
  *) printf 'Unsupported provider: %s (use claude, codex, pi, both, or all)\n' "$INSTALL_PROVIDER" >&2; exit 2 ;;
esac

BRIDGE="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null && pwd)"
[ -n "$BRIDGE" ] || BRIDGE="$(pwd)"

# Piped via curl (or run outside a clone): preserve an existing legacy checkout
# and use the neutral directory only for a fresh installation.
if [ ! -f "$BRIDGE/daemon/daemon.mjs" ]; then
  LEGACY_DEST="$HOME/.claudeslackproxy"
  NEUTRAL_DEST="$HOME/.slack-agent-bridge"
  if [ -n "${CCS_HOME:-}" ]; then DEST="$CCS_HOME"
  elif [ -d "$LEGACY_DEST/.git" ]; then DEST="$LEGACY_DEST"
  elif [ -d "$NEUTRAL_DEST/.git" ]; then DEST="$NEUTRAL_DEST"
  else DEST="$NEUTRAL_DEST"
  fi
  printf 'Installing Slack Agent Bridge in %s…\n' "$DEST"
  if git -C "$DEST" rev-parse --git-dir >/dev/null 2>&1; then
    old_origin="$(git -C "$DEST" remote get-url origin 2>/dev/null || true)"
    case "$old_origin" in *SergioTCG/ClaudeSlackProxy*) git -C "$DEST" remote set-url origin "$REPO_URL" ;; esac
    git -C "$DEST" pull --ff-only
  else
    git clone "$REPO_URL" "$DEST"
  fi
  if [ "$RELOAD_DAEMON" = 0 ]; then
    exec bash "$DEST/install.sh" --provider "$INSTALL_PROVIDER" --no-daemon-reload
  fi
  exec bash "$DEST/install.sh" --provider "$INSTALL_PROVIDER"
fi

CONFIG_DIR="${CCS_CONFIG_DIR:-$HOME/.config/ccs}"
BIN_DIR="${CCS_BIN_DIR:-/opt/homebrew/bin}"
# Compatibility contract: do not create a second LaunchAgent during the rename.
LABEL="si.sergej.claudeslackproxy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
CODEX_HOOKS="$CODEX_DIR/hooks.json"
LOG="$BRIDGE/daemon.log"

say() { printf '%s\n' "$*"; }
wants_claude() { [ "$INSTALL_PROVIDER" = claude ] || [ "$INSTALL_PROVIDER" = both ] || [ "$INSTALL_PROVIDER" = all ]; }
wants_codex() { [ "$INSTALL_PROVIDER" = codex ] || [ "$INSTALL_PROVIDER" = both ] || [ "$INSTALL_PROVIDER" = all ]; }
wants_pi() { [ "$INSTALL_PROVIDER" = pi ] || [ "$INSTALL_PROVIDER" = all ]; }

say "Installing Slack Agent Bridge ($INSTALL_PROVIDER) from $BRIDGE"

# Migrate only the known historical upstream; never rewrite a contributor's fork.
if [ "${CCS_SKIP_GIT_REMOTE_MIGRATION:-0}" != 1 ] && { [ -d "$BRIDGE/.git" ] || git -C "$BRIDGE" rev-parse --git-dir >/dev/null 2>&1; }; then
  old_origin="$(git -C "$BRIDGE" remote get-url origin 2>/dev/null || true)"
  case "$old_origin" in
    *SergioTCG/ClaudeSlackProxy*)
      git -C "$BRIDGE" remote set-url origin "$REPO_URL"
      say "  migrated Git remote to $REPO_URL" ;;
  esac
fi

# ---- 1. prerequisites -------------------------------------------------------
missing=0
for cmd in node npm tmux git jq; do
  if command -v "$cmd" >/dev/null 2>&1; then say "  ✓ $cmd"; else say "  ✗ missing: $cmd"; missing=1; fi
done
if wants_claude; then
  if command -v claude >/dev/null 2>&1; then say "  ✓ claude"; else say "  ✗ missing: claude"; missing=1; fi
fi
if wants_codex; then
  if command -v codex >/dev/null 2>&1; then say "  ✓ codex"; else say "  ✗ missing: codex"; missing=1; fi
fi
if wants_pi; then
  if command -v pi >/dev/null 2>&1; then say "  ✓ pi"; else say "  ✗ missing: pi"; missing=1; fi
fi
[ -d /Applications/Ghostty.app ] || say "  ! Ghostty not found — remote spawn/resume needs it (https://ghostty.org)"
if [ "$missing" = 1 ]; then say "Install the missing prerequisites and re-run."; exit 1; fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || { say "Node >= 20 required (have $(node -v))"; exit 1; }

# ---- 2. dependencies and launchers -----------------------------------------
if [ "${CCS_SKIP_DEPENDENCY_INSTALL:-0}" = 1 ]; then
  say "Skipping dependency installation (test override)."
elif [ "$RELOAD_DAEMON" = 0 ]; then
  say "Leaving live dependencies untouched during staged activation."
else
  say "Installing dependencies…"
  ( cd "$BRIDGE" && { npm ci --omit=dev >/dev/null 2>&1 || npm install --omit=dev >/dev/null 2>&1; } )
fi
mkdir -p "$BIN_DIR"
ln -sf "$BRIDGE/bin/ccs-spawn" "$BIN_DIR/ccs-spawn"
ln -sf "$BRIDGE/bin/sab-upload" "$BIN_DIR/sab-upload"
if wants_claude; then
  ln -sf "$BRIDGE/bin/sab-cc" "$BIN_DIR/sab-cc"
  ln -sf "$BRIDGE/bin/ccs" "$BIN_DIR/ccs"
  ln -sf "$BRIDGE/bin/ccs-account" "$BIN_DIR/ccs-account"
  say "  linked $BIN_DIR/sab-cc (with ccs compatibility alias)"
fi
if wants_codex; then
  ln -sf "$BRIDGE/bin/sab-codex" "$BIN_DIR/sab-codex"
  ln -sf "$BRIDGE/bin/ccs-codex" "$BIN_DIR/ccs-codex"
  say "  linked $BIN_DIR/sab-codex (with ccs-codex compatibility alias)"
fi
if wants_pi; then
  ln -sf "$BRIDGE/bin/sab-pi" "$BIN_DIR/sab-pi"
  say "  linked $BIN_DIR/sab-pi"
fi
chmod +x "$BRIDGE"/bin/sab-cc "$BRIDGE"/bin/sab-codex "$BRIDGE"/bin/sab-pi "$BRIDGE"/bin/sab-upload \
  "$BRIDGE"/bin/ccs "$BRIDGE"/bin/ccs-consent "$BRIDGE"/bin/ccs-codex \
  "$BRIDGE"/bin/ccs-window "$BRIDGE"/bin/ccs-spawn "$BRIDGE"/bin/ccs-account \
  "$BRIDGE"/hooks/hook.sh "$BRIDGE"/hooks/codex-hook.sh \
  "$BRIDGE"/daemon/daemon.mjs "$BRIDGE"/channel/server.mjs 2>/dev/null || true

# ---- 3. config + Slack app --------------------------------------------------
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR" 2>/dev/null || true
if [ ! -f "$CONFIG_DIR/env" ]; then
  if [ -r /dev/tty ]; then
    MANIFEST="$BRIDGE/slack/app-manifest.json"
    APP_URL="https://api.slack.com/apps?new_app=1&manifest_yaml=$(node -e 'process.stdout.write(encodeURIComponent(require("fs").readFileSync(process.argv[1],"utf8")))' "$MANIFEST")"
    say ""
    say "Create your Slack app — the page opens pre-filled:"
    say "  1. Pick your workspace → Next → Create."
    say "  2. Install App → Install to Workspace; copy the xoxb token."
    say "  3. Basic Information → App-Level Tokens; create a connections:write xapp token."
    open "$APP_URL" 2>/dev/null || say "  Open this URL: $APP_URL"
    read -r -p "  SLACK_BOT_TOKEN (xoxb-…): " BOT < /dev/tty
    read -r -p "  SLACK_APP_TOKEN (xapp-…): " APP < /dev/tty
    AUTH="$(curl -s -H "Authorization: Bearer $BOT" https://slack.com/api/auth.test)"
    [ "$(printf %s "$AUTH" | jq -r .ok)" = true ] || { say "  ✗ bot token rejected ($(printf %s "$AUTH" | jq -r .error))"; exit 1; }
    STEAM="$(printf %s "$AUTH" | jq -r .team_id)"
    CONN="$(curl -s -X POST -H "Authorization: Bearer $APP" https://slack.com/api/apps.connections.open)"
    [ "$(printf %s "$CONN" | jq -r .ok)" = true ] || { say "  ✗ app token rejected ($(printf %s "$CONN" | jq -r .error))"; exit 1; }
    umask 177
    printf 'SLACK_BOT_TOKEN=%s\nSLACK_APP_TOKEN=%s\nSLACK_TEAM_ID=%s\n' "$BOT" "$APP" "$STEAM" > "$CONFIG_DIR/env"
    say "  wrote $CONFIG_DIR/env; ownership is claimed later with /cc-claim"
  else
    say "  ! No TTY — create $CONFIG_DIR/env with SLACK_BOT_TOKEN / SLACK_APP_TOKEN, then re-run."
    exit 1
  fi
else
  chmod 600 "$CONFIG_DIR/env" 2>/dev/null || true
  say "  $CONFIG_DIR/env exists — keeping it"
fi

# ---- 4. provider hooks (merge, never clobber) -------------------------------
if wants_claude; then
  mkdir -p "$(dirname "$CLAUDE_SETTINGS")"
  [ -f "$CLAUDE_SETTINGS" ] || printf '{}\n' > "$CLAUDE_SETTINGS"
  HOOK="$BRIDGE/hooks/hook.sh"
  for ev in SessionStart SessionEnd UserPromptSubmit PreToolUse Stop; do
    tmp="$(mktemp)"
    jq --arg ev "$ev" --arg cmd "$HOOK" '
      .hooks = (.hooks // {}) |
      .hooks[$ev] = ((.hooks[$ev] // []) as $arr |
        if ([$arr[].hooks[]?.command] | index($cmd)) then $arr
        else $arr + [{matcher: ".*", hooks: [{type: "command", command: $cmd}]}] end)
    ' "$CLAUDE_SETTINGS" > "$tmp" && mv "$tmp" "$CLAUDE_SETTINGS"
  done
  say "  registered Claude hooks in $CLAUDE_SETTINGS"
fi

if wants_codex; then
  mkdir -p "$CODEX_DIR"
  [ -f "$CODEX_HOOKS" ] || printf '{}\n' > "$CODEX_HOOKS"
  HOOK="$BRIDGE/hooks/codex-hook.sh"
  for ev in SessionStart SessionEnd UserPromptSubmit Stop; do
    tmp="$(mktemp)"
    jq --arg ev "$ev" --arg cmd "$HOOK" '
      .hooks = (.hooks // {}) |
      .hooks[$ev] = ((.hooks[$ev] // []) as $arr |
        if ([$arr[].hooks[]?.command] | index($cmd)) then $arr
        else $arr + [{hooks: [{type: "command", command: $cmd, timeout: 3}]}] end)
    ' "$CODEX_HOOKS" > "$tmp" && mv "$tmp" "$CODEX_HOOKS"
  done
  tmp="$(mktemp)"
  jq --arg cmd "$HOOK" '
    .hooks = (.hooks // {}) |
    .hooks.PermissionRequest = ((.hooks.PermissionRequest // []) as $arr |
      if ([$arr[].hooks[]?.command] | index($cmd)) then $arr
      else $arr + [{matcher: ".*", hooks: [{type: "command", command: $cmd, timeout: 590, statusMessage: "Waiting for Slack approval"}]}] end)
  ' "$CODEX_HOOKS" > "$tmp" && mv "$tmp" "$CODEX_HOOKS"
  say "  registered Codex hooks in $CODEX_HOOKS"
fi

# ---- 5. legacy-compatible LaunchAgent --------------------------------------
if [ "$RELOAD_DAEMON" = 1 ]; then
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
  loaded=0
  for attempt in 1 2 3; do
    if launchctl bootstrap "gui/$(id -u)" "$PLIST"; then
      loaded=1
      break
    fi
    if [ "$attempt" -lt 3 ]; then
      say "  LaunchAgent bootstrap attempt $attempt failed; retrying in 1s…"
      sleep 1
    fi
  done
  [ "$loaded" = 1 ] || { say "LaunchAgent failed to load after 3 attempts"; exit 1; }
  say "  loaded LaunchAgent $LABEL"
else
  say "  left the live LaunchAgent $LABEL untouched"
fi

say ""
say "✅ Slack Agent Bridge files installed for: $INSTALL_PROVIDER"
say "   Claim a fresh bridge in Slack with /cc-claim."
if wants_claude; then say "   Start Claude locally: sab-cc"; fi
if wants_codex; then
  say "   Before the first Codex session, run sab-codex and trust the user hook in /hooks."
  say "   Start Codex locally: sab-codex"
fi
if wants_pi; then
  say "   Start Pi locally: sab-pi"
  say "   Pi's SAB extension is loaded explicitly by sab-pi; no global Pi extension is installed."
fi
say "   Logs: tail -f $LOG"
