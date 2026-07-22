#!/bin/sh
# Bridge statusline: forwards Claude Code's documented status JSON (model, effort,
# tokens, cost) to the daemon so /cc-status can show them, then renders the display.
# Non-blocking: the daemon POST is backgrounded, so the statusline stays instant
# even if the daemon is down.
input=$(cat)
printf '%s' "$input" | curl -s -m 1 -X POST --data-binary @- http://127.0.0.1:8877/statusline >/dev/null 2>&1 &

# Render: delegate to the original statusline if one is configured, else show branch.
if [ -n "$CCS_ORIG_STATUSLINE" ] && [ -x "$CCS_ORIG_STATUSLINE" ]; then
  printf '%s' "$input" | "$CCS_ORIG_STATUSLINE"
else
  cwd=$(printf '%s' "$input" | jq -r '.cwd // .workspace.current_dir // ""' 2>/dev/null)
  b=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)
  [ -n "$b" ] && printf ' %s' "$b"
fi
