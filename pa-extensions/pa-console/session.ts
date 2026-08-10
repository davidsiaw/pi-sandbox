/**
 * pa-console/session.ts — the one live page, and everything that owns it.
 *
 * WHY A LIVE PAGE AND NOT A FRESH LOAD PER CALL
 * The other browsing tools are one-shot: they launch, load, read, and close.
 * That cannot express "click this, THEN look", which is how bugs are actually
 * reported ("I press Pay and nothing happens"). A one-shot tool photographs the
 * initial state forever.
 *
 * So this module keeps exactly one browser, one context and one page alive
 * across tool calls, with the console listeners attached the whole time. Three
 * consequences, all deliberate:
 *
 *   1. Events that arrive BETWEEN tool calls are still captured. A setTimeout
 *      that throws two seconds after the agent moved on lands in the buffer and
 *      is delivered on the next call. Measured: an error fired at t=2970ms while
 *      nothing was being awaited, and surfaced on a later drain. This is why
 *      there is no `settle_ms` parameter -- the one-shot design needed one to
 *      guess how long to wait, and guessing wrong reported "fixed" for a page
 *      that was still broken.
 *
 *   2. `drain()` returns only what is new since the previous call (a cursor over
 *      the buffer), so a REPL turn reads like a console rather than replaying
 *      everything from page load.
 *
 *   3. State persists between evals -- but only on `window`. Each eval is its
 *      own function scope, because the async wrapper is what gives the caller
 *      top-level `await`. Measured: `window.n = 41` read back fine on the next
 *      call; `const localOnly` came back `undefined`. Real DevTools puts
 *      top-level declarations on the global and this does not, which is the one
 *      way the REPL is not console-identical, so the tool description says so.
 *
 * WHY open() CLOSES THE CONTEXT, NOT JUST THE PAGE
 * "Load a new page" has to mean a genuinely clean slate, including cookies and
 * localStorage, or a stale login silently changes the next run's behaviour.
 * Closing the context does that. The BROWSER is reused, which keeps a reload at
 * roughly 100ms instead of a full relaunch, and matters more than it looks:
 * PID 1 in this image is pi, which does not reap orphans, so every browser
 * launch leaves defunct entries behind. Fewer launches, fewer zombies.
 *
 * WHY THERE IS AN EXPLICIT shutdown()
 * Measured: an idle headless Chromium on about:blank holds ~357MB RSS. Holding
 * that for a whole session because the agent debugged something 40 minutes ago
 * is pure waste. It is NOT a safety mechanism -- SIGKILLing the owning node
 * process was measured to take every Chromium process with it, so nothing can
 * run away. It is an early-release valve, and `session_shutdown` is the backstop.
 */

import { createRequire } from "node:module";

// Playwright is not bundled; it comes from the global install baked into the pa
// image. Mirrors ../_shared/stealth.ts, which is not imported here because none
// of its fingerprint masking is wanted: this tool drives pages you wrote, on
// localhost, where a bot-block heuristic is pure overhead and a page that
// happens to contain the word "blocked" would be a false positive.
const GLOBAL_PLAYWRIGHT_CANDIDATES = [
	"playwright",
	"/usr/lib/node_modules/playwright/index.js",
	"/usr/local/lib/node_modules/playwright/index.js",
];

// biome-ignore lint/suspicious/noExplicitAny: playwright has no local types here
type Chromium = any;
// biome-ignore lint/suspicious/noExplicitAny: playwright has no local types here
type Page = any;
// biome-ignore lint/suspicious/noExplicitAny: playwright has no local types here
type BrowserContext = any;
// biome-ignore lint/suspicious/noExplicitAny: playwright has no local types here
type Browser = any;

