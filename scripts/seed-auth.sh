#!/usr/bin/env bash
set -euo pipefail

# Generate a WRITABLE ~/.pi/agent/auth.json in the ephemeral home, instead of
# letting the launcher bind-mount the host's file at that path.
#
# Why: pi WRITES auth.json. Two paths, and only two -- a completed `/login`, and
# an OAuth refresh when a stored credential is within five minutes of expiry
# (pi-ai's auth/resolve.js). Mounted read-only, reads work fine (pi's lock file
# lands in the directory, not the file), so an API-key-only setup looks healthy
# until one of those two fires and dies with:
#
#   Credential store modify failed for anthropic-oauth: EACCES: permission
#   denied, open '/home/agent/.pi/agent/auth.json'
#
# Mounted read-WRITE it works, but then a disposable container can rewrite the
# credentials file on the host it was handed. Neither is good. Seeding sidesteps
# the choice: nothing is mounted at that path, so there is no host file to fail
# on and none to corrupt. Same trick as seed-trust.sh, for the same reason.
#
# Two sources, first wins:
#   PA_AUTH_SEED           - the file's CONTENT in an env var (launcher may
#                            resolve it from a vault; never touches disk on the
#                            host). Consumed here and unset by the entrypoint so
#                            the agent's own environment does not carry it.
#   /opt/pa/auth.host.json - the host's ~/.pi/agent/auth.json, mounted read-only
#                            at a staging path.
#
# ...and a third, which exists purely for BACKWARD COMPATIBILITY: an older
# launcher that still bind-mounts the host auth.json at pi's real path. In that
# case the target already exists and IS the host's file, so it is used as the base
# and only rewritten when this script has something to add (an anthropic-oauth
# entry rebuilt from the token file). Reconstructing from nothing there would
# write straight through the bind mount and DESTROY every other credential in the
# user's real file -- which is exactly what an early version of this script did.
#
# Absent all three, no file is written at all: pi creates `{}` itself when it first
# needs to, and writing an empty file here would only mask a launcher problem.

TARGET="${HOME:-/home/agent}/.pi/agent/auth.json"
HOST=/opt/pa/auth.host.json
AUTH2API_DIR="${HOME:-/home/agent}/.pi/agent/auth2api"

mkdir -p "$(dirname "$TARGET")"

# 0077 so the credential file is never briefly world-readable between creation
# and the explicit chmod below.
umask 077

node -e '
  const fs = require("fs");
  const [target, hostPath, auth2apiDir, seed] = process.argv.slice(1);

  const parse = (text, what) => {
    try {
      const value = JSON.parse(text);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
      console.error(`seed-auth: ignoring ${what}: not a JSON object`);
    } catch (error) {
      console.error(`seed-auth: ignoring ${what}: ${error.message}`);
    }
    return undefined;
  };

  let auth;
  let fromExistingTarget = false;
  if (seed) {
    auth = parse(seed, "PA_AUTH_SEED");
  }
  if (!auth) {
    try {
      auth = parse(fs.readFileSync(hostPath, "utf8"), hostPath);
    } catch {
      // No host file mounted. Not an error: MOUNT_AUTH=0 is a supported mode.
    }
  }
  if (!auth) {
    // Backward compatibility with a launcher that mounts the host file at the real
    // path. Whatever is already there is authoritative, and may be the file the
    // user owns on the far side of a read-write bind mount.
    try {
      auth = parse(fs.readFileSync(target, "utf8"), target);
      if (auth) fromExistingTarget = true;
    } catch {
      // Normal: fresh ephemeral home with nothing in it yet.
    }
  }

  // Rebuild the anthropic-oauth entry from the token file the extension wrote.
  //
  // That entry in auth.json is only a STUB: access/refresh copied out of
  // ~/.pi/agent/auth2api/claude-<email>.json plus an expiry pi is happy with.
  // pi never sends it anywhere -- the provider authenticates to the local
  // auth2api proxy with a static key -- and auth2api owns the real refresh
  // against Anthropic, rewriting that token file on every rotation.
  //
  // The token file lives in a mount that PERSISTS across containers, so
  // regenerating the stub here is what makes a disposable auth.json cost
  // nothing: without it, every container would start logged out of a provider
  // whose credentials are in fact still on disk.
  //
  // Deliberately overwrites any seeded anthropic-oauth entry: a stub carried in
  // from the host may name a token auth2api has already rotated away, while the
  // token file is by definition current.
  //
  // Walks newest-first and takes the first file that parses and carries both
  // tokens, rather than only inspecting the newest. auth2api rewrites these on
  // every rotation, so a crash mid-write can leave the newest one truncated --
  // and falling back to the previous token beats forcing a re-login, since
  // auth2api will refresh whatever it is handed.
  let token;
  try {
    const candidates = fs.readdirSync(auth2apiDir)
      .filter((name) => name.startsWith("claude-") && name.endsWith(".json"))
      .map((name) => {
        const path = `${auth2apiDir}/${name}`;
        return { path, mtime: fs.statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const candidate of candidates) {
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(candidate.path, "utf8"));
      } catch (error) {
        console.error(`seed-auth: ignoring ${candidate.path}: ${error.message}`);
        continue;
      }
      if (parsed?.access_token && parsed?.refresh_token) {
        token = parsed;
        break;
      }
    }
  } catch {
    // No auth2api dir at all -- the normal state before a first login.
  }

  if (token) {
    // Mirror the extension: 12h, so pi "refreshes" twice a day, which is a local
    // file read rather than a network call. Never longer than the token file
    // claims, when it claims something still in the future.
    const stubMs = 12 * 60 * 60 * 1000;
    const claimed = Date.parse(token.expired ?? "");
    const expires = Number.isFinite(claimed) && claimed > Date.now()
      ? Math.min(claimed, Date.now() + stubMs)
      : Date.now() + stubMs;
    const next = {
      type: "oauth",
      access: token.access_token,
      refresh: token.refresh_token,
      expires,
    };
    // When the base came from an existing target, only write if the credential
    // actually changes. Under a legacy read-write mount that write lands on the
    // real file owned by the user, so a no-op rewrite would churn it on every
    // boot for nothing. Expiry alone is not worth a write: pi advances it itself.
    const before = auth?.["anthropic-oauth"];
    const unchanged = fromExistingTarget
      && before?.access === next.access
      && before?.refresh === next.refresh;
    if (unchanged) process.exit(0);
    auth = auth ?? {};
    auth["anthropic-oauth"] = next;
  } else if (fromExistingTarget) {
    // Nothing to add and the file is already in place (possibly the one on the
    // host). Leave it exactly as it is.
    process.exit(0);
  }

  if (!auth) process.exit(0);   // nothing to seed; let pi create its own {}
  fs.writeFileSync(target, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
' "$TARGET" "$HOST" "$AUTH2API_DIR" "${PA_AUTH_SEED:-}"

# Belt and braces: writeFileSync's mode applies only on creation, and this file
# is recreated every boot in a fresh home, so it should always be 0600 already.
[ -f "$TARGET" ] && chmod 0600 "$TARGET" 2>/dev/null || true
