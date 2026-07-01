#!/usr/bin/env bash
set -euo pipefail

BASE=/opt/pa/APPEND_SYSTEM.base.md
HOST=/opt/pa/APPEND_SYSTEM.host.md
TARGET="${HOME:-/home/agent}/.pi/agent/APPEND_SYSTEM.md"

mkdir -p "$(dirname "$TARGET")"

if [ -s "$HOST" ]; then
  {
    cat "$HOST"
    printf '\n\n---\n\n'
    cat "$BASE"
  } > "$TARGET"
else
  cat "$BASE" > "$TARGET"
fi
