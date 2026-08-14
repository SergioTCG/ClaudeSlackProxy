#!/bin/bash
# Backward-compatible Codex activation. Never restarts the live daemon.
set -euo pipefail

BRIDGE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf 'Staging the Codex integration without restarting the live daemon.\n'
exec bash "$BRIDGE/install.sh" --provider codex --no-daemon-reload
