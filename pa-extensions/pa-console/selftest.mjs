/**
 * selftest.mjs — auth-free behavioural guard for pa-console.
 *
 * Two halves.
 *
 * (1) PURE FORMATTING, extracted from format.ts by regex and eval'd. Same
 *     approach as pa-yousoro-browse/selftest.mjs and for the same reason: there
 *     is no esbuild in the image, and loading the extension through pi needs a
 *     model and auth. Deliberately coupled to that file's style.
 *
 * (2) LIVE-PAGE BEHAVIOUR, driven with the real bundled Playwright. This half
 *     matters more. The whole REPL design rests on four properties that are
 *     easy to break silently and impossible to notice by reading code:
 *
 *       a. Injected console output is distinguishable from the page's own
 *          (empty location.url) -- that is how `agent` rows are labelled.
 *       b. `window.x` survives between evaluate() calls and a top-level `const`
 *          does not. If (a) regressed, agent output would be mislabelled; if
 *          (b) regressed, the documented "put state on window" rule is wrong.
 *       c. Events fired BETWEEN calls are still captured. This is the reason
 *          there is no settle_ms guessing, and a regression would make the tool
 *          report "no errors" for a page that is still broken -- the single
 *          worst failure this tool could have.
 *       d. Closing the context wipes page state, so url= really is a clean slate.
 *
 * Usage: node selftest.mjs   (exit 0 = pass, non-zero = fail)
 * Playwright is resolved from the global install baked into the image.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fmtSrc = readFileSync(join(here, "format.ts"), "utf8");

let failures = 0;
function check(name, cond, detail) {
	if (cond) {
		console.log(`  ok   ${name}`);
	} else {
		failures++;
		console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`);
	}
}

// --- (1) Extract pure helpers ---------------------------------------------

function extractFn(src, name) {
	const re = new RegExp(`(?:export )?function ${name}\\([\\s\\S]*?\\n}\\n`, "m");
	const m = re.exec(src);
	if (!m) throw new Error(`selftest: could not extract function ${name}`);
	// Strip TS annotations from the SIGNATURE ONLY (up to the opening brace).
	// The body contains template literals and string comparisons that must not
	// be touched.
	// `export` is meaningless inside a `new Function` body, so drop it.
	const body = m[0].replace(/^export /, "");
	const brace = body.indexOf("{");
	const sig = body.slice(0, brace).replace(/:\s*[A-Za-z_][\w.<>[\]| ]*/g, "");
	return sig + body.slice(brace);
}
function extractConst(src, name) {
	const re = new RegExp(`(?:export )?const ${name}(?::[^=]+)? = [^;]+;`, "m");
	const m = re.exec(src);
	if (!m) throw new Error(`selftest: could not extract const ${name}`);
	return m[0].replace(/^export /, "");
}

const prelude = [
	extractConst(fmtSrc, "TIME_W"),
	extractConst(fmtSrc, "KIND_W"),
	extractConst(fmtSrc, "WHERE_W"),
	extractFn(fmtSrc, "formatEvent"),
	extractFn(fmtSrc, "formatEvents"),
	extractFn(fmtSrc, "countErrors"),
	extractFn(fmtSrc, "humanDuration"),
	extractFn(fmtSrc, "cacheFileName"),
].join("\n");

const { formatEvent, formatEvents, countErrors, humanDuration, cacheFileName } = new Function(
	`${prelude}\nreturn { formatEvent, formatEvents, countErrors, humanDuration, cacheFileName };`,
)();

console.log("formatting:");

const line = formatEvent({ t: 402, kind: "http", where: "", text: "POST /api/order  500" });
check("formatEvent puts time first", /^\s*402ms\s{2}http/.test(line), JSON.stringify(line));
check("formatEvent keeps the message intact", line.includes("POST /api/order  500"));
// Without a unit the leading column reads as a line number or a status code.
check("time carries an explicit ms unit", line.includes("402ms"), JSON.stringify(line));
check(
	"every kind carries the unit, not just the first row",
	formatEvents([
		{ t: 0, kind: "nav", where: "", text: "GET /" },
		{ t: 2970, kind: "uncaught", where: "", text: "boom" },
	])
		.split("\n")
		.every((l) => /^\s*\d+ms\s/.test(l)),
);

