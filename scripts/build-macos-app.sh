#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
APP_NAME="Codex Mobile Remote.app"
SRC_APP="$ROOT_DIR/$APP_NAME"
OUT_APP="$DIST_DIR/$APP_NAME"
RESOURCES_DIR="$OUT_APP/Contents/Resources"
PAYLOAD="$RESOURCES_DIR/codex-mobile-remote.tar.gz"
ZIP_FILE="$DIST_DIR/Codex-Mobile-Remote.app.zip"

cd "$ROOT_DIR"
mkdir -p "$DIST_DIR"
rm -rf "$OUT_APP" "$ZIP_FILE"
cp -R "$SRC_APP" "$OUT_APP"
mkdir -p "$RESOURCES_DIR"

tar \
  --exclude=".git" \
  --exclude="node_modules" \
  --exclude="dist" \
  --exclude="$APP_NAME" \
  --exclude=".remote-token" \
  --exclude=".vnc-password" \
  --exclude=".cmr-config" \
  --exclude=".DS_Store" \
  -czf "$PAYLOAD" .

chmod +x "$OUT_APP/Contents/MacOS/codex-mobile-remote"
ditto -c -k --sequesterRsrc --keepParent "$OUT_APP" "$ZIP_FILE"

echo "Built $OUT_APP"
echo "Built $ZIP_FILE"
