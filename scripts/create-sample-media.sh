#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_DIR="$ROOT_DIR/storage/uploads/samples"
mkdir -p "$TARGET_DIR"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required to generate sample media"
  exit 1
fi

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i testsrc=duration=45:size=1280x720:rate=30 \
  -f lavfi -i sine=frequency=550:duration=45 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac "$TARGET_DIR/program-demo.mp4"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i color=c=#0f4c5c:s=1280x720:d=12 \
  -f lavfi -i sine=frequency=880:duration=12 \
  -c:v libx264 -pix_fmt yuv420p -c:a aac "$TARGET_DIR/ad-demo.mp4"

echo "Sample media generated in $TARGET_DIR"