const withWhere = formatEvent({ t: 7, kind: "error", where: "/app.js:42", text: "boom" });
check("formatEvent renders the source column", withWhere.includes("/app.js:42"));

const withStack = formatEvent({
	t: 9,
	kind: "uncaught",
	where: "/app.js:42",
	text: "TypeError: x",
	extra: ["at handleSubmit (/app.js:42:11)"],
});
check("stack frames go on indented continuation lines", withStack.split("\n").length === 2);
check(
	"continuation lines are indented past the text column",
	/^\s{20,}at handleSubmit/.test(withStack.split("\n")[1]),
);

// Columns must line up or the stream stops being scannable, which is the entire
// point of a single interleaved log.
const a = formatEvent({ t: 1, kind: "log", where: "/a.js:1", text: "X" });
const b = formatEvent({ t: 2, kind: "uncaught", where: "/bbbb.js:99", text: "Y" });
check("text column is aligned across kinds", a.indexOf("X") === b.indexOf("Y"), `${a.indexOf("X")} vs ${b.indexOf("Y")}`);

check("formatEvents joins one per line", formatEvents([{ t: 1, kind: "log", where: "", text: "a" }, { t: 2, kind: "log", where: "", text: "b" }]).split("\n").length === 2);

// A caller's own broken snippet is not evidence about the page; counting it as
// an error would send an agent hunting a bug that does not exist.
const counted = countErrors([
	{ t: 1, kind: "log", where: "", text: "" },
	{ t: 2, kind: "uncaught", where: "", text: "" },
	{ t: 3, kind: "http", where: "", text: "" },
	{ t: 4, kind: "error", where: "", text: "" },
	{ t: 5, kind: "script", where: "", text: "" },
	{ t: 6, kind: "agent", where: "", text: "" },
]);
check("countErrors counts uncaught+http+error only", counted === 3, `got ${counted}`);

check("humanDuration seconds", humanDuration(45_000) === "45s", humanDuration(45_000));
check("humanDuration minutes", humanDuration(372_000) === "6m12s", humanDuration(372_000));
check("humanDuration hours", humanDuration(3_900_000) === "1h5m", humanDuration(3_900_000));
check("cacheFileName is unique per call", cacheFileName() !== cacheFileName());
check("cacheFileName is a .txt under a recognisable prefix", /^pa-console-[\d-]+-[0-9a-f]{4}\.txt$/.test(cacheFileName()));

// --- (2) Live-page behaviour ----------------------------------------------

console.log("live page:");

