#!/usr/bin/env bash
# Package the TV app and install it on a Samsung TV in Developer Mode.
#
#   tools/install-tv.sh <tv-ip> [security-profile]
#
# Requires the Tizen Studio CLI (tizen, sdb) and a signing profile created with
# `tizen certificate` + `tizen security-profiles add` (see docs/INSTALL.md).
set -euo pipefail
TV_IP="${1:?usage: tools/install-tv.sh <tv-ip> [security-profile]}"
PROFILE="${2:-cinema}"
TIZEN="${TIZEN:-$HOME/tizen-studio/tools/ide/bin/tizen}"
SDB="${SDB:-$HOME/tizen-studio/tools/sdb}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT

cp "$ROOT"/tv/*.html "$ROOT"/tv/*.js "$ROOT"/tv/*.css "$ROOT"/tv/config.xml "$ROOT"/tv/icon.png "$BUILD"/
"$SDB" connect "$TV_IP:26101"
TARGET="$("$SDB" devices | awk -v ip="$TV_IP" '$1 ~ ip {print $3}')"
[ -n "$TARGET" ] || { echo "TV $TV_IP not connected. Is Developer Mode on with this computer's IP?"; exit 1; }
( cd "$BUILD" && "$TIZEN" package -t wgt -s "$PROFILE" -o . -- . )
( cd "$BUILD" && "$TIZEN" install -n Cinema.wgt -t "$TARGET" )
echo "Installed. Open Cinema from the TV's Apps."
