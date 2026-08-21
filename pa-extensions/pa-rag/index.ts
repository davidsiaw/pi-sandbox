/**
 * pa-rag — automatic local RAG index for the project, baked into the pa image.
 *
 * WHAT IT DOES
 *   On session start, probes the project for indexable content and indexes it in
 *   the background (see the budget note below). The index persists in `.pirag/`,
 *   so a *fresh* agent with no context can still search everything the previous
 *   one saw.
 *
 *   Past pi transcripts (`.pi-sessions/`) are NOT indexed by default. They were,
 *   and it measurably poisoned retrieval on a large codebase: a transcript scored
 *   1.000 on the exact identifier `partial_capture_amount_cents` and outranked
 *   every real hit, with content that was an unrelated regex dump. One JSONL line
 *   can hold an entire assistant turn, so the line-based chunker turned it into a
 *   wall of JSON whose embedding meant nothing in particular. Opt back in with
 *   PA_RAG_INDEX_SESSIONS=1, which also switches to parsing message text out of
 *   each record instead of embedding raw JSON (see walk.ts extractSessionText).
 *
 * WHAT IT REUSES
 *   Chunking, ONNX embeddings (Xenova/all-MiniLM-L6-v2, 384-dim), SQLite FTS5
 *   BM25 + sqlite-vec cosine, hybrid fusion and hash-based incremental refresh
 *   all come from `pi-local-rag`, unmodified. See upstream.ts for why the
 *   import looks unusual, and walk.ts for why we supply our own file list.
 *
 * WHERE THE WORK RUNS (read this before moving anything back in-process)
 *   The embedding pass runs in a CHILD PROCESS (indexer.mjs). In-process, a
 *   background pass stalled pi's event loop for avg 97ms / max 290ms per 50ms
 *   tick — visible stutter in keystroke echo and token streaming — held ~300 MB
 *   of model in pi's heap, delayed exit by up to a whole slice, and, because
 *   each session aborted the pass at shutdown, took FOUR sessions to finish a
 *   3.3 MB tree. See indexer.mjs's header for the measurements. This module now
 *   only spawns, reports and kills.
 *
 * WHY SLICED, INCREMENTAL INDEXING
 *   Upstream's indexFiles() accumulates EVERYTHING in memory and commits in a
 *   single transaction at the end: `toIndex` holds every chunk's text and
 *   `fw._vectors` every vector, and nothing is released until `tx()` runs. That
 *   makes peak memory O(repo), not O(batch), so a large repo OOM-kills the
 *   container no matter how small the embedding batch is (exit 137, schema-only
 *   DB, wrecked terminal — see scripts/patch-rag-batch.sh for that story).
 *
 *   So we never hand upstream the whole file list. The child slices it into
 *   ~512 KB groups and calls indexFiles() once per slice. Each call returns,
 *   commits, and frees. Measured on a 432-file / 2.2 MB tree: RSS stays FLAT at
 *   ~808 MB across 5 slices versus climbing without bound, 1308 chunks either
 *   way, for ~5% extra wall time (61.9s vs 58.9s).
 *
 *   Slicing buys three things beyond memory:
 *     - CHECKPOINTS. Each slice is committed, so an interrupted pass keeps its
 *       progress instead of losing everything.
 *     - RESUME. Upstream skips unchanged files by content hash, so the next run
 *       picks up exactly where this one stopped, for free.
 *     - A STOP POINT. session_shutdown SIGTERMs the child, which stops at the
 *       next boundary instead of embedding into a dead session. pi does not wait
 *       for it.
 *
 * WHY IT ALWAYS INDEXES, AND WHY IT IS DELIBERATELY SLOW
 *   Fully automatic indexing is the point of this extension: having to remember
 *   /rag-index is worth more friction-cost than the CPU it saves. So a project
 *   inside the auto-index budget is simply ground through, however long it takes
 *   (~1 min/MB measured). That is acceptable ONLY because the pass is polite and
 *   interruptible:
 *
 *     - OUT OF PROCESS, AND NICED. The child renices itself to 19, so it yields
 *       to the session it is indexing for. Impossible in-process.
 *     - LOW-MEMORY BATCH. Background passes embed at batch 2 (~282 MB peak)
 *       rather than 8 (~729 MB). Costs ~27% throughput for 2.6x less memory.
 *       An explicit /rag-index the user is waiting on uses the fast batch.
 *     - DUTY CYCLE. Between slices the background pass sleeps proportionally to
 *       how long the last slice took.
 *     - CHECKPOINTS + RESUME. Every slice commits and unchanged files are
 *       hash-skipped, so being killed at any point costs nothing.
 *
 *   Thread count is NOT a usable lever, and neither is CPU affinity: ORT resets
 *   its own affinity (verified: `taskset -c 0,1` still measured 695-754% CPU),
 *   Transformers.js v2 hardcodes its session options (`intraOpNumThreads: 1`
 *   patched in: no change), and OMP_NUM_THREADS is ignored. Renicing the child
 *   is the only scheduling control that actually exists.
 *
 *   The probe itself is ~1-2 ms even on huge trees, because it bails as soon
 *   as it crosses the cap.
 */

