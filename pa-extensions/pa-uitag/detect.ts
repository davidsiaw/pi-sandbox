/**
 * pa-uitag/detect.ts — uitag YOLO inference in pure Node (ONNX Runtime).
 *
 * WHY ONNX AND NOT THE PYTHON PACKAGE
 * `pip install uitag` pulls ~3 GB (mlx, mlx-lm, mlx-vlm, transformers) as HARD
 * dependencies — MLX is an Apple-Silicon accelerator, dead weight on Linux —
 * and its stage-1 detector shells out to Apple Vision via `swift`, which does
 * not exist here (verified: FileNotFoundError: 'swift'). A Python path would
 * also mean baking Python + torch (~400-600 MB per arch, doubled by the
 * multi-arch build) into an image whose whole premise is "no language runtimes".
 *
 * Instead we take the part that matters — uitag's bundled 18 MB YOLO model,
 * trained on GroundCUA (55K desktop screenshots, 3.56M annotations) — exported
 * once to ONNX at build time, and run it with `onnxruntime-node`, which is
 * ALREADY in the image for pa-rag. Net cost: the 36 MB model file. No Python,
 * no torch, no GPU, and ONNX + WASM are arch-neutral so multi-arch is free.
 *
 * FIDELITY (measured against ultralytics on the same screenshot, conf .25,
 * IoU .5): 55 detections vs 59, box recall 83% @ IoU>=0.5, mean IoU of matched
 * boxes 0.881, label agreement 82%. Close but NOT parity — the residual is
 * most likely letterbox geometry (ultralytics pads to a stride-32 multiple
 * rather than a full square). Ruled out along the way: channel order (RGB is
 * correct here) and the resize filter (swept all five photon filters; Lanczos3
 * is the best at 83%, nearest 81%, the rest much worse).
 *
 * INT8 dynamic quantization shrinks the model 36 MB -> 9.4 MB but costs recall
 * (78% vs 83%), so FP32 is shipped.
 *
 * THE MODEL'S OWN LIMITS, worth knowing before trusting output: the vocabulary
 * is 8 coarse buckets, so a checkbox and a date picker are both
 * "Input_Elements". On synthetic HTML pages it returns almost entirely
 * "Unknown"; it earns its keep on real application screenshots.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Both of these are resolved from pa-rag's node_modules, which the image
// already installs. They are NOT declared as dependencies of this extension —
// duplicating onnxruntime-node (93 MB) would be absurd.
const PA_RAG_MODULES = "/opt/pa/extensions/pa-rag/node_modules";
// Repo-relative fallback so the selftest can run from a checkout.
const LOCAL_RAG_MODULES = new URL("../pa-rag/node_modules", import.meta.url).pathname;

/** Class names, in model output order. From uitag's YOLO_CATEGORY_NAMES. */
export const UITAG_CLASSES = [
	"Button",
	"Menu",
	"Input_Elements",
	"Navigation",
	"Information_Display",
	"Sidebar",
	"Visual_Elements",
	"Others",
	"Unknown",
] as const;

/** Model input is a square of this side; matches the export (imgsz=640). */
const INPUT_SIZE = 640;
/** Letterbox fill, matching ultralytics' grey padding. */
const PAD_VALUE = 114 / 255;
/** photon resize filter 5 = Lanczos3 — measured best for label fidelity. */
const RESIZE_LANCZOS3 = 5;

export interface Detection {
	label: string;
	confidence: number;
	/** Pixel coordinates in the ORIGINAL image space. */
	x: number;
	y: number;
	width: number;
	height: number;
}

// biome-ignore lint/suspicious/noExplicitAny: onnxruntime/photon have no local types
type Any = any;

interface Deps {
	ort: Any;
	photon: Any;
}

