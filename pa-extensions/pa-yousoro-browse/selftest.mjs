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
 * loading via pi needs a model/auth). Instead it reads the source, extracts the
 * pure helpers by regex, strips the few TS annotations they use, and evals them.
 * This is deliberately coupled to that file's style.
 *
 * The helpers now live in ../_shared/stealth.ts (shared with pa-screenshot), so
 * that is the file read here. The regexes also tolerate a leading `export `,
 * which the shared module adds.
 *
 * Usage: node selftest.mjs   (exit 0 = pass, non-zero = fail)
 * Playwright is resolved from the global install baked into the image.
 */

import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "_shared", "stealth.ts"), "utf8");

// --- Extract pure helpers from the source ---------------------------------
function extractFn(name) {
	const re = new RegExp(`(?:export )?function ${name}\\([\\s\\S]*?\\n}\\n`, "m");
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
	const re = new RegExp(`(?:export )?const ${name} = \\[[\\s\\S]*?\\];`, "m");
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
]
	.join("\n")
	// The shared module exports these; `export` is illegal in an eval'd script,
	// so drop the keyword now that the declarations have been extracted.
	.replace(/^export /gm, "");

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

// --- (1b) Output caching: the context-blowout guard ------------------------
// cache.ts is imported directly (node strips types natively) rather than
// regex-scraped like the stealth helpers above -- it is a normal module with no
// browser dependencies, so there is no reason to eval it.
//
// What these guard: an UNCAPPED extract list used to emit every match straight
// into the context window, and page text was truncated with the remainder
// discarded. Truncation is head-first, so a long page lost its BOTTOM -- the
// part scrolling had just paid to load.
const C = await import(join(here, "cache.ts"));

{
	const body = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");
	const t = C.truncateHead(body, 100);
	check("truncateHead reports true totals, not truncated ones", t.totalLines === 500, `got ${t.totalLines}`);
	check("truncateHead actually truncates", t.truncated && t.content.length <= 100);
	check("truncateHead never cuts mid-line", !t.truncated || !t.content.endsWith(" ") && body.startsWith(t.content));
	check("truncateHead keeps whole lines only", t.content.split("\n").every((l) => /^line \d+$/.test(l)));

	const short = C.truncateHead("tiny", 8000);
	check("truncateHead passes short content through untouched", !short.truncated && short.content === "tiny");

	// A single line longer than the budget has no newline to back off to; a hard
	// cut is the only option, and it must not loop or return nothing.
	const huge = C.truncateHead("x".repeat(5000), 100);
	check("truncateHead hard-cuts a single over-long line", huge.truncated && huge.content.length === 100);
}

{
	// TSV is one record per line; embedded tabs/newlines in link text would break
	// every downstream rg/cut, so they must collapse.
	const line = C.tsvLine({ text: "a\tb\nc  ", attr: "https://x/y" });
	check("tsvLine collapses tabs/newlines in text", line === "a b c\thttps://x/y", JSON.stringify(line));
	check("tsvLine omits the tab when there is no attr", C.tsvLine({ text: "solo" }) === "solo");
}

{
	const extracted = Array.from({ length: 300 }, (_, i) => ({
		text: `link ${i + 1}`,
		attr: `https://example.com/${i + 1}`,
	}));
	const text = Array.from({ length: 400 }, (_, i) => `body line ${i + 1}`).join("\n");
	const dir = mkdtempSync(join(tmpdir(), "pa-browse-selftest-"));
	try {
		const info = C.writeCache(dir, "https://www.example.com/some/page", {
			extract: "a",
			extractAttr: "href",
			extracted,
			text,
		});
		const onDisk = readFileSync(info.path, "utf8");
		const fileLines = onDisk.split("\n");

		check("cache filename carries the host", /pa-browse-example\.com-/.test(info.path), info.path);
		check("cache holds every extracted item", extracted.every((e) => onDisk.includes(e.attr)));

		// The contract that matters: the reported ranges must actually index the
		// data, or `read offset=` lands on the wrong thing.
		const [exStart, exEnd] = info.extractedRange;
		check("extractedRange spans exactly the TSV rows", exEnd - exStart + 1 === 300, `${exStart}-${exEnd}`);
		check("extractedRange start points at the first item", fileLines[exStart - 1] === "link 1\thttps://example.com/1", fileLines[exStart - 1]);
		check("extractedRange end points at the last item", fileLines[exEnd - 1] === "link 300\thttps://example.com/300", fileLines[exEnd - 1]);

		const [ptStart, ptEnd] = info.pageTextRange;
		check("pageTextRange spans exactly the page text", ptEnd - ptStart + 1 === 400, `${ptStart}-${ptEnd}`);
		check("pageTextRange start points at the first text line", fileLines[ptStart - 1] === "body line 1", fileLines[ptStart - 1]);

		// The whole reason this exists: what the inline preview drops must still be
		// reachable in the file.
		const preview = C.truncateHead(text, 200);
		check("preview omits the tail", !preview.content.includes("body line 400"));
		check("cache file still has the tail the preview dropped", fileLines[ptEnd - 1] === "body line 400", fileLines[ptEnd - 1]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

{
	// Degenerate inputs must not produce bogus ranges.
	const dir = mkdtempSync(join(tmpdir(), "pa-browse-selftest-"));
	try {
		const empty = C.writeCache(dir, "not a url", { text: "" });
		check("empty page text yields no pageTextRange", empty.pageTextRange === undefined);
		check("no extract yields no extractedRange", empty.extractedRange === undefined);
		check("unparseable URL still produces a filename", /pa-browse-page-/.test(empty.path), empty.path);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

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
