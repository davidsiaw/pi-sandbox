#!/usr/bin/env bash
set -euo pipefail

# Install runtime dependencies for any baked extension that ships a package.json
# with a "dependencies" block. Baked extensions live at /opt/pa/extensions/<name>
# and are loaded by the `pa` launcher via `-e`. Extensions that need npm deps
# (declared in "dependencies", not "devDependencies") get a local node_modules/
# here at build time so jiti can resolve them at runtime.
#
# Uses the fixed system Node's npm. Installs are production-only and root-owned
# read-only, consistent with everything else baked into the image.

EXT_ROOT=/opt/pa/extensions

if [ ! -d "$EXT_ROOT" ]; then
  echo "no extensions dir at $EXT_ROOT; nothing to install"
  exit 0
fi

for dir in "$EXT_ROOT"/*/; do
  pkg="${dir}package.json"
  [ -f "$pkg" ] || continue

  has_deps="$(node -e 'const d=require(process.argv[1]).dependencies; process.stdout.write(d && Object.keys(d).length ? "1" : "")' "$pkg" 2>/dev/null || echo "")"
  if [ -z "$has_deps" ]; then
    echo "extension $(basename "$dir"): no dependencies, skipping"
    continue
  fi

  echo "extension $(basename "$dir"): installing dependencies"
  ( cd "$dir" && npm install --omit=dev --no-audit --no-fund --cache /tmp/npm-ext-cache )
done

rm -rf /tmp/npm-ext-cache
