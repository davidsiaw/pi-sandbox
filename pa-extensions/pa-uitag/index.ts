/**
 * pa-uitag
 *
 * Registers a `detect_ui_elements` tool: given a screenshot, return the pixel
 * bounding box of every UI element it can find, so an agent can crop the image
 * into regions and inspect them individually.
 *
 * WHY BOXES AND NOTHING ELSE
 * The point of this tool is coordinates. A vision model handed a whole 2185x1166
 * screenshot describes it vaguely; handed a 160x50 crop of one control it can
 * read the control. So this returns numbers — x, y, width, height — in the
 * ORIGINAL image's pixel space, ready to pass straight to a crop. It draws
 * nothing, writes no files, and returns no image bytes.
 *
 * See detect.ts for why this is ONNX-in-Node rather than the uitag Python
 * package, and for the measured fidelity gap against the Python reference.
 *
 * REGISTRATION IS CONDITIONAL: with no model baked (PA_UITAG_MODEL_URL unset at
 * build time) the tool is not registered at all. See resolveModelPath below.
 *
 * SCOPE, stated plainly: the model has 8 coarse classes, so it says
 * "Input_Elements" where you might want "checkbox" vs "date picker", and it
 * extracts NO text. It is a region locator. On synthetic HTML pages it returns
 * mostly "Unknown"; it earns its keep on real application screenshots. To learn
 * what a region contains, crop to its box and call inspect_image.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve as resolvePath } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { UITAG_CLASSES, detect } from "./detect.ts";

/** Baked model location; see scripts/install-uitag-model.sh. */
const BAKED_MODEL = "/opt/pa/models/uitag/yolo-ui.onnx";
/** Env override, mainly for the selftest and for trying a quantized model. */
const MODEL_ENV = "PA_UITAG_MODEL";

/**
 * Locate a usable model, or return null when there is none.
 *
 * Deliberately does NOT throw: the caller decides at load time whether to
 * register the tool at all. Registering `detect_ui_elements` without a model
 * puts a capability in the system prompt that fails on every single call --
 * the model burns a tool call to discover the tool is a lie. Better to not
 * offer it. See scripts/install-uitag-model.sh (PA_UITAG_MODEL_URL build arg).
 */
