#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_SRC="$ROOT/assets/icons/appling.png"
INSTALLER_SRC="$ROOT/assets/icons/transparent.png"
BUILD_DIR="$ROOT/build"
APP_ICONSET_DIR="$BUILD_DIR/icon.iconset"
INSTALLER_ICONSET_DIR="$BUILD_DIR/installer-drive.iconset"

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

rm -rf "$APP_ICONSET_DIR" "$INSTALLER_ICONSET_DIR"
mkdir -p "$APP_ICONSET_DIR" "$INSTALLER_ICONSET_DIR"

for SIZE in 16 32 128 256 512; do
  NEXT=$((SIZE * 2))
  sips -z "$SIZE" "$SIZE" "$APP_SRC" --out "$APP_ICONSET_DIR/icon_${SIZE}x${SIZE}.png" >/dev/null
  sips -z "$NEXT" "$NEXT" "$APP_SRC" --out "$APP_ICONSET_DIR/icon_${SIZE}x${SIZE}@2x.png" >/dev/null
  sips -z "$SIZE" "$SIZE" "$INSTALLER_SRC" --out "$INSTALLER_ICONSET_DIR/icon_${SIZE}x${SIZE}.png" >/dev/null
  sips -z "$NEXT" "$NEXT" "$INSTALLER_SRC" --out "$INSTALLER_ICONSET_DIR/icon_${SIZE}x${SIZE}@2x.png" >/dev/null
done

iconutil -c icns "$APP_ICONSET_DIR" -o "$BUILD_DIR/icon.icns"
iconutil -c icns "$INSTALLER_ICONSET_DIR" -o "$BUILD_DIR/installer-drive.icns"
rm -rf "$APP_ICONSET_DIR" "$INSTALLER_ICONSET_DIR"

echo "Synced app icon from $APP_SRC and installer icon from $INSTALLER_SRC"
