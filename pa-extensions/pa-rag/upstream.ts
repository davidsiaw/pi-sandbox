/**
 * pa-rag/upstream.ts — load pi-local-rag's internals without forking it.
 *
 * WHY THE ODD LOADER:
 * pi-local-rag's package.json declares `"exports": { ".": "./index.ts" }`,
 * which SEALS every other subpath. Two consequences:
 *
 *   1. `import("pi-local-rag/indexing.ts")` fails with
 *      ERR_PACKAGE_PATH_NOT_EXPORTED.
 *   2. `import("pi-local-rag")` (the root) fails in THIS image with
 *      ERR_MODULE_NOT_FOUND, because their entry point imports
 *      `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui` and
 *      `@sinclair/typebox` — the older package names, none of which exist
 *      here (this image ships `@earendil-works/*` and `typebox`).
 *
 * Their *submodules* are clean: constants/store/config/db/embed/search/
 * chunking/indexing import only node builtins plus better-sqlite3,
 * sqlite-vec and ignore. So we locate the package directory on disk by
 * walking up node_modules, then import the submodule files directly by
 * file:// URL. That sidesteps both the exports map and their unusable entry
 * point, while still running their real, unmodified code.
 *
 * This is the load-bearing assumption of the whole extension. If a future
 * pi-local-rag reorganises its files, `load()` throws with a clear message
 * rather than failing silently.
 *
 * WHY JITI AND NOT A PLAIN import():
 * pi-local-rag ships raw TypeScript (its package `main` is `./index.ts`).
 * Node's built-in type stripping refuses to touch files under node_modules:
 *   "Stripping types is currently unsupported for files under node_modules"
 * So we load their .ts through jiti — the same loader pi itself uses for
 * extensions, already present in the pi install — which transpiles on the fly.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Locate jiti. Prefer the copy inside the pi install (guaranteed present,
 * since pi loads every extension with it), then fall back to normal
 * resolution for dev checkouts outside the image.
 */
async function getJiti(fromDir: string): Promise<(id: string) => unknown> {
	const candidates = [
		"/usr/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti",
		"jiti",
	];
	let lastError: unknown;
	for (const candidate of candidates) {
		try {
			const mod = (await import(candidate)) as {
				createJiti?: (from: string, opts?: unknown) => { import: (id: string) => Promise<unknown> };
				default?: unknown;
			};
			const createJiti = mod.createJiti ?? (mod.default as typeof mod.createJiti);
			if (typeof createJiti !== "function") continue;
			const jiti = createJiti(pathToFileURL(join(fromDir, "/")).href, {
				interopDefault: true,
				// Cache transpiled output; the modules are immutable in the image.
				fsCache: true,
			});
			return (id: string) => jiti.import(id);
		} catch (err) {
			lastError = err;
		}
	}
	throw new Error(
		`pa-rag: could not load jiti to transpile pi-local-rag's TypeScript: ${
			lastError instanceof Error ? lastError.message : String(lastError)
		}`,
	);
}

/** Minimal shape of the upstream pieces we actually use. */
export interface Upstream {
	packageDir: string;
	indexFiles: (
		paths: string[],
		progress?: {
			onFile?: (current: number, total: number, filename: string, skipped: number) => void;
			onEmbed?: (done: number, total: number) => void;
		},
		db?: unknown,
		force?: boolean,
	) => Promise<{ indexed: number; chunks: number; skipped: number; durationMs: number }>;
	hybridSearch: (
		query: string,
		index: { chunks: unknown[]; files: Record<string, unknown> },
		topK: number,
		alpha: number,
		db?: unknown,
	) => Promise<
		Array<{
			chunk: { file: string; content: string; lineStart: number; lineEnd: number };
			hybrid: number;
		}>
	>;
	openDb: () => { close: () => void };
	getIndexStats: (db?: unknown) => {
		totalFiles: number;
		totalChunks: number;
		totalVectors?: number;
		lastBuild?: string;
		embeddingModel?: string;
	};
}

/**
 * Locate an installed package directory by walking up `node_modules` chains.
 * Uses plain fs checks rather than `require.resolve`, because resolution goes
 * through the exports map we are trying to avoid.
 */
