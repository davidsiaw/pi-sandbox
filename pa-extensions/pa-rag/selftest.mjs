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
