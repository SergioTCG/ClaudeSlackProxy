#!/bin/bash
# Pi activation for an existing bridge installation. Never restarts the daemon.
set -euo pipefail

BRIDGE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
printf 'Staging the Pi integration without restarting the live daemon.\n'
exec bash "$BRIDGE/install.sh" --provider pi --no-daemon-reload