import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { load, type Upstream } from "./upstream.ts";
import { isIndexable, probe } from "./walk.ts";

const EXTENSION_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)));

/** Store directory name, relative to the project root. */
const STORE_DIR = ".pirag";

/**
 * Bumped whenever a change alters WHAT gets indexed rather than how it is
 * stored. Upstream's incremental refresh keys on per-file content hashes, so it
 * cannot notice that the file SET changed: excluding `.pi-sessions/` leaves every
 * previously-embedded session chunk sitting in the index forever, still winning
 * searches. On a version mismatch we clear once and re-index.
 *
 *   1 — initial
 *   2 — sessions excluded by default; .jsonl indexed as parsed prose
 */
const INDEX_VERSION = 2;

/** Marker file recording INDEX_VERSION for a store. */
const VERSION_FILE = "index-version.json";

/**
 * Auto-index budget. Below this we index in the background without asking.
 *
 * 32 MB, derived from the measured rate rather than chosen for feel: a pass
 * embeds ~16.7 chunks/sec on ~3300-char chunks, i.e. roughly 1 minute per MB,
 * so 32 MB is already a ~30-minute background grind. The previous value was
 * 1 GiB, which at that rate is about 17 HOURS — so the "this is probably not
 * source, ask first" path was unreachable in practice and every mounted data
 * dump got ground through silently.
 */
const AUTO_INDEX_MAX_BYTES = 32 * 1024 * 1024;

/** Absolute path of the child that does the embedding. See indexer.mjs. */
const INDEXER_PATH = join(EXTENSION_DIR, "indexer.mjs");

/**
 * Scheduling priority for a background child. 19 is maximum niceness, i.e. "run
 * on cores nobody else wants", so the interactive session always wins.
 */
const BACKGROUND_NICE = 19;

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
 * sleeps as long as the slice took. Expressed as a duty cycle rather than a fixed
 * pause so it self-tunes: slow machines and big slices back off more.
 *
 * NOTE what this does and does not buy. It halves the wall-clock time spent
 * embedding; it does NOT bound the pass to a fraction of a core, which an earlier
 * version of this comment claimed. Measured, one pass runs 22 threads at 750-800%
 * CPU while working, and no ORT knob changes that (see the file header). The
 * child's nice 19 is what keeps that off the interactive session.
 */
const BACKGROUND_DUTY_CYCLE = 0.5;

/** Ceiling on a single throttle sleep, so progress stays visible. */
const MAX_THROTTLE_MS = 5000;

/** Footer status key. Stable so updates replace rather than stack. */
const STATUS_KEY = "pa-rag";

/**
 * How many raw hits to pull before filtering/collapsing, as a multiple of the
 * caller's limit. hybridSearch truncates internally, so path filters applied to
 * a `limit`-sized list would routinely return 1-2 results.
 */
const CANDIDATE_MULTIPLIER = 8;

/** Absolute ceiling on the candidate set, so a big limit cannot blow up cost. */
const MAX_CANDIDATES = 200;

