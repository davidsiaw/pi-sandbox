#!/usr/bin/env bash
set -euo pipefail

TARGET="${HOME:-/home/agent}/.pi/agent/trust.json"

mkdir -p "$(dirname "$TARGET")"

# Generate a writable trust.json that trusts the current project directory,
# rather than mounting the host's trust.json (which is read-only, so pi's
# "Trust" write fails with EROFS). The project is bind-mounted at its real host
# path and the container's workdir is that path, so `pwd` is the key pi looks up
# (pi canonicalizes the cwd via realpathSync, then checks trust.json[path]).
# We pre-trust it so pi never needs to prompt or write. Written fresh each run
# in the ephemeral HOME; the host trust.json is never touched.
CWD="$(pwd)"

node -e '
  const fs = require("fs");
  const [target, cwd] = process.argv.slice(1);
  let trust = {};
  // Trust the resolved cwd (matches pi realpathSync canonicalization).
  let key = cwd;
  try { key = fs.realpathSync(cwd); } catch {}
  trust[key] = true;
  fs.writeFileSync(target, JSON.stringify(trust, null, 2) + "\n");
' "$TARGET" "$CWD"
