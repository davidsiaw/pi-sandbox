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

# --verify: install nothing, just assert every extension that declares
# dependencies actually has a node_modules. The Dockerfile installs deps from a
# manifest-only COPY (so that editing extension SOURCE does not invalidate the
# npm installs and model bakes), and that layer lists each extension explicitly.
# A new extension with dependencies whose manifest is not added to that list
# would otherwise get no node_modules and fail at RUNTIME, when jiti cannot
# resolve its imports. This turns that into a build failure.
VERIFY_ONLY=0
[ "${1:-}" = "--verify" ] && VERIFY_ONLY=1

missing=0
for dir in "$EXT_ROOT"/*/; do
  pkg="${dir}package.json"
  [ -f "$pkg" ] || continue

  has_deps="$(node -e 'const d=require(process.argv[1]).dependencies; process.stdout.write(d && Object.keys(d).length ? "1" : "")' "$pkg" 2>/dev/null || echo "")"
  if [ -z "$has_deps" ]; then
    [ "$VERIFY_ONLY" = "1" ] || echo "extension $(basename "$dir"): no dependencies, skipping"
    continue
  fi

  if [ "$VERIFY_ONLY" = "1" ]; then
    if [ -d "${dir}node_modules" ]; then
      echo "extension $(basename "$dir"): deps present"
    else
      echo "ERROR: extension $(basename "$dir") declares dependencies but has no node_modules." >&2
      echo "       Add its package.json to the manifest COPY block in the Dockerfile" >&2
      echo "       (the one above 'RUN bash /tmp/install-extension-deps.sh')." >&2
      missing=1
    fi
    continue
  fi

  echo "extension $(basename "$dir"): installing dependencies"
  ( cd "$dir" && npm install --omit=dev --no-audit --no-fund --cache /tmp/npm-ext-cache )
done

if [ "$missing" != "0" ]; then
  exit 1
fi

rm -rf /tmp/npm-ext-cache
