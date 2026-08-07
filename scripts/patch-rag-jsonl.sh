#!/usr/bin/env bash
set -euo pipefail

# Let pa-rag control how `.jsonl` files are turned into text.
#
# THE PROBLEM
#   A pi session transcript is one JSON object per line, and a single line can
#   hold an entire assistant turn: thinking blocks, several text blocks, tool
#   calls and their results. Upstream's chunker is line-based, so one line
#   becomes one chunk -- a wall of JSON syntax, escaped newlines and tool
#   plumbing. Embedding that yields a vector that means nothing in particular.
#
#   Measured on a large real codebase: a transcript chunk scored 1.000 for the
#   exact identifier `partial_capture_amount_cents` and outranked every genuine
#   hit, while actually containing an unrelated credit-card regex dump.
#
#   Sessions are now excluded by default (see walk.ts SESSION_DIRS). But when a
#   user opts back in with PA_RAG_INDEX_SESSIONS=1, indexing raw JSON lines would
#   reproduce exactly the same noise -- so the opt-in has to index PROSE.
#
# THE FIX
#   extractText() gains a `.jsonl`/`.ndjson` branch that delegates to a hook on
#   globalThis, which pa-rag installs at load time (see upstream.ts). The parser
#   itself lives in pa-rag's walk.ts as extractSessionText().
#
#   Delegating rather than inlining the parser keeps ONE implementation, in our
#   own source, unit-tested by selftest.mjs. Inlining it here would mean the real
#   logic lived inside a bash heredoc patching a dependency -- unreviewable and
#   untestable. If the hook is absent the branch falls through to upstream's
#   normal UTF-8 read, so the patch is inert on its own.
#
#   Same `node - "$FILE" <<'PATCH'` idiom as install-pi.sh and patch-auth2api.sh.

CHUNKING="${1:-/opt/pa/extensions/pa-rag/node_modules/pi-local-rag/chunking.ts}"
[ -f "$CHUNKING" ] || { echo "pi-local-rag chunking.ts not found at $CHUNKING" >&2; exit 1; }

node - "$CHUNKING" <<'PATCH'
const fs = require("fs");

const path = process.argv[2];
let src = fs.readFileSync(path, "utf8");

if (src.includes("__paRagExtractJsonl")) {
  console.log("pa-rag: chunking.ts already patched; nothing to do");
  process.exit(0);
}

// Anchor on the final fallback read at the end of extractText.
const ANCHOR = `  const text = readFileSync(fp, "utf-8");
  return { text, hash: sha256(text), size: text.length };
}`;

if (!src.includes(ANCHOR)) {
  console.error(
    "pa-rag: could not find extractText's fallback read in chunking.ts. " +
      "Upstream changed its extraction path; patch-rag-jsonl.sh needs updating.",
  );
  process.exit(1);
}

const REPLACEMENT = `  if (ext === ".jsonl" || ext === ".ndjson") {
    const raw = readFileSync(fp, "utf-8");
    // Installed by pa-rag (see upstream.ts). Absent in a plain pi-local-rag
    // install, in which case fall through to the normal read below.
    const hook = (globalThis as any).__paRagExtractJsonl;
    if (typeof hook === "function") {
      const parsed = hook(raw);
      if (typeof parsed === "string") {
        // Hash the RAW bytes, not the parsed text: incremental refresh must
        // notice any change to the file, including in parts we discard.
        return { text: parsed, hash: sha256(raw), size: raw.length };
      }
    }
    return { text: raw, hash: sha256(raw), size: raw.length };
  }
${ANCHOR}`;

src = src.replace(ANCHOR, REPLACEMENT);
fs.writeFileSync(path, src);
console.log("pa-rag: patched chunking.ts (.jsonl extraction delegates to __paRagExtractJsonl)");
PATCH
