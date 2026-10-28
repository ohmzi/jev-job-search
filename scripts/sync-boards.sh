#!/usr/bin/env bash
# Pull the four boards' resumes from the machine that runs them.
#
# Each portal keeps its own resume: Android or Full Stack, New Jersey or Texas.
# `page fill` sends the resume of the board the job was opened from, so these
# four files have to be here and named after the board. Run this when a resume
# changes on the server.
#
#   ./scripts/sync-boards.sh
#
# Set JEV_BOARDS_HOST to the ssh host that holds the portals (default: homelab).
set -euo pipefail

HOST="${JEV_BOARDS_HOST:-homelab}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/documents/resume"
mkdir -p "$DEST"

for board in android-nj android-tx fullstack-nj fullstack-tx; do
  scp -q "$HOST:StudioProjects/jev-$board/documents/resume.pdf" "$DEST/$board.pdf"
  printf '%s  %s\n' "$(shasum -a 256 "$DEST/$board.pdf" | cut -c1-12)" "$DEST/$board.pdf"
done