function loadDeps(): Deps {
	const require = createRequire(import.meta.url);
	let lastErr: unknown;
	for (const root of [PA_RAG_MODULES, LOCAL_RAG_MODULES]) {
		try {
			const ort = require(`${root}/onnxruntime-node/dist/index.js`);
			const photon = require(`${root}/@silvia-odwyer/photon-node/photon_rs.js`);
			if (ort?.InferenceSession && photon?.PhotonImage) {
				return { ort: ort.default ?? ort, photon: photon.default ?? photon };
			}
		} catch (err) {
			lastErr = err;
		}
	}
	throw new Error(
		"Could not load onnxruntime-node / photon-node from pa-rag's node_modules " +
			`(tried ${PA_RAG_MODULES} and ${LOCAL_RAG_MODULES}). ` +
			`Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
	);
}

/** Cached session — loading a 36 MB model per call would be wasteful. */
let cachedSession: Any;
let cachedPath: string | undefined;

async function getSession(ort: Any, modelPath: string): Promise<Any> {
	if (cachedSession && cachedPath === modelPath) return cachedSession;
	cachedSession = await ort.InferenceSession.create(modelPath);
	cachedPath = modelPath;
	return cachedSession;
}

interface Letterboxed {
	tensor: Float32Array;
	scale: number;
	padX: number;
	padY: number;
	origWidth: number;
	origHeight: number;
}

/**
 * Decode the image and letterbox it into a 640x640 NCHW float tensor.
 * Scale preserves aspect ratio; the remainder is grey-padded and CENTERED
 * (ultralytics centers, and off-center padding shifts every coordinate).
 */
function preprocess(photon: Any, imageBytes: Buffer): Letterboxed {
	const img = photon.PhotonImage.new_from_byteslice(new Uint8Array(imageBytes));
	const origWidth: number = img.get_width();
	const origHeight: number = img.get_height();
	const scale = Math.min(INPUT_SIZE / origWidth, INPUT_SIZE / origHeight);
	const newWidth = Math.round(origWidth * scale);
	const newHeight = Math.round(origHeight * scale);
	const padX = Math.floor((INPUT_SIZE - newWidth) / 2);
	const padY = Math.floor((INPUT_SIZE - newHeight) / 2);

	const rgba: Uint8Array = photon
		.resize(img, newWidth, newHeight, RESIZE_LANCZOS3)
		.get_raw_pixels();

	const plane = INPUT_SIZE * INPUT_SIZE;
	const tensor = new Float32Array(3 * plane).fill(PAD_VALUE);
	for (let y = 0; y < newHeight; y++) {
		for (let x = 0; x < newWidth; x++) {
			const s = (y * newWidth + x) * 4;
			const d = (y + padY) * INPUT_SIZE + (x + padX);
			// RGB order (verified against the Python reference on a real screenshot).
			tensor[d] = rgba[s] / 255;
			tensor[plane + d] = rgba[s + 1] / 255;
			tensor[2 * plane + d] = rgba[s + 2] / 255;
		}
	}
	return { tensor, scale, padX, padY, origWidth, origHeight };
}

interface RawBox {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
	conf: number;
	cls: number;
}

function iou(a: RawBox, b: RawBox): number {
	const inter =
		Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) *
		Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
	const union =
		(a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
	return union > 0 ? inter / union : 0;
}

/** Greedy non-maximum suppression, highest confidence first. */
function nms(boxes: RawBox[], threshold: number): RawBox[] {
	const sorted = [...boxes].sort((a, b) => b.conf - a.conf);
	const keep: RawBox[] = [];
	for (const box of sorted) {
		if (!keep.some((k) => iou(k, box) > threshold)) keep.push(box);
	}
	return keep;
}

export interface DetectOptions {
	modelPath: string;
	confThreshold?: number;
	iouThreshold?: number;
}

export interface DetectResult {
	detections: Detection[];
	imageWidth: number;
	imageHeight: number;
	inferenceMs: number;
}

/**
 * Run detection on a PNG/JPEG/WebP buffer.
 *
 * Output layout is YOLOv8-style: [1, 4 + numClasses, numBoxes], where rows 0..3
 * are the box as centre-x, centre-y, width, height in INPUT_SIZE space and the
 * remaining rows are per-class scores (already activated — no sigmoid needed).
 */
export async function detect(
	imageBytes: Buffer,
	opts: DetectOptions,
): Promise<DetectResult> {
	const conf = opts.confThreshold ?? 0.25;
	const iouThreshold = opts.iouThreshold ?? 0.5;
	const { ort, photon } = loadDeps();

	const pre = preprocess(photon, imageBytes);
	const session = await getSession(ort, opts.modelPath);

	const started = Date.now();
	const outputs = await session.run({
		images: new ort.Tensor("float32", pre.tensor, [1, 3, INPUT_SIZE, INPUT_SIZE]),
	});
	const inferenceMs = Date.now() - started;

	const out = outputs[session.outputNames[0]];
	const [, attrs, numBoxes] = out.dims as [number, number, number];
	const data = out.data as Float32Array;
	const numClasses = attrs - 4;

	const candidates: RawBox[] = [];
	for (let i = 0; i < numBoxes; i++) {
		let best = -1;
		let bestCls = 0;
		for (let c = 0; c < numClasses; c++) {
			const score = data[(4 + c) * numBoxes + i];
			if (score > best) {
				best = score;
				bestCls = c;
			}
		}
		if (best < conf) continue;
		const cx = data[i];
		const cy = data[numBoxes + i];
		const w = data[2 * numBoxes + i];
		const h = data[3 * numBoxes + i];
		// Undo the letterbox: remove padding, then rescale to original pixels.
		candidates.push({
			x1: (cx - w / 2 - pre.padX) / pre.scale,
			y1: (cy - h / 2 - pre.padY) / pre.scale,
			x2: (cx + w / 2 - pre.padX) / pre.scale,
			y2: (cy + h / 2 - pre.padY) / pre.scale,
			conf: best,
			cls: bestCls,
		});
	}

	const kept = nms(candidates, iouThreshold);

	// Clamp to the image; letterbox rounding can push an edge a pixel outside.
	const clampX = (v: number) => Math.max(0, Math.min(pre.origWidth, v));
	const clampY = (v: number) => Math.max(0, Math.min(pre.origHeight, v));

	const detections: Detection[] = kept.map((b) => {
		const x1 = clampX(b.x1);
		const y1 = clampY(b.y1);
		const x2 = clampX(b.x2);
		const y2 = clampY(b.y2);
		return {
			label: UITAG_CLASSES[b.cls] ?? "Unknown",
			confidence: Math.round(b.conf * 1000) / 1000,
			x: Math.round(x1),
			y: Math.round(y1),
			width: Math.round(x2 - x1),
			height: Math.round(y2 - y1),
		};
	});

	// Stable, readable order: top-to-bottom, then left-to-right.
	detections.sort((a, b) => a.y - b.y || a.x - b.x);

	return {
		detections,
		imageWidth: pre.origWidth,
		imageHeight: pre.origHeight,
		inferenceMs,
	};
}
