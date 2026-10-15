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

# Strip dead weight from known-heavy packages. Must run in the same RUN layer as
# the npm install, or the deleted bytes stay in the layer below and the image
# does not shrink.
prune_node_modules() {
  local nm="$1"
  # onnxruntime-node (pa-uitag) ships prebuilt binaries for every platform. This
  # sandbox is CPU-only Linux, so darwin, win32 and CUDA/TensorRT providers are
  # dead weight. The napi ABI dir is version-dependent, so glob, don't hardcode.
  local ort_bin="$nm/onnxruntime-node/bin"
  if [ -d "$ort_bin" ]; then
    echo "  pruning onnxruntime-node platform binaries (before: $(du -sh "$ort_bin" | cut -f1))"
    find "$ort_bin" -maxdepth 2 -type d \( -name darwin -o -name win32 \) -exec rm -rf {} +
    find "$ort_bin" -type f \
      \( -name 'libonnxruntime_providers_cuda.so*' \
      -o -name 'libonnxruntime_providers_tensorrt.so*' \) -delete
    echo "  onnxruntime-node now: $(du -sh "$ort_bin" | cut -f1)"
  fi
  # pdf-parse (pa-pdf) ships a large test-asset corpus never read at runtime.
  rm -rf "$nm/pdf-parse/test"
}

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
  prune_node_modules "${dir}node_modules"
done

if [ "$missing" != "0" ]; then
  exit 1
fi

rm -rf /tmp/npm-ext-cache
