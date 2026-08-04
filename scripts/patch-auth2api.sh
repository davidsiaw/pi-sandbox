#!/usr/bin/env bash
set -euo pipefail

# Patch auth2api's cloaking.ts to relocate third-party system prompts into the
# first user message. Without this, Anthropic rejects OAuth requests with a 400
# ("Third-party apps now draw from your extra usage").
#
# Written with node, not python3. Nothing here is python-specific -- it is a
# string replace with a regex fallback -- and the image has no Python of its own:
# `python3` was only ever present as an undeclared transitive dependency of
# NodeSource's `nodejs` package (`apt-cache depends nodejs` -> `Depends: python3`,
# marked auto). Relying on that made the build hostage to a packaging decision
# nobody here controls, in an image whose whole premise is "no language runtimes
# unless mise installs them". Node is guaranteed present at this build step.
#
# Uses the same `node - "$FILE" <<'PATCH'` idiom as install-pi.sh, which patches
# pi's dist the same way.

CLOAKING="$1/src/upstream/cloaking.ts"
[ -f "$CLOAKING" ] || { echo "cloaking.ts not found" >&2; exit 1; }

node - "$CLOAKING" <<'PATCH'
const fs = require("fs");

const path = process.argv[2];
const src = fs.readFileSync(path, "utf8");

const old =
  "  // Reassemble: billing header (pos 0), prefix (pos 1), then the rest\n" +
  "  body.system = [billingBlock, prefixBlock, ...remaining];";

// Backslashes are doubled so the GENERATED TypeScript contains the escape
// sequence "\n\n", not a literal newline -- same as the python heredoc did.
const replacement = `  body.system = [billingBlock, prefixBlock];

  if (remaining.length > 0 && Array.isArray(body.messages)) {
    const firstUser = body.messages.find((m: any) => m.role === "user");
    if (firstUser) {
      const movedText = remaining
        .map((e: any) => (typeof e === "string" ? e : (e.text ?? "")))
        .filter((t: string) => t.length > 0)
        .join("\\n\\n");
      if (movedText.length > 0) {
        if (typeof firstUser.content === "string") {
          firstUser.content = movedText + "\\n\\n" + firstUser.content;
        } else if (Array.isArray(firstUser.content)) {
          firstUser.content.unshift({ type: "text", text: movedText });
        }
      }
    }
  }`;

// Fallback for when upstream reworded the comment but kept the statement.
// [\s\S] is JS's DOTALL; the quantifier is lazy so it stops at the first match.
const loose =
  /  \/\/ Reassemble:[\s\S]*?\n  body\.system = \[billingBlock, prefixBlock, \.\.\.remaining\];/;

let out;
if (src.includes(old)) {
  out = src.replace(old, () => replacement);
} else if (loose.test(src)) {
  out = src.replace(loose, () => replacement);
} else {
  console.error("target line not found");
  process.exit(1);
}

fs.writeFileSync(path, out);
console.log("patched cloaking.ts");
PATCH
