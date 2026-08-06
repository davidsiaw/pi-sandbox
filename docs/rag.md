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

Guidance baked into the tool's `promptGuidelines` tells the model to reach for
`rag_search` first when orienting in an unfamiliar repo, and to prefer `grep`/`rg`
for exact identifiers and `read` for whole files.

The orientation guideline exists because the needle-hunting framing alone was not
enough: asked an open question like *"what is in this repo"*, models defaulted to
`ls` and `grep` and never queried the index, even though a single semantic query
returns the README, the architecture docs and the directory map together.

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

## Sliced, incremental indexing

Upstream's `indexFiles()` accumulates **everything** in memory and commits in a
single transaction at the very end: `toIndex` holds every chunk's text and
`fw._vectors` every vector, and nothing is released until `tx()` runs. Peak
memory is therefore **O(repo), not O(batch)** — so a large repo OOM-kills the
container no matter how small the embedding batch is.

So pa-rag **never hands upstream the whole file list**. It slices the walk result
into ~512 KB groups and calls `indexFiles()` once per slice. Each call returns,
commits, and frees. Measured on a 432-file / 2.2 MB tree:

| | single call | sliced |
|---|---|---|
| peak RSS | climbs without bound | **flat at ~808 MB** |
| chunks indexed | 1308 | 1308 |
| wall time | 58.9 s | 61.9 s (+5%) |

Slicing buys three things beyond the memory bound:

- **Checkpoints.** Every slice is committed, so an interrupted pass keeps its
  progress instead of losing all of it.
- **Free resume.** Upstream skips unchanged files by content hash, so the next
  run continues exactly where the last one stopped. Verified: re-running all
  slices of an indexed tree re-embeds **0** chunks and skips all 432 files.
- **A stop point.** `session_shutdown` sets an abort flag that the slice loop
  checks, so a long background pass stops at the next boundary rather than
  embedding into a dead session.

`SLICE_BYTES` (512 KB) is both the memory bound and the checkpoint granularity.
Raising it trades memory for slightly less overhead.

## Background vs foreground: the resource tradeoff

Batch size is the only real memory/speed lever. Measured peak RSS embedding
64 real-sized (~3300-char) chunks:

| batch | peak RSS | throughput |
|---|---|---|
| 1 | 253 MB | 14.4 chunks/s |
| **2 (background)** | **~314 MB** | 13.4 chunks/s |
| 4 | 410 MB | 16.9 chunks/s |
| **8 (foreground)** | **~800 MB** | 18.3 chunks/s |
| 16 | 1284 MB | 19.7 chunks/s |
| 64 (upstream default) | 2167 MB | OOM-kills |

So an unattended background pass runs at **batch 2** — 2.5× less memory for ~24%
less throughput — while an explicit `/rag-index` the user is waiting on uses
**batch 8**. `scripts/patch-rag-batch.sh` makes upstream resolve the size **per
call** (not once at import), which is what allows the two modes to coexist.

Background passes are also **duty-cycled**: after each slice the pass sleeps in
proportion to how long that slice took (50% duty → at most ~half a core over
time, instead of pegging one for hours). It self-tunes, so slower machines back
off further. A slice that hash-skipped everything took ~0 ms and therefore rests
~0 ms, so catch-up passes over an already-indexed tree stay fast.

Throughput is deliberately **not** recorded from a throttled background pass: its
elapsed time is mostly intentional sleeping, and storing that as `chunks/sec`
would poison every future ETA. Only foreground passes calibrate.

**Thread count is not a lever.** Transformers.js v2 hardcodes its ORT session
options, so `intraOpNumThreads` has no measurable effect (1/2/4 threads all land
at ~15 chunks/s). Batch size and scheduling are all there is.

## Progress visibility

A pass can run for hours, so it reports live progress in the **footer status line**
(`ctx.ui.setStatus`) rather than as notifications:

```
pa-rag ████░░░░░░░░ 33% · 256/~390 chunks · ~13s left
```

Why a status line and not notifications: `setStatus` is a single keyed entry that
updates **in place** and can be cleared. Notifications are permanent transcript
entries — one per update would bury the conversation, and one per quartile tells
you nothing for 15 minutes at a time. So the footer carries the fine-grained view
and the transcript keeps only durable breadcrumbs (start, quartiles on a large
repo, final summary) for a pass that outlives its scrollback.

Details that matter:

- **Updates within a slice**, not just at slice boundaries. Upstream's
  `onEmbed(done, total)` fires per micro-batch (every 2 chunks in background
  mode), so the bar moves smoothly instead of jumping every 512 KB. Its `total`
  is per-slice, so pa-rag tracks the cumulative count itself.
- **Throttled to 400 ms**, because `onEmbed` fires far faster than a terminal
  should repaint — but the **first** write always lands, so a fast pass shows a
  real starting frame rather than flashing straight to 100%.
- **The denominator self-corrects.** Total chunks is estimated from
  `BYTES_PER_CHUNK`, which is only a guess (measured **1854** bytes/chunk on a
  docs tree vs **3324** on this repo — nearly 2× apart, since upstream breaks
  chunks on blank lines). Once real chunks exceed the estimate the denominator
  grows, so it never renders `102/~88 chunks` at 100% and then keeps counting.
  Both of those were real bugs caught while building this, and `selftest.mjs`
  now pins the behaviour.
- **Guarded by `ctx.hasUI`**, so print (`-p`) and JSON runs stay clean.
  `hasUI` rather than `mode === "tui"` because `setStatus` is a safe
  fire-and-forget in RPC mode too.