function resolveModelPath(): string | null {
	const override = process.env[MODEL_ENV];
	if (override) return existsSync(override) ? override : null;
	return existsSync(BAKED_MODEL) ? BAKED_MODEL : null;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Resolve an input image path against the project dir. */
function resolveInput(cwd: string, raw: string): string {
	const cleaned = raw.startsWith("@") ? raw.slice(1) : raw;
	const abs = isAbsolute(cleaned) ? cleaned : resolvePath(cwd, cleaned);
	if (!existsSync(abs)) throw new Error(`Image not found: ${abs}`);
	const st = statSync(abs);
	if (!st.isFile()) throw new Error(`Not a file: ${abs}`);
	if (st.size > MAX_IMAGE_BYTES) {
		throw new Error(`Image is ${st.size} bytes, over the ${MAX_IMAGE_BYTES}-byte limit.`);
	}
	if (!IMAGE_EXTS.has(extname(abs).toLowerCase())) {
		throw new Error(
			`Unsupported image type "${extname(abs)}". Supported: ${[...IMAGE_EXTS].join(", ")}`,
		);
	}
	return abs;
}

const PARAMS = Type.Object({
	image: Type.String({
		description:
			"Path to the screenshot to analyse (png/jpg/webp/bmp/gif). Relative paths " +
			"resolve against the project directory.",
	}),
	min_confidence: Type.Optional(
		Type.Number({
			description:
				"Drop detections below this confidence (0-1). Default 0.25. Raise to ~0.5 " +
				"for only the strong hits; lower to ~0.1 to find more, noisier regions.",
		}),
	),
	iou_threshold: Type.Optional(
		Type.Number({
			description:
				"Non-maximum-suppression IoU threshold (0-1). Default 0.5. Lower merges " +
				"overlapping boxes more aggressively.",
		}),
	),
	label: Type.Optional(
		Type.String({
			description: `Only report detections of this class. One of: ${UITAG_CLASSES.join(", ")}.`,
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description:
				"Report at most this many detections, highest confidence first. Useful on " +
				"dense screenshots. Default: all.",
		}),
	),
});

export default function paUitagExtension(pi: ExtensionAPI) {
	const modelPath = resolveModelPath();
	if (!modelPath) {
		// No model -> no tool. Silent for the common case (image built without
		// PA_UITAG_MODEL_URL): nothing was ever promised, so nothing is missing.
		// But if the user set PA_UITAG_MODEL explicitly they asked for this tool,
		// and a typo'd path must not vanish silently -- say so once, at startup.
		const override = process.env[MODEL_ENV];
		if (override) {
			pi.on("session_start", (_event, ctx) => {
				ctx.ui.notify(
					`${MODEL_ENV} points at ${override}, which does not exist. ` +
						`detect_ui_elements is disabled.`,
					"warning",
				);
			});
		}
		return;
	}

	pi.registerTool({
		name: "detect_ui_elements",
		label: "Detect UI Elements",
		description:
			"Locate UI elements in a screenshot and return each one's pixel bounding box " +
			"(x, y, width, height) plus a coarse class and confidence. Use the boxes to crop " +
			"the image into regions you can inspect individually. Classes are coarse (Button, " +
			"Input_Elements, Navigation, Information_Display, Menu, Sidebar, Visual_Elements, " +
			"Others) and NO text is extracted — crop to a box and call inspect_image to read " +
			"a region. Best on real application screenshots; returns mostly 'Unknown' on plain " +
			"HTML pages.",
		promptSnippet: "Locate UI elements in a screenshot and return their pixel bounding boxes",
		promptGuidelines: [
			"Use detect_ui_elements when you need the COORDINATES of UI elements in a screenshot — to crop regions, verify layout, or decide where to click.",
			"It returns boxes and coarse classes only; it reads no text. To learn what a region says, crop the image to that box and call inspect_image on the crop.",
			"Pair it with screenshot_url: capture a page to a PNG, then detect elements in that file.",
			"On a dense screenshot, raise min_confidence (~0.5) or set limit rather than trying to reason about every low-confidence box.",
		],
		parameters: PARAMS,
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			// --- Resolve inputs ------------------------------------------------
			// modelPath was resolved and validated at load time; the tool is not
			// registered at all when no model is present.
			let imagePath: string;
			try {
				imagePath = resolveInput(ctx.cwd, params.image);
			} catch (err) {
				return {
					content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
					isError: true,
				};
			}

			if (params.label && !UITAG_CLASSES.includes(params.label as (typeof UITAG_CLASSES)[number])) {
				return {
					content: [
						{
							type: "text",
							text: `Unknown label "${params.label}". Valid: ${UITAG_CLASSES.join(", ")}`,
						},
					],
					isError: true,
				};
			}

			// --- Detect ---------------------------------------------------------
			onUpdate?.({ content: [{ type: "text", text: "Running UI element detection..." }] });
			let result: Awaited<ReturnType<typeof detect>>;
			try {
				result = await detect(readFileSync(imagePath), {
					modelPath,
					confThreshold: params.min_confidence ?? 0.25,
					iouThreshold: params.iou_threshold ?? 0.5,
				});
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `detect_ui_elements failed: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					isError: true,
				};
			}

			let dets = params.label
				? result.detections.filter((d) => d.label === params.label)
				: result.detections;

			// `limit` keeps the strongest hits, but the output stays in reading
			// order (top-to-bottom) so the list still maps onto the screenshot.
			if (params.limit !== undefined && params.limit >= 0 && dets.length > params.limit) {
				const strongest = new Set(
					[...dets].sort((a, b) => b.confidence - a.confidence).slice(0, params.limit),
				);
				dets = dets.filter((d) => strongest.has(d));
			}

			// --- Report ---------------------------------------------------------
			const counts = new Map<string, number>();
			for (const d of dets) counts.set(d.label, (counts.get(d.label) ?? 0) + 1);

			const lines: string[] = [
				`${dets.length} UI element(s) in ${imagePath} ` +
					`(${result.imageWidth}x${result.imageHeight}, ${result.inferenceMs}ms)`,
			];

			if (dets.length === 0) {
				lines.push(
					"",
					"No detections above the confidence threshold. This model is trained on real " +
						"desktop/application screenshots; on plain or synthetic HTML pages it often " +
						"finds little. Try min_confidence=0.1, or use inspect_image on the whole image.",
				);
			} else {
				const summary = [...counts.entries()]
					.sort((a, b) => b[1] - a[1])
					.map(([k, v]) => `${k}=${v}`)
					.join("  ");
				lines.push(
					`By class: ${summary}`,
					"Boxes are x,y,width,height in this image's pixel space (origin top-left).",
					"",
					"  #  class                conf      x      y      w      h",
				);
				dets.forEach((d, i) => {
					lines.push(
						`${String(i + 1).padStart(3)}  ${d.label.padEnd(20)} ` +
							`${d.confidence.toFixed(3).padStart(5)} ` +
							`${String(d.x).padStart(6)} ${String(d.y).padStart(6)} ` +
							`${String(d.width).padStart(6)} ${String(d.height).padStart(6)}`,
					);
				});
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					image: imagePath,
					imageWidth: result.imageWidth,
					imageHeight: result.imageHeight,
					count: dets.length,
					inferenceMs: result.inferenceMs,
					byClass: Object.fromEntries(counts),
					// Machine-readable boxes, for callers that consume `details`.
					detections: dets,
				},
			};
		},
	});
}
