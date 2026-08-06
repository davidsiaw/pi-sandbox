/**
 * pa-rag — automatic local RAG index for the project, baked into the pa image.
 *
 * WHAT IT DOES
 *   On session start, probes the project for indexable content. If it is small
 *   enough to index quickly, it indexes it in the background; otherwise it
 *   tells the user the estimate and waits for an explicit `/rag-index`. The
 *   index persists in `.pirag/`, so a *fresh* agent with no context can still
 *   search everything the previous one saw — including past pi sessions.
 *
 * WHAT IT REUSES
 *   Chunking, ONNX embeddings (Xenova/all-MiniLM-L6-v2, 384-dim), SQLite FTS5
 *   BM25 + sqlite-vec cosine, hybrid fusion and hash-based incremental refresh
 *   all come from `pi-local-rag`, unmodified. See upstream.ts for why the
 *   import looks unusual, and walk.ts for why we supply our own file list.
 *
 * WHY SLICED, INCREMENTAL INDEXING
 *   Upstream's indexFiles() accumulates EVERYTHING in memory and commits in a
 *   single transaction at the end: `toIndex` holds every chunk's text and
 *   `fw._vectors` every vector, and nothing is released until `tx()` runs. That
 *   makes peak memory O(repo), not O(batch), so a large repo OOM-kills the
 *   container no matter how small the embedding batch is (exit 137, schema-only
 *   DB, wrecked terminal — see scripts/patch-rag-batch.sh for that story).
 *
 *   So we never hand upstream the whole file list. We slice it into ~512 KB
 *   groups and call indexFiles() once per slice. Each call returns, commits, and
 *   frees. Measured on a 432-file / 2.2 MB tree: RSS stays FLAT at ~808 MB
 *   across 5 slices versus climbing without bound, 1308 chunks either way, for
 *   ~5% extra wall time (61.9s vs 58.9s).
 *
 *   Slicing buys three things beyond memory:
 *     - CHECKPOINTS. Each slice is committed, so an interrupted pass keeps its
 *       progress instead of losing everything.
 *     - RESUME. Upstream skips unchanged files by content hash, so the next run
 *       picks up exactly where this one stopped, for free.
 *     - A STOP POINT. session_shutdown sets abortIndex and the loop exits at the
 *       next boundary instead of embedding into a dead session.
 *
 * WHY IT ALWAYS INDEXES, AND WHY IT IS DELIBERATELY SLOW
 *   Fully automatic indexing is the point of this extension: having to remember
 *   /rag-index is worth more friction-cost than the CPU it saves. So the budget
 *   is 1 GB of source and the background pass simply grinds through it, however
 *   long that takes (~1 min/MB, so a 1 GB repo is many hours). That is
 *   acceptable ONLY because the pass is polite and interruptible:
 *
 *     - LOW-MEMORY BATCH. Background passes embed at batch 2 (~282 MB peak)
 *       rather than 8 (~729 MB). Costs ~27% throughput for 2.6x less memory.
 *       An explicit /rag-index the user is waiting on uses the fast batch.
 *     - DUTY CYCLE. Between slices the background pass sleeps proportionally to
 *       how long the last slice took, so it uses a bounded FRACTION of a core
 *       instead of pegging one. Foreground passes do not throttle.
 *     - CHECKPOINTS + RESUME. Every slice commits and unchanged files are
 *       hash-skipped, so being killed at any point costs nothing.
 *
 *   Thread count is NOT a usable lever: Transformers.js v2 hardcodes its ORT
 *   session options, so intraOpNumThreads has no measurable effect (verified:
 *   1/2/4 threads all ~15 chunks/sec). Batch size and scheduling are all we have.
 *
 *   The probe itself is ~1-2 ms even on huge trees, because it bails as soon
 *   as it crosses the cap.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { load, type Upstream } from "./upstream.ts";
import { isIndexable, probe, walk } from "./walk.ts";

const EXTENSION_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));

/** Store directory name, relative to the project root. */
const STORE_DIR = ".pirag";

/**
 * Auto-index budget. Below this we index in the background without asking.
 *
 * Deliberately huge: automatic indexing is the whole value proposition, and a
 * background pass is now memory-bounded, throttled, checkpointed and resumable,
 * so the only cost of a big repo is elapsed time. Above this the project is
 * almost certainly not source (a data dump, a mounted volume) and silently
 * grinding for days would be wrong — so it asks instead.
 */
const AUTO_INDEX_MAX_BYTES = 1024 * 1024 * 1024;

