/**
 * pa-rag/walk.ts — file discovery + cheap size probe.
 *
 * WHY THIS EXISTS (do not "simplify" it away):
 * pi-local-rag's own walkers (collectFiles / collectFromTracked) skip every
 * dotfile and dot-directory unconditionally:
 *
 *     if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
 *
 * That is a hard-coded walk filter, not config, so `.github/`, `.pi-sessions/`
 * and plain dotfiles can never be indexed through their entry points.
 *
 * Their INDEXER, however, does no filtering at all: `indexFiles(paths, ...)`
 * takes an explicit path array, and `extractText()` falls through to a plain
 * UTF-8 read for any unrecognised extension. So we supply our own file list
 * and hand it to their unmodified indexer. No fork required.
 *
 * Everything here is intentionally dependency-free (node builtins only) and
 * synchronous — the probe runs on the startup path and must stay in the
 * single-digit-milliseconds range.
 */

import { readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

/**
 * Directories holding pi session transcripts. Skipped unless the caller opts in.
 *
 * Kept separate from SKIP_DIRS so the opt-in can re-admit exactly these without
 * having to reconstruct the rest of the skip set.
 */
export const SESSION_DIRS = [".pi-sessions", ".omp-sessions"] as const;

/** True if `dir` is a session transcript directory. */
export const isSessionDir = (dir: string): boolean =>
	(SESSION_DIRS as readonly string[]).includes(basename(dir));

/**
 * Directories never worth indexing. Mostly build output, dependency trees and
 * caches: enormous, machine-generated, and actively harmful to retrieval
 * quality because they crowd out real source with near-duplicate text.
 *
 * `.git` matters most: it is NOT covered by .gitignore, and `.git/objects` is
 * compressed binary that would produce garbage embeddings in bulk.
 */
export const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	".pirag", // our own store — never index the index
	".pi", // pi state, incl. upstream's default .pi/rag store
	// Past pi transcripts. Indexed by default until it was measured against a
	// large real codebase, where a session file scored 1.000 on an exact
	// identifier query (`partial_capture_amount_cents`) and outranked every real
	// hit -- with content that was an unrelated regex dump. Cross-session recall
	// is genuinely useful, but not at the cost of poisoning identifier search, so
	// it is now opt-in via SESSION_DIRS + walk({ includeSessions: true }).
	...SESSION_DIRS,
	"dist",
	"build",
	"out",
	"target",
	".next",
	".nuxt",
	".svelte-kit",
	".turbo",
	".cache",
	".venv",
	"venv",
	"__pycache__",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	".gradle",
	".idea",
	".vscode",
	"vendor",
	"coverage",
	".terraform",
	"ms-playwright",
]);

/**
 * Files never worth indexing, matched on the full basename.
 * Lockfiles are huge, generated, and semantically empty.
 */
export const SKIP_FILES = new Set([
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lockb",
	"Cargo.lock",
	"poetry.lock",
	"Gemfile.lock",
	"composer.lock",
	"go.sum",
	"rag.db",
	"rag.db-wal",
	"rag.db-shm",
]);

/** Extensions that are text but never useful: minified/generated bundles. */
const SKIP_SUFFIXES = [".min.js", ".min.css", ".map", ".d.ts.map", ".lock"];

/**
 * Binary and media extensions. We index by extension allowlist rather than
 * sniffing content, so this set only exists to keep the allowlist honest for
 * extensionless files (see `isIndexable`).
 */
const BINARY_EXTS = new Set([
	".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg", ".pdf",
	".mp3", ".mp4", ".mov", ".avi", ".wav", ".flac", ".ogg", ".webm",
	".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".jar", ".war",
	".so", ".dylib", ".dll", ".exe", ".bin", ".o", ".a", ".node", ".wasm",
	".db", ".sqlite", ".sqlite3", ".pyc", ".class", ".onnx", ".gguf", ".safetensors",
	".woff", ".woff2", ".ttf", ".otf", ".eot",
]);

/**
 * Text extensions we index. Deliberately broader than upstream's list: adds
 * `.jsonl` (pi session transcripts) and config/dotfile formats.
 */
