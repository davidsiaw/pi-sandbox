/**
 * selftest.mjs — auth-free guard for pa-screenshot.
 *
 * Guards the three things most likely to break silently:
 *   (1) output-path policy: .png required, traversal rejected, inside/outside
 *       the project classified correctly (that classification is what decides
 *       whether the file survives the container);
 *   (2) the refuse-to-overwrite rule;
 *   (3) a real end-to-end capture with JS execution — the whole point of the
 *       tool is that the PNG shows what JS rendered, not the pre-JS HTML.
 *
 * Like pa-yousoro-browse's selftest it does NOT import the extension (loading
 * via pi needs a model/auth). The path helpers are re-implemented here from the
 * same rules; the capture half drives Playwright directly.
 *
 * Usage: node selftest.mjs   (exit 0 = pass, non-zero = fail)
 */

import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";

let failed = 0;
function check(name, cond, detail) {
	if (cond) {
		console.log(`  ok   ${name}`);
	} else {
		failed++;
		console.log(`  FAIL ${name}${detail ? " :: " + detail : ""}`);
	}
}

// --- Mirror of resolveOutPath's rules (keep in sync with index.ts) ----------
function resolveOutPath(cwd, requested) {
	if (extname(requested).toLowerCase() !== ".png") throw new Error("not-png");
	const absolute = isAbsolute(requested) ? requested : resolvePath(cwd, requested);
	const rel = relative(cwd, absolute);
	const insideProject = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
	if (!isAbsolute(requested) && !insideProject) throw new Error("escapes");
	return { absolute, insideProject };
}

const CWD = "/home/agent/proj";

// --- (1) Path policy -------------------------------------------------------
check(
	"relative path lands inside the project",
	resolveOutPath(CWD, "shot.png").insideProject === true,
);
check(
	"nested relative path stays inside",
	resolveOutPath(CWD, "out/ui/shot.png").absolute === "/home/agent/proj/out/ui/shot.png",
);
check("absolute /tmp path is flagged as OUTSIDE the project", (() => {
	const r = resolveOutPath(CWD, "/tmp/x.png");
	return r.insideProject === false && r.absolute === "/tmp/x.png";
})());
check("traversal via .. is rejected", (() => {
	try {
		resolveOutPath(CWD, "../escape.png");
		return false;
	} catch (e) {
		return e.message === "escapes";
	}
})());
check("deep traversal is rejected", (() => {
	try {
		resolveOutPath(CWD, "../../etc/evil.png");
		return false;
	} catch (e) {
		return e.message === "escapes";
	}
})());
check("non-.png extension is rejected", (() => {
	try {
		resolveOutPath(CWD, "shot.jpg");
		return false;
	} catch (e) {
		return e.message === "not-png";
	}
})());
check(
	"normalised inner path is accepted",
	resolveOutPath(CWD, "sub/../ok.png").absolute === "/home/agent/proj/ok.png",
);

// --- (2) Refuse to overwrite ------------------------------------------------
const tmp = mkdtempSync(join(tmpdir(), "pa-shot-selftest-"));
try {
	const taken = join(tmp, "taken.png");
	writeFileSync(taken, "not-really-a-png");
	check("existing file is detected (refusal path)", existsSync(taken) === true);
	check(
		"suggested alternative differs from the taken path",
		taken.replace(/\.png$/i, "-2.png") !== taken,
	);
	check("free path is not reported as existing", existsSync(join(tmp, "free.png")) === false);

	// --- (3) End-to-end capture with JS execution ---------------------------
	const require = createRequire(import.meta.url);
	const CANDIDATES = [
		"playwright",
		"/usr/lib/node_modules/playwright/index.js",
		"/usr/local/lib/node_modules/playwright/index.js",
	];
	let chromium;
	for (const c of CANDIDATES) {
		try {
			const mod = require(c);
			chromium = mod.chromium ?? mod.default?.chromium;
			if (chromium) break;
		} catch {}
	}
	if (!chromium) {
		console.log("  FAIL could not load Playwright");
		failed++;
	} else {
		const browser = await chromium.launch({ args: ["--no-sandbox"] });
		try {
			const page = await browser.newPage({ viewport: { width: 640, height: 240 } });
			// The marker text exists ONLY if JS ran and mutated the DOM.
			await page.setContent(
				`<body style="font:24px sans-serif"><div id="o">NO-JS</div>
				 <script>document.getElementById('o').textContent='JS-RAN';</script></body>`,
			);
			const rendered = await page.innerText("#o");
			check("JS executes before capture", rendered.trim() === "JS-RAN", `got "${rendered}"`);

			const outFile = join(tmp, "e2e.png");
			await page.screenshot({ path: outFile, type: "png" });
			check("screenshot written to disk", existsSync(outFile));

			const bytes = readFileSync(outFile);
			check("output is a valid PNG", bytes.subarray(1, 4).toString() === "PNG");
			// IHDR width/height, big-endian u32 at offsets 16/20.
			const w = bytes.readUInt32BE(16);
			const h = bytes.readUInt32BE(20);
			check("PNG dimensions match the viewport", w === 640 && h === 240, `got ${w}x${h}`);

			// Parent directories must be created on demand.
			const nested = join(tmp, "a/b/c/deep.png");
			const { mkdirSync } = await import("node:fs");
			mkdirSync(join(tmp, "a/b/c"), { recursive: true });
			await page.screenshot({ path: nested, type: "png" });
			check("nested output directory is created", existsSync(nested));
		} finally {
			await browser.close();
		}
	}
} finally {
	rmSync(tmp, { recursive: true, force: true });
}

if (failed > 0) {
	console.log(`selftest: ${failed} check(s) FAILED`);
	process.exit(1);
}
console.log("selftest: all checks passed");