- **Cleared on `session_shutdown`** and ~8 s after finishing, so a resumed or
  replaced session never inherits a frozen bar for work that stopped.

If the footer has already cleared, `/rag-status` still shows `indexing: in
progress`, how many files are queued for refresh, and the last pass's summary.

## The size gate

Measured throughput is **~28 chunks/sec** foreground at ~2 KB per chunk, so
roughly **1 minute per MB** of source — and about double that for a 50%-throttled
background pass:

| indexable size | chunks | foreground | background (throttled) |
|---|---|---|---|
| 0.4 MB (this repo) | 260 | ~15 s | ~30 s |
| 2.2 MB | 1,308 | ~1 min | ~2 min |
| 10 MB | ~5,900 | ~3.5 min | ~7 min |
| 100 MB | ~59,000 | ~35 min | ~70 min |
| 1 GB | ~590,000 | ~6 h | ~12 h |

The startup path **probes first** and auto-indexes in the background up to
**1 GB**. That budget is deliberately huge: *fully automatic indexing is the
point*, and never having to remember `/rag-index` is worth more than the CPU it
saves. It is only safe to be this generous because the pass is memory-bounded,
throttled, checkpointed and resumable — so a long one is merely slow, and killing
it costs nothing. Above the cap the project is almost certainly not source (a data
dump, a mounted volume), where silently grinding for days would be wrong, so it
prints an estimate and waits for `/rag-index`.

`PROBE_CAP_BYTES` (2 GB) must stay **at or above** the auto-index budget, or the
probe would bail before it could tell whether a project fits and everything
between the two limits would wrongly land in the "ask first" path. `smoketest.sh`
asserts the ordering.

Earlier versions capped this at 10 MB, then 100 MB, on the theory that a long
background pass was inherently rude. The real problems were unbounded memory and
losing all progress on interruption — both fixed — so the cap could go up.

The probe costs 1–2 ms even on huge trees, because it **bails early** as soon as
it crosses the cap. Measured throughput is written to
`.pirag/throughput.json` after a substantial run, so later estimates reflect the
machine actually in use rather than the figures above.

## The memory cap (why embed.ts is patched)

Upstream hardcodes `BATCH_SIZE = 64` in `embed.ts` and calls the embedder with
no truncation. `all-MiniLM-L6-v2` is a **512-token** model, but real source
chunks reach ~830 tokens, and transformer attention is O(n²) in sequence length.
Measured peak RSS for a single batch of ~3300-char chunks:

| batch | peak RSS |
|---|---|
| 4 | 347 MB |
| 8 | 451 MB |
| 16 | 701 MB |
| 32 | 1204 MB |
| **64 (upstream default)** | **2167 MB** |

Docker Desktop's VM is ~3.8 GB. At batch 64 that one allocation, plus the model,
pi itself and the pending chunk set, exceeds the cgroup limit and the kernel
**SIGKILLs node (exit 137)**. The symptom was ugly and hard to read: the index
DB got its schema but **zero chunks**, the container "fell out", and because pi's
TUI had the terminal in raw mode and never got to restore it, every later
keypress emitted garbage. (Recover a stranded terminal with `stty sane`.)

`scripts/patch-rag-batch.sh` patches upstream at build time to default the batch
to **8** and truncate at 512 tokens. Truncation alone does **not** fix the
memory — Transformers.js pads to the longest sequence in the batch either way,
so batch size is the real knob — but it keeps sequences inside the window the
model was actually trained on, so chunks past 512 tokens stop producing garbage
embeddings.

Override per host with **`PA_RAG_BATCH_SIZE`** (forward it via `~/.pi/agent/pa.env`)
if you have more memory and want the throughput back.

A full index of this repo after the patch: 72 files, 260 chunks, **15.3 s, peak
765 MB**.

The patch is a build-time patch rather than a fork for the same reason as the
rest of `upstream.ts`: pa-rag runs pi-local-rag's real code. `smoketest.sh`
asserts the patch is present, that `BATCH_SIZE` *resolves* to 8, and — the check
whose absence let this ship — that embedding 64 realistically-sized chunks
actually survives. The pa-rag selftest runs with `PA_RAG_SKIP_EMBED=1` in CI and
its fixtures are tiny, so neither exercised a real batch.

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

### What a turn actually costs

It does **not** re-scan or re-index the project every turn. The only work queued
is the exact set of paths the agent wrote, so a turn that edits nothing does
literally nothing — the indexer is never called. Measured on a 34-file tree:

| turn | cost |
|---|---|
| nothing changed | **18 ms** (all files hash-skipped) |
| 1 file edited | **27 ms** |
| 10 files edited | **175 ms** |

There is no "catch-up" pass to pay for, because the dirty set is precisely what
changed. The 18 ms figure is the worst case for an idle turn and only applies if
something forces a full re-walk.

While a **background pass** is still running, `flushDirty` sees `indexing` set and
re-queues rather than competing for CPU; the queued files flush in one batch once
the pass finishes. So the initial index and mid-session refresh never overlap.

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
[`pi-local-rag`](https://github.com/vahidkowsari/pi-local-rag). `pa-rag` adds a
walker, the slicing/scheduling layer, a size gate and a tool.

Upstream's source is used as-is at runtime with one build-time patch:
`scripts/patch-rag-batch.sh` caps the embedding batch and adds truncation (see
[the memory cap](#the-memory-cap-why-embedts-is-patched)). Everything else —
including the O(repo) memory behaviour of `indexFiles()` — is worked around from
*outside* by slicing rather than by editing upstream, so the dependency stays
replaceable.

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