function findPackageDir(name: string, from: string): string | null {
	let dir = from;
	for (;;) {
		const candidate = join(dir, "node_modules", name);
		if (existsSync(join(candidate, "package.json"))) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

let cached: Upstream | null = null;

/**
 * Point Transformers.js at the model baked into the image, so a cold container
 * never reaches out to Hugging Face. `env.cacheDir` must be set BEFORE
 * pi-local-rag's embed.ts first constructs a pipeline, which is why this runs
 * inside load() ahead of the submodule imports.
 *
 * If the baked directory is absent (dev checkout outside the image) we leave
 * the defaults alone and let it download as usual.
 */
async function configureModelCache(): Promise<void> {
	const baked = "/opt/pa/models";
	if (!existsSync(baked)) return;
	process.env.TRANSFORMERS_CACHE ??= baked;
	process.env.HF_HOME ??= baked;
	try {
		const mod = (await import("@xenova/transformers")) as {
			env?: { cacheDir?: string; allowRemoteModels?: boolean };
		};
		if (mod.env) {
			mod.env.cacheDir = baked;
			// The model is present locally; a miss should surface as an error
			// rather than a silent slow download inside someone's first prompt.
			mod.env.allowRemoteModels = false;
		}
	} catch {
		// transformers not resolvable from here — embed.ts will use its own copy
		// and the env vars above still apply.
	}
}

/**
 * Import pi-local-rag's submodules. Cached: the ONNX embedder inside
 * `embed.ts` holds a lazily-initialised model, and re-importing would risk
 * loading it twice.
 */
export async function load(extensionDir: string): Promise<Upstream> {
	if (cached) return cached;

	// Install the .jsonl text extractor that our build-time patch to upstream's
	// chunking.ts delegates to (see scripts/patch-rag-jsonl.sh). Done here because
	// this runs before any indexing call, and a global is the only channel through
	// which a jiti-loaded dependency can reach back into our module.
	//
	// Without this, an opted-in session transcript is embedded as raw JSON and
	// produces the meaningless vectors that made sessions worth excluding at all.
	if (!(globalThis as Record<string, unknown>).__paRagExtractJsonl) {
		const { extractSessionText } = await import("./walk.ts");
		(globalThis as Record<string, unknown>).__paRagExtractJsonl = extractSessionText;
	}

	// Try the extension's own node_modules first (that is where the baked
	// `npm install` puts it), then fall back to this file's location.
	const here = dirname(new URL(import.meta.url).pathname);
	const packageDir =
		findPackageDir("pi-local-rag", extensionDir) ?? findPackageDir("pi-local-rag", here);

	if (!packageDir) {
		throw new Error(
			"pa-rag: could not find pi-local-rag. Run `npm install` in the extension directory.",
		);
	}

	await configureModelCache();

	const jitiImport = await getJiti(packageDir);

	const importFile = async (basename: string): Promise<Record<string, unknown>> => {
		const file = join(packageDir, basename);
		if (!existsSync(file)) {
			throw new Error(
				`pa-rag: expected ${basename} in pi-local-rag at ${packageDir}. ` +
					"Upstream layout changed; pa-rag needs updating.",
			);
		}
		return (await jitiImport(file)) as Record<string, unknown>;
	};

	const [indexing, search, db] = await Promise.all([
		importFile("indexing.ts"),
		importFile("search.ts"),
		importFile("db.ts"),
	]);

	const indexFiles = indexing.indexFiles as Upstream["indexFiles"] | undefined;
	const hybridSearch = search.hybridSearch as Upstream["hybridSearch"] | undefined;
	const openDb = db.openDb as Upstream["openDb"] | undefined;
	const getIndexStats = db.getIndexStats as Upstream["getIndexStats"] | undefined;

	if (!indexFiles || !hybridSearch || !openDb || !getIndexStats) {
		throw new Error(
			"pa-rag: pi-local-rag did not export the expected functions " +
				"(indexFiles, hybridSearch, openDb, getIndexStats).",
		);
	}

	cached = { packageDir, indexFiles, hybridSearch, openDb, getIndexStats };
	return cached;
}

/**
 * `createRequire` is exported for callers that need CommonJS resolution
 * against the extension directory (not currently used, but keeps the
 * dependency explicit rather than re-deriving it at call sites).
 */
export const requireFrom = (from: string) => createRequire(pathToFileURL(join(from, "/")).href);
