#!/bin/bash
# Installs the latest tandem for Mac. Run:
#   curl -fsSL https://raw.githubusercontent.com/ankitkapooor/tandem/main/install.sh | bash
set -e
REPO="ankitkapooor/tandem"
APP="/Applications/tandem.app"

[ "$(uname)" = "Darwin" ] || { echo "tandem's app is for macOS."; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading tandem…"
curl -fL --progress-bar "https://github.com/$REPO/releases/latest/download/tandem-mac.zip" -o "$tmp/tandem.zip"
ditto -xk "$tmp/tandem.zip" "$tmp"

pkill -x tandem 2>/dev/null || true
rm -rf "$APP"
mv "$tmp/tandem.app" "$APP"
xattr -cr "$APP" 2>/dev/null || true

echo "Installed to /Applications/tandem.app"
command -v claude >/dev/null || echo "Note: the 'claude' command was not found. Install Claude Code, then run 'claude' and sign in."
command -v codex  >/dev/null || echo "Note: the 'codex' command was not found. Install Codex, then run 'codex login'."
open "$APP"
