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
	extractArray("HOPELESS_MARKERS"),
	extractFn("chromeMajor"),
	extractFn("yousoroUserAgent"),
	extractFn("secChUa"),
	extractFn("makeYousoroInitScript"),
	extractFn("looksChallenge"),
	extractFn("looksBlocked"),
	extractFn("looksHopeless"),
	"globalThis.__H = { chromeMajor, yousoroUserAgent, secChUa, makeYousoroInitScript, looksChallenge, looksBlocked, looksHopeless };",
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

// Google's /sorry/ page: served as HTTP 200, titled with the requested URL, and
// worded "not a robot" rather than any of the older CAPTCHA phrases. It slipped
// through every check and was reported as a successful fetch of a page whose only
// content is the refusal, so escalation never fired. Caught in a live drive.
check(
	"looksBlocked true on Google's /sorry/ interstitial (HTTP 200)",
	H.looksBlocked(
		200,
		"About this page\n\nOur systems have detected unusual traffic from your computer network. This page checks to see if it's really you sending the requests, and not a robot.",
	),
	"Google's rate-limit page would be reported as real content",
);
// The narrow marker must not swallow pages that merely discuss bot detection: a
// false block discards a good page AND burns a CloakBrowser fetch.
check(
	"looksBlocked false on an article about CAPTCHAs",
	!H.looksBlocked(200, "How reCAPTCHA decides whether you are a robot: a technical explainer"),
	"BLOCK_MARKERS got too broad — legitimate pages will be thrown away",
);

