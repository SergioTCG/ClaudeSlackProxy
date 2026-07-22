#!/bin/sh
# Claude Code global hook → bridge daemon. Must be instant, silent, and never fail the session.
[ -n "$CCS_BRIDGE" ] || exit 0
payload=$(cat)
curl -s -m 2 -X POST "http://127.0.0.1:8877/hook?ppid=$PPID&tmux=$CCS_TMUX" \
  -H 'content-type: application/json' -H "x-ccs-flags: $CCS_FLAGS" \
  --data-binary "$payload" >/dev/null 2>&1
exit 0