export function loadChromium(): Chromium {
	const require = createRequire(import.meta.url);
	let lastErr: unknown;
	for (const candidate of GLOBAL_PLAYWRIGHT_CANDIDATES) {
		try {
			const mod = require(candidate);
			const chromium = mod.chromium ?? mod.default?.chromium;
			if (chromium) return chromium;
		} catch (err) {
			lastErr = err;
		}
	}
	throw new Error(
		`Could not load Playwright. Tried: ${GLOBAL_PLAYWRIGHT_CANDIDATES.join(", ")}. ` +
			`Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
	);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * `agent` is console output from an injected script; `log`/`warn`/`error`/etc.
 * come from the page's own code. `uncaught` is a thrown exception, which never
 * passes through the console API and so needs its own channel. `script` is the
 * injected code itself failing -- kept distinct from `uncaught` because
 * confusing "your selector was wrong" with "the app threw" sends an agent off
 * fixing a bug that does not exist.
 */
export type EventKind =
	| "nav"
	| "agent"
	| "log"
	| "warn"
	| "error"
	| "info"
	| "debug"
	| "uncaught"
	| "http"
	| "neterr"
	| "script"
	| "return"
	| "note";

export interface ConsoleEvent {
	/** ms since the current page began loading. */
	t: number;
	kind: EventKind;
	/** Source location (`/app.js:42`) where known, else "". */
	where: string;
	text: string;
	/** Extra indented lines, e.g. the top stack frames of an uncaught error. */
	extra?: string[];
}

/** Console API type names differ from what a reader expects; normalise. */
function kindFromConsoleType(type: string): EventKind {
	switch (type) {
		case "warning":
			return "warn";
		case "error":
			return "error";
		case "info":
			return "info";
		case "debug":
			return "debug";
		default:
			return "log";
	}
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

/**
 * Ring-buffer ceiling. A chatty dev build left running for minutes would grow
 * without bound otherwise. Dropping the OLDEST events is the right trade: the
 * newest are the ones a REPL turn is about, and the count of dropped events is
 * reported so the loss is never silent.
 */
const MAX_EVENTS = 5000;

interface SessionState {
	browser: Browser | null;
	context: BrowserContext | null;
	page: Page | null;
	url: string | null;
	openedAt: number;
	/** ms timestamp that `ConsoleEvent.t` is relative to. */
	t0: number;
	buf: ConsoleEvent[];
	/** High-water mark: events before this index have already been returned. */
	cursor: number;
	dropped: number;
	pagesOpened: number;
	viewport: { width: number; height: number };
}

const S: SessionState = {
	browser: null,
	context: null,
	page: null,
	url: null,
	openedAt: 0,
	t0: 0,
	buf: [],
	cursor: 0,
	dropped: 0,
	pagesOpened: 0,
	viewport: { width: 1280, height: 800 },
};

export function hasPage(): boolean {
	return S.page !== null && !S.page.isClosed();
}

export function currentUrl(): string | null {
	return S.url;
}

export interface SessionStatus {
	running: boolean;
	url: string | null;
	uptimeMs: number;
	pagesOpened: number;
	totalEvents: number;
	dropped: number;
	viewport: { width: number; height: number };
}

export function status(): SessionStatus {
	return {
		running: S.browser !== null,
		url: S.url,
		uptimeMs: S.openedAt ? Date.now() - S.openedAt : 0,
		pagesOpened: S.pagesOpened,
		totalEvents: S.buf.length + S.dropped,
		dropped: S.dropped,
		viewport: S.viewport,
	};
}

function push(ev: ConsoleEvent): void {
	S.buf.push(ev);
	if (S.buf.length > MAX_EVENTS) {
		const excess = S.buf.length - MAX_EVENTS;
		S.buf.splice(0, excess);
		S.dropped += excess;
		// The cursor indexes into buf, so it has to slide with the window or the
		// next drain would replay events the caller already saw.
		S.cursor = Math.max(0, S.cursor - excess);
	}
}

function now(): number {
	return Date.now() - S.t0;
}

/** Strip the origin so `/app.js:42` reads cleanly instead of a 60-char URL. */
function shortenUrl(u: string): string {
	return u.replace(/^https?:\/\/[^/]+/, "");
}

/**
 * Playwright reports a console message's line as **0-based** (`line`, with the
 * older `lineNumber` deprecated but still populated). Every other line number a
 * reader will compare it against -- the editor, the stack frames on `uncaught`
 * rows in this same column -- is 1-based, so reporting it raw puts an
 * off-by-one into the one field whose entire job is to point at a line of code.
 * Measured before this fix: a console.log on line 1 of app.js reported `:0`
 * while an exception on line 5 of the same file correctly reported `:5`.
 */
function sourceRef(loc: { url: string; line?: number; lineNumber?: number }): string {
	const zeroBased = loc.line ?? loc.lineNumber ?? 0;
	return `${shortenUrl(loc.url)}:${zeroBased + 1}`;
}

/**
 * Attach the listeners. Called BEFORE goto, always: attach afterwards and every
 * error thrown during page load is already gone, which is a large share of real
 * bugs.
 *
 * Handlers push SYNCHRONOUSLY. The tempting upgrade -- `msg.args()` +
 * `jsonValue()` to recover full objects instead of the preview string -- is
 * async, and awaiting inside the handler reorders the stream. Chronological
 * order is the entire value of this tool, so it is not worth a deeper object
 * dump. Measured on the alternative: it also returns `ref: <Node>` for DOM
 * elements (no better than the preview) and throws outright on a circular
 * object.
 */
function attach(page: Page): void {
	page.on(
		"console",
		(m: {
			type(): string;
			text(): string;
			location(): { url: string; line?: number; lineNumber?: number };
		}) => {
			const loc = m.location();
			// Injected script has no source URL, which is how agent output is told
			// apart from the page's own logging -- no tagging convention required.
			const injected = !loc.url;
			push({
				t: now(),
				kind: injected ? "agent" : kindFromConsoleType(m.type()),
				where: injected ? "" : sourceRef(loc),
				text: m.text(),
			});
		},
	);

	page.on("pageerror", (e: Error) => {
		const frames = (e.stack ?? "")
			.split("\n")
			.slice(1, 4)
			.map((s) => s.trim())
			.filter(Boolean);
		const first = frames[0] ?? "";
		const m = first.match(/\(?(https?:\/\/[^\s)]+|file:\/\/[^\s)]+)\)?/);
		push({
			t: now(),
			kind: "uncaught",
			where: m ? shortenUrl(m[1]) : "",
			text: e.message,
			extra: frames,
		});
	});

	// A 4xx/5xx is not a JS error but is very often the actual cause of "I
	// clicked and nothing happened", so it belongs in the same ordered stream.
	page.on("response", (r: { status(): number; url(): string; request(): { method(): string } }) => {
		const code = r.status();
		if (code >= 400) {
			push({
				t: now(),
				kind: "http",
				where: "",
				text: `${r.request().method()} ${shortenUrl(r.url())}  ${code}`,
			});
		}
	});

	page.on("requestfailed", (r: { url(): string; failure(): { errorText: string } | null }) => {
		push({
			t: now(),
			kind: "neterr",
			where: "",
			text: `${shortenUrl(r.url())}  ${r.failure()?.errorText ?? "failed"}`,
		});
	});

	// The app routing itself would otherwise leave `t` relative to a stale load
	// and the stream silently describing a different document.
	page.on("framenavigated", (frame: { url(): string; parentFrame(): unknown }) => {
		if (frame.parentFrame()) return; // subframes are noise here
		const u = frame.url();
		if (u === "about:blank" || u === S.url) return;
		S.url = u;
		push({ t: now(), kind: "nav", where: "", text: `navigated to ${u}` });
	});

	page.on("crash", () => {
		push({ t: now(), kind: "note", where: "", text: "PAGE CRASHED (out of memory?)" });
	});
}

export interface OpenOptions {
	url: string;
	width?: number;
	height?: number;
	timeoutMs?: number;
}

/** Discard any current page and load a fresh one. Reuses the browser process. */
export async function open(opts: OpenOptions): Promise<void> {
	const chromium = loadChromium();
	if (!S.browser) {
		S.browser = await chromium.launch({
			headless: true,
			// Required in this container: no user namespaces available.
			args: ["--no-sandbox", "--disable-dev-shm-usage"],
		});
	}
	if (S.context) {
		await S.context.close().catch(() => {
			/* already gone; nothing to salvage */
		});
	}
	if (opts.width || opts.height) {
		S.viewport = {
			width: opts.width ?? S.viewport.width,
			height: opts.height ?? S.viewport.height,
		};
	}

	S.context = await S.browser.newContext({ viewport: S.viewport });
	S.page = await S.context.newPage();
	S.buf = [];
	S.cursor = 0;
	S.dropped = 0;
	S.url = opts.url;
	S.t0 = Date.now();
	if (!S.openedAt) S.openedAt = Date.now();
	S.pagesOpened += 1;

	attach(S.page);

	const resp = await S.page.goto(opts.url, {
		waitUntil: "domcontentloaded",
		timeout: opts.timeoutMs ?? 30000,
	});
	// Unshift so the nav line sorts first even though goto resolves after the
	// page's own load-time logging has already been pushed.
	S.buf.unshift({
		t: 0,
		kind: "nav",
		where: "",
		text: `GET ${opts.url}  ${resp ? resp.status() : "(no response)"}`,
	});
	S.url = S.page.url();
}

/**
 * Run caller JS in the page's own realm.
 *
 * Wrapped in an async IIFE so `await` works at the top level of the snippet,
 * the same as typing into DevTools. A rejected evaluate is the CALLER's bug
 * (bad selector, typo), not the page's, so it is recorded as `script` and
 * swallowed: the events collected before the throw are usually what explain it,
 * and killing the session would discard them.
 */
export async function evaluate(script: string): Promise<void> {
	if (!hasPage()) throw new Error("no page open");
	try {
		const value = await S.page.evaluate(`(async () => { ${script} })()`);
		if (value !== undefined) {
			let rendered: string;
			try {
				rendered = JSON.stringify(value) ?? String(value);
			} catch {
				// Circular or otherwise unserialisable: say so rather than throw.
				rendered = "<unserialisable value>";
			}
			push({ t: now(), kind: "return", where: "", text: rendered });
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		push({
			t: now(),
			kind: "script",
			where: "",
			text: msg.split("\n")[0].replace(/^page\.evaluate:\s*/, ""),
		});
	}
}

/** Give the page a moment to react before draining. */
export async function settle(ms: number): Promise<void> {
	if (!hasPage() || ms <= 0) return;
	await S.page.waitForTimeout(ms);
}

export interface Drained {
	events: ConsoleEvent[];
	dropped: number;
}

/** Everything since the last drain. Advances the cursor. */
export function drain(): Drained {
	const events = S.buf.slice(S.cursor);
	S.cursor = S.buf.length;
	const dropped = S.dropped;
	S.dropped = 0;
	return { events, dropped };
}

/** Every event still buffered, for the shutdown flush. Does not move the cursor. */
export function allEvents(): ConsoleEvent[] {
	return S.buf.slice();
}

export interface ShotOptions {
	path: string;
	fullPage?: boolean;
	selector?: string;
}

export async function screenshot(opts: ShotOptions): Promise<void> {
	if (!hasPage()) throw new Error("no page open");
	if (opts.selector) {
		const el = await S.page.$(opts.selector);
		if (!el) throw new Error(`selector "${opts.selector}" matched no element`);
		await el.screenshot({ path: opts.path, type: "png" });
		return;
	}
	await S.page.screenshot({ path: opts.path, type: "png", fullPage: opts.fullPage ?? false });
}

/**
 * Close everything. Idempotent by contract: callable when nothing is open, and
 * callable twice, because both the tool and `session_shutdown` invoke it and an
 * agent should be able to call it reflexively without checking first.
 */
export async function shutdown(): Promise<SessionStatus | null> {
	if (!S.browser) return null;
	const final = status();
	try {
		await S.browser.close();
	} catch {
		// Already dead. Nothing useful left to do, and throwing here would make
		// session_shutdown noisy at exactly the moment nobody can act on it.
	}
	S.browser = null;
	S.context = null;
	S.page = null;
	S.url = null;
	S.openedAt = 0;
	S.t0 = 0;
	S.buf = [];
	S.cursor = 0;
	S.dropped = 0;
	S.pagesOpened = 0;
	return final;
}
