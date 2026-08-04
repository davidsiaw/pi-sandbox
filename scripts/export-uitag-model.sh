#!/usr/bin/env bash
set -euo pipefail

# Export the uitag YOLO model to ONNX. Runs in a THROWAWAY builder stage; only
# the resulting 36MB .onnx is copied into the final image.
#
# WHY EXPORT HERE INSTEAD OF DOWNLOADING A PREBUILT .onnx
#   Upstream publishes no ONNX build. The only public mirror of the weights
#   (huggingface.co/laywens/uitag-yolo11s-ui-detect-v1) is a GATED repo -- it
#   needs an account and an accepted licence click, so it cannot be fetched from
#   an unauthenticated build -- and it ships the .pt anyway, not ONNX. Requiring
#   the maintainer to self-host meant that in practice nobody did, and every
#   published image shipped detect_ui_elements with no model behind it.
#
#   The weights themselves ARE freely available: the `uitag` wheel on PyPI is
#   pure-python (py3-none-any) and bundles uitag/models/yolo-ui.pt. We take the
#   .pt straight out of the zip -- no `pip install uitag`, which would drag in
#   mlx-vlm + transformers (~3GB, and MLX is an Apple-Silicon accelerator that
#   is dead weight on Linux).
#
# WHY THIS COSTS NOTHING IN THE FINAL IMAGE
#   torch + ultralytics (~1GB) exist only in this stage. The final image gets
#   one 36MB file and keeps its "no language runtimes" premise.
#
# WHY THE STAGE IS PINNED TO $BUILDPLATFORM (see the Dockerfile)
#   An ONNX graph is architecture-neutral: the bytes produced on amd64 are the
#   bytes arm64 loads. Running this stage natively instead of under QEMU turns a
#   very slow emulated torch install into a normal one, and the arm64 leg of the
#   multi-arch build reuses the identical artifact.
#
# LICENCE: uitag is MIT and its training set GroundCUA is MIT, so redistributing
# the derived .onnx is permitted. LICENSE_NOTICE below travels with the model so
# the attribution ships too.

UITAG_VERSION="0.6.0"
UITAG_WHEEL_URL="https://files.pythonhosted.org/packages/df/a6/b86ad0d07380fbdefd12d98ff06b67c9fa617dff41f4b930e7a48c537275/uitag-0.6.0-py3-none-any.whl"
UITAG_WHEEL_SHA256="0c05544554df05edeaff920cd7d8252332fe1a19ec4ae0931b5646c59536085b"

# Pinned to the exact set this export was validated against. A silent upstream
# bump changing the graph would surface as a runtime shape error, so pin loudly.
TORCH_VERSION="2.13.0"
TORCHVISION_VERSION="0.28.0"
ULTRALYTICS_VERSION="8.4.115"
ONNX_VERSION="1.22.0"
ONNXSLIM_VERSION="0.1.95"
# Must match the opencv-python that ultralytics resolves, so the swap below is a
# like-for-like replacement rather than a version change.
OPENCV_VERSION="5.0.0.93"

OUT_DIR="${1:-/out}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

mkdir -p "$OUT_DIR"

echo "==> fetching uitag ${UITAG_VERSION} wheel"
# python's stdlib rather than curl/unzip: python:*-slim ships neither, and
# adding apt just to download a zip is silly when urllib is right there.
python - "$UITAG_WHEEL_URL" "$UITAG_WHEEL_SHA256" "$WORK_DIR" <<'PY'
import hashlib, sys, urllib.request, zipfile, pathlib

url, expected_sha, work = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])
whl = work / "uitag.whl"

with urllib.request.urlopen(url, timeout=120) as r:
    data = r.read()

actual = hashlib.sha256(data).hexdigest()
if actual != expected_sha:
    # A mirror serving something else, or a truncated read, must not silently
    # become "the model". Fail here, not at inference time.
    raise SystemExit(f"wheel sha256 mismatch\n  expected {expected_sha}\n  actual   {actual}")
