# UI element detection (`pa-uitag`)

The image bakes a `pa-uitag` extension that registers **`detect_ui_elements`**:
given a screenshot, it returns the **pixel bounding box** of every UI element it
can find, so an agent can cut the image into regions and inspect them
individually.

- Extension source: `pa-extensions/pa-uitag/`
  (`index.ts` = tool, `detect.ts` = inference)
- Model baked at `/opt/pa/models/uitag/yolo-ui.onnx` (~36 MB) by
  `scripts/install-uitag-model.sh`
- Reuses `onnxruntime-node` and `photon-node` from **pa-rag's** `node_modules`;
  declares no heavy dependencies of its own

## What it is for

A vision model handed a whole 2185x1166 screenshot describes it vaguely. Handed
a 186x52 crop of one control, it answers precisely:

```
detect_ui_elements image="image.png" min_confidence=0.6
  -> #12  Input_Elements  0.768  x=327 y=618 w=186 h=52

# crop to that box, then:
read path="crop.png"
  -> the 186x52 crop, attached: a checkbox labelled "Checkbox".
```

That last step is `read` because pi's `read` attaches an image directly to the
conversation whenever the active model declares `input: ["image"]`. If it instead
reports `[Current model does not support images...]`, the model is text-only —
then use `inspect_image image="crop.png" prompt="What control is this?"`, which
routes the crop to a separate vision model from the registry.

That is the intended workflow: **detect → crop → inspect**. The tool's whole job
is producing numbers you can crop with, so coordinates are integers in the
original image's pixel space, origin top-left, clamped to the image bounds.

It deliberately does **not** draw boxes, write files, or return image bytes.

## What it reports

```
55 UI element(s) in /Users/you/proj/image.png (2185x1166, 92ms)
By class: Button=21  Input_Elements=21  Information_Display=11  Navigation=1  Others=1
Boxes are x,y,width,height in this image's pixel space (origin top-left).

  #  class                conf      x      y      w      h
  1  Information_Display  0.553      0      0    107     42
  2  Information_Display  0.767    373     48    326     58
  ...
```

Detections are sorted **top-to-bottom, then left-to-right**, so the list maps
onto the screenshot in reading order. The same boxes are available
machine-readably in the tool result's `details.detections`.

## Parameters

| Parameter | Default | Notes |
|---|---|---|
| `image` | — | Path to a png/jpg/webp/bmp/gif. Relative resolves against the project. |
| `min_confidence` | `0.25` | Raise to ~0.5 for strong hits only; lower to ~0.1 to find more, noisier regions. |
| `iou_threshold` | `0.5` | NMS overlap threshold. Lower merges overlapping boxes harder. |
| `label` | — | Report only one class. |
| `limit` | all | Keep the N highest-confidence detections (output stays in reading order). |

## The 8 classes, and why they are coarse

`Button`, `Menu`, `Input_Elements`, `Navigation`, `Information_Display`,
`Sidebar`, `Visual_Elements`, `Others`, `Unknown`.

That is the model's whole vocabulary. A checkbox, a text field and a date picker
are all `Input_Elements`. **No text is extracted.** This is a region locator, not
an accessibility tree — to learn what a region says, crop to its box and `read`
the crop (or `inspect_image` it, if `read` says this model cannot see images).

Two limits worth knowing before trusting output:

- On **synthetic HTML pages** the model returns almost entirely `Unknown`. It was
  trained on real desktop application screenshots (GroundCUA) and earns its keep
  there. If you get nothing useful, that is expected — not a bug.
- If you need fine-grained classes (`Checkbox` vs `Date-Time picker`),
  **ScreenParser** (YOLO11-L, 55 classes, Apache 2.0, ~146 MB) classifies
  visibly better on the same screenshot. uitag was chosen here for size.

## Why ONNX in Node, not the Python package

`pip install uitag` is not viable in this image:

| Blocker | Detail |
|---|---|
| Apple Vision is macOS-only | its stage-1 detector shells out to `swift`; in-sandbox that dies with `FileNotFoundError: 'swift'` |
| ~3 GB of hard deps | `mlx`, `mlx-lm`, `mlx-vlm`, `transformers`. MLX is an Apple-Silicon accelerator — dead weight on Linux. `uitag[yolo]` does **not** avoid it; it is in `Requires:`, not an extra |
| No Python in the image | by design (see [architecture.md](architecture.md)); baking Python + torch costs ~400–600 MB **per arch**, doubled by the multi-arch build |

