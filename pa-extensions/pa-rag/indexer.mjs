#!/usr/bin/env node
/**
 * pa-rag/indexer.mjs — the embedding pass, in a CHILD PROCESS.
 *
 * WHY THIS FILE EXISTS (measured, not theoretical):
 * The pass used to run inside pi. With a 50ms interval installed in pi's own
 * process during a background index, the event loop reported
 *
 *     LAG n=100 max=290ms avg=96.7ms
 *
 * i.e. the UI thread was stalled roughly two thirds of the time — keystroke
 * echo, spinner and token streaming all visibly stuttering. The embedding call
 * itself is async (onnxruntime runs off-thread and pegs ~8 cores, measured
 * 750-800% CPU / 22 threads), but tokenization, tensor marshalling and the
 * SQLite writes are plain main-thread JS, and no ORT knob moves the CPU cost:
 * `intraOpNumThreads: 1`, `OMP_NUM_THREADS=2` and even `taskset -c 0,1` were all
 * verified ineffective — ORT resets its own affinity.
 *
 * Three further problems came from being in-process, and all three are fixed by
 * being out of it:
 *
 *   1. EXIT HUNG. `session_shutdown` set an abort flag checked only at slice
 *      boundaries, and the pending indexFiles() promise plus ORT's handles kept
 *      node alive, so quitting cost up to a whole slice (measured 5-15s).
 *      Now shutdown is a SIGTERM and pi exits immediately.
 *   2. NO CONVERGENCE. Because each session aborted the pass, a 3.3 MB tree
 *      needed FOUR sessions to finish indexing, so short sessions in a large
 *      repo paid the cost forever without ever completing. The child outlives
 *      the turn it was started in and is only killed at shutdown, so a session
 *      of any length makes real progress.
 *   3. MEMORY. The model plus its batch (~300 MB) lived in pi's heap for the
 *      rest of the session. Here it dies with the child.
 *
 * The child also lowers its own scheduling priority (os.setPriority) for
 * background passes, which the in-process version could not do at all.
 *
 * PROTOCOL: argv[2] is a JSON config (see index.ts `spawnIndexer`). stdout is
 * newline-delimited JSON events; stderr is free-form and only read if the child
 * fails. Never print anything else to stdout — the parent parses every line.
 */

import { readFileSync, statSync } from "node:fs";
import { setPriority } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const HERE = dirname(new URL(import.meta.url).pathname);

/** @type {{
 *   cwd: string, storeDir: string, ppid: number,
 *   force?: boolean, background?: boolean, includeSessions?: boolean,
 *   skipPaths?: string[], filesFile?: string,
 *   sliceBytes: number, batchSize: number, dutyCycle: number, maxThrottleMs: number,
 *   nice?: number,
 * }} */
const cfg = JSON.parse(process.argv[2] ?? "{}");

// SURVIVE THE PARENT CLOSING THE PIPE. When pi exits, our stdout pipe is closed
// and the next write raises EPIPE — asynchronously, as an 'error' event, which
// node treats as an uncaught exception. That killed the child MID-SLICE, so the
// slice in flight was rolled back and the store stayed empty: verified, a fresh
// 3.3 MB tree ended a run with 0 files / 0 chunks committed. With the error
// swallowed, the slice finishes and commits, and the liveness check below is what
// decides to stop.
for (const stream of [process.stdout, process.stderr]) {
	stream.on("error", () => {});
}

/** Emit one protocol event. Dropped silently once the parent is gone. */
const emit = (event) => {
	try {
		process.stdout.write(`${JSON.stringify(event)}\n`);
	} catch {
		// Pipe already gone; the liveness check below will stop us.
	}
};

// ── Stop conditions ─────────────────────────────────────────────────────────
// Checked at every slice boundary. Everything before the boundary is already
// committed, so stopping there loses no work and needs no rollback.
let abort = false;
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
	process.on(signal, () => {
		abort = true;
	});
}

/**
 * True while pi is still running.
 *
 * Without this a SIGKILLed pi (OOM, `docker kill`, closed terminal) would leave
 * an orphan burning eight cores to embed into a project nobody is looking at.
 * `kill(pid, 0)` only tests for existence; it sends no signal.
 */
const parentAlive = () => {
	if (!cfg.ppid) return true;
	try {
		process.kill(cfg.ppid, 0);
		return true;
	} catch {
		return false;
	}
};

// The timer is deliberately NOT unref'd. Unref'ing it (copied from the
// in-process version, where pi's own handles kept the loop alive) left this
// process with no referenced handles during a throttle nap, so node decided it
// had nothing left to do and exited 0 after the FIRST slice — silently, mid-pass.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Locate jiti, exactly as upstream.ts does: pi-local-rag AND our own
 * upstream.ts/walk.ts are TypeScript, and node refuses to strip types under
 * node_modules, so the child cannot `import()` them directly.
 */
async function getJiti(fromDir) {
	const candidates = [
		"/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti",
		"jiti",
	];
	let lastError;
	for (const candidate of candidates) {
		try {
			const mod = await import(candidate);
			const createJiti = mod.createJiti ?? mod.default;
			if (typeof createJiti !== "function") continue;
			const jiti = createJiti(pathToFileURL(join(fromDir, "/")).href, {
				interopDefault: true,
				fsCache: true,
			});
			return (id) => jiti.import(id);
		} catch (err) {
			lastError = err;
		}
	}
	throw new Error(
		`could not load jiti to transpile pa-rag's TypeScript: ${
			lastError instanceof Error ? lastError.message : String(lastError)
		}`,
	);
}