// --- (1b) Output caching: the context-blowout guard ------------------------
// ../_shared/cache.ts (shared with pa-cloakbrowser) is imported directly
// (node strips types natively) rather than
// regex-scraped like the stealth helpers above -- it is a normal module with no
// browser dependencies, so there is no reason to eval it.
//
// What these guard: an UNCAPPED extract list used to emit every match straight
// into the context window, and page text was truncated with the remainder
// discarded. Truncation is head-first, so a long page lost its BOTTOM -- the
// part scrolling had just paid to load.
const C = await import(join(here, "..", "_shared", "cache.ts"));

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

		// Both browsing tools now also keep the RAW markup next to the rendered
		// body, so "did the renderer drop something?" is answerable without a
		// re-fetch. Same stem, .html extension.
		const withRaw = C.writeCache(dir, "https://www.example.com/some/page", {
			text: "rendered body",
			textLabel: "PAGE MARKDOWN",
			rawHtml: "<html><body>RAW-ONLY-MARKER</body></html>",
		});
		check("raw DOM lands in a sibling .html", withRaw.rawPath === withRaw.path.replace(/\.txt$/, ".html"), String(withRaw.rawPath));
		check("raw markup is kept verbatim", readFileSync(withRaw.rawPath, "utf8").includes("RAW-ONLY-MARKER"));
		check("raw markup stays out of the greppable body", !readFileSync(withRaw.path, "utf8").includes("RAW-ONLY-MARKER"));
		const foot = C.formatCacheFooter(withRaw, { truncated: false, sections: ["page body lines 2-2"] });
		check("shared footer names both files and the sections", foot.includes(withRaw.path) && foot.includes(withRaw.rawPath) && foot.includes("page body lines"), foot);
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

	// --- (3) format="markdown": DOM -> Markdown, run in the page --------------
	// The point of markdown over innerText is structure and, above all, link
	// URLs: innerText shows that a link exists but not where it goes, forcing a
	// second extract="a" fetch. These checks pin that, plus the visibility
	// filtering that only an in-page walk can do.
	const M = await import(join(here, "markdown.ts"));
	const fixture = [
		'<nav style="display:none"><a href="https://example.com/hidden">Hidden menu</a></nav>',
		"<h1>Title &amp; Co</h1>",
		'<p>Intro with a <a href="https://example.com/docs?a=1">doc link</a> and <strong>bold</strong> and <code>x_y</code>.</p>',
		"<ul><li>one</li><li>two<ul><li>nested a</li></ul></li></ul>",
		'<ol start="3"><li>third</li></ol>',
		"<blockquote><p>quoted line</p></blockquote>",
		"<pre><code>def f(x)\n  x * 2\nend</code></pre>",
		"<table><tr><th>lang</th><th>year</th></tr><tr><td>Ruby</td><td>1995</td></tr></table>",
		'<p><a href="javascript:void(0)">js link</a> <a href="#History">jump to History</a></p>',
		'<div style="visibility:hidden">invisible text</div>',
	].join("\n");
	await page.evaluate((html) => { document.body.innerHTML = html; }, fixture);
	const md = await page.evaluate(M.domToMarkdown);

	check("markdown keeps headings", md.includes("# Title & Co"), md.split("\n")[0]);
	check(
		"markdown carries link URLs inline (the whole point)",
		md.includes("[doc link](https://example.com/docs?a=1)"),
		md,
	);
	check("markdown resolves hrefs to absolute URLs", !/\]\(\/docs/.test(md));
	check("markdown skips display:none subtrees", !md.includes("Hidden menu"));
	check("markdown skips visibility:hidden nodes", !md.includes("invisible text"));
	check("markdown nests sublists by indent", /- two\n  - nested a/.test(md), md);
	check("markdown honours <ol start>", md.includes("3. third"), md);
	check("markdown quotes blockquotes", md.includes("> quoted line"));
	check("markdown fences <pre> and keeps its newlines", /```\ndef f\(x\)\n  x \* 2\nend\n```/.test(md), md);
	check("markdown renders tables with a separator row", md.includes("| lang | year |") && md.includes("| --- | --- |"));

	// Old sites (Hacker News, mailing list archives) lay pages out with NESTED
	// tables. Rendering those as tables duplicates every cell into giant
	// pipe-rows: measured 29KB of duplicated junk vs 14KB clean for one HN page.
	await page.evaluate(() => {
		document.body.innerHTML =
			'<table><tr><td><table><tr><td>header cell</td></tr></table></td></tr>' +
			'<tr><td><p>story <a href="https://ex.org/1">one</a></p></td></tr></table>';
	});
	const layout = await page.evaluate(M.domToMarkdown);
	check("layout tables are walked, not rendered as tables", !layout.includes("| --- |"), layout);
	check("layout table content survives", layout.includes("header cell") && layout.includes("[one](https://ex.org/1)"), layout);
	check("nested layout tables do not duplicate cells", layout.split("header cell").length - 1 === 1, layout);
	check("markdown keeps code spans literal (no escaping inside)", md.includes("`x_y`"), md);
	check("markdown drops javascript: targets but keeps the label", md.includes("js link") && !md.includes("javascript:"));
	// A TOC of same-page anchors otherwise repeats the whole page URL per entry.
	check("markdown shortens same-document anchors to #frag", md.includes("[jump to History](#History)"), md);

	// innerText is the baseline this exists to beat: same page, no URL anywhere.
	const flat = await page.evaluate(() => document.body.innerText);
	check("innerText really does lose the URLs (baseline)", !flat.includes("https://example.com/docs"));

	// The tool now defaults to markdown; `text` and `html` remain reachable.
	const idx = readFileSync(join(here, "index.ts"), "utf8");
	check("index.ts defaults to markdown", /params\.format === "text" \|\| params\.format === "html" \? params\.format : "markdown"/.test(idx));
	check("index.ts always captures the raw DOM", /const html: string = await page\.content\(\)/.test(idx));
	check("index.ts caches the raw DOM alongside the body", /rawHtml: format === "html" \? undefined : result\.html/.test(idx));
	check("index.ts uses the shared footer (identical to cloak_browse)", /formatCacheFooter\(cache, \{/.test(idx));

	// --- (4) escalation to CloakBrowser on a block --------------------------
	// Agents were observed reporting "blocked" to the user instead of reaching
	// for cloak_browse, so the escalation happens in code, and the blocked text
	// says what to do next AT the moment of failure.
	check("index.ts escalates to CloakBrowser when blocked", /if \(result\.blocked && escalate\)/.test(idx));
	check("escalation is opt-out, i.e. on by default", /params\.escalate !== false/.test(idx));
	// "Only after a block" is the property that keeps a normal fetch free, so
	// assert the position of the call, not just that some guard exists.
	const guardAt = idx.indexOf("if (result.blocked && escalate)");
	const callAt = idx.indexOf("cloakDumpDom({");
	check("cloakDumpDom is called exactly once", idx.split("cloakDumpDom({").length - 1 === 1);
	check("escalation only runs after a block (a normal fetch pays nothing)", guardAt > 0 && callAt > guardAt, `guard@${guardAt} call@${callAt}`);
	check("successful escalation clears the blocked flag", /result\.blocked = false;/.test(idx));
	check("successful escalation reports which engine won", /Engine: \$\{/.test(idx) && /escalated automatically/.test(idx));
	check("escalated status is attributed, not left contradictory", /CloakBrowser reports none; yousoro saw/.test(idx));
	check("stale extract list is dropped after escalation", /result\.extracted = undefined;/.test(idx));
	check("blocked+escalate tells the agent to stop retrying", /Do not retry either one/.test(idx));
	check("blocked+no-escalate names cloak_browse explicitly", /retry this URL with the cloak_browse tool/.test(idx));
	check("attempts counter is clamped (loop runs one past)", /Math\.min\(attempt, opts\.maxAttempts\)/.test(idx));

// One backoff, then escalate. This was 4 attempts (27s of sleeping: 6+9+12s)
// before CloakBrowser was tried at all -- the wrong order, since a second
// identical request rarely changes a block but a different engine sometimes does.
check(
	"max_attempts defaults to 2, so only ONE backoff happens before escalation",
	/params\.max_attempts \?\? 2/.test(idx),
	"the slow 4-attempt backoff is back; a blocked page costs ~27s again",
);

// A block retrying cannot fix must not sleep at all. Escalation still runs --
// what is skipped is only re-asking the SAME engine the same question.
check(
	"a hopeless block breaks out instead of backing off",
	/looksHopeless\(vtext\)[\s\S]{0,200}?break;/.test(idx),
	"Google's /sorry/ will burn the backoff again for an identical page",
);
check("looksHopeless true on Google's /sorry/", H.looksHopeless("Our systems have detected unusual traffic from your computer network."));
check("looksHopeless true on an image CAPTCHA", H.looksHopeless("Enter the characters seen in the image"));
check(
	"looksHopeless false on a transient rate-limit, which backing off can fix",
	!H.looksHopeless("Too many requests. Please try again later."),
	"transient 429s would stop being retried",
);
} finally {
	await browser.close();
}

if (failed > 0) {
	console.log(`selftest: ${failed} check(s) FAILED`);
	process.exit(1);
}
console.log("selftest: all checks passed");