/**
 * Bytes of source per slice. Each slice is one upstream indexFiles() call, so
 * this bounds peak memory AND is the checkpoint granularity. Smaller slices mean
 * finer checkpoints and less memory, at the cost of more per-call overhead.
 */
const SLICE_BYTES = 512 * 1024;

/**
 * Embedding batch size for unattended background passes. Measured ~282 MB peak
 * RSS versus ~729 MB at batch 8, for ~27% less throughput. Read by upstream's
 * patched embed.ts via PA_RAG_BATCH_SIZE (see scripts/patch-rag-batch.sh).
 */
const BACKGROUND_BATCH_SIZE = 2;

/**
 * Embedding batch size when the user explicitly ran /rag-index and is watching.
 * Faster, more memory; still far below the upstream default of 64 that OOM-killed
 * the container.
 */
const FOREGROUND_BATCH_SIZE = 8;

/**
 * Fraction of wall-clock time a background pass may spend working. 0.5 means it
 * sleeps as long as the slice took, so it consumes at most ~half a core over
 * time rather than pegging one for hours. Expressed as a duty cycle rather than
 * a fixed pause so it self-tunes: slow machines and big slices back off more.
 */
const BACKGROUND_DUTY_CYCLE = 0.5;

/** Ceiling on a single throttle sleep, so progress stays visible. */
const MAX_THROTTLE_MS = 5000;

/** Minimal breather after a foreground slice, just to let the TUI repaint. */
const FOREGROUND_PAUSE_MS = 50;

/** Footer status key. Stable so updates replace rather than stack. */
const STATUS_KEY = "pa-rag";

/**
 * Minimum gap between footer status writes. upstream's onEmbed fires per
 * micro-batch (every 2 chunks in background mode), which is far more often than
 * a human can read or a terminal should repaint.
 */
const STATUS_THROTTLE_MS = 400;

/** How long the final "indexed N files" status lingers before clearing. */
const STATUS_LINGER_MS = 8000;

/**
 * Hard cap for the probe's early bail. Anything past this is reported as
 * "very large" without a precise figure — we stop counting to stay fast.
 *
 * Must stay >= AUTO_INDEX_MAX_BYTES, or the probe would bail before it could
 * tell whether a project is inside the auto-index budget and everything between
 * the two limits would wrongly fall into the "ask first" path.
 */
const PROBE_CAP_BYTES = 2 * 1024 * 1024 * 1024;

/** Fallback throughput before we have measured this machine. Chunks/second. */
const DEFAULT_CHUNKS_PER_SEC = 36;

/**
 * Upstream chunks at ~50 lines, broken at blank lines where possible, so the
 * bytes-per-chunk ratio depends entirely on a tree's formatting. Measured 1854
 * on a docs/scripts tree and 3324 on this repo overall — nearly 2x apart. This
 * constant is therefore only ever an ESTIMATE, used for ETAs and for a progress
 * denominator before the real chunk count is known. Anything displaying it must
 * clamp, because it will be wrong in both directions.
 */
const BYTES_PER_CHUNK = 2500;

interface Throughput {
	chunksPerSec: number;
	measuredAt: string;
}

/** Minimal shape of the pieces of ctx.ui a background pass may touch. */
interface StatusUi {
	setStatus?: (key: string, value: string | undefined) => void;
}

const BAR_WIDTH = 12;

/** Render a compact unicode progress bar for the footer. */
const progressBar = (fraction: number): string => {
	const clamped = Math.max(0, Math.min(1, fraction));
	const filled = Math.round(clamped * BAR_WIDTH);
	return `${"\u2588".repeat(filled)}${"\u2591".repeat(BAR_WIDTH - filled)}`;
};

