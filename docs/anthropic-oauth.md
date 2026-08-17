# Anthropic OAuth (pa-anthropic-oauth)

Routes Claude requests through a local proxy that presents them as a
first-party client, so a Claude Pro/Max subscription can be used from pi.

## Architecture

```
pi ──► auth2api (:8317) ──► api.anthropic.com
         │
         ├─ reads OAuth tokens from ~/.pi/agent/auth2api/
         ├─ injects billing headers, beta flags, SDK fingerprint
         ├─ relocates third-party system prompts into the first user
         │  message (patched at build time — see scripts/patch-auth2api.sh)
         └─ tolerates a refresh token rotated by another container
            (same patch — see "Concurrent containers" below)
```

The extension itself is thin: it owns the OAuth PKCE flow and writes token
files. auth2api owns request cloaking and forwarding. The two communicate
only through the filesystem (`~/.pi/agent/auth2api/`) and the local HTTP
port — the extension never spawns auth2api directly (doing so from inside
pi's process tree corrupts the raw-mode TUI).

auth2api is launched by `scripts/start-auth2api.sh`, which the entrypoint
starts in a detached session (`setsid` + `/dev/null`). The watcher polls
for `claude-*.json` token files, writes `config.yaml`, then `exec`s
auth2api.

## Files

| Path | Role |
|------|------|
| `pa-extensions/pa-anthropic-oauth/index.ts` | OAuth flow, model catalog, usage status bar |
| `scripts/start-auth2api.sh` | Watcher: waits for tokens, launches auth2api |
| `scripts/patch-auth2api.sh` | Build-time patches: cloaking + shared-token refresh |
| `Dockerfile` | Clones + patches + builds auth2api, bakes watcher |

## Setup

The `pa` launcher must bind-mount the token directory so credentials
persist across container restarts:

```bash
mkdir -p "$PI_HOME/agent/auth2api"
mounts+=(-v "$PI_HOME/agent/auth2api:/home/agent/.pi/agent/auth2api")
```

First login:

```
/login anthropic-oauth
  → choose "Manual"
  → open the URL in a host browser
  → paste the authorization code shown on console.anthropic.com
/model anthropic-oauth/claude-opus-5
```

After that, `pa` starts auth2api automatically on every boot.

## Concurrent containers (one token, many refreshers)

`~/.pi/agent/auth2api` is a **host mount shared by every running pa
container**, but each container runs its **own** auth2api, with its own
in-memory copy of the token and its own 60s refresh timer. Anthropic
rotates the refresh token on every use and invalidates the previous one,
so the moment one container refreshes, every other container is holding a
dead refresh token.

Unpatched, that produced this failure — reported as "it works for a while,
then every request fails, and restarting `pa` fixes it without logging in
again":

```
Error: 503 {"error":{"message":"Configured account requires re-authentication"}}
```

The chain: refresh gets `400 invalid_grant` → auth2api records an
account-level `auth` failure → cooldown → with a single account, "in
cooldown" means `getNextAccount()` returns nothing → that 503. The 60s
timer then retries the same dead token and re-arms the cooldown (10 min,
doubling to a 60 min cap), so it never recovers on its own. A restart
fixes it because a fresh process loads the winner's rotated token from the
shared dir. Signature in `~/.pi/agent/auth2api/auth2api.log`:

```
[anthropic] account <email> cooled down for 3600s (auth)
[anthropic] token refresh failed for <email>: Token refresh failed (400):
  {"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}
```

`scripts/patch-auth2api.sh` fixes this in `accounts/manager.ts`, in two
independent halves:

1. **`refreshAll()` reconciles from disk first.** `reload()` already adopts
   a token rotated by someone else and clears the failure state; calling
   it means a container picks up the winner's token rather than refreshing
   a dead one — and then has nothing to refresh.
2. **A failed refresh no longer cools down an account whose _access_ token
   is still valid.** Those are different things: the access token keeps
   working for hours after the refresh token rotates away. Serving with it
   is correct, and it is what turns the remaining race (both timers firing
   within the same second) from a dead session into one log line. Once the
   access token really has expired, the old cooldown behaviour applies, so
   a genuinely revoked credential still surfaces as re-auth-required.

Not done: a cross-container refresh lock. With (1) the collision window is
~1s per 4h rotation, and with (2) the loser costs nothing.

## Usage status bar

Polls `api.anthropic.com/api/oauth/usage` (harshly rate-limited — cached
for 5 min) and renders two progress bars in the status slot:

```
5h ████████████░░ 27%(3h30m) | 7d ████████████████ 3%
```

Full blocks = remaining capacity; dotted = used. Adapts to terminal width
via `process.stdout.columns`. Only shown while the `anthropic-oauth`
provider is active.

## Logs

All extension output goes to `~/.pi/agent/auth2api/extension.log` — never
to stderr/stdout, which would corrupt pi's TUI.

## Config

| Env var | Default | Purpose |
|---------|---------|---------|
| `AUTH2API_URL` | `http://127.0.0.1:8317` | Proxy endpoint |
| `AUTH2API_KEY` | `pa-anthropic-oauth-local` | Key pi sends to auth2api |

## Updating auth2api

The Dockerfile clones from GitHub at build time. To pick up upstream
cloaking fixes, rebuild the image (`--no-cache` if the clone layer is
cached). The patch script is idempotent and tolerates upstream changes to
the target line.
