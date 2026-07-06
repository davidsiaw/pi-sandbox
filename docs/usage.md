# Usage

## Running the agent: the `pa` launcher

`pa` (short for **pi-agent**) is a small launcher script that lives in your
crun toolkit at `~/crun.d/pa`. It runs the prebuilt `davidsiaw/pi-sandbox`
image against the current directory. It never builds anything — the image is
built and pushed separately (see [building.md](building.md)).

```bash
cd ~/some/project
pa
```

That starts the pi agent inside the container, with your project directory as
the working directory.

## What gets mounted

| Host path                          | Container path                                   | Mode | Why |
|------------------------------------|--------------------------------------------------|------|-----|
| `$PWD` (current dir)               | same path as on the host                         | rw   | your project — edits are real |
| named volume `pi-sandbox-mise`     | `/home/agent/.local/share/mise`                  | rw   | caches compiled runtimes (see [runtimes.md](runtimes.md)) |
| `~/.pi/agent/skills`               | `/home/agent/.pi/agent/skills`                   | rw   | agent-authored skills persist |
| `~/.pi/agent/extensions`           | `/home/agent/.pi/agent/extensions`               | rw   | agent-authored extensions persist |
| `~/.pi/agent/settings.json`        | `/opt/pa/settings.host.json`                     | ro   | staged, then seeded (see below) |
| `~/.pi/agent/models.json`          | same                                             | ro   | model config |
| `~/.pi/agent/trust.json`           | same                                             | ro   | trust config |
| `~/.pi/agent/auth.json` (optional) | same                                             | ro   | model auth token (see below) |
| `~/.pi/agent/AGENTS.md` (if present) | same                                           | ro   | your global context file |
| `~/.pi/agent/CLAUDE.md` (if present) | same                                           | ro   | your global context file |
| `~/.pi/agent/SYSTEM.md` (if present) | same                                           | ro   | replaces pi's system prompt (opt out: `NO_MOUNT_SYSTEM=1`) |
| `~/.pi/agent/APPEND_SYSTEM.md` (if present) | `/opt/pa/APPEND_SYSTEM.host.md`         | ro   | staged, then merged (see below) |

Note the project is mounted **at its real host path** (e.g.
`/Users/you/proj` → `/Users/you/proj`), matching the convention of the other
crun tools. This keeps absolute paths in output/errors meaningful on the host.

### Sessions

