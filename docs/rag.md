# pa-rag — automatic local RAG index

`pa-rag` indexes the project into a local hybrid search index on session start,
so the agent can find code and notes **by meaning** rather than by exact string,
and so a *fresh* agent with an empty context can still recover what earlier
sessions concluded.

- Extension source: `pa-extensions/pa-rag/`
- In image: `/opt/pa/extensions/pa-rag/`
- Store: `.pirag/rag.db` in the project root (gitignored)
- Model: `Xenova/all-MiniLM-L6-v2`, 384-dim, baked at `/opt/pa/models`

## What it gives the agent

One tool, `rag_search`, plus `/rag-index` and `/rag-status` commands.

```
rag_search query="how is retry and backoff handled" limit=5 alpha=0.4
```

`alpha` blends keyword against semantic: `0` = pure vector, `1` = pure BM25,
default `0.4`.

Results are excerpts with file paths and line numbers. They are search hits, not
authoritative content — `read` the file before making claims about it.

## Why it exists alongside grep

`rg` already handles exact identifiers, and does it better. `pa-rag` covers the
case grep structurally cannot: finding code whose *words you do not know*.

Measured example — cosine similarity between

- `"how is retry and backoff handled"`, and
- `function retryWithExponentialBackoff(attempts)`

is **0.68**, with zero shared keywords. Grep scores that 0.

Guidance baked into the tool's `promptGuidelines` tells the model to prefer
`grep`/`rg` for exact identifiers and `read` for whole files.

## What gets indexed

Deliberately more than upstream `pi-local-rag` does:

- ordinary source and docs
- **dotfiles** (`.hiddenrc`, `.gitignore`) and **dot-directories** (`.github/`)
- **past pi session transcripts** (`.pi-sessions/*.jsonl`)
- extensionless text (`Dockerfile`, `Makefile`, `LICENSE`)

Excluded (see `SKIP_DIRS` / `SKIP_FILES` in `walk.ts`):

- `.git/` — compressed binary; produces garbage embeddings in bulk, and is
  **not** covered by `.gitignore`
- `node_modules/`, `dist/`, `build/`, `target/`, caches, `vendor/`
- `.pirag/` — never index the index
- lockfiles, `*.min.js`, `*.map`
- the **active** session file — it grows every turn, and upstream keys
  incremental refresh on whole-file hashes, so re-indexing it would re-embed the
  whole transcript each turn. Closed sessions are indexed.
- anything over 500 KB, and binary/media extensions

## The size gate

Embedding throughput was measured at **~36 chunks/sec**, and it does **not**
improve with batching or threads:

```
batch= 1  25.8 ms/chunk      threads=1  26.8 ms/chunk
batch=16  27.8 ms/chunk      threads=4  26.1 ms/chunk
batch=64  28.1 ms/chunk      threads=8  26.9 ms/chunk
```

At ~2 KB per chunk that is roughly 1 minute per 5 MB of source:

| indexable size | chunks | cold index |
|---|---|---|
| 5 MB | 2,300 | ~1 min |
| 10 MB | 4,700 | ~2 min |
| 50 MB | 23,000 | ~11 min |
| 250 MB | 116,000 | ~54 min |

So the startup path **probes first** and only auto-indexes when the project is
under **10 MB** (~2 min). Above that it prints an estimate and waits for
`/rag-index`.

The probe costs 1–2 ms even on huge trees, because it **bails early** as soon as
it crosses the cap. Measured throughput is written to
`.pirag/throughput.json` after a substantial run, so later estimates reflect the
machine actually in use rather than the figures above.

Subsequent sessions are cheap: upstream skips unchanged files by content hash.

## Staying fresh mid-session

When the agent writes or edits a file, `pa-rag` re-embeds **just that file**,
debounced by 1.5s so a burst of edits in one turn collapses into a single pass.
A file written in one turn is searchable in the next — verified end to end:
writing a file and immediately calling `rag_search` for a phrase inside it
returns it at score 1.000.

