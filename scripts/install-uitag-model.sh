#!/usr/bin/env bash
set -euo pipefail

# Bake the pa-uitag UI-element detection model into the image.
#
# WHAT THIS MODEL IS
#   The YOLO detector bundled inside the `uitag` PyPI package (MIT), trained on
#   GroundCUA (55K desktop screenshots, 3.56M human-verified annotations, MIT).
#   It locates UI regions and classifies them into 8 coarse buckets. We ship it
#   as ONNX so it runs under onnxruntime-node, which the image already carries
#   for pa-rag.
#
# WHY NOT `pip install uitag`
#   That pulls ~3GB of hard dependencies (mlx, mlx-lm, mlx-vlm, transformers) --
#   MLX is an Apple-Silicon accelerator, dead weight on Linux -- and its stage-1
#   detector shells out to Apple Vision via `swift`, which does not exist here.
#   It would also mean baking Python + torch (~400-600MB per arch, doubled by
#   the multi-arch build) into an image whose premise is "no language runtimes".
#   Exporting the model once and running it in Node costs ~36MB and nothing else.
#
# WHY THE MODEL IS FETCHED, NOT COMMITTED
#   A 36MB binary in git bloats every clone forever. pa-rag sets the precedent:
#   produce it at build time into /opt/pa/models. Whatever the source, the file
#   is size- and signature-checked below; a silent HTML error page must not be
#   allowed to masquerade as a model (that exact failure -- a 404 page saved as
#   .pt -- cost real debugging time during development).
#
# WHERE THE MODEL COMES FROM (in order of preference)
#   1. PA_UITAG_MODEL_URL, if set -- you host your own copy and skip the export.
#   2. /tmp/uitag-prebuilt/yolo-ui.onnx, produced by the `uitag-export` builder
#      stage (see scripts/export-uitag-model.sh). This is the default path and
#      needs no hosting, no account, and no manual step.
#   3. Nothing -- skip the bake. pa-uitag then does not register
#      detect_ui_elements at all, rather than advertising a dead tool.
#
# PROVENANCE / LICENSING NOTE
#   uitag is MIT and GroundCUA is MIT, so redistributing the derived .onnx is
#   permitted; the export stage writes a LICENSE_NOTICE alongside it that is
#   installed next to the model so the attribution ships with the image.

MODEL_DIR=/opt/pa/models/uitag
MODEL_PATH="$MODEL_DIR/yolo-ui.onnx"
EXT_DIR=/opt/pa/extensions/pa-uitag
PREBUILT_DIR=/tmp/uitag-prebuilt

# Override to self-host the export instead of building it in-image.
MODEL_URL="${PA_UITAG_MODEL_URL:-}"

if [ ! -d "$EXT_DIR" ]; then
  echo "pa-uitag extension not present at $EXT_DIR; skipping model bake"
  exit 0
fi

mkdir -p "$MODEL_DIR"

if [ -n "$MODEL_URL" ]; then
  echo "fetching uitag model from $MODEL_URL"
  curl -fsSL --retry 3 -o "$MODEL_PATH.tmp" "$MODEL_URL"
elif [ -f "$PREBUILT_DIR/yolo-ui.onnx" ]; then
  echo "using uitag model exported by the uitag-export build stage"
  cp "$PREBUILT_DIR/yolo-ui.onnx" "$MODEL_PATH.tmp"
  [ -f "$PREBUILT_DIR/LICENSE_NOTICE" ] && cp "$PREBUILT_DIR/LICENSE_NOTICE" "$MODEL_DIR/"
else
  cat >&2 <<'EOF'
install-uitag-model.sh: no model available.

Neither PA_UITAG_MODEL_URL nor the uitag-export build stage produced a model,
which means the Dockerfile was changed or the stage was skipped. Skipping the
bake: pa-uitag will not register detect_ui_elements at all.

To restore it, either let the uitag-export stage run (the default), or host a
yolo-ui.onnx yourself and pass PA_UITAG_MODEL_URL.
EOF
  exit 0
fi

# An HTML error page or a truncated download must fail loudly here rather than
# at runtime. ONNX files are protobuf; they do not start with '<'.
first_byte="$(head -c 1 "$MODEL_PATH.tmp" | od -An -c | tr -d ' \n')"
if [ "$first_byte" = "<" ]; then
  echo "ERROR: downloaded file starts with '<' -- that is HTML, not an ONNX model." >&2
  rm -f "$MODEL_PATH.tmp"
  exit 1
fi

size="$(stat -c%s "$MODEL_PATH.tmp")"
if [ "$size" -lt 10000000 ]; then
  echo "ERROR: downloaded model is only $size bytes; expected ~36MB." >&2
  rm -f "$MODEL_PATH.tmp"
  exit 1
fi

mv "$MODEL_PATH.tmp" "$MODEL_PATH"

# Verify the model actually loads and produces the expected output shape, using
# the onnxruntime-node that pa-rag already installed. Baking a model that cannot
# be loaded is worse than not baking one, because it fails on the user's prompt.
ORT="/opt/pa/extensions/pa-rag/node_modules/onnxruntime-node/dist/index.js"
if [ -f "$ORT" ]; then
  node --input-type=module -e "
    const { createRequire } = await import('node:module');
    const req = createRequire('file:///opt/pa/');
    const ortMod = req('$ORT');
    const ort = ortMod.default ?? ortMod;
    const s = await ort.InferenceSession.create('$MODEL_PATH');
    if (!s.inputNames.includes('images')) throw new Error('missing input \"images\": ' + s.inputNames);
    const S = 640;
    const out = await s.run({ images: new ort.Tensor('float32', new Float32Array(3*S*S).fill(0.5), [1,3,S,S]) });
    const dims = out[s.outputNames[0]].dims;
    // [1, 4 + numClasses, numBoxes]; uitag has 9 classes -> 13.
    if (dims[1] !== 13) throw new Error('unexpected output dims: ' + JSON.stringify(dims));
    console.log('uitag model verified, output dims', JSON.stringify(dims));
  "
else
  echo "WARNING: onnxruntime-node not found at $ORT; skipping load verification" >&2
fi

# Readable by any uid (pa runs as an arbitrary uid).
chmod -R a+rX "$MODEL_DIR"
echo "uitag model: $(du -sh "$MODEL_PATH" | cut -f1)"
