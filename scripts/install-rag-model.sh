#!/usr/bin/env bash
set -euo pipefail

# Bake the pa-rag embedding model into the image and strip ONNX Runtime bloat.
#
# WHY BAKE THE MODEL
#   Transformers.js downloads ~23MB from Hugging Face on first use. In pa that
#   would happen inside a fresh container on someone's first prompt: slow, needs
#   network, and re-downloads every run because $HOME is ephemeral. We fetch it
#   at build time into /opt/pa/models and point the library there read-only.
#
# WHY STRIP onnxruntime-node
#   The published package carries prebuilt binaries for every platform, and
#   (on newer versions) a ~300MB CUDA execution provider. This sandbox is
#   CPU-only Linux, so darwin, win32 and any CUDA/TensorRT providers are dead
#   weight. The napi ABI directory is version-dependent (napi-v3 on the
#   transformers v2 line, napi-v6 on newer ones), so we glob rather than
#   hardcode it. This must happen in the same RUN layer as the npm install, or
#   the deleted bytes remain in the layer below and the image does not shrink.

EXT_DIR=/opt/pa/extensions/pa-rag
MODEL_DIR=/opt/pa/models
MODEL_ID="Xenova/all-MiniLM-L6-v2"

if [ ! -d "$EXT_DIR" ]; then
  echo "pa-rag extension not present at $EXT_DIR; skipping model bake"
  exit 0
fi

# ── 1. Prune onnxruntime-node ───────────────────────────────────────────────
ORT_BIN="$EXT_DIR/node_modules/onnxruntime-node/bin"
if [ -d "$ORT_BIN" ]; then
  echo "pruning onnxruntime-node platform binaries (before: $(du -sh "$ORT_BIN" | cut -f1))"
  # Drop non-Linux platforms across whichever napi-v* dirs exist.
  find "$ORT_BIN" -maxdepth 2 -type d \( -name darwin -o -name win32 \) -exec rm -rf {} +
  # CPU inference needs libonnxruntime + the shared provider stub only.
  find "$ORT_BIN" -type f \
    \( -name 'libonnxruntime_providers_cuda.so*' \
    -o -name 'libonnxruntime_providers_tensorrt.so*' \) -delete
  echo "onnxruntime-node now: $(du -sh "$ORT_BIN" | cut -f1)"
fi

# NOTE: do NOT delete onnxruntime-web. @xenova/transformers v2's
# backends/onnx.js imports it unconditionally at module load, even on node,
# so removing it breaks the embedder with ERR_MODULE_NOT_FOUND. Learned the
# hard way; leave it in place.

# pi-local-rag declares @mariozechner/pi-coding-agent as a PEER dependency,
# used only by its entry point (index.ts) for ExtensionAPI types. pa-rag never
# imports that entry point — it loads the submodules directly (see
# upstream.ts) — so the whole peer tree is dead weight at runtime: the agent
# SDK itself plus its provider SDKs and telemetry.
rm -rf \
  "$EXT_DIR/node_modules/@mariozechner" \
  "$EXT_DIR/node_modules/@mistralai" \
  "$EXT_DIR/node_modules/@google" \
  "$EXT_DIR/node_modules/@anthropic-ai" \
  "$EXT_DIR/node_modules/@opentelemetry" \
  "$EXT_DIR/node_modules/openai" \
  "$EXT_DIR/node_modules/koffi"

# NOTE: keep `sharp` and `onnxruntime-web`. @xenova/transformers imports both
# unconditionally (utils/image.js and backends/onnx.js respectively), even for
# a text-only feature-extraction pipeline on node. Deleting either one breaks
# the embedder at import time.

# pdf-parse ships a large test-asset corpus; pa-rag never parses PDFs.
rm -rf "$EXT_DIR/node_modules/pdf-parse/test"

# ── 2. Fetch the model ──────────────────────────────────────────────────────
mkdir -p "$MODEL_DIR"
echo "fetching $MODEL_ID into $MODEL_DIR"

cd "$EXT_DIR"
TRANSFORMERS_CACHE="$MODEL_DIR" HF_HOME="$MODEL_DIR" node - <<'FETCH'
const { env, pipeline } = await import("@xenova/transformers");
env.cacheDir = process.env.TRANSFORMERS_CACHE;
env.allowRemoteModels = true;
// Quantized (q8) is what pa-rag uses at runtime; fetching it here warms the
// exact files the runtime will look for.
const extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
  quantized: true,
});
const out = await extractor(["warmup"], { pooling: "mean", normalize: true });
if (!out?.dims?.includes(384)) {
  throw new Error(`unexpected embedding dims: ${JSON.stringify(out?.dims)}`);
}
console.log("model fetched and verified, dims:", JSON.stringify(out.dims));
FETCH

# Make the model readable by any uid (pa runs as an arbitrary uid).
chmod -R a+rX "$MODEL_DIR"

echo "model dir: $(du -sh "$MODEL_DIR" | cut -f1)"
echo "pa-rag total: $(du -sh "$EXT_DIR" | cut -f1)"
