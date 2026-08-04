#!/usr/bin/env bash
set -euo pipefail

CLOAKING="$1/src/upstream/cloaking.ts"
[ -f "$CLOAKING" ] || { echo "cloaking.ts not found" >&2; exit 1; }

python3 - "$CLOAKING" <<'PYEOF'
import sys, re

path = sys.argv[1]
src = open(path).read()

old = "  // Reassemble: billing header (pos 0), prefix (pos 1), then the rest\n  body.system = [billingBlock, prefixBlock, ...remaining];"
new = """  body.system = [billingBlock, prefixBlock];

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
  }"""

if old in src:
    src = src.replace(old, new)
elif re.search(r'  // Reassemble:.*?\n  body\.system = \[billingBlock, prefixBlock, \.\.\.remaining\];', src, re.DOTALL):
    src = re.sub(r'  // Reassemble:.*?\n  body\.system = \[billingBlock, prefixBlock, \.\.\.remaining\];', new, src, count=1, flags=re.DOTALL)
else:
    print("target line not found", file=sys.stderr)
    sys.exit(1)

open(path, "w").write(src)
print("patched cloaking.ts")
PYEOF
