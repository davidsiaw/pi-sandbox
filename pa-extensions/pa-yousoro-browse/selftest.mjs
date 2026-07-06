/**
 * selftest.mjs — auth-free behavioral guard for pa-yousoro-browse.
 *
 * The smoke test runs this to catch regressions in the two things most likely
 * to silently break: (1) the fingerprint init script, and (2) the block/
 * challenge detection that must key off VISIBLE text, not raw HTML (the
 * 403-then-redirect fix — leftover Cloudflare <script> tags must not flag a
 * cleared page as blocked).
 *
 * It does NOT bundle or import the extension (no esbuild in the image, and
 * loading via pi needs a model/auth). Instead it reads the sibling index.ts,
 * extracts the pure helpers by regex, strips the few TS annotations they use,
 * and evals them. This is deliberately coupled to this one file's style.
 *
 * Usage: node selftest.mjs   (exit 0 = pass, non-zero = fail)
 * Playwright is resolved from the global install baked into the image.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "index.ts"), "utf8");

// --- Extract pure helpers from the source ---------------------------------
function extractFn(name) {
	const re = new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`, "m");
	const m = re.exec(src);
	if (!m) throw new Error(`selftest: could not extract function ${name}`);
	// Strip TS annotations from the SIGNATURE LINE ONLY (up to the opening "{").
	// The body can contain a template literal with ": string" etc. that must not
	// be touched, so we split off the first line and clean just that.
	const nl = m[0].indexOf("{");
	const sig = m[0].slice(0, nl);
	const rest = m[0].slice(nl);
	const cleanSig = sig.replace(/:\s*(?:string|number|boolean|null|\|| )+/g, "");
	return cleanSig + rest;
}
function extractArray(name) {
	const re = new RegExp(`const ${name} = \\[[\\s\\S]*?\\];`, "m");
	const m = re.exec(src);
	if (!m) throw new Error(`selftest: could not extract array ${name}`);
	return m[0];
}

const helperSource = [
	extractArray("CHALLENGE_MARKERS"),
	extractArray("BLOCK_MARKERS"),
	extractFn("chromeMajor"),
	extractFn("yousoroUserAgent"),
	extractFn("secChUa"),
	extractFn("makeYousoroInitScript"),
	extractFn("looksChallenge"),
	extractFn("looksBlocked"),
	"globalThis.__H = { chromeMajor, yousoroUserAgent, secChUa, makeYousoroInitScript, looksChallenge, looksBlocked };",
].join("\n");

// eslint-disable-next-line no-eval
(0, eval)(helperSource);
const H = globalThis.__H;

// --- Assertion helpers -----------------------------------------------------
let failed = 0;
function check(name, cond, detail) {
	if (cond) {
		console.log(`  ok   ${name}`);
	} else {
		failed++;
		console.log(`  FAIL ${name}${detail ? " :: " + detail : ""}`);
	}
}

// --- (1) Pure detection logic: the 403-then-redirect guard -----------------
// A cleared page whose raw HTML still contains CF challenge scripts, but whose
// VISIBLE text is clean, must NOT be flagged. Detection takes (title, visible).
check(
	"looksChallenge true on visible interstitial",
	H.looksChallenge("Just a moment...", "Checking your browser before accessing"),
);
check(
	"looksChallenge false when only leftover script markers (visible text clean)",
	!H.looksChallenge("Newest Questions - Stack Overflow", "Newest Questions cf_chl_opt challenge-platform is only in HTML not here"),
	"visible-text detection regressed — would false-flag 403-then-redirect pages",
);
check("looksBlocked true on 403", H.looksBlocked(403, "anything"));
check("looksBlocked true on CAPTCHA text", H.looksBlocked(200, "Verification required. I'm not a robot"));
check("looksBlocked false on normal 200", !H.looksBlocked(200, "Welcome to the site"));

// --- (2) Fingerprint init script in a real Chromium page -------------------
const require = createRequire(import.meta.url);
let chromium;
for (const c of ["playwright", "/usr/lib/node_modules/playwright/index.js"]) {
	try {
		const mod = require(c);
		chromium = mod.chromium ?? mod.default?.chromium;
		if (chromium) break;
	} catch {}
}
if (!chromium) {
	console.log("  FAIL could not load Playwright for fingerprint checks");
	process.exit(1);
}

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
try {
	const major = H.chromeMajor(browser.version());
	check("chromeMajor parses engine version", /^\d+$/.test(major), `got ${major}`);

	const ctx = await browser.newContext({ userAgent: H.yousoroUserAgent(major), viewport: { width: 1280, height: 800 } });
	await ctx.addInitScript(H.makeYousoroInitScript(major));
	const page = await ctx.newPage();
	// Use a real https page: init scripts run on navigation, and navigator.
	// userAgentData only exists in a secure context (not about:blank / data:).
	await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30000 });

	const fp = await page.evaluate(async () => {
		const c = document.createElement("canvas");
		const gl = c.getContext("webgl");
		const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info");
		const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "";
		let brands = [];
		try { brands = navigator.userAgentData ? navigator.userAgentData.brands.map((b) => b.brand) : []; } catch {}
		return {
			webdriver: navigator.webdriver,
			ownProps: Object.getOwnPropertyNames(navigator),
			brands,
			renderer,
			hwc: navigator.hardwareConcurrency,
			platform: navigator.platform,
			screenW: window.screen.width,
			dpr: window.devicePixelRatio,
		};
	});

	check("navigator.webdriver === false", fp.webdriver === false, JSON.stringify(fp.webdriver));
	check("no leaked own-props on navigator", fp.ownProps.length === 0, JSON.stringify(fp.ownProps));
	check("userAgentData claims Google Chrome", fp.brands.includes("Google Chrome"), JSON.stringify(fp.brands));
	check("WebGL renderer is not SwiftShader", !/swiftshader/i.test(fp.renderer), fp.renderer);
	check("hardwareConcurrency spoofed to 8", fp.hwc === 8, String(fp.hwc));
	check("platform is MacIntel", fp.platform === "MacIntel", fp.platform);
	check("screen.width spoofed to 1440", fp.screenW === 1440, String(fp.screenW));
	check("devicePixelRatio spoofed to 2", fp.dpr === 2, String(fp.dpr));

	// Canvas fingerprint noise: a text-rich canvas must differ from the same
	// render without the init script (perturbation applied), and be stable
	// within the session (same URL twice -> identical).
	const noise = await page.evaluate(() => {
		function draw() {
			const c = document.createElement("canvas");
			c.width = 240; c.height = 60;
			const x = c.getContext("2d");
			x.textBaseline = "top"; x.font = "16px Arial"; x.fillStyle = "#f60";
			x.fillRect(0, 0, 240, 60); x.fillStyle = "#069"; x.fillText("Yousoro fp probe 42!", 4, 8);
			return c.toDataURL();
		}
		const a = draw();
		const b = draw();
		return { stable: a === b, len: a.length };
	});
	check("canvas fingerprint stable within session", noise.stable);
} finally {
	await browser.close();
}

if (failed > 0) {
	console.log(`selftest: ${failed} check(s) FAILED`);
	process.exit(1);
}
console.log("selftest: all checks passed");