What is worth taking is the **model**: the 18 MB YOLO detector bundled in the
wheel, trained on GroundCUA (55K screenshots, 3.56M human-verified annotations,
MIT). Exported once to ONNX it is 36 MB and runs under the `onnxruntime-node`
the image already carries for pa-rag. Net cost: **one 36 MB file**, no Python, no
torch, no GPU — and ONNX + WASM are arch-neutral, so multi-arch is free.

## Fidelity: measured, and not at parity

Against ultralytics/PyTorch on the same screenshot (conf 0.25, IoU 0.5):

| Metric | Value |
|---|---|
| Detections | 55 (Node) vs 59 (Python) |
| Box recall @ IoU ≥ 0.5 | **83%** (49/59) |
| Mean IoU of matched boxes | **0.881** |
| Label agreement on matched | **82%** |
| Inference | ~92 ms |

Good enough to crop with, but **not identical**. The residual is most likely
letterbox geometry — ultralytics pads to a stride-32 multiple rather than a full
square, which shifts coordinates slightly. Ruled out while investigating:

- **Channel order** — RGB is correct. (An early BGR result looked closer, but
  that comparison was run on a synthetic page where the model returned almost
  all `Unknown`, making it meaningless.)
- **Resize filter** — swept all five photon filters. Lanczos3 is best at 83%,
  nearest 81%, the rest much worse.

INT8 dynamic quantization shrinks the model 36 MB → 9.4 MB but costs recall
(78% vs 83%), so FP32 is shipped. `PA_UITAG_MODEL` can point at an alternative.

## Baking the model

The model is **built at image-build time**, not committed — a 36 MB binary in git
bloats every clone forever (pa-rag sets the same precedent). It requires no
setup: the `uitag-export` stage in the Dockerfile does the whole thing.

```
uitag-export stage (throwaway, runs on $BUILDPLATFORM)
  │  download pinned uitag 0.6.0 wheel from PyPI, verify sha256
  │  unzip uitag/models/yolo-ui.pt   (no `pip install uitag`)
  │  pip install torch-cpu + ultralytics  (~1GB, discarded)
  │  assert the 9 class names match detect.ts, then export ONNX
  └─► /out/yolo-ui.onnx  ──COPY──►  /opt/pa/models/uitag/
```

Why export rather than download: upstream publishes no ONNX build, and the only
public mirror of the weights
([laywens/uitag-yolo11s-ui-detect-v1](https://huggingface.co/laywens/uitag-yolo11s-ui-detect-v1))
is a **gated** HF repo — it needs an account and an accepted licence click, so an
unauthenticated build cannot fetch it, and it ships the `.pt` anyway. The weights
themselves are freely redistributable inside the pure-python PyPI wheel.

Why `--platform=$BUILDPLATFORM`: an ONNX graph is architecture-neutral, so the
arm64 leg reuses the artifact built natively on the builder instead of running a
torch install under QEMU.

**Cost:** a cold build pays ~1 GB of torch/ultralytics downloads in that stage.
It is cached (keyed on the pinned wheel hash and pinned tool versions) and
nothing from it reaches the final image. To skip it, host the `.onnx` yourself:

```bash
PA_UITAG_MODEL_URL=https://your-host/yolo-ui.onnx sh build.sh
```

CI also reads that from the optional `PA_UITAG_MODEL_URL` **repository variable**
(Settings → Secrets and variables → Actions → Variables); unset is fine and is
the normal case.

If neither source yields a model the bake **skips with a clear message** and the
extension **does not register `detect_ui_elements` at all** — an advertised tool
that fails on every call is worse than an absent one, because the model spends a
call discovering it. `smoketest.sh` asserts the model file is present, so this
cannot regress silently. The script also rejects an HTML error page masquerading
as a model (a 404 page saved as `.pt` cost real debugging time during
development) and verifies the model loads with the expected output shape
`[1,13,8400]` before accepting it.

**Licensing:** uitag is MIT and GroundCUA is MIT, so redistributing the derived
`.onnx` is permitted. The export stage writes a `LICENSE_NOTICE` next to the
model recording both, so attribution ships with the image.

## Testing

`pa-extensions/pa-uitag/selftest.mjs` is auth-free and runs in `smoketest.sh`.
It asserts box geometry (in-bounds, positive area, integer coordinates), known
labels, reading-order sorting, threshold monotonicity, and the contract that
matters: **cropping by a reported box yields exactly that box's size**. It
*skips* (does not fail) when the model was not baked.

```bash
cd /opt/pa/extensions/pa-uitag && node selftest.mjs
# locally, without a baked model:
PA_UITAG_MODEL=/path/to/yolo-ui.onnx node selftest.mjs
```
