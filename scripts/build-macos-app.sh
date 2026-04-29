#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
APP_NAME="Codex Mobile Remote.app"
SRC_APP="$ROOT_DIR/$APP_NAME"
OUT_APP="$DIST_DIR/$APP_NAME"
RESOURCES_DIR="$OUT_APP/Contents/Resources"
SRC_RESOURCES_DIR="$SRC_APP/Contents/Resources"
PAYLOAD="$RESOURCES_DIR/codex-mobile-remote.tar.gz"
ZIP_FILE="$DIST_DIR/Codex-Mobile-Remote.app.zip"
SWIFT_LAUNCHER="$ROOT_DIR/src/macos/CodexMobileRemoteLauncher.swift"

cd "$ROOT_DIR"
mkdir -p "$DIST_DIR"
rm -rf "$OUT_APP" "$ZIP_FILE"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Please install Xcode Command Line Tools first." >&2
  exit 1
fi

mkdir -p "$SRC_RESOURCES_DIR"
swiftc "$SWIFT_LAUNCHER" \
  -framework AppKit \
  -o "$SRC_APP/Contents/MacOS/codex-mobile-remote"
chmod +x "$SRC_APP/Contents/MacOS/codex-mobile-remote"
chmod 644 "$SRC_RESOURCES_DIR/codex-mobile-remote-runner"
/usr/bin/codesign --force --deep --sign - "$SRC_APP"

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
chmod 644 "$RESOURCES_DIR/codex-mobile-remote-runner"
/usr/bin/codesign --force --deep --sign - "$OUT_APP"
ditto -c -k --sequesterRsrc --keepParent "$OUT_APP" "$ZIP_FILE"

echo "Built $OUT_APP"
echo "Built $ZIP_FILE"