/** Characters of chunk body shown per result. */
const EXCERPT_CHARS = 1200;

/** Path segments that mark a file as tests, for the `prefer` ranking bias. */
const TEST_PATH_RE = /(^|\/)(spec|specs|test|tests|__tests__|features)(\/|$)|_(spec|test)\.[a-z]+$|\.(spec|test)\.[a-z]+$/i;

/**
 * Multipliers for the `prefer` knob.
 *
 * 0.70 is derived, not guessed. The reported failure was a spec at 0.600
 * outranking the correct controller at 0.463, so anything above 0.772 leaves the
 * bug in place — an earlier 0.8 gave 0.480 and still lost, i.e. the knob would
 * have existed without working. 0.70 flips it with margin while staying a nudge:
 * a spec must score 1.43x the implementation to still win, which is the case
 * where the spec really is the better answer.
 */
const TEST_DOWNWEIGHT = 0.7;
const TEST_UPWEIGHT = 1.2;

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
 * the two limits would wrongly fall into the "ask first" path. Kept at 2x rather
 * than enormous, because the walk is the one piece of startup work that is
 * synchronous and therefore on pi's UI thread: measured 118us per file on a
 * macOS bind mount versus 14us on the container's own filesystem, so a cap that
 * lets it enumerate gigabytes is a self-inflicted startup stall.
 */
const PROBE_CAP_BYTES = 2 * AUTO_INDEX_MAX_BYTES;

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

/**
 * Truncate to a character budget WITHOUT cutting mid-token.
 *
 * The previous `content.slice(0, 1200)` produced excerpts ending in `params =
 * par` and `class_`, which reads as corruption and costs the agent a follow-up
 * read -- defeating the point of an excerpt. Upstream's chunker is line-based,
 * so a chunk always has clean line boundaries to cut on; we just have to use
 * them. Falls back to a word boundary for a single very long line.
 */
const truncateAtLine = (content: string, maxChars: number): string => {
	if (content.length <= maxChars) return content;

	const window = content.slice(0, maxChars);
	const lastNewline = window.lastIndexOf("\n");
	// Only trust the newline if it leaves a useful excerpt; otherwise the chunk is
	// one enormous line and we fall back to the last space.
	let cut = lastNewline > maxChars * 0.4 ? lastNewline : window.lastIndexOf(" ");
	if (cut < maxChars * 0.4) cut = maxChars;

	const kept = content.slice(0, cut).replace(/\s+$/, "");
	const omittedLines = content.slice(cut).split("\n").length;
	return `${kept}\n… (+${omittedLines} more line(s) — read the file for full context)`;
};

/**
 * Build a path predicate from gitignore-style globs.
 *
 * `ignore` is already a transitive dependency (upstream uses it for its own
 * exclude patterns) and implements exactly gitignore semantics, so this needs no
 * new dependency and behaves the way anyone who has written a .gitignore
 * expects. Patterns are matched against the path RELATIVE to cwd, because that
 * is how a caller thinks about "app/**".
 */
const buildPathMatcher = (
	cwd: string,
	include: string[] | undefined,
	exclude: string[] | undefined,
): ((absolutePath: string) => boolean) => {
	if ((!include || include.length === 0) && (!exclude || exclude.length === 0)) return () => true;

	// Lazily required: keeps the module import-clean for callers that never search.
	let ignoreFactory: ((patterns: string[]) => { ignores: (p: string) => boolean }) | null = null;
	try {
		const require = createRequire(import.meta.url);
		const mod = require("ignore");
		const factory = (mod.default ?? mod) as () => {
			add: (p: string[]) => unknown;
			ignores: (p: string) => boolean;
		};
		ignoreFactory = (patterns) => {
			const inst = factory();
			inst.add(patterns);
			return inst;
		};
	} catch {
		// `ignore` unavailable (dev checkout without deps). Filters silently become
		// no-ops rather than failing the search: degraded, not broken.
		return () => true;
	}

	const inc = include && include.length > 0 ? ignoreFactory(include) : null;
	const exc = exclude && exclude.length > 0 ? ignoreFactory(exclude) : null;

	return (absolutePath: string): boolean => {
		const rel = relative(cwd, absolutePath).split("\\").join("/");
		// Outside the project entirely (global store, another tree): only keep it if
		// the caller did not ask to scope by path.
		if (rel.startsWith("..")) return !inc;
		if (inc && !inc.ignores(rel)) return false;
		if (exc?.ignores(rel)) return false;
		return true;
	};
};