whl.write_bytes(data)
print(f"    wheel ok ({len(data)} bytes, sha256 verified)")

member = "uitag/models/yolo-ui.pt"
with zipfile.ZipFile(whl) as z:
    if member not in z.namelist():
        raise SystemExit(f"{member} not in wheel; upstream layout changed")
    (work / "yolo-ui.pt").write_bytes(z.read(member))
print(f"    extracted {member}")
PY

echo "==> installing export toolchain (this stage is discarded)"
# CPU index first so ultralytics' torch requirement is already satisfied and pip
# never reaches for the multi-GB CUDA build from PyPI.
pip install --no-cache-dir --disable-pip-version-check \
  "torch==${TORCH_VERSION}" "torchvision==${TORCHVISION_VERSION}" \
  --index-url https://download.pytorch.org/whl/cpu
pip install --no-cache-dir --disable-pip-version-check \
  "ultralytics==${ULTRALYTICS_VERSION}" "onnx==${ONNX_VERSION}" "onnxslim==${ONNXSLIM_VERSION}"

# ultralytics requires `opencv-python`, the GUI build, which links libxcb/libGL
# and therefore fails at `import cv2` on any slim container image:
#   ImportError: libxcb.so.1: cannot open shared object file
# opencv-python-headless provides the identical cv2 module built without the
# X11/GL linkage. Swapping it in is the standard fix and is far less brittle
# than apt-installing a guessed set of X libraries that grows with each opencv
# release. Nothing in the export path touches cv2 beyond importing it.
#
# This is exactly the bug that only appears in a minimal image: a workstation
# with a browser toolchain already has the X libs, so the GUI build imports fine
# there and the failure surfaces only in the build.
echo "==> swapping opencv-python for the headless build"
pip uninstall -y --disable-pip-version-check opencv-python
pip install --no-cache-dir --disable-pip-version-check \
  "opencv-python-headless==${OPENCV_VERSION}"

# Prove the import works before spending time on the export, and prove it works
# without X libs present rather than assuming.
python - <<'PY'
import cv2, ctypes.util
print(f"    cv2 {cv2.__version__} imports cleanly")
if ctypes.util.find_library("xcb") is None:
    print("    (no libxcb on this system -- headless import confirmed)")
PY

echo "==> exporting to ONNX"
# YOLO_OFFLINE stops ultralytics reaching out for fonts/telemetry mid-build.
cd "$WORK_DIR"
YOLO_OFFLINE=1 python - "$WORK_DIR/yolo-ui.pt" "$OUT_DIR/yolo-ui.onnx" <<'PY'
import shutil, sys
from ultralytics import YOLO

pt_path, out_path = sys.argv[1], sys.argv[2]
model = YOLO(pt_path)

# detect.ts hardcodes this class list in this order; a mismatch would silently
# mislabel every box, so assert it rather than trusting the checkpoint.
expected = ["Button", "Menu", "Input_Elements", "Navigation",
            "Information_Display", "Sidebar", "Visual_Elements", "Others", "Unknown"]
actual = [model.names[i] for i in range(len(model.names))]
if actual != expected:
    raise SystemExit(f"class list changed\n  expected {expected}\n  actual   {actual}")

produced = model.export(format="onnx", imgsz=640, simplify=True, opset=17)
shutil.move(produced, out_path)
print(f"    exported -> {out_path}")
PY

cat > "$OUT_DIR/LICENSE_NOTICE" <<EOF
yolo-ui.onnx is an ONNX export of the YOLO11s checkpoint bundled in the \`uitag\`
PyPI package v${UITAG_VERSION} (MIT, https://github.com/swaylenhayes/uitag),
fine-tuned on GroundCUA (MIT, https://huggingface.co/datasets/ServiceNow/GroundCUA).
Exported unmodified apart from the format conversion; both licences are MIT.
EOF

ls -lh "$OUT_DIR/yolo-ui.onnx"
echo "==> uitag ONNX export complete"
