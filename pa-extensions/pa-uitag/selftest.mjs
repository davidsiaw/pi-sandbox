/**
 * selftest.mjs — auth-free guard for pa-uitag.
 *
 * Guards what would break silently:
 *   (1) the model loads and inference runs at all;
 *   (2) boxes land inside the image bounds and have positive area — a letterbox
 *       or scaling regression shows up here as negative/oob coordinates, which
 *       is exactly the bug class that makes crops garbage;
 *   (3) the reported box actually crops to the reported size, since the whole
 *       point of the tool is coordinates an agent can crop with;
 *   (4) detections are sorted in reading order and thresholds behave.
 *
 * Needs a model. Uses $PA_UITAG_MODEL if set, else the baked path. If neither
 * exists the test SKIPS rather than fails, so a checkout without the baked
 * model is not a red build; the smoketest asserts the baked file separately.
 *
 * Usage: node selftest.mjs   (exit 0 = pass/skip, non-zero = fail)
 */

import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BAKED = "/opt/pa/models/uitag/yolo-ui.onnx";
const modelPath = process.env.PA_UITAG_MODEL ?? BAKED;

if (!existsSync(modelPath)) {
	console.log(`selftest: SKIP (no model at ${modelPath}; set PA_UITAG_MODEL to run locally)`);
	process.exit(0);
}

let failed = 0;
function check(name, cond, detail) {
	if (cond) {
		console.log(`  ok   ${name}`);
	} else {
		failed++;
		console.log(`  FAIL ${name}${detail ? " :: " + detail : ""}`);
	}
}

const { detect, UITAG_CLASSES } = await import(join(here, "detect.ts"));

// --- Build a test image with real native-ish controls ----------------------
// Generated rather than committed: a binary fixture in the repo would bloat it,
// and Playwright is already in the image.
const require_ = createRequire(import.meta.url);
const PW = [
	"playwright",
	"/usr/lib/node_modules/playwright/index.js",
	"/usr/local/lib/node_modules/playwright/index.js",
];
let chromium;
for (const c of PW) {
	try {
		const m = require_(c);
		chromium = m.chromium ?? m.default?.chromium;
		if (chromium) break;
	} catch {}
}
if (!chromium) {
	console.log("  FAIL could not load Playwright to build the test image");
	process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "pa-uitag-selftest-"));
try {
	const shotPath = join(tmp, "shot.png");
	const browser = await chromium.launch({ args: ["--no-sandbox"] });
	const VIEW = { width: 900, height: 600 };
	try {
		const page = await browser.newPage({ viewport: VIEW });
		await page.setContent(
			`<body style="font:13px -apple-system,system-ui;background:#ededed;margin:0;padding:20px">
			 <div style="font-weight:600;margin-bottom:10px">Preferences</div>
			 <table style="border-spacing:12px 14px">
			  <tr><td><select><option>Item 1</option></select></td><td><input value="Input"></td></tr>
			  <tr><td><label><input type=checkbox> Checkbox</label></td><td><input value="8/ 3/2026"></td></tr>
			  <tr><td><button>Button</button></td><td><button>Textured</button></td></tr>
			 </table></body>`,
		);
		await page.screenshot({ path: shotPath });
	} finally {
		await browser.close();
	}

	const bytes = readFileSync(shotPath);

	// --- (1) Inference runs -------------------------------------------------
	const r = await detect(bytes, { modelPath, confThreshold: 0.1 });
	check("inference produced a result", Array.isArray(r.detections));
	check(
		"image dimensions reported correctly",
		r.imageWidth === VIEW.width && r.imageHeight === VIEW.height,
		`got ${r.imageWidth}x${r.imageHeight}`,
	);
	check("inference time is plausible", r.inferenceMs >= 0 && r.inferenceMs < 60000);

	// The model can legitimately find little on a synthetic page, so do not
	// assert a count — assert that whatever it finds is well-formed.
	console.log(`  note detections=${r.detections.length} in ${r.inferenceMs}ms`);

	// --- (2) Boxes are geometrically sane -----------------------------------
	const oob = r.detections.filter(
		(d) =>
			d.x < 0 ||
			d.y < 0 ||
			d.width <= 0 ||
			d.height <= 0 ||
			d.x + d.width > r.imageWidth ||
			d.y + d.height > r.imageHeight,
	);
	check("all boxes are within bounds with positive area", oob.length === 0, JSON.stringify(oob.slice(0, 3)));

	check(
		"all labels are known classes",
		r.detections.every((d) => UITAG_CLASSES.includes(d.label)),
	);
	check(
		"all confidences are in (0,1]",
		r.detections.every((d) => d.confidence > 0 && d.confidence <= 1),
	);
	check(
		"coordinates are integers (directly usable for cropping)",
		r.detections.every(
			(d) =>
				Number.isInteger(d.x) &&
				Number.isInteger(d.y) &&
				Number.isInteger(d.width) &&
				Number.isInteger(d.height),
		),
	);

	// --- (3) Sorted in reading order ----------------------------------------
	let ordered = true;
	for (let i = 1; i < r.detections.length; i++) {
		const p = r.detections[i - 1];
		const c = r.detections[i];
		if (c.y < p.y || (c.y === p.y && c.x < p.x)) {
			ordered = false;
			break;
		}
	}
	check("detections sorted top-to-bottom, left-to-right", ordered);

	// --- (4) A reported box really crops to the reported size ---------------
	// This is the contract that matters: the numbers must be directly usable.
	if (r.detections.length > 0) {
		const roots = [
			"/opt/pa/extensions/pa-rag/node_modules",
			join(here, "..", "pa-rag", "node_modules"),
		];
		let photon;
		for (const root of roots) {
			try {
				const m = require_(`${root}/@silvia-odwyer/photon-node/photon_rs.js`);
				if (m?.PhotonImage) {
					photon = m.default ?? m;
					break;
				}
			} catch {}
		}
		if (!photon) {
			check("photon available for the crop check", false);
		} else {
			const d = [...r.detections].sort((a, b) => b.confidence - a.confidence)[0];
			const img = photon.PhotonImage.new_from_byteslice(new Uint8Array(bytes));
			const crop = photon.crop(img, d.x, d.y, d.x + d.width, d.y + d.height);
			const cropPath = join(tmp, "crop.png");
			writeFileSync(cropPath, Buffer.from(crop.get_bytes()));
			const cb = readFileSync(cropPath);
			const cw = cb.readUInt32BE(16);
			const ch = cb.readUInt32BE(20);
			check(
				"cropping by a reported box yields exactly that size",
				cw === d.width && ch === d.height,
				`box ${d.width}x${d.height} -> crop ${cw}x${ch}`,
			);
		}
	} else {
		console.log("  note skipped crop check (no detections on the synthetic page)");
	}

	// --- (5) Thresholds behave ----------------------------------------------
	const strict = await detect(bytes, { modelPath, confThreshold: 0.9 });
	check(
		"raising min_confidence never increases the count",
		strict.detections.length <= r.detections.length,
		`0.9 -> ${strict.detections.length}, 0.1 -> ${r.detections.length}`,
	);
	check(
		"every detection at 0.9 is above 0.9",
		strict.detections.every((d) => d.confidence >= 0.9),
	);
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

if (failed > 0) {
	console.log(`selftest: ${failed} check(s) FAILED`);
	process.exit(1);
}
console.log("selftest: all checks passed");