/** Ranking multiplier for the `prefer` knob. */
const testWeight = (relPath: string, prefer: "impl" | "test" | "any"): number => {
	if (prefer === "any") return 1;
	const isTest = TEST_PATH_RE.test(relPath);
	if (prefer === "impl") return isTest ? TEST_DOWNWEIGHT : 1;
	return isTest ? TEST_UPWEIGHT : 1;
};

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

	/** Resolve (and create) the store dir for a project root. */
	const ensureStore = (cwd: string): string => {
		const dir = join(cwd, STORE_DIR);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		return dir;
	};

	/**
	 * Drop a store built by an older indexing policy.
	 *
	 * Returns true if anything was discarded, so the caller can say so rather than
	 * silently appearing to re-index for no reason. Deletes the SQLite files and
	 * lets upstream recreate the schema; keeps throughput.json, which stays valid
	 * because it measures the machine, not the content.
	 */
	const reconcileVersion = (dir: string): boolean => {
		const marker = join(dir, VERSION_FILE);
		let found = 0;
		try {
			const raw = JSON.parse(readFileSync(marker, "utf8")) as { version?: unknown };
			if (typeof raw.version === "number") found = raw.version;
		} catch {
			// No marker: either a brand-new store or one from before versioning. Both
			// are treated as stale, which is right -- a pre-versioning store is exactly
			// the one that may hold session chunks.
		}

		const stale = found !== INDEX_VERSION;
		const hadData = existsSync(join(dir, "rag.db"));

		if (stale) {
			if (hadData) {
				for (const f of ["rag.db", "rag.db-wal", "rag.db-shm"]) {
					try {
						rmSync(join(dir, f), { force: true });
					} catch {
						// Locked by another container sharing this project mount. Leave it:
						// a stale index is worse than ideal but not worth failing startup.
					}
				}
			}
			try {
				writeFileSync(marker, `${JSON.stringify({ version: INDEX_VERSION }, null, 2)}\n`);
			} catch {
				// Read-only store dir; the rebuild still happened, we just cannot record
				// it, so it will rebuild again next run.
			}
		}

		return stale && hadData;
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

	/**
	 * One-line trust statement for the top of a result set.
	 *
	 * The motivating complaint: "no idea if the index reflects the working tree, so
	 * for any file I'm about to edit I grep anyway." An agent cannot calibrate how
	 * much to trust an excerpt without knowing the index's age and whether the tree
	 * moved under it, so say both up front.
	 *
	 * Counts files whose mtime is newer than the last build. That is a real stat
	 * sweep, but it reuses the same walk the indexer uses and only runs per search,
	 * so it is bounded by the same cost as a probe.
	 */
	const describeFreshness = (lastBuild: string | undefined): string => {
		if (!lastBuild) return "index: freshly created (no completed build yet)";

		const builtMs = Date.parse(lastBuild);
		if (Number.isNaN(builtMs)) return "index: build time unknown";

		const age = humanDuration((Date.now() - builtMs) / 1000);
		const parts = [`built ${age} ago`];

		if (indexing) parts.push("index pass RUNNING now (results incomplete)");
		if (dirtyFiles.size > 0) parts.push(`${dirtyFiles.size} edited file(s) awaiting refresh`);

		return `index: ${parts.join(" · ")}`;
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

	/**
	 * Whether to index past pi transcripts. Off by default — see the file header for
	 * the retrieval-quality measurement behind that.
	 */
	const includeSessions = process.env.PA_RAG_INDEX_SESSIONS === "1";

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

	/** Result of one child indexing pass, as reported over the protocol. */
	interface ChildResult {
		indexed: number;
		chunks: number;
		skipped: number;
		aborted: boolean;
		elapsedSec: number;
		/** Set when the walk found nothing worth indexing. */
		empty?: boolean;
		/** Set when the child failed; the pass produced no result. */
		error?: string;
	}

	/** The running background/foreground child, if any. Killed at shutdown. */
	let indexChild: ReturnType<typeof spawn> | null = null;

	/**
	 * Run one indexing pass in a child process (indexer.mjs) and report progress.
	 *
	 * This function deliberately does no embedding, no walking and no SQLite work:
	 * all of it belongs to the child, because in-process it stalled pi's UI thread
	 * (measured avg 97ms / max 290ms event-loop lag) and delayed exit by a whole
	 * slice. See indexer.mjs's header.
	 */
	const spawnIndexer = (opts: {
		cwd: string;
		storeDir: string;
		sessionFile?: string;
		/** Explicit file list instead of a walk (the dirty-file flush). */
		files?: string[];
		force?: boolean;
		background?: boolean;
		/** Called once the child has walked the tree, before any embedding. */
		onWalk?: (files: number, bytes: number) => void;
		onSlice?: (done: number, total: number, chunks: number) => void;
		onChunks?: (done: number, sliceDone: number, sliceTotal: number) => void;
	}): Promise<ChildResult> => {
		const background = opts.background ?? false;

		// An explicit file list is passed through a temp file, not argv: a bulk
		// rename can queue thousands of paths and blow past ARG_MAX.
		let filesFile: string | undefined;
		let tempDir: string | undefined;
		if (opts.files) {
			tempDir = mkdtempSync(join(tmpdir(), "pa-rag-"));
			filesFile = join(tempDir, "files.json");
			writeFileSync(filesFile, JSON.stringify(opts.files));
		}

		const config = {
			cwd: opts.cwd,
			storeDir: opts.storeDir,
			ppid: process.pid,
			force: opts.force ?? false,
			background,
			includeSessions,
			skipPaths: [...buildSkipPaths(opts.cwd, opts.sessionFile)],
			filesFile,
			sliceBytes: SLICE_BYTES,
			batchSize: background ? BACKGROUND_BATCH_SIZE : FOREGROUND_BATCH_SIZE,
			dutyCycle: BACKGROUND_DUTY_CYCLE,
			maxThrottleMs: MAX_THROTTLE_MS,
			// Only unattended work yields. A /rag-index the user is watching should
			// finish as fast as the machine allows.
			nice: background ? BACKGROUND_NICE : 0,
		};

		return new Promise<ChildResult>((resolveResult) => {
			let child: ReturnType<typeof spawn>;
			try {
				child = spawn(process.execPath, [INDEXER_PATH, JSON.stringify(config)], {
					cwd: opts.cwd,
					stdio: ["ignore", "pipe", "pipe"],
					// Its own process group, so a Ctrl-C or SIGINT aimed at pi does not
					// tear down a pass that is safe to let finish. Shutdown kills it
					// explicitly, and the child also exits on its own if pi disappears.
					detached: true,
				});
			} catch (err) {
				resolveResult({
					indexed: 0,
					chunks: 0,
					skipped: 0,
					aborted: false,
					elapsedSec: 0,
					error: err instanceof Error ? err.message : String(err),
				});
				return;
			}

			indexChild = child;
			// Never hold pi open for a background pass: quitting must be instant.
			if (background) {
				child.unref();
				child.stdout?.unref?.();
				child.stderr?.unref?.();
			}

			let result: ChildResult | null = null;
			let failure: string | null = null;
			let stderr = "";
			let pending = "";

			const handle = (line: string): void => {
				if (line.trim().length === 0) return;
				let event: Record<string, unknown>;
				try {
					event = JSON.parse(line) as Record<string, unknown>;
				} catch {
					// Not protocol output. Treat as diagnostics rather than crashing the
					// reader: a dependency that prints to stdout must not break indexing.
					stderr += `${line}\n`;
					return;
				}
				switch (event.t) {
					case "walk":
						opts.onWalk?.(Number(event.files), Number(event.bytes));
						break;
					case "chunks":
						opts.onChunks?.(
							Number(event.done),
							Number(event.sliceDone),
							Number(event.sliceTotal),
						);
						break;
					case "slice":
						opts.onSlice?.(Number(event.done), Number(event.total), Number(event.chunks));
						break;
					case "empty":
						result = {
							indexed: 0,
							chunks: 0,
							skipped: 0,
							aborted: false,
							elapsedSec: 0,
							empty: true,
						};
						break;
					case "done":
						result = {
							indexed: Number(event.indexed),
							chunks: Number(event.chunks),
							skipped: Number(event.skipped),
							aborted: Boolean(event.aborted),
							elapsedSec: Number(event.elapsedSec),
						};
						break;
					case "error":
						failure = String(event.message ?? "unknown error");
						break;
				}
			};

			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				pending += chunk;
				const lines = pending.split("\n");
				// Keep the trailing fragment: a JSON event can be split across reads.
				pending = lines.pop() ?? "";
				for (const line of lines) handle(line);
			});
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (chunk: string) => {
				// Bounded: a crash loop must not grow pi's heap.
				if (stderr.length < 4000) stderr += chunk;
			});

			const finish = (fallbackError?: string): void => {
				if (indexChild === child) indexChild = null;
				if (tempDir) {
					try {
						rmSync(tempDir, { recursive: true, force: true });
					} catch {
						// Temp cleanup is best-effort.
					}
				}
				if (result) {
					resolveResult(result);
					return;
				}
				resolveResult({
					indexed: 0,
					chunks: 0,
					skipped: 0,
					aborted: false,
					elapsedSec: 0,
					error: failure ?? fallbackError ?? stderr.trim() ?? "indexer exited without a result",
				});
			};

			child.on("error", (err) => finish(err.message));
			child.on("close", (code, signal) => {
				if (result || failure) {
					finish();
					return;
				}
				// Killed at shutdown before the first slice finished: not an error, just
				// nothing done yet. The next run resumes from the last commit.
				if (signal) {
					result = {
						indexed: 0,
						chunks: 0,
						skipped: 0,
						aborted: true,
						elapsedSec: 0,
					};
					finish();
					return;
				}
				finish(`indexer exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`);
			});
		});
	};

	/** Stop a running pass. Returns immediately; the child exits on its own. */
	const stopIndexer = (): void => {
		const child = indexChild;
		if (!child) return;
		indexChild = null;
		try {
			// SIGTERM, not SIGKILL: the child stops at the next slice boundary, so
			// the slice in flight is still committed instead of being thrown away.
			child.kill("SIGTERM");
		} catch {
			// Already gone.
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
		try {
			const dir = ensureStore(cwd);
			storeDir = dir;
			bindStore(dir);

			const started = Date.now();
			const chunksPerSec = readThroughput(dir);

			// Filled in by the child's first event. The parent does NOT walk: that used
			// to be a second full pass over the tree on pi's own thread, and on a bind
			// mount a walk costs 118us per file.
			let estTotalChunks = 1;

			opts.status?.(`pa-rag ${progressBar(0)} starting…`, true);

			// Report at quartiles. Per-slice would be noise on a small repo and a
			// flood on a large one; silence for many minutes is worse than both.
			// The footer carries the fine-grained view; these are the durable
			// transcript breadcrumbs for a pass that outlives its scrollback.
			let nextQuartile = 1;

			const result = await spawnIndexer({
				cwd,
				storeDir: dir,
				sessionFile,
				force: opts.force,
				background: opts.background,
				onWalk: (files, bytes) => {
					estTotalChunks = Math.max(1, Math.round(bytes / BYTES_PER_CHUNK));
					// A throttled background pass spends only BACKGROUND_DUTY_CYCLE of its
					// wall time working, so quote the user the real elapsed estimate.
					const dutyFactor = opts.background ? 1 / BACKGROUND_DUTY_CYCLE : 1;
					const eta = estimateSeconds(bytes, chunksPerSec) * dutyFactor;
					notify(
						`pa-rag: indexing ${files} files (${humanBytes(bytes)}), ~${humanDuration(eta)}` +
							`${opts.background ? " in the background" : ""}…`,
						"info",
					);
				},
				onSlice: (done, totalSlices, chunksSoFar) => {
					if (totalSlices < 4) return;
					const pct = (done / totalSlices) * 100;
					if (pct >= nextQuartile * 25 && nextQuartile <= 3) {
						nextQuartile = Math.floor(pct / 25) + 1;
						notify(`pa-rag: ${Math.round(pct)}% (${chunksSoFar} chunks)…`, "info");
					}
				},
				onChunks: (doneChunks, sliceDone, sliceTotal) => {
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

			if (result.error) {
				const msg = `pa-rag: index failed: ${result.error}`;
				notify(msg, "error");
				if (opts.status) {
					opts.status("pa-rag · index failed", true);
					const clear = setTimeout(() => opts.status?.(undefined, true), STATUS_LINGER_MS);
					clear.unref?.();
				}
				return msg;
			}

			if (result.empty) {
				opts.status?.(undefined, true);
				return "pa-rag: nothing indexable found.";
			}

			const elapsedSec = result.elapsedSec || (Date.now() - started) / 1000;

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
			// Same child as a full pass, with an explicit file list. Foreground batch
			// and normal priority: this is a handful of files the agent just touched
			// and is about to search, so latency matters more than politeness. Sliced
			// for the same reason as a full pass, because a package-wide rename can
			// queue enough files to matter.
			await spawnIndexer({ cwd, storeDir: dir, files: batch });
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
		// Reset per-session state (matters for reload/resume/fork). A pass left
		// running by the session being replaced is killed rather than adopted: its
		// ctx is stale, so its progress reporting would throw, and the pass below
		// resumes its work anyway via hash-skip.
		stopIndexer();
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

		// Discard a store built under an older indexing policy before probing, so the
		// pass below rebuilds rather than inheriting (for example) session chunks that
		// content-hash refresh would never evict.
		const rebuilt = reconcileVersion(dir);
		if (rebuilt) {
			ctx.ui.notify(
				"pa-rag: indexing policy changed — discarded the old index and rebuilding once.",
				"info",
			);
		}

		const sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
		const skipPaths = buildSkipPaths(cwd, sessionFile);
		const result = probe(cwd, PROBE_CAP_BYTES, skipPaths, includeSessions);

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
			"relevant file chunks. Covers source, docs, dotfiles and CI config. Returns one " +
			"entry per FILE (best chunk shown, sibling matches noted) with line numbers, " +
			"plus an index-freshness header. Supports path_include / path_exclude globs to " +
			"scope the search, and prefer=impl to down-rank tests.",
		promptSnippet: "Semantic + keyword search over the indexed project, with path filters",
		promptGuidelines: [
			"Use rag_search FIRST when orienting in an unfamiliar or large repo — to answer what the project is, how it is built, or how a subsystem works — before falling back to ls/grep. It surfaces the relevant docs and code in one call.",
			"Use rag_search when you need to find code or notes by meaning and do not know the exact identifier — it finds 'retry/backoff handling' even when those words do not appear literally.",
			"Scope rag_search with path_include (e.g. [\"app/**\", \"packs/**\"]) and path_exclude (e.g. [\"spec/**\", \"db/migrate/**\"]) instead of triaging unwanted results by hand.",
			"rag_search defaults to prefer=impl, which mildly down-ranks spec/test files; pass prefer=test to search tests, or prefer=any for no adjustment.",
			"Prefer grep/rg over rag_search for exact identifiers, and read for whole files; rag_search returns excerpts, not authoritative full content.",
			"Check the freshness line in rag_search output: if it reports changed files since the last index, results for those files may be stale — read them directly.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Natural-language or keyword query" }),
			limit: Type.Optional(
				Type.Number({
					description: "Max FILES to return (default 5). Chunks are collapsed per file.",
					default: 5,
				}),
			),
			alpha: Type.Optional(
				Type.Number({
					description:
						"Keyword/vector blend: 0 = pure semantic, 1 = pure keyword. Default 0.4.",
					default: 0.4,
				}),
			),
			path_include: Type.Optional(
				Type.Array(Type.String(), {
					description:
						'Gitignore-style globs; only matching paths are returned, e.g. ["app/**", "packs/**"].',
				}),
			),
			path_exclude: Type.Optional(
				Type.Array(Type.String(), {
					description:
						'Gitignore-style globs to drop, e.g. ["spec/**", "db/migrate/**"]. Applied after path_include.',
				}),
			),
			prefer: Type.Optional(
				Type.Union([Type.Literal("impl"), Type.Literal("test"), Type.Literal("any")], {
					description:
						"Ranking bias. impl (default) down-weights spec/test paths, test up-weights them, any leaves scores alone.",
					default: "impl",
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
			const prefer = params.prefer ?? "impl";
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

				// OVER-FETCH. hybridSearch truncates to its topK internally, so filtering
				// or collapsing afterwards would starve the result set -- ask for path
				// filters on a 5-hit list and you get 1. Pull a wide candidate set, then
				// filter, re-rank and collapse down to `limit` FILES.
				const wide = Math.min(MAX_CANDIDATES, Math.max(limit * CANDIDATE_MULTIPLIER, limit));
				const raw = await upstream.hybridSearch(
					params.query,
					{ chunks: [], files: {} },
					wide,
					alpha,
					db,
				);

				const matcher = buildPathMatcher(ctx.cwd, params.path_include, params.path_exclude);
				const filtered = raw.filter((hit) => matcher(hit.chunk.file));

				// Ranking bias, not a filter: a spec is sometimes the right answer, it
				// just should not outrank the implementation by default. Specs embed well
				// because they read like prose describing intent.
				const adjusted = filtered
					.map((hit) => ({
						hit,
						score: hit.hybrid * testWeight(relative(ctx.cwd, hit.chunk.file), prefer),
					}))
					.sort((a, b) => b.score - a.score);

				if (adjusted.length === 0) {
					const scoped =
						params.path_include || params.path_exclude
							? " within the requested paths"
							: "";
					return {
						content: [
							{
								type: "text",
								text:
									`No matches for "${params.query}"${scoped}.` +
									(raw.length > 0 ? ` (${raw.length} hits were filtered out by path.)` : ""),
							},
						],
						details: { results: 0, filteredOut: raw.length, chunks: stats.totalChunks },
					};
				}

				// COLLAPSE PER FILE. Three chunks of payment.rb used to consume three of
				// five result slots; now one entry per file reports its siblings, so
				// `limit` means `limit` distinct files.
				const byFile = new Map<string, { best: (typeof adjusted)[number]; count: number }>();
				for (const entry of adjusted) {
					const existing = byFile.get(entry.hit.chunk.file);
					if (existing) existing.count++;
					else byFile.set(entry.hit.chunk.file, { best: entry, count: 1 });
				}
				const files = [...byFile.values()].slice(0, limit);

				const rendered = files
					.map(({ best, count }) => {
						const { chunk } = best.hit;
						const rel = relative(ctx.cwd, chunk.file) || chunk.file;
						const siblings = count > 1 ? `  (+${count - 1} more chunk(s) in this file)` : "";
						const header =
							`${rel}:${chunk.lineStart}-${chunk.lineEnd}  score=${best.score.toFixed(3)}${siblings}`;
						return `${header}\n${truncateAtLine(chunk.content, EXCERPT_CHARS)}`;
					})
					.join("\n\n---\n\n");

				const freshness = describeFreshness(stats.lastBuild);

				return {
					content: [{ type: "text", text: `${freshness}\n\n${rendered}` }],
					details: {
						results: files.length,
						candidates: raw.length,
						pathFiltered: raw.length - filtered.length,
						chunks: stats.totalChunks,
						files: stats.totalFiles,
						stale: dirtyFiles.size,
						indexing,
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
		// SIGTERM the indexing child, if any. It stops at its next slice boundary;
		// everything already committed stays, and the rest is picked up by hash-skip
		// on the next run. We do NOT wait for it: waiting for the in-flight slice is
		// exactly the 5-15s exit hang that moving the pass out of process removed.
		stopIndexer();
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
