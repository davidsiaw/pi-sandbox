#!/usr/bin/env bash
set -euo pipefail

TARGET="${HOME:-/home/agent}/.pi/agent/settings.json"
HOST=/opt/pa/settings.host.json
PKG=/usr/lib/node_modules/@earendil-works/pi-coding-agent/package.json

mkdir -p "$(dirname "$TARGET")"

VERSION="$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$PKG" 2>/dev/null || echo "")"

node -e '
  const fs = require("fs");
  const [hostPath, target, version] = process.argv.slice(1);
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(hostPath, "utf-8")); } catch {}
  if (version) settings.lastChangelogVersion = version;
  fs.writeFileSync(target, JSON.stringify(settings, null, 2) + "\n");
' "$HOST" "$TARGET" "$VERSION"