const require = createRequire(import.meta.url);
let chromium;
for (const cand of ["playwright", "/usr/lib/node_modules/playwright/index.js"]) {
	try {
		const mod = require(cand);
		chromium = mod.chromium ?? mod.default?.chromium;
		if (chromium) break;
	} catch {
		/* try the next candidate */
	}
}
if (!chromium) {
	console.log("  FAIL could not load Playwright");
	process.exit(1);
}

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
try {
	let ctx = await browser.newContext({ viewport: { width: 800, height: 400 } });
	let page = await ctx.newPage();

	const events = [];
	const attach = (p) => {
		p.on("console", (m) => {
			const loc = m.location();
			events.push({
				injected: !loc.url,
				type: m.type(),
				text: m.text(),
				url: loc.url,
				line: loc.line,
				lineNumber: loc.lineNumber,
			});
		});
		p.on("pageerror", (e) => events.push({ kind: "uncaught", text: e.message }));
		p.on("response", (r) => { if (r.status() >= 400) events.push({ kind: "http", text: `${r.status()}` }); });
	};
	attach(page);

	// A real http:// origin, because a data:/about: URL reports an empty
	// location.url for PAGE code too, which would defeat check (a) below.
	const { createServer } = await import("node:http");
	const APP = `console.log('[app] mounted');
window.hit = function () { setTimeout(function () { missingGlobal.boom; }, 400); };`;
	const server = createServer((req, res) => {
		if (req.url === "/app.js") {
			res.writeHead(200, { "content-type": "text/javascript" });
			return res.end(APP);
		}
		if (req.url === "/fail") {
			res.writeHead(500, { "content-type": "text/plain" });
			return res.end("nope");
		}
		res.writeHead(200, { "content-type": "text/html" });
		res.end('<!doctype html><meta charset=utf-8><title>t</title><script src="/app.js"></script>');
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${server.address().port}`;

	await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(200);

	// (a) page output carries a source URL; injected output does not.
	const appLog = events.find((e) => e.text.includes("[app] mounted"));
	check("page's own console.log has a source URL", !!appLog && appLog.injected === false, JSON.stringify(appLog));
	// Playwright reports console lines 0-based; app.js line 1 must not read as 0,
	// or it disagrees with both the editor and the stack frames on uncaught rows.
	check(
		"raw console location is 0-based (the reason sourceRef adds 1)",
		!!appLog && (appLog.line ?? appLog.lineNumber) === 0,
		JSON.stringify(appLog),
	);

	await page.evaluate(`(async () => { console.log('[agent] injected'); })()`);
	await page.waitForTimeout(100);
	const agentLog = events.find((e) => e.text.includes("[agent] injected"));
	check("injected console.log is flagged as agent output", !!agentLog && agentLog.injected === true, JSON.stringify(agentLog));

	// (b) window state persists between evals; a top-level const does not.
	await page.evaluate(`(async () => { window.n = 41; const localOnly = 'vanishes'; })()`);
	const persisted = await page.evaluate(`(async () => window.n)()`);
	check("window state survives between evals", persisted === 41, `got ${persisted}`);
	const scoped = await page.evaluate(`(async () => typeof localOnly)()`);
	check("top-level const does NOT survive (documented gotcha)", scoped === "undefined", `got ${scoped}`);

	// A return value must come back, since it is how a snippet reports a result.
	const returned = await page.evaluate(`(async () => ({ ok: true, n: 2 }))()`);
	check("return value comes back to the caller", returned && returned.ok === true && returned.n === 2);

	// A bad selector must reject on the caller's side rather than surface as a
	// page error, or "your typo" gets mistaken for "the app is broken".
	let threwCallerSide = false;
	const errorsBefore = events.filter((e) => e.kind === "uncaught").length;
	try {
		await page.evaluate(`(async () => { document.getElementById('nope').click(); })()`);
	} catch {
		threwCallerSide = true;
	}
	check("a bad selector rejects the evaluate call", threwCallerSide);
	check(
		"a bad selector does not masquerade as a page error",
		events.filter((e) => e.kind === "uncaught").length === errorsBefore,
	);

	// (c) THE IMPORTANT ONE: an error fired long after the call that triggered
	// it must still be captured, with nothing awaiting it.
	const lateBefore = events.filter((e) => e.kind === "uncaught").length;
	await page.evaluate(`(async () => { window.hit(); })()`);
	await page.waitForTimeout(1200); // simulates the agent doing something else
	const lateAfter = events.filter((e) => e.kind === "uncaught").length;
	check("a delayed error is captured after the call returned", lateAfter === lateBefore + 1, `${lateBefore} -> ${lateAfter}`);

	// Failed requests share the stream, because a 500 is usually the real cause.
	await page.evaluate(`(async () => { try { await fetch('/fail'); } catch {} })()`);
	await page.waitForTimeout(300);
	check("a 4xx/5xx response is recorded", events.some((e) => e.kind === "http"));

	// (d) url= means a genuinely clean slate: closing the context drops state.
	await ctx.close();
	ctx = await browser.newContext({ viewport: { width: 800, height: 400 } });
	page = await ctx.newPage();
	attach(page);
	await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
	const afterReopen = await page.evaluate(`(async () => typeof window.n)()`);
	check("re-opening drops the previous page's window state", afterReopen === "undefined", `got ${afterReopen}`);

	// Screenshotting the state we drove the page into is the capability
	// screenshot_url cannot provide, so guard that it produces a real PNG.
	await page.evaluate(`(async () => { document.body.innerHTML = '<h1>changed</h1>'; })()`);
	const { mkdtempSync, readFileSync: rf, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const dir = mkdtempSync(join(tmpdir(), "pa-console-selftest-"));
	const shot = join(dir, "state.png");
	await page.screenshot({ path: shot, type: "png" });
	const bytes = rf(shot);
	const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes.toString("ascii", 1, 4) === "PNG";
	check("screenshot of the live page writes a real PNG", isPng, `${bytes.length} bytes`);
	rmSync(dir, { recursive: true, force: true });

	server.close();
} finally {
	await browser.close();
}

if (failures > 0) {
	console.log(`selftest: ${failures} check(s) FAILED`);
	process.exit(1);
}
console.log("selftest: all checks passed");
