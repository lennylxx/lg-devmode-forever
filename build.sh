#!/bin/bash
#
#   ./build.sh                  # syntax check + ares-package -> IPK + manifest
#   ./build.sh --install [dev]  # + ares-install + ares-launch
set -e
cd "$(dirname "$0")"

APP_ID=com.lennylxx.devmodeforever
error() { echo "[ERROR] $1" >&2; exit 1; }

command -v ares-package >/dev/null 2>&1 || error "ares-package not found — npm install -g @webos-tools/cli"
for f in app/*.js service/*.js; do node --check "$f" || error "syntax error in $f"; done

ares-package -o . app service
IPK=$(ls -t *.ipk | head -1)
echo "[INFO] Built: $IPK"
node scripts/generate-homebrew-manifest.mjs

if [ "$1" = "--install" ]; then
  DEVICE="${2:+--device $2}"
  ares-install $DEVICE "$IPK"
  # An in-place upgrade keeps a stale suspended instance — close it first.
  ares-launch $DEVICE --close "$APP_ID" 2>/dev/null || true
  sleep 1
  ares-launch $DEVICE "$APP_ID"
  echo "[INFO] Installed and launched."
fi
