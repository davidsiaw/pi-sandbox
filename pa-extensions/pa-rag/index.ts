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
 * WHY A SIZE GATE
 *   Measured embedding throughput is ~36 chunks/sec and does NOT improve with
 *   batching or threads (verified: batch=1/16/64 and threads=1/4/8 all land at
 *   26-28 ms/chunk). At ~2 KB per chunk that is ~1 min per 5 MB of source. So
 *   10 MB ~ 2 min is a reasonable "just do it" budget, while 50 MB would be
 *   ~11 minutes of pegged CPU — far too rude to start unannounced.
 *
 *   The probe itself is ~1-2 ms even on huge trees, because it bails as soon
 *   as it crosses the cap.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
 * Auto-index budget. Below this we index without asking. Chosen for time, not
 * bytes: see the throughput note in the file header.
 */
const AUTO_INDEX_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Hard cap for the probe's early bail. Anything past this is reported as
 * "very large" without a precise figure — we stop counting to stay fast.
 */
const PROBE_CAP_BYTES = 250 * 1024 * 1024;

/** Fallback throughput before we have measured this machine. Chunks/second. */
const DEFAULT_CHUNKS_PER_SEC = 36;

/** Upstream chunks at ~50 lines; on real source that averages ~2 KB. */
const BYTES_PER_CHUNK = 2150;

interface Throughput {
	chunksPerSec: number;
	measuredAt: string;
}

export default function paRagExtension(pi: ExtensionAPI) {
	// Per-session state. Reset on every session_start so that /resume and
	// forks do not inherit a stale view.
	let storeDir: string | null = null;
	let indexing = false;
	let indexedThisSession = false;
	let lastSummary: string | null = null;

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
	 * Run an index pass. Returns a human-readable summary.
	 * Never throws: indexing is best-effort background work and must not take
	 * the session down with it.
	 */
	const runIndex = async (
		cwd: string,
		sessionFile: string | undefined,
		notify: (msg: string, level?: "info" | "warning" | "error") => void,
		opts: { force?: boolean } = {},
	): Promise<string> => {
		if (indexing) return "pa-rag: an index pass is already running.";
		indexing = true;
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
			const eta = estimateSeconds(bytes, chunksPerSec);
			notify(
				`pa-rag: indexing ${files.length} files (${humanBytes(bytes)}), ~${humanDuration(eta)}…`,
				"info",
			);

			const db = upstream.openDb();
			try {
				const started = Date.now();
				// Passing a progress object is what makes upstream stop writing its
				// own \r-based progress bar to stderr (indexing.ts flips an internal
				// _suppressStderr when callbacks are supplied). Without this, a
				// background index scribbles over the TUI and pollutes -p output.
				const result = await upstream.indexFiles(files, { onFile: () => {} }, db, opts.force);
				const elapsedSec = (Date.now() - started) / 1000;

				// Only trust a measurement with enough work to be meaningful.
				if (result.chunks > 200 && elapsedSec > 2) {
					writeThroughput(dir, result.chunks / elapsedSec);
				}

				indexedThisSession = true;
				const summary =
					`pa-rag: indexed ${result.indexed} files (${result.chunks} chunks), ` +
					`${result.skipped} unchanged, ${humanDuration(elapsedSec)} → ${STORE_DIR}/`;
				lastSummary = summary;
				return summary;
			} finally {
				db.close();
			}
		} catch (err) {
			const msg = `pa-rag: index failed: ${err instanceof Error ? err.message : String(err)}`;
			notify(msg, "error");
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
				await upstream.indexFiles(batch, { onFile: () => {} }, db, false);
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
				`pa-rag: project is large (${size}, ~${humanDuration(eta)} to index). ` +
					"Run /rag-index when you want it.",
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
		void runIndex(cwd, sessionFile, safeNotify(ctx)).then((summary) => {
			if (summary) safeNotify(ctx)(summary, "info");
		});
	});

	// ── /rag-index ───────────────────────────────────────────────────────────
	pi.registerCommand("rag-index", {
		description: "pa-rag: index the project now (--force to re-embed everything)",
		handler: async (args, ctx) => {
			const force = /(^|\s)--force(\s|$)/.test(args ?? "");
			const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
			const summary = await runIndex(ctx.cwd, sessionFile, (m, l) => ctx.ui.notify(m, l), {
				force,
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
	pi.on("session_shutdown", () => {
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