/**
 * Split files into byte-bounded slices. One slice is one upstream indexFiles()
 * call, which bounds peak memory (upstream accumulates every chunk and vector
 * until its single closing transaction) and is the checkpoint granularity.
 *
 * Sizes come from the walk, so this does not stat anything a second time.
 */
const sliceFiles = (files, sizes, maxBytes) => {
	const slices = [];
	let current = [];
	let currentBytes = 0;
	for (let i = 0; i < files.length; i++) {
		current.push(files[i]);
		currentBytes += sizes[i] ?? 0;
		if (currentBytes >= maxBytes) {
			slices.push(current);
			current = [];
			currentBytes = 0;
		}
	}
	if (current.length > 0) slices.push(current);
	return slices;
};

async function main() {
	// Be the process that yields. A background pass is unattended work competing
	// with an interactive session for the same cores; nice 19 costs it nothing it
	// is entitled to. Best-effort: containers may forbid renicing.
	if (cfg.nice) {
		try {
			setPriority(0, cfg.nice);
		} catch {
			// Not permitted (some sandboxes). Continue at normal priority.
		}
	}

	// Both are read by the code below at call time, not at import time:
	// PI_RAG_DIR steers pi-local-rag's getRagDir() to our .pirag store, and
	// PA_RAG_BATCH_SIZE is resolved per embedBatch() call by our build-time patch
	// (scripts/patch-rag-batch.sh).
	process.env.PI_RAG_DIR = cfg.storeDir;
	process.env.PA_RAG_BATCH_SIZE = String(cfg.batchSize);

	const jitiImport = await getJiti(HERE);
	const upstreamMod = await jitiImport(join(HERE, "upstream.ts"));
	const walkMod = await jitiImport(join(HERE, "walk.ts"));
	const upstream = await upstreamMod.load(HERE);

	// Two callers: a full pass (walk the tree) and a dirty-file flush (an explicit
	// list from the parent, which watched the agent write those files).
	let files;
	let sizes;
	let bytes = 0;
	if (cfg.filesFile) {
		files = JSON.parse(readFileSync(cfg.filesFile, "utf8"));
		sizes = files.map((f) => {
			try {
				const size = statSync(f).size;
				bytes += size;
				return size;
			} catch {
				return 0;
			}
		});
	} else {
		const walked = walkMod.walk(cfg.cwd, {
			skipPaths: new Set(cfg.skipPaths ?? []),
			includeSessions: cfg.includeSessions ?? false,
		});
		files = walked.files;
		sizes = walked.sizes;
		bytes = walked.bytes;
	}

	if (files.length === 0) {
		emit({ t: "empty" });
		return;
	}

	emit({ t: "walk", files: files.length, bytes });

	const slices = sliceFiles(files, sizes, cfg.sliceBytes);
	const started = Date.now();
	let indexed = 0;
	let chunks = 0;
	let skipped = 0;
	// upstream's onEmbed total resets per slice, so this is what makes the
	// parent's progress bar monotonic across the whole pass.
	let embeddedBefore = 0;

	const db = upstream.openDb();
	try {
		for (let i = 0; i < slices.length; i++) {
			if (abort || !parentAlive()) {
				emit({
					t: "done",
					aborted: true,
					indexed,
					chunks,
					skipped,
					elapsedSec: (Date.now() - started) / 1000,
				});
				return;
			}

			const sliceStarted = Date.now();
			// Supplying progress callbacks is also what stops upstream writing its own
			// \r progress bar to stderr (indexing.ts flips an internal
			// _suppressStderr when callbacks are present).
			const result = await upstream.indexFiles(
				slices[i],
				{
					onFile: () => {},
					onEmbed: (done) => {
						emit({
							t: "chunks",
							done: embeddedBefore + done,
							sliceDone: i,
							sliceTotal: slices.length,
						});
					},
				},
				db,
				cfg.force ?? false,
			);
			const sliceMs = Date.now() - sliceStarted;

			indexed += result.indexed;
			chunks += result.chunks;
			skipped += result.skipped;
			embeddedBefore += result.chunks;

			emit({ t: "slice", done: i + 1, total: slices.length, chunks });

			if (i < slices.length - 1 && cfg.background) {
				// Duty-cycle throttle: rest in proportion to how long the slice took, so
				// a pass over an already-indexed tree (slices that hash-skip everything
				// take ~0ms) stays fast while a real pass backs off.
				const rest = Math.min(
					cfg.maxThrottleMs,
					Math.round(sliceMs * ((1 - cfg.dutyCycle) / cfg.dutyCycle)),
				);
				if (rest > 0) await sleep(rest);
			}
		}

		emit({
			t: "done",
			aborted: false,
			indexed,
			chunks,
			skipped,
			elapsedSec: (Date.now() - started) / 1000,
		});
	} finally {
		db.close();
	}
}

/**
 * Exit, but not before stdout has flushed.
 *
 * process.exit() discards writes still queued on a pipe, which silently ate the
 * final `done` event whenever stdout was a pipe (i.e. always — the parent reads
 * it) and made a perfectly good pass look like "exited without a result". The
 * safety timer is there because we cannot simply fall off the end of main():
 * ORT leaves its thread pool behind, so this process must force its own exit.
 */
const exitWhenFlushed = (code) => {
	const hardExit = setTimeout(() => process.exit(code), 2000);
	process.stdout.write("", () => {
		clearTimeout(hardExit);
		process.exit(code);
	});
};

// Exported for selftest.mjs. Importing this module must therefore stay free of
// side effects, which is why main() only runs when we are the entry script.
export { sliceFiles };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().then(
		() => exitWhenFlushed(0),
		(err) => {
			emit({ t: "error", message: err instanceof Error ? err.message : String(err) });
			exitWhenFlushed(1);
		},
	);
}