const TEXT_EXTS = new Set([
	".md", ".mdx", ".markdown", ".txt", ".rst", ".adoc", ".org",
	".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
	".py", ".pyi", ".rb", ".rake", ".php", ".pl", ".pm", ".lua",
	".rs", ".go", ".java", ".kt", ".kts", ".scala", ".clj", ".cljs", ".edn",
	".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx",
	".cs", ".fs", ".fsx", ".vb", ".swift", ".m", ".mm", ".dart",
	".ex", ".exs", ".erl", ".hrl", ".hs", ".ml", ".mli", ".nim", ".zig",
	".vue", ".svelte", ".astro",
	".css", ".scss", ".sass", ".less", ".styl",
	".html", ".htm", ".xml", ".xsl", ".jsp", ".erb", ".ejs", ".hbs", ".mustache",
	".json", ".jsonc", ".jsonl", ".ndjson",
	".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".properties",
	".csv", ".tsv",
	".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd",
	".sql", ".graphql", ".gql", ".proto", ".thrift",
	".tf", ".tfvars", ".hcl", ".nix", ".dockerfile", ".containerfile",
	".env", ".gitignore", ".gitattributes", ".dockerignore", ".editorconfig",
	".patch", ".diff", ".log",
	".mk", ".cmake", ".gradle", ".sbt", ".bazel", ".bzl",
]);

/**
 * Files with no extension that are conventionally text and worth indexing.
 *
 * NOTE: `extname(".hiddenrc")` returns "" — node treats a leading dot as the
 * start of the basename, not an extension. So bare dotfiles land in the
 * no-extension branch of `isIndexable` and are matched here (or by
 * DOTFILE_PREFIXES), not by TEXT_EXTS.
 */
const TEXT_BASENAMES = new Set([
	"Dockerfile", "Containerfile", "Makefile", "GNUmakefile", "Rakefile",
	"Gemfile", "Procfile", "Brewfile", "Justfile", "justfile", "Vagrantfile",
	"CMakeLists.txt", "LICENSE", "LICENCE", "COPYING", "NOTICE", "AUTHORS",
	"README", "CHANGELOG", "TODO", "VERSION", "CODEOWNERS",
]);

/**
 * Bare dotfiles are almost always small text config (`.hiddenrc`, `.babelrc`,
 * `.env.local`, `.gitignore`). Indexing them is the point of this extension,
 * so allow any dotfile that is not explicitly excluded elsewhere.
 */
const DOTFILE_BINARY_HINTS = [".png", ".jpg", ".gz", ".zip", ".db", ".so", ".node", ".wasm"];

/** Skip anything above this — big files are generated far more often than written. */
export const MAX_FILE_BYTES = 500_000;

export interface ProbeResult {
	/** Total bytes of indexable content found. */
	bytes: number;
	/** Number of indexable files found. */
	files: number;
	/** True if the walk stopped early because it exceeded `capBytes`. */
	overCap: boolean;
	/** Wall-clock duration of the probe, milliseconds. */
	ms: number;
}

/** Decide whether a single file is worth indexing, by name alone. */
export function isIndexable(name: string): boolean {
	if (SKIP_FILES.has(name)) return false;
	for (const suffix of SKIP_SUFFIXES) {
		if (name.endsWith(suffix)) return false;
	}
	const ext = extname(name).toLowerCase();
	if (ext) {
		if (BINARY_EXTS.has(ext)) return false;
		return TEXT_EXTS.has(ext);
	}
	// No extension. Two cases land here:
	//   - bare dotfiles (".hiddenrc", ".gitignore") — extname() returns ""
	//   - extensionless text ("Dockerfile", "Makefile")
	if (name.startsWith(".")) {
		const lower = name.toLowerCase();
		return !DOTFILE_BINARY_HINTS.some((hint) => lower.endsWith(hint));
	}
	return TEXT_BASENAMES.has(name);
}

/**
 * Walk `root` collecting indexable files.
 *
 * Unlike upstream we do NOT skip dotfiles or dot-directories — that is the
 * whole point of this module. Dot-directories are filtered by `SKIP_DIRS`
 * only, so `.github/` and `.pi-sessions/` are included while `.git/` is not.
 *
 * `capBytes` enables early bail: as soon as the running total exceeds the cap
 * the walk aborts. That keeps the worst case (a huge monorepo) as fast as the
 * best case, which is what makes calling this on the startup path acceptable.
 *
 * `sizes` is parallel to `files` and exists so that NOTHING stats a file twice.
 * The indexer slices by bytes, and re-statting there cost a second full pass
 * over the tree: measured 118us per file on a macOS bind mount (vs 14us on the
 * container's own filesystem), so on a large repo those passes are seconds of
 * pure duplicate I/O.
 */
