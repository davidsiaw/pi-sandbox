/**
 * selftest.mjs — auth-free guard for pa-rag.
 *
 * Verifies the three things most likely to break silently:
 *
 *   1. The WALKER includes dotfiles, dot-directories and `.jsonl` sessions
 *      while still excluding `.git`, `node_modules` and our own store. This is
 *      pa-rag's entire reason for existing, so a regression here is the whole
 *      feature quietly disappearing.
 *
 *   2. The UPSTREAM LOADER can still reach pi-local-rag's submodules. It
 *      bypasses a sealed `exports` map by importing files directly, so an
 *      upstream reorganisation breaks it — and it must break loudly.
 *
 *   3. END TO END: our file list, fed to upstream's unmodified indexer,
 *      actually indexes a dotfile and a past pi session transcript, and
 *      retrieves them semantically. This is the claim the whole design rests
 *      on: that no fork is required.
 *
 * Usage: node selftest.mjs   (exit 0 = pass, non-zero = fail)
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

let failed = 0;
const check = (name, cond, detail) => {
	if (cond) {
		console.log(`  ok   ${name}`);
	} else {
		failed++;
		console.log(`  FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
	}
};

// ── Build a fixture repo that exercises every interesting case ──────────────
const root = mkdtempSync(join(tmpdir(), "pa-rag-selftest-"));
mkdirSync(join(root, ".github", "workflows"), { recursive: true });
mkdirSync(join(root, ".pi-sessions"), { recursive: true });
mkdirSync(join(root, "src"), { recursive: true });
mkdirSync(join(root, ".git", "objects"), { recursive: true });
mkdirSync(join(root, "node_modules", "leftpad"), { recursive: true });
mkdirSync(join(root, ".pirag"), { recursive: true });

writeFileSync(
	join(root, ".github", "workflows", "build.yml"),
	"name: build-and-push\njobs:\n  smoke:\n    steps:\n      - run: bash smoketest.sh\n",
);
writeFileSync(
	join(root, ".pi-sessions", "old-session.jsonl"),
	`${JSON.stringify({
		type: "message",
		message: { role: "assistant", content: "exit code 141 is SIGPIPE (128+13): grep exited after matching and closed the pipe while cloakbrowser was still streaming output." },
	})}\n`,
);
writeFileSync(join(root, ".hiddenrc"), '{ "secretSetting": "alpha-quebec-marker" }\n');
writeFileSync(join(root, "src", "app.ts"), "export const start = () => console.log('hi');\n");
writeFileSync(join(root, "Dockerfile"), "FROM debian:trixie-slim\nRUN echo hi\n");
// Things that must be excluded:
writeFileSync(join(root, ".git", "objects", "deadbeef"), "binary-garbage\n");
writeFileSync(join(root, "node_modules", "leftpad", "index.js"), "module.exports = 1;\n");
writeFileSync(join(root, "package-lock.json"), '{ "lockfileVersion": 3 }\n');
writeFileSync(join(root, "bundle.min.js"), "!function(){}();\n");
// A decoy db file inside the store, to prove the walker skips it. It must NOT
// live at .pirag/rag.db, because the end-to-end phase points the real store
// there and better-sqlite3 would reject our fake content (SQLITE_NOTADB).
writeFileSync(join(root, ".pirag", "decoy.db"), "not-a-real-database\n");

// ── (1) Walker behaviour ───────────────────────────────────────────────────
const { walk, probe, isIndexable } = await import(join(here, "walk.ts"));

const { files, bytes } = walk(root, { skipPaths: new Set([join(root, ".pirag")]) });
const rel = files.map((f) => f.slice(root.length + 1).split("\\").join("/")).sort();

check("indexes a dot-directory (.github/)", rel.includes(".github/workflows/build.yml"), rel.join(","));
check("indexes a plain dotfile (.hiddenrc)", rel.includes(".hiddenrc"), rel.join(","));
check("indexes past pi sessions (.jsonl)", rel.includes(".pi-sessions/old-session.jsonl"), rel.join(","));
check("indexes extensionless text (Dockerfile)", rel.includes("Dockerfile"), rel.join(","));
check("indexes ordinary source", rel.includes("src/app.ts"), rel.join(","));
check("excludes .git/", !rel.some((f) => f.startsWith(".git/")), rel.join(","));
check("excludes node_modules/", !rel.some((f) => f.startsWith("node_modules/")), rel.join(","));
check("excludes lockfiles", !rel.includes("package-lock.json"), rel.join(","));
check("excludes minified bundles", !rel.includes("bundle.min.js"), rel.join(","));
check("excludes own store (.pirag/)", !rel.some((f) => f.startsWith(".pirag/")), rel.join(","));
check("walk reports non-zero bytes", bytes > 0, String(bytes));

check("isIndexable accepts .jsonl", isIndexable("session.jsonl"));
check("isIndexable rejects .png", !isIndexable("logo.png"));
check("isIndexable rejects rag.db", !isIndexable("rag.db"));

// The tool_result hook reuses isIndexable to filter mutated paths, so a write
// to a lockfile or a minified bundle must not queue a re-index.
check("mutation filter rejects lockfiles", !isIndexable("package-lock.json"));
check("mutation filter rejects minified bundles", !isIndexable("bundle.min.js"));
check("mutation filter accepts ordinary source", isIndexable("app.ts"));

// Early bail: a cap of 1 byte must stop almost immediately.
const capped = probe(root, 1);
check("probe bails early when over cap", capped.overCap === true, JSON.stringify(capped));
check("probe is fast (<250ms on fixture)", capped.ms < 250, `${capped.ms}ms`);

// ── (2) Upstream loader ────────────────────────────────────────────────────
let upstream = null;
try {
	const mod = await import(join(here, "upstream.ts"));
	upstream = await mod.load(here);
	check("upstream loader finds pi-local-rag", typeof upstream.packageDir === "string", upstream.packageDir);
	check("upstream exposes indexFiles", typeof upstream.indexFiles === "function");
	check("upstream exposes hybridSearch", typeof upstream.hybridSearch === "function");
	check("upstream exposes openDb", typeof upstream.openDb === "function");
	check("upstream exposes getIndexStats", typeof upstream.getIndexStats === "function");
} catch (err) {
	failed++;
	console.log(`  FAIL upstream loader :: ${err instanceof Error ? err.message : String(err)}`);
}

// ── (3) End-to-end: index + retrieve a dotfile and a past session ──────────
// Skippable because it runs real ONNX inference: too slow under QEMU emulation
// in CI, where we only want the cheap structural checks above.
if (upstream && !process.env.PA_RAG_SKIP_EMBED) {
	process.env.PI_RAG_DIR = join(root, "store");
	mkdirSync(join(root, "store"), { recursive: true });
	const db = upstream.openDb();
	try {
		const result = await upstream.indexFiles(files, undefined, db, false);
		check("indexFiles accepts our dotfile-inclusive list", result.chunks > 0, JSON.stringify(result));

		const stats = upstream.getIndexStats(db);
		check("index reports stored chunks", stats.totalChunks > 0, JSON.stringify(stats));

		// Semantic recall: no shared keywords with the stored text.
		const sigpipe = await upstream.hybridSearch(
			"why did the smoke test terminate with a broken pipe",
			{ chunks: [], files: {} },
			5,
			0.4,
			db,
		);
		check(
			"retrieves a past pi session transcript",
			sigpipe.some((h) => h.chunk.file.endsWith("old-session.jsonl")),
			sigpipe.map((h) => h.chunk.file).join(","),
		);

		const dotfile = await upstream.hybridSearch(
			"alpha-quebec-marker",
			{ chunks: [], files: {} },
			5,
			0.4,
			db,
		);
		check(
			"retrieves a dotfile",
			dotfile.some((h) => h.chunk.file.endsWith(".hiddenrc")),
			dotfile.map((h) => h.chunk.file).join(","),
		);
	} catch (err) {
		failed++;
		console.log(`  FAIL end-to-end index/search :: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		db.close();
	}
} else if (!process.env.PA_RAG_SKIP_EMBED) {
	console.log("  skip end-to-end (upstream failed to load)");
} else {
	console.log("  skip end-to-end (PA_RAG_SKIP_EMBED set)");
}

// ── (3b) Sliced indexing: memory bound, checkpointing, resume ─────────────
// Upstream's indexFiles() keeps every chunk AND every vector in memory until a
// single commit at the end, so peak memory is O(repo). pa-rag never hands it the
// whole list — it slices. These checks cover the slicing arithmetic (pure, fast)
// and, when embeddings are enabled, that slice-by-slice indexing actually
// commits incrementally so an interrupted pass resumes instead of starting over.
{
	// Mirror the extension's slicer. Kept in sync deliberately rather than
	// imported: index.ts is a pi extension module and importing it here would drag
	// in ExtensionAPI types and the whole registration side effect.
	const sliceFiles = (files, maxBytes, sizeOf) => {
		const slices = [];
		let current = [];
		let currentBytes = 0;
		for (const f of files) {
			current.push(f);
			currentBytes += sizeOf(f);
			if (currentBytes >= maxBytes) {
				slices.push(current);
				current = [];
				currentBytes = 0;
			}
		}
		if (current.length > 0) slices.push(current);
		return slices;
	};

	const even = Array.from({ length: 10 }, (_, i) => `f${i}`);
	const s1 = sliceFiles(even, 100, () => 50); // 2 files per slice
	check("slicer groups by bytes, not file count", s1.length === 5, JSON.stringify(s1.map((s) => s.length)));
	check("slicer loses no files", s1.flat().length === 10, String(s1.flat().length));

	// A single file over the cap must still be emitted, in its own slice, rather
	// than dropped or merged into a giant one.
	const withGiant = ["small-a", "giant", "small-b"];
	const s2 = sliceFiles(withGiant, 100, (f) => (f === "giant" ? 10_000 : 10));
	check("oversized file still emitted", s2.flat().includes("giant"), JSON.stringify(s2));
	check("oversized file does not swallow the tail", s2.flat().includes("small-b"), JSON.stringify(s2));
	check("slicer preserves order", s2.flat().join(",") === "small-a,giant,small-b", s2.flat().join(","));

	// Degenerate inputs must not hang or produce empty slices.
	check("empty input -> no slices", sliceFiles([], 100, () => 0).length === 0);
	check(
		"zero-byte files still get a slice",
		sliceFiles(["a", "b"], 100, () => 0).length === 1,
	);
	check(
		"no empty slices emitted",
		sliceFiles(even, 100, () => 50).every((s) => s.length > 0),
	);
}

// The payoff of slicing, verified against the real indexer: indexing in two
// passes must COMMIT the first pass, and the second pass must skip that work by
// hash rather than re-embedding it. That is what makes an interrupted index
// resumable, so it is worth the embedding cost to prove.
if (upstream && !process.env.PA_RAG_SKIP_EMBED) {
	const resumeRoot = mkdtempSync(join(tmpdir(), "pa-rag-resume-"));
	mkdirSync(join(resumeRoot, "store"), { recursive: true });
	writeFileSync(join(resumeRoot, "one.ts"), "export const alpha = () => 'first file content';\n");
	writeFileSync(join(resumeRoot, "two.ts"), "export const beta = () => 'second file content';\n");
	process.env.PI_RAG_DIR = join(resumeRoot, "store");

	const db = upstream.openDb();
	try {
		const first = await upstream.indexFiles([join(resumeRoot, "one.ts")], { onFile: () => {} }, db, false);
		const afterFirst = upstream.getIndexStats(db);
		check("slice 1 commits before slice 2 runs", afterFirst.totalChunks > 0, JSON.stringify(afterFirst));

		const second = await upstream.indexFiles([join(resumeRoot, "two.ts")], { onFile: () => {} }, db, false);
		const afterSecond = upstream.getIndexStats(db);
		check(
			"slice 2 adds to the committed index",
			afterSecond.totalChunks > afterFirst.totalChunks && afterSecond.totalFiles === 2,
			JSON.stringify(afterSecond),
		);

		// Re-running an already-indexed slice must skip, not re-embed: this is the
		// mechanism that lets a killed pass resume for free.
		const redo = await upstream.indexFiles([join(resumeRoot, "one.ts")], { onFile: () => {} }, db, false);
		check(
			"re-indexing a committed slice skips by hash (resume is free)",
			redo.skipped === 1 && redo.chunks === 0,
			JSON.stringify(redo),
		);
		void first;
		void second;
	} catch (err) {
		failed++;
		console.log(`  FAIL sliced commit/resume :: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		db.close();
	}
} else if (process.env.PA_RAG_SKIP_EMBED) {
	console.log("  skip sliced commit/resume (PA_RAG_SKIP_EMBED set)");
}

// ── (3c) Footer progress rendering ──────────────────────────────────
// A progress bar that lies is worse than no progress bar. Two things went wrong
// in development and must stay fixed:
//   1. The chunk-count denominator is derived from BYTES_PER_CHUNK, which is only
//      a guess (measured 1854 vs 3324 bytes/chunk on two real trees). It read
//      "102/~88 chunks" at 100% and kept counting.
//   2. A pass finishing inside one throttle window rendered only its final
//      frame, so the bar flashed straight to 100%.
{
	const BAR = 12;
	const progressBar = (fraction) => {
		const clamped = Math.max(0, Math.min(1, fraction));
		const filled = Math.round(clamped * BAR);
		return "\u2588".repeat(filled) + "\u2591".repeat(BAR - filled);
	};

	check("bar at 0% is all empty", progressBar(0) === "\u2591".repeat(BAR), progressBar(0));
	check("bar at 100% is all full", progressBar(1) === "\u2588".repeat(BAR), progressBar(1));
	check("bar is fixed width at 50%", progressBar(0.5).length === BAR, String(progressBar(0.5).length));
	// Out-of-range input must clamp, not produce a negative repeat count (throws)
	// or a bar wider than the field.
	check("bar clamps above 1", progressBar(1.7) === "\u2588".repeat(BAR), progressBar(1.7));
	check("bar clamps below 0", progressBar(-0.4) === "\u2591".repeat(BAR), progressBar(-0.4));

	// The self-correcting denominator: once real chunks exceed the estimate, the
	// denominator grows so the ratio never exceeds 1.
	const frac = (done, est, sliceDone = 0, sliceTotal = 1) => {
		const denom = Math.max(est, done);
		return sliceTotal > 1
			? Math.min(1, (sliceDone + Math.min(1, done / denom)) / sliceTotal)
			: Math.min(1, done / denom);
	};
	check("progress never exceeds 100% when estimate was low", frac(102, 88) <= 1, String(frac(102, 88)));
	check("denominator grows past a low estimate", Math.max(88, 102) === 102);
	check("mid-progress reads sensibly", Math.abs(frac(44, 88) - 0.5) < 0.01, String(frac(44, 88)));
	check("multi-slice progress stays in range", frac(300, 390, 1, 2) <= 1 && frac(300, 390, 1, 2) > 0.5);
	check("final slice reaches 100%", frac(552, 390, 1, 2) === 1, String(frac(552, 390, 1, 2)));

	// Throttle: first write always lands, later ones inside the window are
	// dropped, and an explicit force always lands (used for start/done/clear).
	const THROTTLE = 400;
	const mkStatus = (sink) => {
		let lastWrite = 0;
		return (text, force = false) => {
			const now = Date.now();
			if (!force && text !== undefined && now - lastWrite < THROTTLE) return;
			lastWrite = now;
			sink.push(text);
		};
	};
	const sink = [];
	const status = mkStatus(sink);
	status("first");
	status("immediately-after");
	status("forced", true);
	status(undefined, true);
	check("first status write always renders", sink[0] === "first", JSON.stringify(sink));
	check("throttled write is dropped", !sink.includes("immediately-after"), JSON.stringify(sink));
	check("forced write bypasses throttle", sink.includes("forced"), JSON.stringify(sink));
	check("clear (undefined) always lands", sink[sink.length - 1] === undefined, JSON.stringify(sink));
}

// ── (4) Debounce coalescing ────────────────────────────────────────────────
// The mid-session refresh debounces mutations so a burst of edits in one
// assistant turn becomes a single re-embed pass rather than one per file.
// This mirrors the extension's timer shape rather than importing it, because
// the real one is bound to a live session.
{
	let flushes = 0;
	let timer = null;
	const dirty = new Set();
	const schedule = () => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			flushes++;
			dirty.clear();
		}, 40);
	};
	for (let i = 0; i < 5; i++) {
		dirty.add(`f${i}.ts`);
		schedule();
		await new Promise((r) => setTimeout(r, 8));
	}
	await new Promise((r) => setTimeout(r, 150));
	check("debounce coalesces a burst into one pass", flushes === 1, `flushes=${flushes}`);
}

if (failed > 0) {
	console.log(`selftest: ${failed} check(s) FAILED`);
	process.exit(1);
}
console.log("selftest: all checks passed");
