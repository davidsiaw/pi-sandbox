#!/usr/bin/env bash
set -euo pipefail

# Patch pi-local-rag's embedding batch size so indexing cannot OOM-kill the
# container.
#
# THE BUG
#   Upstream hardcodes `BATCH_SIZE = 64` in embed.ts and calls the embedder with
#   no truncation. all-MiniLM-L6-v2 is a 512-token model, but real source chunks
#   reach ~830 tokens, and transformer attention is O(n^2) in sequence length.
#   A single 64-text batch of ~3300-char chunks peaks at ~2.2 GB RSS (measured).
#   Docker Desktop's default VM is ~3.8 GB, so that one allocation plus the
#   model, pi itself and the pending chunk set exceeds the cgroup limit and the
#   kernel SIGKILLs node (exit 137). Symptom: the index DB is created with its
#   schema but zero chunks, the container "falls out", and because pi's TUI had
#   the terminal in raw mode and never got to restore it, every subsequent
#   keypress emits garbage.
#
#   Measured peak RSS for one batch of ~3300-char chunks:
#     batch=4 -> 347 MB   batch=8  -> 451 MB
#     batch=16 -> 701 MB  batch=32 -> 1204 MB   batch=64 -> 2167 MB
#
# THE FIX
#   Drop the default batch to 8 (~451 MB peak, comfortable inside a 3.8 GB VM)
#   and add truncation at the model's real 512-token limit. Truncation alone does
#   NOT fix the memory (measured: same peak) because Transformers.js pads to the
#   longest sequence in the batch either way -- the batch size is the real knob --
#   but it keeps sequences inside the model's trained range, so embeddings past
#   512 tokens stop being garbage.
#
#   PA_RAG_BATCH_SIZE overrides it at runtime for hosts with more memory.
#
#   The size is resolved PER CALL rather than once at module load, so pa-rag can
#   lower it for unattended background passes and raise it for an explicit
#   /rag-index the user is waiting on. Measured peak RSS / throughput:
#     batch=1 253MB 14.4/s   batch=2 282MB 13.4/s   batch=4 410MB 16.9/s
#     batch=8 729MB 18.3/s   batch=16 1284MB 19.7/s
#   Thread count is NOT a usable knob: Transformers.js v2 hardcodes its ORT
#   session options, so intraOpNumThreads has no measurable effect (verified
#   1/2/4 threads all land at ~15 chunks/s). Batch size and scheduling are the
#   only levers.
#
# WHY PATCH INSTEAD OF FORK
#   pa-rag deliberately runs pi-local-rag's real code (see upstream.ts). Forking
#   embed.ts would mean owning the embedder forever. A build-time patch keeps the
#   dependency intact and fails loudly here if upstream's shape changes. Same
#   idiom as install-pi.sh and patch-auth2api.sh: `node - "$FILE" <<'PATCH'`.

EMBED="${1:-/opt/pa/extensions/pa-rag/node_modules/pi-local-rag/embed.ts}"
[ -f "$EMBED" ] || { echo "pi-local-rag embed.ts not found at $EMBED" >&2; exit 1; }

node - "$EMBED" <<'PATCH'
const fs = require("fs");

const path = process.argv[2];
let src = fs.readFileSync(path, "utf8");

const BATCH_DECL = "export const BATCH_SIZE = 64;";
if (!src.includes(BATCH_DECL)) {
  if (/PA_RAG_BATCH_SIZE/.test(src)) {
    console.log("pa-rag: embed.ts already patched; nothing to do");
    process.exit(0);
  }
  console.error(
    "pa-rag: could not find `" + BATCH_DECL + "` in embed.ts. " +
      "Upstream changed its batching; patch-rag-batch.sh needs updating.",
  );
  process.exit(1);
}

// Memory-safe default, overridable per host AND per call. resolveBatchSize() is
// read inside embedBatch so pa-rag can switch between a low-memory background
// batch and a faster foreground one without reloading the module.
src = src.replace(
  BATCH_DECL,
  [
    "export function resolveBatchSize() {",
    "  const raw = Number(process.env.PA_RAG_BATCH_SIZE);",
    "  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8;",
    "}",
    "export const BATCH_SIZE = resolveBatchSize();",
  ].join("\n"),
);

// Make the loop use the per-call value rather than the module-load constant.
const LOOP = [
  "  for (let start = 0; start < texts.length; start += BATCH_SIZE) {",
  "    const batch = texts.slice(start, start + BATCH_SIZE);",
].join("\n");
const LOOP_PATCHED = [
  "  const _paBatchSize = resolveBatchSize();",
  "  for (let start = 0; start < texts.length; start += _paBatchSize) {",
  "    const batch = texts.slice(start, start + _paBatchSize);",
].join("\n");
if (src.includes(LOOP)) {
  src = src.replace(LOOP, LOOP_PATCHED);
} else {
  console.error("pa-rag: could not find embedBatch's batching loop in embed.ts");
  process.exit(1);
}

// Keep sequences inside the model's trained 512-token window. Without this,
// ~830-token chunks are embedded outside the range the model was trained on.
const CALL = 'const output = await embedder(batch, { pooling: "mean", normalize: true });';
const CALL_PATCHED =
  'const output = await embedder(batch, { pooling: "mean", normalize: true, truncation: true, max_length: 512 });';
if (src.includes(CALL)) {
  src = src.replace(CALL, CALL_PATCHED);
} else {
  console.error("pa-rag: could not find the batched embedder call in embed.ts");
  process.exit(1);
}

fs.writeFileSync(path, src);
console.log(
  "pa-rag: patched embed.ts (per-call batch size via PA_RAG_BATCH_SIZE, default 8, truncation at 512)",
);
PATCH