This hooks `tool_result` for the built-in `write` and `edit` tools rather than
watching the filesystem: it gets the exact path, costs nothing when idle, and
needs no watcher lifecycle. Mutated paths pass through the same `isIndexable`
filter as the initial walk, so writing a lockfile or `.git` internals cannot
sneak into the index.

**Known gap:** edits made *outside* pi — your own editor, `git checkout`, a
build step — are not detected. Those stay stale until the next session start or
an explicit `/rag-index`. `/rag-status` shows how many files are queued for
refresh.

Refresh failures are silent by design: a stale index is a degraded search, not a
broken session, and a notification on every write would be noise. Check
`/rag-status` if you suspect a problem.

## How it reuses pi-local-rag

Chunking, ONNX embeddings, SQLite FTS5 BM25, `sqlite-vec` cosine KNN, hybrid
fusion and hash-based incremental refresh all come from
[`pi-local-rag`](https://github.com/vahidkowsari/pi-local-rag) **unmodified**.
`pa-rag` adds only a walker, a size gate and a tool.

Two non-obvious mechanics make that possible without forking:

1. **We supply the file list.** Upstream's own walkers skip every dotfile
   (`entry.name.startsWith(".")`), which is hard-coded, not configurable. But
   `indexFiles(paths, …)` does no filtering at all and `extractText()` falls
   through to a plain UTF-8 read for unknown extensions — so handing it our own
   list is enough. See `walk.ts`.

2. **We import its submodules by file path through jiti.** Its `package.json`
   declares `"exports": { ".": "./index.ts" }`, which seals every other subpath,
   and its entry point imports `@mariozechner/*` + `@sinclair/typebox` — package
   names that do not exist in this image. Its *submodules*, though, only need
   node builtins plus `better-sqlite3`, `sqlite-vec` and `ignore`. Node refuses
   to strip types under `node_modules`, so we load them via `jiti` (the same
   loader pi uses for extensions). See `upstream.ts`.

Both assumptions are covered by `selftest.mjs` and fail loudly if upstream
reorganises.

`PI_RAG_DIR` is honoured by upstream as an explicit override, which is how the
store lands in `.pirag/` instead of its default `.pi/rag/`.

## Image size

The dependency tree installs at ~511 MB and is pruned to ~329 MB by
`scripts/install-rag-model.sh`, which also bakes the 23 MB model so a cold
container never touches the network.

Two things that look prunable but **are not** — deleting either breaks the
embedder at import time, because `@xenova/transformers` v2 imports both
unconditionally even for a text-only pipeline on node:

- `onnxruntime-web` (`backends/onnx.js`)
- `sharp` (`utils/image.js`)

## Auto-injection is off

Upstream can inject retrieved chunks before every turn. `pa-rag` does not use
that: it costs 1–3k tokens on *every* request whether or not the turn concerns
the repo. The model calls `rag_search` when it decides it needs it.

## Troubleshooting

`/rag-status` shows store path, file/chunk/vector counts, model, last build and
measured throughput.

- **`rag_search` says nothing is indexed** — the project was over the gate, or
  indexing is still running. Run `/rag-index`.
- **Want a full re-embed** — `/rag-index --force`.
- **Node version** — `better-sqlite3` is native and ships prebuilds for
  `linux-x64` and `linux-arm64`. It is loaded under the fixed system Node at
  `/usr/bin/node`; switching the active node with `mise` does not affect it,
  but do not run pi itself on a different node.

## Verifying

```bash
cd /opt/pa/extensions/pa-rag && node selftest.mjs      # full, runs real ONNX
PA_RAG_SKIP_EMBED=1 node selftest.mjs                  # structural only
```

The smoke test runs the structural form: real inference is far too slow under
QEMU emulation on the arm64 CI build, and the walker/loader checks are what
actually regress.
// canary-marker-zulu-7
