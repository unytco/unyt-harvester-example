#!/usr/bin/env bash
# Run a throwaway Holochain conductor for the rehearsal.
#
#   rehearsal/conductor.sh <dir> <admin-port>
#
# Data and an in-process lair keystore live under <dir>. Bootstrap and relay
# point at a closed local port: every agent runs on this one conductor, so the
# network never leaves the machine.
set -euo pipefail

DIR="$1"
ADMIN_PORT="$2"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOLOCHAIN="$ROOT/.rehearsal/bin/holochain-0.7.1"

mkdir -p "$DIR/data"
cat > "$DIR/config.yaml" <<YAML
data_root_path: $DIR/data
keystore:
  type: lair_server_in_proc
  lair_root: $DIR/data/ks
admin_interfaces:
- driver:
    type: websocket
    port: $ADMIN_PORT
    allowed_origins: '*'
network:
  bootstrap_url: http://127.0.0.1:1
  relay_url: https://127.0.0.1:1
db_sync_level: Normal
YAML

# The lair passphrase on stdin. A here-string keeps `exec` in this process, so
# stopping this script stops the conductor.
exec "$HOLOCHAIN" --config-path "$DIR/config.yaml" --piped <<<"rehearsal"
