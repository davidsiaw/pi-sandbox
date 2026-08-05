# Anthropic OAuth (pa-anthropic-oauth)

Routes Claude requests through a local proxy that presents them as a
first-party client, so a Claude Pro/Max subscription can be used from pi.

## Architecture

```
pi ──► auth2api (:8317) ──► api.anthropic.com
         │
         ├─ reads OAuth tokens from ~/.pi/agent/auth2api/
         ├─ injects billing headers, beta flags, SDK fingerprint
         └─ relocates third-party system prompts into the first user
            message (patched at build time — see scripts/patch-auth2api.sh)
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
| `scripts/patch-auth2api.sh` | Build-time patch to auth2api's cloaking |
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