export function walk(
	root: string,
	opts: { capBytes?: number; skipPaths?: Set<string>; includeSessions?: boolean } = {},
): { files: string[]; sizes: number[]; bytes: number; overCap: boolean } {
	const capBytes = opts.capBytes ?? Number.POSITIVE_INFINITY;
	const skipPaths = opts.skipPaths;
	const includeSessions = opts.includeSessions ?? false;
	const files: string[] = [];
	const sizes: number[] = [];
	let bytes = 0;
	let overCap = false;

	const recurse = (dir: string): void => {
		if (overCap) return;
		let entries: ReturnType<typeof readdirSync>;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return; // unreadable dir (permissions, race) — skip silently
		}
		for (const entry of entries) {
			if (overCap) return;
			const full = join(dir, entry.name);
			if (skipPaths?.has(full)) continue;
			if (entry.isDirectory()) {
				// Session dirs live in SKIP_DIRS, so re-admit them explicitly when asked.
				if (SKIP_DIRS.has(entry.name) && !(includeSessions && isSessionDir(full))) continue;
				recurse(full);
			} else if (entry.isFile()) {
				if (!isIndexable(entry.name)) continue;
				let size: number;
				try {
					size = statSync(full).size;
				} catch {
					continue;
				}
				if (size === 0 || size > MAX_FILE_BYTES) continue;
				files.push(full);
				sizes.push(size);
				bytes += size;
				if (bytes > capBytes) {
					overCap = true;
					return;
				}
			}
			// symlinks are ignored: following them invites cycles and duplicates
		}
	};

	recurse(root);
	return { files, sizes, bytes, overCap };
}

/** Measure indexable size without collecting paths. Cheap enough for startup. */
export function probe(
	root: string,
	capBytes: number,
	skipPaths?: Set<string>,
	includeSessions?: boolean,
): ProbeResult {
	const started = Date.now();
	const { files, bytes, overCap } = walk(root, { capBytes, skipPaths, includeSessions });
	return { bytes, files: files.length, overCap, ms: Date.now() - started };
}

/**
 * Flatten a pi session transcript into readable prose.
 *
 * WHY THIS EXISTS:
 * A `.jsonl` transcript is one JSON object per line, and a single line can carry
 * an entire assistant turn -- thinking blocks, several text blocks, tool calls
 * and their results. Upstream's chunker is line-based, so one line becomes one
 * chunk: a wall of JSON syntax, base64, escaped newlines and tool plumbing.
 * Embedding that produces a vector that means nothing in particular, which is
 * exactly why a session file could score 1.000 on an unrelated identifier query.
 *
 * So when sessions ARE indexed, index this instead: `role: text` per message,
 * one message per line, JSON scaffolding and non-text blocks discarded. Now the
 * chunker sees prose and the embeddings describe what was actually discussed.
 *
 * Returns "" when the file yields no usable text, which the caller treats as
 * "skip this file" rather than indexing an empty chunk.
 */
export function extractSessionText(raw: string): string {
	const out: string[] = [];

	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;

		let record: unknown;
		try {
			record = JSON.parse(trimmed);
		} catch {
			continue; // partial final line (session killed mid-write) or not JSONL
		}
		if (typeof record !== "object" || record === null) continue;

		const message = (record as { message?: unknown }).message;
		if (typeof message !== "object" || message === null) continue;

		const role = (message as { role?: unknown }).role;
		const content = (message as { content?: unknown }).content;
		const roleLabel = typeof role === "string" ? role : "unknown";

		// Content is either a bare string or an array of typed blocks.
		if (typeof content === "string") {
			const text = content.trim();
			if (text.length > 0) out.push(`${roleLabel}: ${text}`);
			continue;
		}
		if (!Array.isArray(content)) continue;

		for (const block of content) {
			if (typeof block !== "object" || block === null) continue;
			const type = (block as { type?: unknown }).type;
			// Only prose. Deliberately skipping toolCall/toolResult: they are the
			// bulk of a transcript's bytes and almost none of its meaning, and they
			// are what made raw JSONL lines embed so badly.
			if (type !== "text" && type !== "thinking") continue;
			const value =
				type === "text"
					? (block as { text?: unknown }).text
					: (block as { thinking?: unknown }).thinking;
			if (typeof value !== "string") continue;
			const text = value.trim();
			if (text.length > 0) out.push(`${roleLabel}: ${text}`);
		}
	}

	return out.join("\n");
}