pi's session files are stored in a **`.pi-sessions/`** directory inside the
project, not in the container's ephemeral home. `pa` creates `$PWD/.pi-sessions`
on the host (so it's owned by you) and launches pi with
`--session-dir "$PWD/.pi-sessions"`. Since the project is already mounted at its
real path, sessions persist on the host and survive the container. Add
`.pi-sessions/` to your project's `.gitignore` if you don't want them tracked.

#### Resuming a session

When pi exits it prints a "To resume this session" line. In the sandbox this is
rewritten to use the `pa` launcher instead of a bare `pi` command, so it works
from the host:

```
To resume this session: pa --session <id>
```

Run that from the **same project directory** and it resumes — `pa` re-mounts
the project at its real path and passes `--session-dir "$PWD/.pi-sessions"`, so
the session id resolves to the file on the host. Any extra args you give `pa`
are forwarded straight to `pi`.

How it works: the image sets `PI_RESUME_COMMAND=pa`, and `install-pi.sh` patches
pi's `formatResumeCommand` so that (a) the printed command name comes from
`PI_RESUME_COMMAND`, and (b) the `--session-dir` argument is omitted (the
launcher already supplies it). The patch is idempotent and only affects the
copy of pi baked into the image; your host pi is untouched.

### What is deliberately *not* mounted

- other `~/.pi/` extension state (files an extension keeps outside
  `~/.pi/agent`) — stays on the host, out of the sandbox. Tools that only read
  such files (rather than an env var) won't work in the sandbox unless you add
  a mount for them.
- `~/.pi/agent/sessions`, `bin`, `npm` — the container's own home is ephemeral
  and auto-cleaned. (pi's sessions go to the project's `.pi-sessions/` instead —
  see above — not the container home.)

Env-based secrets (any tool that reads an env var) are *forwarded* rather than
mounted — see [Forwarding secrets / env vars](#forwarding-secrets--env-vars)
below.

## Environment toggles

Set these when invoking `pa`:

| Variable        | Default                          | Effect |
|-----------------|----------------------------------|--------|
| `PA_IMAGE`      | `davidsiaw/pi-sandbox:latest`    | image to run |
| `MOUNT_AUTH`    | `1`                              | `0` = do **not** mount `auth.json`; keeps all credentials out of the sandbox (the agent then needs its own auth inside) |
| `MISE_VOLUME`   | `pi-sandbox-mise`                | name of the runtime cache volume |
| `NO_MOUNT_SYSTEM` | `0`                            | `1` = do **not** mount a host `SYSTEM.md` (which would replace pi's default system prompt) |

Examples:

```bash
# run a specific image tag
PA_IMAGE=davidsiaw/pi-sandbox:dev pa

# run fully offline w.r.t. credentials
MOUNT_AUTH=0 pa

# use a separate throwaway runtime cache
MISE_VOLUME=scratch pa
```

## System prompt & context files

Pi injects always-in-context guidance from fixed files in `~/.pi/agent/`. The
sandbox composes two sources without either clobbering the other:

- **Baked container guidance** — a short block describing this environment
  (mise on demand, cache volume, Chromium `--no-sandbox`, what's ephemeral) is
  built into the image at `/opt/pa/APPEND_SYSTEM.base.md`.
- **Your host files** — if present, `pa` mounts them in:
  - `AGENTS.md` / `CLAUDE.md` → their real slots (context files, always loaded)
  - `SYSTEM.md` → replaces the default prompt (opt out with `NO_MOUNT_SYSTEM=1`)
  - `APPEND_SYSTEM.md` → **not** mounted directly; it is *staged* at
    `/opt/pa/APPEND_SYSTEM.host.md`.

At container start the entrypoint runs `merge-append-system.sh`, which writes
the final `~/.pi/agent/APPEND_SYSTEM.md` as **your host append first, then a
separator, then the baked container guidance**. If you have no host append, the
target is simply the baked guidance. This is regenerated every run, so nothing
accumulates.

Even when a host `SYSTEM.md` *replaces* the base prompt, pi still appends
`APPEND_SYSTEM.md` afterward — so the container guidance lands either way. No
shell interpolation of prompt text is involved; pi loads the files natively.

## Quiet startup (no changelog blob)

pi shows a "What's New" changelog on startup when the `lastChangelogVersion` in
`settings.json` is older than the installed pi version. In a sandbox the host
`settings.json` is read-only, so pi can never persist the new version — it would
replay the changelog on *every* run.

To avoid this, `pa` does **not** mount `settings.json` at its real slot. It
stages the host copy (if any) at `/opt/pa/settings.host.json`, and the container
entrypoint runs `seed-settings.sh`, which writes a **writable**
`~/.pi/agent/settings.json` (in the ephemeral HOME) containing your host
settings plus `lastChangelogVersion` set to the image's pi version. Since that
always matches the installed version, there are no "new" entries and no
changelog. Your host `settings.json` is never modified.

## Forwarding secrets / env vars

Some pi extensions read secrets from environment variables (e.g. an extension
might use `MY_ENV_VAR`). Rather than mounting secret files into the sandbox,
`pa` forwards env vars at launch. Two sources, applied in order:

### 1. `~/.pi/agent/pa.env` — plain values

One `KEY=value` per line (`#` comments and blank lines ignored). Each is passed
as `-e KEY=value`:

```
MY_ENV_VAR=some-value
MY_OTHER_KEY=whatever
```

Simple, but the secret sits in a plaintext file — fine for low-value keys.

### 2. `~/.pi/agent/pa.openv` — live 1Password lookups (preferred for secrets)

Borrowed from the crun `openv` pattern. One line per var:

```
ENVNAME=item:field
ENVNAME=item:field:vault
```

For each line `pa` runs `op item get --reveal <item> --fields label=<field>`
(adding `--vault <vault>` when given) and forwards the result as `-e`. The
secret is pulled **live at launch** and never stored on disk. Requires the
1Password CLI (`op`) to be installed and signed in; lines are skipped with a
warning if resolution fails. Example:

```
MY_ENV_VAR=my-1password-item:credential
MY_OTHER_KEY=another-item:password:Work
```

Both are additive; the openv source overrides `pa.env` for the same var (Docker
keeps the last `-e`). Neither mounts a secret file into the container, and no
secret is baked into the image.

## Baked skills & extensions

The image can ship its own skills and extensions, separate from the ones you
keep on the host. They live in the repo under `pa-skills/` and `pa-extensions/`,
are copied into the image at `/opt/pa/skills` and `/opt/pa/extensions`, and are
loaded additively by `pa`:

- Skills: `pi --skill /opt/pa/skills` (pi discovers every subdirectory
  containing a `SKILL.md`).
- Extensions: one `-e /opt/pa/extensions/<name>` per subdirectory that has an
  `index.ts`.

Each baked resource is a **subdirectory**:

```
pa-skills/<name>/SKILL.md
pa-extensions/<name>/index.ts   (plus any helper files it needs)
```

These are loaded *in addition to* the host skills/extensions mounted from
`~/.pi/agent/` — nothing is shadowed, because the baked copies live at a
different path (`/opt/pa/...`). Give baked skills unique names (the examples use
a `pa-` prefix) so they never collide with a host skill of the same name; on a
collision pi keeps the first found and warns.

Why not bake into `~/.pi/agent/skills` directly? `pa` mounts those paths from
the host read-write, so a baked copy there would be hidden by the mount at
runtime. The `/opt/pa` + CLI-flag approach keeps image and host resources
orthogonal, the same way the baked `APPEND_SYSTEM.base.md` is kept separate.

## Credentials: the `auth.json` trade-off

By default `pa` mounts `~/.pi/agent/auth.json` read-only so the agent can talk
to a model immediately. This shares your model provider token with the
container. For a disposable sandbox this is usually fine (the isolation goal is
about *installs*, not credentials), but if you want the container to have no
access to your host credentials, run with `MOUNT_AUTH=0` and provide the
sandbox its own auth.

## Inside the container

- `pi` is the agent, running on the fixed system Node.
- `mise` manages Ruby/Node/Python — see [runtimes.md](runtimes.md).
- `playwright` / Chromium are available for browsing.
- The current uid has a synthesized identity (`whoami` → `agent`) and a
  writable `HOME` at `/home/agent`.

## Cleaning up

The container is `--rm`, so it's gone the moment the agent exits. To reclaim the
cached runtimes:

```bash
docker volume rm pi-sandbox-mise
```

The next `pa` run recreates the volume and recompiles versions on first use.
