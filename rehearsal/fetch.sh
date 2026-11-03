#!/usr/bin/env bash
# Download the pinned artifacts the rehearsal runs on into .rehearsal/bin:
# the production unyt.happ (checked against the release's SHA256SUMS), the
# unyt_cli that stands up HoloFuel, and the Holochain conductor.
set -euo pipefail

UNYT_RELEASE="v1.0.1"
UNYT_CLI_RELEASE="cli-v1.0.0.0"
HOLOCHAIN_VERSION="0.7.1"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/.rehearsal/bin"
mkdir -p "$BIN"

if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
  echo "the rehearsal needs Linux x86-64 (unyt_cli is published only for it);" \
    "on macOS run it in a Linux container" >&2
  exit 1
fi

fetch() {
  local url="$1" out="$2"
  if [ ! -s "$out" ]; then
    echo "downloading $url" >&2
    curl -fsSLo "$out.part" "$url"
    mv "$out.part" "$out"
  fi
}

RELEASES="https://github.com/unytco/unyt-release/releases/download"
fetch "$RELEASES/$UNYT_RELEASE/unyt.happ" "$BIN/unyt.happ"
fetch "$RELEASES/$UNYT_RELEASE/SHA256SUMS" "$BIN/SHA256SUMS"
(cd "$BIN" && grep ' unyt.happ$' SHA256SUMS | sha256sum -c --quiet -)

fetch "$RELEASES/$UNYT_CLI_RELEASE/unyt_cli" "$BIN/unyt_cli"
fetch "https://github.com/holochain/holochain/releases/download/holochain-$HOLOCHAIN_VERSION/holochain-x86_64-unknown-linux-gnu" \
  "$BIN/holochain-$HOLOCHAIN_VERSION"
chmod +x "$BIN/unyt_cli" "$BIN/holochain-$HOLOCHAIN_VERSION"
