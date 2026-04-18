#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_SRC="$ROOT/../images/appling.png"
INSTALLER_SRC="$ROOT/../images/transparent.png"
BUILD_DIR="$ROOT/build"
ICONSET_DIR="$BUILD_DIR/icon.iconset"

if [ ! -f "$APP_SRC" ]; then
  echo "App icon source not found: $APP_SRC" >&2
  exit 1
fi

if [ ! -f "$INSTALLER_SRC" ]; then
  echo "Installer icon source not found: $INSTALLER_SRC" >&2
  exit 1
fi

cp "$APP_SRC" "$BUILD_DIR/icon.png"
cp "$INSTALLER_SRC" "$BUILD_DIR/installer-drive.png"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Synced PNG icons (icns generation skipped: non-macOS host)."
  exit 0
fi

rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

sips -z 16 16 "$APP_SRC" --out "$ICONSET_DIR/icon_16x16.png" >/dev/null
sips -z 32 32 "$APP_SRC" --out "$ICONSET_DIR/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$APP_SRC" --out "$ICONSET_DIR/icon_32x32.png" >/dev/null
sips -z 64 64 "$APP_SRC" --out "$ICONSET_DIR/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$APP_SRC" --out "$ICONSET_DIR/icon_128x128.png" >/dev/null
sips -z 256 256 "$APP_SRC" --out "$ICONSET_DIR/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$APP_SRC" --out "$ICONSET_DIR/icon_256x256.png" >/dev/null
sips -z 512 512 "$APP_SRC" --out "$ICONSET_DIR/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$APP_SRC" --out "$ICONSET_DIR/icon_512x512.png" >/dev/null
cp "$APP_SRC" "$ICONSET_DIR/icon_512x512@2x.png"

iconutil -c icns "$ICONSET_DIR" -o "$BUILD_DIR/icon.icns"
rm -rf "$ICONSET_DIR"

echo "Synced app icon from $APP_SRC and installer icon from $INSTALLER_SRC"
