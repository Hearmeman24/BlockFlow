#!/usr/bin/env bash
# One-shot installer for rife-ncnn-vulkan (Apple Silicon / Intel mac).
# Drops the binary in ~/bin and models in ~/.cache/rife.
# The video-fx block reads $RIFE_BIN / $RIFE_MODEL_DIR if set, else these defaults.

set -euo pipefail

BIN_DIR="${HOME}/bin"
CACHE_DIR="${HOME}/.cache/rife"
RELEASE_URL="https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-macos.zip"
ZIP_PATH="$(mktemp -t rife-ncnn-vulkan.XXXXXX).zip"
EXTRACT_DIR="$(mktemp -d -t rife-ncnn-vulkan.XXXXXX)"

cleanup() { rm -rf "$ZIP_PATH" "$EXTRACT_DIR"; }
trap cleanup EXIT

mkdir -p "$BIN_DIR" "$CACHE_DIR"

echo "→ Downloading rife-ncnn-vulkan macOS build..."
curl -fL --progress-bar "$RELEASE_URL" -o "$ZIP_PATH"

echo "→ Extracting..."
unzip -q "$ZIP_PATH" -d "$EXTRACT_DIR"

SRC_BIN="$(find "$EXTRACT_DIR" -type f -name 'rife-ncnn-vulkan' | head -1 || true)"
if [ -z "$SRC_BIN" ]; then
  echo "✗ Could not locate rife-ncnn-vulkan binary in the archive."
  exit 1
fi
SRC_ROOT="$(dirname "$SRC_BIN")"

echo "→ Installing binary  : $BIN_DIR/rife-ncnn-vulkan"
install -m 0755 "$SRC_BIN" "$BIN_DIR/rife-ncnn-vulkan"

echo "→ Installing models  : $CACHE_DIR"
for model in "$SRC_ROOT"/rife*; do
  [ -d "$model" ] || continue
  name="$(basename "$model")"
  rm -rf "$CACHE_DIR/$name"
  cp -R "$model" "$CACHE_DIR/$name"
done

# macOS Gatekeeper would otherwise block the unsigned binary the first time.
xattr -dr com.apple.quarantine "$BIN_DIR/rife-ncnn-vulkan" 2>/dev/null || true
xattr -dr com.apple.quarantine "$CACHE_DIR" 2>/dev/null || true

echo
echo "✓ Installed."
echo "    binary : $BIN_DIR/rife-ncnn-vulkan"
echo "    models : $CACHE_DIR/{rife-v4.6, rife-v4, rife-anime, ...}"
echo
if ! echo ":$PATH:" | grep -q ":$BIN_DIR:"; then
  echo "Note: $BIN_DIR is not on \$PATH — that's fine, the video-fx block"
  echo "      reads the absolute path. Add it to PATH only if you want the CLI."
fi
echo "Smoke test:"
echo "    $BIN_DIR/rife-ncnn-vulkan 2>&1 | head -3"