export default function paRagExtension(pi: ExtensionAPI) {
	// Per-session state. Reset on every session_start so that /resume and
	// forks do not inherit a stale view.
	let storeDir: string | null = null;
	let indexing = false;
	let indexedThisSession = false;
	let lastSummary: string | null = null;
	/**
	 * Set when the session goes away. Checked between slices so a long background
	 * pass stops promptly instead of embedding into a dead session. Safe to stop
	 * at any slice boundary: everything before it is already committed.
	 */
	let abortIndex = false;

	/** Resolve (and create) the store dir for a project root. */
	const ensureStore = (cwd: string): string => {
		const dir = join(cwd, STORE_DIR);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		return dir;
	};

	/**
	 * Point pi-local-rag at our store. Its `getRagDir()` honours PI_RAG_DIR as
	 * an explicit override that wins over its own cwd walk-up, which is how we
	 * get `.pirag/` instead of its default `.pi/rag/` without patching it.
	 */
	const bindStore = (dir: string): void => {
		process.env.PI_RAG_DIR = dir;
	};

	/**
	 * Files mutated during this session that still need re-embedding, plus the
	 * debounce timer that drains them. Keeping the index fresh matters most for
	 * files WE just changed: that is precisely when the agent is most likely to
	 * search them and most likely to be misled by a stale hit.
	 */
	const dirtyFiles = new Set<string>();
	let flushTimer: ReturnType<typeof setTimeout> | null = null;

	/**
	 * Debounce window for re-embedding mutated files. Long enough that a burst
	 * of edits in one assistant turn collapses into a single pass, short enough
	 * that the next turn sees fresh results.
	 */
	const FLUSH_DEBOUNCE_MS = 1500;

	/** Remembered embedding throughput, so estimates improve after a real run. */
	const throughputFile = (dir: string) => join(dir, "throughput.json");

	const readThroughput = (dir: string): number => {
		try {
			const raw = JSON.parse(readFileSync(throughputFile(dir), "utf8")) as Throughput;
			if (typeof raw.chunksPerSec === "number" && raw.chunksPerSec > 0) return raw.chunksPerSec;
		} catch {
			// no measurement yet, or unreadable — fall back to the default
		}
		return DEFAULT_CHUNKS_PER_SEC;
	};

	const writeThroughput = (dir: string, chunksPerSec: number): void => {
		try {
			const payload: Throughput = { chunksPerSec, measuredAt: new Date().toISOString() };
			writeFileSync(throughputFile(dir), `${JSON.stringify(payload, null, 2)}\n`);
		} catch {
			// non-fatal: estimates just stay at the previous value
		}
	};

	/**
	 * Wrap ctx.ui.notify so a background task can report progress without
	 * crashing when its session has already been replaced or torn down.
	 * Accessing ctx.ui on a stale ctx throws; there is no "isStale" predicate
	 * to test first, so catching is the only option.
	 */
	const safeNotify =
		(ctx: { ui: { notify: (msg: string, level?: "info" | "warning" | "error") => void } }) =>
		(msg: string, level: "info" | "warning" | "error" = "info"): void => {
			try {
				ctx.ui.notify(msg, level);
			} catch {
				// Session gone (stale ctx). Fall back to stderr so the information
				// is not silently lost in non-interactive runs.
				process.stderr.write(`${msg}\n`);
			}
		};

	/**
	 * Write a footer status line, throttled, tolerating a stale ctx.
	 *
	 * Separate from safeNotify because the two have opposite lifetimes: a
	 * notification is a permanent transcript entry, while this is one mutable line
	 * that must be cleared when the work ends. A long index would otherwise either
	 * spam the transcript or say nothing for an hour.
	 */
	const makeStatus = (ctx: { ui: StatusUi }) => {
		// 0 rather than Date.now(): the FIRST update must always render. Otherwise a
		// pass that finishes inside one throttle window shows nothing but its final
		// frame, and the user sees a bar flash straight to 100%.
		let lastWrite = 0;
		const write = (text: string | undefined, force = false): void => {
			const now = Date.now();
			if (!force && text !== undefined && now - lastWrite < STATUS_THROTTLE_MS) return;
			lastWrite = now;
			try {
				// Older pi builds may not expose setStatus; progress is optional polish,
				// never a hard dependency.
				ctx.ui.setStatus?.(STATUS_KEY, text);
			} catch {
				// Session replaced or torn down. Nothing to do: the pass itself keeps
				// going and its result is still committed.
			}
		};
		return write;
	};

	const humanBytes = (n: number): string =>
		n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;

	const humanDuration = (seconds: number): string => {
		if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
		const mins = seconds / 60;
		return mins < 60 ? `${mins.toFixed(1)} min` : `${(mins / 60).toFixed(1)} h`;
	};

	const estimateSeconds = (bytes: number, chunksPerSec: number): number =>
		bytes / BYTES_PER_CHUNK / chunksPerSec;

	/** Paths we must never index: our own store, and the active session file. */
	const buildSkipPaths = (cwd: string, sessionFile: string | undefined): Set<string> => {
		const skip = new Set<string>([join(cwd, STORE_DIR)]);
		// The live session transcript grows on every turn. Upstream keys
		// incremental refresh on whole-file hashes, so re-indexing it would
		// re-embed the entire transcript each turn. Closed sessions are still
		// indexed — those are the ones worth recovering from.
		if (sessionFile) skip.add(resolve(sessionFile));
		return skip;
	};

	/**
	 * Split `files` into byte-bounded slices. A file bigger than SLICE_BYTES gets
	 * its own slice rather than being split: chunk boundaries belong to upstream,
	 * and a single file is bounded anyway (the walker rejects anything > 500 KB).
	 */
	const sliceFiles = (files: string[], maxBytes: number): string[][] => {
		const slices: string[][] = [];
		let current: string[] = [];
		let currentBytes = 0;
		for (const file of files) {
			let size = 0;
			try {
				size = statSync(file).size;
			} catch {
				// Vanished between walk and now. Keep it and let upstream count it as
				// an unreadable skip rather than dropping it silently here.
			}
			current.push(file);
			currentBytes += size;
			if (currentBytes >= maxBytes) {
				slices.push(current);
				current = [];
				currentBytes = 0;
			}
		}
		if (current.length > 0) slices.push(current);
		return slices;
	};

	interface SlicedResult {
		indexed: number;
		chunks: number;
		skipped: number;
		aborted: boolean;
	}

	/**
	 * Feed `files` to upstream one slice at a time. See the file header for why
	 * this is never a single indexFiles() call.
	 */
	const sleep = (ms: number): Promise<void> =>
		new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, ms);
			// Never hold the process open just for a throttle nap.
			timer.unref?.();
		});

	const indexSliced = async (
		upstream: Upstream,
		db: unknown,
		files: string[],
		force: boolean,
		opts: {
			background?: boolean;
			onProgress?: (sliceDone: number, sliceTotal: number, chunks: number) => void;
			/**
			 * Fires as chunks are embedded WITHIN a slice. `done` counts cumulatively
			 * across the whole pass, because upstream's own onEmbed total resets per
			 * slice and a bar that restarts every 512 KB is worse than none.
			 */
			onChunkProgress?: (doneChunks: number, sliceDone: number, sliceTotal: number) => void;
		} = {},
	): Promise<SlicedResult> => {
		const background = opts.background ?? false;
		const slices = sliceFiles(files, SLICE_BYTES);
		let indexed = 0;
		let chunks = 0;
		let skipped = 0;
		// Chunks embedded in slices already finished. upstream's onEmbed reports a
		// per-slice figure, so this is what makes the total monotonic.
		let embeddedBefore = 0;

		// Upstream reads PA_RAG_BATCH_SIZE per embedBatch() call (see
		// scripts/patch-rag-batch.sh), so this selects the memory/speed tradeoff for
		// the duration of this pass. Restored afterwards so a background pass cannot
		// leave the process stuck in low-memory mode.
		const previousBatch = process.env.PA_RAG_BATCH_SIZE;
		process.env.PA_RAG_BATCH_SIZE = String(
			background ? BACKGROUND_BATCH_SIZE : FOREGROUND_BATCH_SIZE,
		);

		try {
			for (let i = 0; i < slices.length; i++) {
				if (abortIndex) return { indexed, chunks, skipped, aborted: true };

				const sliceStarted = Date.now();
				// Passing a progress object is what makes upstream stop writing its own
				// \r-based progress bar to stderr (indexing.ts flips an internal
				// _suppressStderr when callbacks are supplied). Without this, a
				// background index scribbles over the TUI and pollutes -p output.
				const result = await upstream.indexFiles(
					slices[i],
					{
						onFile: () => {},
						onEmbed: (done) => {
							opts.onChunkProgress?.(embeddedBefore + done, i, slices.length);
						},
					},
					db,
					force,
				);
				const sliceMs = Date.now() - sliceStarted;

				indexed += result.indexed;
				chunks += result.chunks;
				skipped += result.skipped;
				embeddedBefore += result.chunks;

				opts.onProgress?.(i + 1, slices.length, chunks);

				if (i < slices.length - 1) {
					if (background) {
						// Duty-cycle throttle: work for sliceMs, then rest in proportion.
						// A slice that hash-skipped everything took ~0ms and rests ~0ms, so
						// catch-up passes over an already-indexed tree stay fast.
						const rest = Math.min(
							MAX_THROTTLE_MS,
							Math.round(sliceMs * ((1 - BACKGROUND_DUTY_CYCLE) / BACKGROUND_DUTY_CYCLE)),
						);
						if (rest > 0) await sleep(rest);
					} else {
						await sleep(FOREGROUND_PAUSE_MS);
					}
				}
			}

			return { indexed, chunks, skipped, aborted: false };
		} finally {
			if (previousBatch === undefined) delete process.env.PA_RAG_BATCH_SIZE;
			else process.env.PA_RAG_BATCH_SIZE = previousBatch;
		}
	};

	/**
	 * Run an index pass. Returns a human-readable summary.
	 * Never throws: indexing is best-effort background work and must not take
	 * the session down with it.
	 */
	const runIndex = async (
		cwd: string,
		sessionFile: string | undefined,
		notify: (msg: string, level?: "info" | "warning" | "error") => void,
		opts: {
			force?: boolean;
			background?: boolean;
			/** Footer status writer. Omitted in print mode / non-TUI runs. */
			status?: (text: string | undefined, force?: boolean) => void;
		} = {},
	): Promise<string> => {
		if (indexing) return "pa-rag: an index pass is already running.";
		indexing = true;
		abortIndex = false;
		try {
			const dir = ensureStore(cwd);
			storeDir = dir;
			bindStore(dir);

			let upstream: Upstream;
			try {
				upstream = await load(EXTENSION_DIR);
			} catch (err) {
				const msg = `pa-rag: ${err instanceof Error ? err.message : String(err)}`;
				notify(msg, "error");
				return msg;
			}

			const skipPaths = buildSkipPaths(cwd, sessionFile);
			const { files, bytes } = walk(cwd, { skipPaths });
			if (files.length === 0) return "pa-rag: nothing indexable found.";

			const chunksPerSec = readThroughput(dir);
			// A throttled background pass spends only BACKGROUND_DUTY_CYCLE of its
			// wall time working, so quote the user the real elapsed estimate.
			const dutyFactor = opts.background ? 1 / BACKGROUND_DUTY_CYCLE : 1;
			const eta = estimateSeconds(bytes, chunksPerSec) * dutyFactor;
			notify(
				`pa-rag: indexing ${files.length} files (${humanBytes(bytes)}), ~${humanDuration(eta)}` +
					`${opts.background ? " in the background" : ""}…`,
				"info",
			);

			const db = upstream.openDb();
			try {
				const started = Date.now();

				// Estimated total chunks, for a percentage before we know the real count.
				// upstream only reports totals per slice, so a global bar needs this.
				const estTotalChunks = Math.max(1, Math.round(bytes / BYTES_PER_CHUNK));

				opts.status?.(`pa-rag ${progressBar(0)} starting…`, true);

				// Report at quartiles. Per-slice would be noise on a small repo and a
				// flood on a large one; silence for many minutes is worse than both.
				// The footer carries the fine-grained view; these are the durable
				// transcript breadcrumbs for a pass that outlives its scrollback.
				let nextQuartile = 1;
				const result = await indexSliced(upstream, db, files, opts.force ?? false, {
					background: opts.background,
					onProgress: (done, totalSlices, chunksSoFar) => {
						if (totalSlices < 4) return;
						const pct = (done / totalSlices) * 100;
						if (pct >= nextQuartile * 25 && nextQuartile <= 3) {
							nextQuartile = Math.floor(pct / 25) + 1;
							notify(`pa-rag: ${Math.round(pct)}% (${chunksSoFar} chunks)…`, "info");
						}
					},
					onChunkProgress: (doneChunks, sliceDone, sliceTotal) => {
						if (!opts.status) return;

						// BYTES_PER_CHUNK is a rough guess (see its docstring: measured 1854
						// to 3324 on two real trees), so grow the denominator once reality
						// exceeds it. Without this the bar reads "102/~88 chunks" at 100%
						// and then keeps counting, which looks broken.
						const denom = Math.max(estTotalChunks, doneChunks);

						// With several slices, slice completion is a far better signal than
						// the byte estimate; within the current slice interpolate by chunks.
						const fraction =
							sliceTotal > 1
								? Math.min(1, (sliceDone + Math.min(1, doneChunks / denom)) / sliceTotal)
								: Math.min(1, doneChunks / denom);

						// ETA from THIS pass's observed rate, which already includes the
						// background throttle — so the number reflects reality rather than
						// the unthrottled calibration figure. Suppressed once the estimate
						// is exhausted, since "0s left" while still working is a lie.
						const elapsed = (Date.now() - started) / 1000;
						const rate = doneChunks / Math.max(0.001, elapsed);
						const remaining = denom - doneChunks;
						const etaText =
							rate > 0.2 && remaining > 0 ? ` · ~${humanDuration(remaining / rate)} left` : "";

						// "~" on the denominator: it is an estimate until the pass ends.
						opts.status(
							`pa-rag ${progressBar(fraction)} ${Math.round(fraction * 100)}% · ` +
								`${doneChunks}/~${denom} chunks${etaText}`,
						);
					},
				});
				const elapsedSec = (Date.now() - started) / 1000;

				// Only trust a measurement with enough work to be meaningful. Throttled
				// background passes must NOT be measured: their elapsed time is mostly
				// deliberate sleeping, and recording that as throughput would poison
				// every future estimate.
				if (!opts.background && result.chunks > 200 && elapsedSec > 2) {
					writeThroughput(dir, result.chunks / elapsedSec);
				}

				indexedThisSession = true;
				const summary = result.aborted
					? `pa-rag: stopped after ${result.indexed} files (${result.chunks} chunks) — ` +
						`progress kept, resumes next run → ${STORE_DIR}/`
					: `pa-rag: indexed ${result.indexed} files (${result.chunks} chunks), ` +
						`${result.skipped} unchanged, ${humanDuration(elapsedSec)} → ${STORE_DIR}/`;
				lastSummary = summary;

				// Leave the outcome visible briefly, then clear: a permanent footer
				// entry for finished work is clutter, and the transcript already has
				// the summary notification.
				if (opts.status) {
					opts.status(
						result.aborted
							? `pa-rag stopped · ${result.chunks} chunks saved`
							: `pa-rag ${progressBar(1)} done · ${result.chunks} chunks`,
						true,
					);
					const clear = setTimeout(() => opts.status?.(undefined, true), STATUS_LINGER_MS);
					clear.unref?.();
				}

				return summary;
			} finally {
				db.close();
			}
		} catch (err) {
			const msg = `pa-rag: index failed: ${err instanceof Error ? err.message : String(err)}`;
			notify(msg, "error");
			opts.status?.("pa-rag · index failed", true);
			if (opts.status) {
				const clear = setTimeout(() => opts.status?.(undefined, true), STATUS_LINGER_MS);
				clear.unref?.();
			}
			return msg;
		} finally {
			indexing = false;
		}
	};

	/**
	 * Re-embed just the files recorded in `dirtyFiles`. Upstream skips unchanged
	 * content by hash, so this is cheap: a handful of files, tens of chunks.
	 *
	 * Silent by design — this runs after ordinary edits, and a notification on
	 * every write would be pure noise. Failures are swallowed for the same
	 * reason: a stale index is a degraded search, not a broken session. Use
	 * /rag-status to see whether the last pass worked.
	 */
	// Declared with `function` so flushDirty can call it before this point in
	// source order without tripping the const/TDZ trap.
	function scheduleFlush(cwd: string): void {
		if (flushTimer) clearTimeout(flushTimer);
		flushTimer = setTimeout(() => {
			flushTimer = null;
			void flushDirty(cwd);
		}, FLUSH_DEBOUNCE_MS);
		// Do not hold the process open just for a pending re-index.
		flushTimer.unref?.();
	}

	const flushDirty = async (cwd: string): Promise<void> => {
		if (dirtyFiles.size === 0) return;
		// If a full pass is running, leave the entries queued: that pass may not
		// have picked up these versions, and re-queuing is cheaper than guessing.
		if (indexing) {
			scheduleFlush(cwd);
			return;
		}

		const batch = [...dirtyFiles].filter((f) => existsSync(f));
		dirtyFiles.clear();
		if (batch.length === 0) return;

		indexing = true;
		try {
			const dir = storeDir ?? ensureStore(cwd);
			bindStore(dir);
			const upstream = await load(EXTENSION_DIR);
			const db = upstream.openDb();
			try {
				// Sliced for the same reason as a full pass: a bulk edit (package-wide
				// rename, codegen) can queue enough files that one upstream call
				// accumulates too much. Foreground batch: this is a handful of files the
				// agent just touched and is about to search, so latency matters more
				// than the memory difference at this size.
				await indexSliced(upstream, db, batch, false);
			} finally {
				db.close();
			}
		} catch {
			// Best-effort. Do not disturb the session over a refresh failure.
		} finally {
			indexing = false;
		}
	};

	// ── Keep the index fresh as files change ─────────────────────────────────
	// Without this, anything edited mid-session stays stale in the index until
	// the next launch or an explicit /rag-index — and a confidently-wrong hit on
	// a file we just rewrote is the most misleading failure this tool can have.
	//
	// We hook tool_result rather than watching the filesystem: it is precise (we
	// get the exact path), costs nothing when idle, and needs no watcher
	// lifecycle. The trade-off is that edits made OUTSIDE pi (your editor, git
	// checkout) are still missed until the next session_start or /rag-index.
	pi.on("tool_result", (event, ctx) => {
		if (event.isError) return;
		if (event.toolName !== "write" && event.toolName !== "edit") return;

		const raw = (event.input as { path?: unknown } | undefined)?.path;
		if (typeof raw !== "string" || raw.length === 0) return;

		// Some models prefix paths with '@'; built-in tools strip it, so we must too.
		const normalized = raw.startsWith("@") ? raw.slice(1) : raw;
		const absolute = resolve(ctx.cwd, normalized);

		// Respect the same filters as the initial walk, so a mutation cannot
		// sneak .git internals or a lockfile into the index.
		if (!isIndexable(basename(absolute))) return;
		if (absolute.startsWith(join(ctx.cwd, STORE_DIR))) return;

		dirtyFiles.add(absolute);
		scheduleFlush(ctx.cwd);
	});

	// ── Startup: probe, then auto-index if cheap ─────────────────────────────
	// Deliberately in session_start, not the extension factory: the docs are
	// explicit that background work must not start in the factory, because
	// factories also run in invocations that never open a session.
	//
	// This background index used to OOM-kill the container: upstream's hardcoded
	// BATCH_SIZE=64 peaks at ~2.2GB RSS for one batch of real source chunks,
	// which exceeds Docker Desktop's ~3.8GB VM once the model and pi are also
	// resident. The kernel SIGKILLed node (exit 137), leaving a schema-only
	// index DB and pi's TUI mid-render with the terminal still in raw mode.
	// Fixed at the source by scripts/patch-rag-batch.sh, which caps the batch at
	// 8 (~451MB peak) and truncates to the model's real 512-token window.
	pi.on("session_start", async (event, ctx) => {
		// Reset per-session state (matters for reload/resume/fork).
		storeDir = null;
		indexedThisSession = false;
		lastSummary = null;
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
		dirtyFiles.clear();

		// Forking clones an existing session; the index is already warm and
		// re-probing on every fork is pure noise.
		if (event.reason === "fork") return;

		// Never touch a project the user has not trusted.
		if (!ctx.isProjectTrusted()) return;

		const cwd = ctx.cwd;
		const dir = ensureStore(cwd);
		storeDir = dir;
		bindStore(dir);

		const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
		const skipPaths = buildSkipPaths(cwd, sessionFile);
		const result = probe(cwd, PROBE_CAP_BYTES, skipPaths);

		if (result.files === 0) return;

		const chunksPerSec = readThroughput(dir);
		const eta = estimateSeconds(result.bytes, chunksPerSec);

		if (result.overCap || result.bytes > AUTO_INDEX_MAX_BYTES) {
			const size = result.overCap ? `>${humanBytes(PROBE_CAP_BYTES)}` : humanBytes(result.bytes);
			ctx.ui.notify(
				`pa-rag: project is ${size} (~${humanDuration(eta)} to index) — past the ` +
					`${humanBytes(AUTO_INDEX_MAX_BYTES)} auto-index limit, so not starting on its own. ` +
					"Run /rag-index to do it anyway.",
				"info",
			);
			return;
		}

		// Fire and forget: do not block the first turn on embedding.
		//
		// The captured `ctx` becomes STALE if the session is replaced (reload,
		// fork, switchSession) or simply ends while indexing is still running —
		// pi throws "extension ctx is stale after session replacement" on any
		// ctx.ui access after that. Since this task deliberately outlives the
		// call that started it, every notification must be guarded.
		// hasUI (not mode === "tui") is the right guard: setStatus is a no-op-safe
		// fire-and-forget in RPC too, and must be skipped only in print/JSON runs.
		const status = ctx.hasUI ? makeStatus(ctx) : undefined;

		void runIndex(cwd, sessionFile, safeNotify(ctx), { background: true, status }).then(
			(summary) => {
				if (summary) safeNotify(ctx)(summary, "info");
			},
		);
	});

	// ── /rag-index ───────────────────────────────────────────────────────────
	pi.registerCommand("rag-index", {
		description: "pa-rag: index the project now (--force to re-embed everything)",
		handler: async (args, ctx) => {
			const force = /(^|\s)--force(\s|$)/.test(args ?? "");
			const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
			const summary = await runIndex(ctx.cwd, sessionFile, (m, l) => ctx.ui.notify(m, l), {
				force,
				status: ctx.hasUI ? makeStatus(ctx) : undefined,
			});
			ctx.ui.notify(summary, "info");
		},
	});

	// ── /rag-status ──────────────────────────────────────────────────────────
	pi.registerCommand("rag-status", {
		description: "pa-rag: show index statistics and store location",
		handler: async (_args, ctx) => {
			const dir = storeDir ?? ensureStore(ctx.cwd);
			bindStore(dir);
			try {
				const upstream = await load(EXTENSION_DIR);
				const db = upstream.openDb();
				try {
					const stats = upstream.getIndexStats(db);
					const lines = [
						`store:      ${dir}`,
						`files:      ${stats.totalFiles}`,
						`chunks:     ${stats.totalChunks}`,
						`vectors:    ${stats.totalVectors ?? "?"}`,
						`model:      ${stats.embeddingModel ?? "?"}`,
						`last build: ${stats.lastBuild ?? "never"}`,
						`throughput: ${readThroughput(dir).toFixed(1)} chunks/sec`,
						`indexing:   ${indexing ? "in progress" : "idle"}`,
						`pending:    ${dirtyFiles.size} file(s) awaiting refresh`,
					];
					if (lastSummary) lines.push(`last run:   ${lastSummary}`);
					ctx.ui.notify(lines.join("\n"), "info");
				} finally {
					db.close();
				}
			} catch (err) {
				ctx.ui.notify(
					`pa-rag: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});

	// ── The tool the model calls ─────────────────────────────────────────────
	pi.registerTool({
		name: "rag_search",
		label: "RAG Search",
		description:
			"Search the project's local hybrid index (BM25 keyword + vector semantic) for " +
			"relevant file chunks. Covers source, docs, dotfiles, CI config and PAST pi " +
			"session transcripts, so it can recover decisions and findings from earlier " +
			"sessions that are no longer in context. Returns file paths with line numbers.",
		promptSnippet:
			"Semantic + keyword search over the indexed project, including past pi sessions",
		promptGuidelines: [
			"Use rag_search when you need to find code or notes by meaning and do not know the exact identifier — it finds 'retry/backoff handling' even when those words do not appear literally.",
			"Use rag_search to recall what a previous session concluded; it indexes past pi session transcripts.",
			"Prefer grep/rg over rag_search for exact identifiers, and read for whole files; rag_search returns excerpts, not authoritative full content.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Natural-language or keyword query" }),
			limit: Type.Optional(
				Type.Number({ description: "Max results to return (default 5)", default: 5 }),
			),
			alpha: Type.Optional(
				Type.Number({
					description:
						"Keyword/vector blend: 0 = pure semantic, 1 = pure keyword. Default 0.4.",
					default: 0.4,
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const dir = storeDir ?? ensureStore(ctx.cwd);
			bindStore(dir);

			let upstream: Upstream;
			try {
				upstream = await load(EXTENSION_DIR);
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `rag_search unavailable: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					isError: true,
				};
			}

			const limit = params.limit ?? 5;
			const alpha = params.alpha ?? 0.4;
			const db = upstream.openDb();
			try {
				const stats = upstream.getIndexStats(db);
				if (stats.totalChunks === 0) {
					const hint = indexing
						? "The index is still building; try again shortly."
						: "Nothing is indexed yet. Run /rag-index to build the index.";
					return {
						content: [{ type: "text", text: hint }],
						details: { indexed: false, indexing },
					};
				}

				const hits = await upstream.hybridSearch(
					params.query,
					{ chunks: [], files: {} },
					limit,
					alpha,
					db,
				);
				if (hits.length === 0) {
					return {
						content: [{ type: "text", text: `No matches for "${params.query}".` }],
						details: { results: 0, chunks: stats.totalChunks },
					};
				}

				const rendered = hits
					.map((hit) => {
						const rel = relative(ctx.cwd, hit.chunk.file) || hit.chunk.file;
						const header = `${rel}:${hit.chunk.lineStart}-${hit.chunk.lineEnd}  score=${hit.hybrid.toFixed(3)}`;
						return `${header}\n${hit.chunk.content.slice(0, 1200)}`;
					})
					.join("\n\n---\n\n");

				return {
					content: [{ type: "text", text: rendered }],
					details: {
						results: hits.length,
						chunks: stats.totalChunks,
						files: stats.totalFiles,
					},
				};
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `rag_search failed: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					isError: true,
				};
			} finally {
				db.close();
			}
		},
	});

	// Idempotent teardown. Each operation opens and closes its own db, so the
	// only long-lived resource is the debounce timer — which must be cleared or
	// it can fire against a torn-down session.
	pi.on("session_shutdown", (_event, ctx) => {
		// Stop a background pass at its next slice boundary. Everything already
		// committed stays; the rest is picked up by hash-skip on the next run.
		abortIndex = true;
		// Drop the footer line, or a resumed/replaced session inherits a frozen
		// progress bar for work that is no longer running.
		try {
			(ctx?.ui as StatusUi | undefined)?.setStatus?.(STATUS_KEY, undefined);
		} catch {
			// Already gone; nothing to clear.
		}
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
		dirtyFiles.clear();
		storeDir = null;
		indexing = false;
		indexedThisSession = false;
		lastSummary = null;
	});
}
