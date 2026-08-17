#!/usr/bin/env bash
set -euo pipefail

# Two patches to auth2api's TypeScript source, applied before `npm run build`:
#
#   1. cloaking.ts -- relocate third-party system prompts into the first user
#      message. Without this, Anthropic rejects OAuth requests with a 400
#      ("Third-party apps now draw from your extra usage").
#   2. accounts/manager.ts -- survive a refresh token that another pa container
#      rotated away. See the comments in the second patch block.
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

# ---------------------------------------------------------------------------
# accounts/manager.ts
#
# THE BUG (observed): after a few hours, pi starts failing every request with
#   503 {"error":{"message":"Configured account requires re-authentication"}}
# and restarting pa fixes it instantly, without logging in again.
#
# WHY: ~/.pi/agent/auth2api is a HOST mount (crun.d/pa), shared by every pa
# container, but each container runs its OWN auth2api with its own in-memory
# copy of the token and its own 60s refresh timer. Anthropic rotates the
# refresh token on every use and invalidates the previous one, so as soon as
# one container refreshes, every other container is holding a dead refresh
# token. Their next refresh gets 400 invalid_grant, which auth2api treats as an
# account-level "auth" failure -> cooldown. With one account, an account in
# cooldown means getNextAccount() returns nothing at all, which is exactly the
# 503 above. The 60s timer then retries the same dead token and re-arms the
# cooldown forever -- hence "only a restart fixes it", because a restart loads
# the winner's freshly rotated token from the shared dir.
#
# THE FIX, two independent halves:
#   1. refreshAll() reconciles from disk first. reload() already exists and
#      already adopts a rotated token + clears the failure state; calling it
#      means a container picks up the winner's token instead of refreshing a
#      dead one, and then has nothing to refresh.
#   2. A failed refresh no longer cools down an account whose ACCESS token is
#      still valid. Those are different things: the access token works for
#      hours after the refresh token rotates away, and refusing to serve with
#      it was what turned a background bookkeeping failure into a dead session.
#
# Not done: a cross-container refresh lock. With (1) both instances have to
# fire their 60s timers within the same ~1s window to collide at all, and with
# (2) the loser now costs one log line instead of the session.

MANAGER="$1/src/accounts/manager.ts"
[ -f "$MANAGER" ] || { echo "accounts/manager.ts not found" >&2; exit 1; }

node - "$MANAGER" <<'PATCH'
const fs = require("fs");

const path = process.argv[2];
let src = fs.readFileSync(path, "utf8");

// Single-quoted lines joined with \n: the TypeScript being matched and emitted
// is full of backticks and ${...}, which a JS template literal here would try
// to interpolate.
const L = (...lines) => lines.join("\n");

function patch(label, needle, replacement, loose) {
  if (src.includes(needle)) {
    src = src.replace(needle, () => replacement);
  } else if (loose && loose.test(src)) {
    src = src.replace(loose, () => replacement);
  } else {
    console.error(`manager.ts: could not find target for "${label}"`);
    process.exit(1);
  }
}

// 1. Reconcile with the shared auth dir before deciding to refresh.
patch(
  "refreshAll reload",
  L(
    '    this.refreshing = true;',
    '    try {',
    '      const now = Date.now();',
  ),
  L(
    '    this.refreshing = true;',
    '    try {',
    '      // pa: the auth dir is a host mount shared by every concurrent pa',
    '      // container, each running its own auth2api with its own copy of the',
    '      // token. Anthropic rotates the refresh token on every use, so the',
    '      // second instance to refresh presents an already-consumed token and',
    '      // gets 400 invalid_grant. Re-read disk first: reload() adopts the',
    '      // token another instance just rotated (and clears the failure state',
    '      // that instance left behind), after which shouldRefresh() sees the',
    '      // fresh expiry and this cycle correctly does nothing.',
    '      await this.reload();',
    '      const now = Date.now();',
  ),
  /this\.refreshing = true;\s*\n\s*try \{\s*\n\s*const now = Date\.now\(\);/,
);

// 2. A refresh failure must not take the account out of service while its
//    access token is still good.
patch(
  "refresh failure cooldown",
  L(
    '      } else {',
    '        this.recordFailure(acct.token.email, "auth", err.message);',
    '        console.error(',
    '          `[${this.provider}] token refresh failed for ${acct.token.email}: ${err.message}`,',
    '        );',
    '      }',
  ),
  L(
    '      } else {',
    '        // pa: a failed REFRESH does not mean the account cannot serve',
    '        // requests. Cooling it down here made getNextAccount() return no',
    '        // account at all, so every request 503\'d with "Configured account',
    '        // requires re-authentication" while a perfectly good access token',
    '        // sat unused -- and the 60s refresh cycle re-armed the cooldown',
    '        // forever, so only a restart cleared it. Cool down only once the',
    '        // access token itself has expired.',
    '        const accessTokenValid =',
    '          new Date(acct.token.expiresAt).getTime() > Date.now();',
    '        if (accessTokenValid) {',
    '          // Recorded, but no failureCount bump: the backoff ladder is for',
    '          // accounts that cannot serve, and this one still can.',
    '          acct.totalFailures++;',
    '          acct.lastFailureAt = new Date().toISOString();',
    '          acct.lastError = `auth (refresh only, access token still valid): ${err.message}`;',
    '        } else {',
    '          this.recordFailure(acct.token.email, "auth", err.message);',
    '        }',
    '        console.error(',
    '          `[${this.provider}] token refresh failed for ${acct.token.email}: ${err.message}`,',
    '        );',
    '      }',
  ),
);

// 3. reload() now runs every 60s, so only log it when something changed --
//    otherwise it appends 1440 no-op lines a day to a log file that is shared
//    by every container and never rotated.
patch(
  "reload log noise",
  L(
    '    console.log(',
    '      `[${this.provider}] reload: +${stats.added.length} added, ${stats.updated.length} updated, ${stats.unchanged.length} unchanged`,',
    '    );',
  ),
  L(
    '    if (stats.added.length > 0 || stats.updated.length > 0) {',
    '      console.log(',
    '        `[${this.provider}] reload: +${stats.added.length} added, ${stats.updated.length} updated, ${stats.unchanged.length} unchanged`,',
    '      );',
    '    }',
  ),
);

fs.writeFileSync(path, src);
console.log("patched accounts/manager.ts");
PATCH
