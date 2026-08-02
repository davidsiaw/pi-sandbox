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
import { extname, join } from "node:path";

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
 */
export function walk(
	root: string,
	opts: { capBytes?: number; skipPaths?: Set<string> } = {},
): { files: string[]; bytes: number; overCap: boolean } {
	const capBytes = opts.capBytes ?? Number.POSITIVE_INFINITY;
	const skipPaths = opts.skipPaths;
	const files: string[] = [];
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
				if (SKIP_DIRS.has(entry.name)) continue;
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
	return { files, bytes, overCap };
}

/** Measure indexable size without collecting paths. Cheap enough for startup. */
export function probe(root: string, capBytes: number, skipPaths?: Set<string>): ProbeResult {
	const started = Date.now();
	const { files, bytes, overCap } = walk(root, { capBytes, skipPaths });
	return { bytes, files: files.length, overCap, ms: Date.now() - started };
}
