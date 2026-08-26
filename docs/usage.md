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

Every argument goes straight through to pi, with one exception:

```bash
pa update    # pull a newer sandbox image
```

**Launching does not pull.** The image is several gigabytes, and a registry
round-trip before every session buys nothing most of the time — yesterday's
sandbox runs today's project perfectly well. Upgrading is a decision, and
`update` is how you make it. Docker still pulls on the very first run, when there
is no local image to reuse.

This shadows pi's own `update` subcommand on purpose. Inside the sandbox that is
the wrong tool: pi is baked into the image and the container is destroyed on exit,
so `pi update` would spend a download upgrading something that does not outlive
the session. Here, pulling the image *is* updating pi — along with the runtimes,
the skills and the extensions that ship with it.

pi's own `update` becomes unreachable as a `pa` argument — pi rejects a `--`
separator, so there is no pass-through spelling. If you do want it (to refresh
model catalogs, say), have the agent run `pi update --models` in the sandbox. The
result lasts until the container exits, which is the point being made above.

For the same reason, pi's own "Update Available" banner is patched in the image to
say `pa update` rather than `pi update` — following its original advice would
upgrade a container that is about to be thrown away, and the banner would return
on the next launch. See
[scripts.md](scripts.md#scriptspatch-update-commandsh-root).

## What gets mounted

| Host path                          | Container path                                   | Mode | Why |
|------------------------------------|--------------------------------------------------|------|-----|
| `$PWD` (current dir)               | same path as on the host                         | rw   | your project — edits are real |
| named volume `pi-sandbox-mise`     | `/home/agent/.local/share/mise`                  | rw   | caches installed runtimes (see [runtimes.md](runtimes.md)) |
| `~/.pi/agent/skills`               | `/home/agent/.pi/agent/skills`                   | rw   | agent-authored skills persist |
| `~/.pi/agent/extensions`           | `/home/agent/.pi/agent/extensions`               | rw   | agent-authored extensions persist |
| `~/.pi/agent/settings.json`        | `/opt/pa/settings.host.json`                     | ro   | staged, then seeded (see below) |
| `~/.pi/agent/models.json`          | same                                             | ro   | model config |
| `~/.pi/agent/trust.json`           | *(not mounted)*                                  | —    | generated writable in-container (see below) |
| `~/.pi/agent/auth.json` (optional) | `/opt/pa/auth.host.json`                         | ro   | staged, then seeded into the ephemeral home (see below) |
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

pi ships that function twice — once in its plain `dist/` output and once in the
minified `dist/bundle/` that the `pi` command actually executes — so the patch is
applied to both and the build fails if the bundle copy is missed. If you ever see
a bare `pi --session-dir /.../.pi-sessions --session <id>` line again, that is the
symptom of the bundle copy going unpatched; see
[scripts.md](scripts.md#scriptspi-patchmjs-build-time-helper).

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

## Networking: DNS and tailnet hostnames

The container uses **docker's default DNS**. `pa` never passes `--dns`, and
nothing rewrites `/etc/resolv.conf` at startup.

If Tailscale is running on the host, `pa` snapshots MagicDNS **on the host** and
passes each peer to docker as a static hosts entry:

```
--add-host my-mac.tail12345.ts.net:100.101.102.103
```

So `curl http://my-mac.tail12345.ts.net:11434` works in the container (handy for
a model served on the host's `127.0.0.1`), while normal DNS is untouched.

Two consequences worth knowing:

- The snapshot is taken **at launch**. A peer that joins the tailnet mid-session
  won't be known; restart `pa`.
- Only **fully-qualified** MagicDNS names are injected, not bare short names —
  there is no tailnet search domain in the container.

### Heighliner's resolver (spice only)

When a spice server is up, `pa` joins heighliner's docker network, and heighliner
runs its own dnsmasq so `<env>.<suffix>` resolves to its nginx proxy. That one
**does** need `--dns`: the suffix is server config and the env name only exists
after `heighliner init`, so no static hosts entry could cover it.

Neither the network nor the resolver's name is hardcoded. Heighliner used to be
called [kaiser](https://github.com/degica/kaiser) and keeps using a `~/.kaiser`
config when that is the only one present, where they are called `kaiser_net` and
`kaiser-dns`. So `sp up` asks heighliner what they are and stamps the answer onto
the spice container as labels; `pa` reads them from the `docker inspect` it
already makes. A server started by an older `sp` has no labels, and `pa` assumes
the heighliner names — which is right, because that is the only network such a
server could have joined.

It is wired up only when heighliner's DNS container is **running** *and*
reports a valid IPv4 on that network — `docker inspect` answers `<no value>`
when the network key is missing, and `docker run --dns "<no value>"` fails with
*invalid argument* before the agent starts. A public resolver is passed as a
**second** forwarder (`PA_FALLBACK_DNS`, default `1.1.1.1`) so that a dnsmasq
that dies mid-session degrades instead of taking all name resolution with it.
Reaching `heighliner-spice` by container name keeps working regardless: docker's
embedded resolver answers container names itself.

<details>
<summary>Why not <code>--dns 100.100.100.100</code>?</summary>

That is what `pa` used to do, and it broke DNS entirely on Tailscale hosts.
`--dns` **replaces** the container's resolvers rather than adding to them, and
`100.100.100.100` is a tailnet-local address served by `tailscaled` — whether a
container network namespace can reach it depends on the host (on Docker Desktop
the Linux VM has no tailscale route at all). The result was a container whose
*only* nameserver was unreachable: nothing resolved.

The entrypoint then grew a `sudo`-powered `/etc/resolv.conf` rewrite to undo it,
which stopped working the day `pa` started launching with
`--security-opt no-new-privileges` (see
[architecture.md](architecture.md#security-note-sudo-is-opt-in)). Both layers are
gone: MagicDNS is only a name → `100.x` mapping, so it is resolved on the host,
where tailscale definitely works, and passed in as data.

</details>

## Environment toggles

Set these when invoking `pa`:

| Variable        | Default                          | Effect |
|-----------------|----------------------------------|--------|
| `PA_IMAGE`      | `davidsiaw/pi-sandbox:latest`    | image to run |
| `MOUNT_AUTH`    | `1`                              | `0` = do **not** mount `auth.json`; keeps all credentials out of the sandbox (the agent then needs its own auth inside) |
| `MISE_VOLUME`   | `pi-sandbox-mise`                | name of the runtime cache volume |
| `PA_NPM_VOLUME` | `pi-sandbox-npm`                 | volume holding pi's npm package store (`~/.pi/agent/npm`). Set to `""` to opt out and reinstall `packages` from scratch every launch |
| `PA_NPM_CACHE_VOLUME` | `pi-sandbox-npm-cache`     | volume holding npm's own cache (`~/.npm`). Set to `""` to opt out |
| `PA_TS_CACHE_TTL` | `300`                          | seconds to reuse the cached tailnet host snapshot instead of calling `tailscale status`. `0` disables the cache |
| `PA_OPENV_CACHE_TTL` | `0` (off)                   | seconds to cache values resolved from `pa.openv`. **Writes those secrets to `~/.cache/pa` in plaintext** (`0600` in a `0700` dir), so it is opt-in; skips one `op item get` per line, each 0.5–2s |
| `NO_MOUNT_SYSTEM` | `0`                            | `1` = do **not** mount a host `SYSTEM.md` (which would replace pi's default system prompt) |
| `PI_TOOL_EXECUTION` | `sequential`                 | tool-call strategy. `sequential` runs one tool at a time; `parallel` restores upstream concurrent fan-out. Any other value falls back to `parallel`. |
| `PA_UPDATE_COMMAND` | `pa update`                  | what pi's "Update Available" banner tells the user to run. Set it if your launcher is named something else (see [scripts.md](scripts.md#scriptspatch-update-commandsh-root)) |
| `PA_FALLBACK_DNS` | `1.1.1.1`                      | second DNS forwarder, used **only** when heighliner's resolver is wired up (see [Networking](#networking-dns-and-tailnet-hostnames)) |
| `PA_PACKAGES`   | *(empty)*                        | `:`- or `,`-separated host directories, each a pi package checkout, mounted read-only and loaded for the run (see [Private extensions and skills](#private-extensions-and-skills)) |

Examples:

```bash
# run a specific image tag
PA_IMAGE=davidsiaw/pi-sandbox:dev pa

# run fully offline w.r.t. credentials
MOUNT_AUTH=0 pa

# use a separate throwaway runtime cache
MISE_VOLUME=scratch pa

# reinstall pi packages from npm on every launch (no persistence)
PA_NPM_VOLUME= PA_NPM_CACHE_VOLUME= pa

# accept plaintext secret caching for 12h in exchange for a faster launch
PA_OPENV_CACHE_TTL=43200 pa
```

### Why `packages` are kept in a volume

`packages` in `settings.json` is installed with npm on **every** pi startup, and
before the first prompt appears. In a container that is destroyed on exit that
meant a cold install every launch: measured 4.8s cold, 0.66s warm, versus 0.55s
with nothing to install. `PA_NPM_VOLUME` and `PA_NPM_CACHE_VOLUME` persist the
store and the npm cache in Docker volumes, so only the first launch pays.

Volumes, not bind mounts of the host's `~/.pi/agent/npm`: the host store was
built for the host (a native module compiled on macOS is useless to a Linux
container), and the sandbox has no business writing into the real one.

### Tool call serialization

The image runs tool calls **one at a time**. Upstream pi executes sibling tool
calls from the same assistant message concurrently, which a weaker model can turn
into ten simultaneous calls: interleaved output, multiplied rate-limit pressure,
and a run that is hard to review or interrupt.

This costs wall-clock time on independent work — three 3-second commands take ~9s
instead of ~3s. If you want the throughput back:

```bash
docker run -e PI_TOOL_EXECUTION=parallel ...   # or set it in the pa launcher
```

Note that built-in `edit`/`write` serialize per-file through pi's file mutation
queue even in parallel mode, so this is about predictability, not data safety.
See [scripts.md](scripts.md) for how the toggle is patched in.

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

## Project trust

pi prompts for trust the first time it sees a project's local resources
(extensions, `.pi/` config, etc.) and persists your choice by writing
`~/.pi/agent/trust.json`. Two sandbox problems:

1. Mounting the host `trust.json` **read-only** at its real slot makes clicking
   **"Trust"** fail — pi can't write the file.
2. Even if it could, you launched `pa` deliberately in the directory you want to
   work in, so the prompt is friction.

`pa` handles both:

- It passes **`pi --approve`**, which trusts the project for the run without
  prompting. Override per-run with `pa … --no-approve` if you want the prompt.
- It does **not** mount `trust.json` at all. Instead the entrypoint runs
  `seed-trust.sh`, which **generates** a writable `~/.pi/agent/trust.json` in
  the ephemeral HOME that pre-trusts the project directory (the project is
  bind-mounted at its real host path, so `pwd` — canonicalized via
  `realpathSync`, exactly as pi does — is the key pi looks up). pi therefore
  never needs to prompt or write, so there's no read-only mount to fail on and
  your host `trust.json` is never touched.

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

Simple, but the secret sits in a plaintext file — fine for low-value keys. A line
with **no `=`** (just `MY_VAR`) means "inherit this one from my shell".

Because these values are plaintext on disk anyway, they are passed as
`-e KEY=value`, which makes them visible in `ps` output on the host while the
container runs. Use `pa.openv` for anything you would mind being seen there.

### 2. `~/.pi/agent/pa.openv` — live 1Password lookups (preferred for secrets)

Borrowed from the crun `openv` pattern. One line per var:

```
ENVNAME=item:field
ENVNAME=item:field:vault
```

For each line `pa` runs `op item get --reveal <item> --fields label=<field>`
(adding `--vault <vault>` when given) and forwards the result. The
secret is pulled **live at launch** and never stored on disk. Requires the
1Password CLI (`op`) to be installed and signed in; lines are skipped with a
warning if resolution fails. Example:

```
MY_ENV_VAR=my-1password-item:credential
MY_OTHER_KEY=another-item:password:Work
```

Resolved values are forwarded as `-e NAME` (no `=`), so docker inherits them from
`pa`'s own environment and **the secret never appears in the host's `ps` output**.
(`docker inspect` on the container still shows it — unavoidable with `-e`, and
anyone who can reach the docker socket already owns the host.)

Two file-format requirements, both of which fail quietly if ignored:

- **LF endings, and a trailing newline.** CRLF puts a `\r` inside the value and
  the lookup fails. macOS has no `cat -A`; inspect with `cat -etv` or
  `sed -n l` — every line must end in `$` with no `^M` before it.
- **Append carefully.** If the file does not end in a newline, `cat >> pa.openv`
  welds your first new line onto the old last one, and that variable silently
  ceases to exist under the name you expect.

`field` is matched against the field's **label**. A label that matches a
different, *empty* field is the nastiest failure: `op` exits 0, so it looks like
a success. `pa` therefore warns separately and refuses to forward it —

```
pa: warning: MY_ENV_VAR resolved EMPTY from 1Password (item, label=credential) -- wrong field label? not forwarding it
```

— because an empty value is *worse* than a missing one: pi treats `"$VAR"`
resolving to `""` as unresolvable and drops the whole provider from its catalog,
so the only symptom is `Warning: No models match "<your-model>"` with nothing
about credentials anywhere.

Both are additive; the openv source overrides `pa.env` for the same var (Docker
keeps the last `-e`). Neither mounts a secret file into the container, and no
secret is baked into the image.

This is also the recommended way to hold **model credentials**: an `auth.json`
API key can be written as `"$MY_VAR"` and resolved from a var forwarded here, so
the host file carries no secret. See
[Credentials: the `auth.json` trade-off](#credentials-the-authjson-trade-off).

## Private extensions and skills

A public package installs normally: put `npm:...` or an `https://` git source in
`packages` in your host `settings.json` and it works in the sandbox, because
neither needs credentials.

A **private** one does not, and deliberately so. A `packages` entry like
`git:git@github.com:acme/private-pi-ext` makes pi clone the repo at startup, over
ssh — and the sandbox mounts no ssh keys and forwards no agent socket. That entry
fails, loudly, every launch. It is not going to be rescued: cloning a repo into a
container that is deleted on exit is the wrong operation. If you need to *change*
the package, `cd` into its checkout and run `pa` there, like any other project.

To *use* one, hand `pa` the checkout you already have:

```bash
PA_PACKAGES=~/work/acme-private-pi-ext pa
```

Or permanently, one path per line (`#` comments and blanks ignored):

```
# ~/.pi/agent/pa.packages
~/work/acme-private-pi-ext
~/work/data-eng-pi-ext
```

Both sources are additive. `PA_PACKAGES` splits on `:` (like `PATH`) and `,`
(like `PA_ADD_HOST`), so a path containing either character has to go in
`pa.packages`. `~` is expanded. A path that is not a directory is skipped with a
warning.

For each entry `pa`:

- bind-mounts it **read-only** at `/opt/pa/local-packages/<basename>-<n>`, and
- passes `pi -e /opt/pa/local-packages/<basename>-<n>`.

One flag is enough for a whole package. pi resolves a local path through the same
package resolver as an installed package, so it loads that directory's
**extensions, skills, prompt templates and themes** — honouring the `pi` key in
its `package.json`, or the conventional `extensions/` + `skills/` directories if
there is no manifest:

```json
{
  "name": "@acme/private-pi-ext",
  "private": true,
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./extensions"], "skills": ["./skills"] }
}
```

Nothing is copied into `~/.pi/agent/skills` or `~/.pi/agent/extensions`, so your
host pi config stays exactly as clean as it was — which is the point: the private
team packages are not global to your machine, they are a per-launch decision.
Loading is `-e`, i.e. temporary scope: nothing is written to the container's
`settings.json` either.

Two consequences of the read-only mount, both intended:

- The agent cannot modify your checkout. Run `pa` inside the checkout to work on
  it.
- pi does not `npm install` local package sources (that is upstream behaviour,
  not a sandbox restriction), and the mount is not writable, so a package with
  real runtime dependencies needs its `node_modules` present **on the host**.

The index suffix (`-0`, `-1`, …) is there because two checkouts can share a
basename — a fork and its upstream. A visibly ugly path beats one package
silently shadowing the other.

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

`pa` mounts `~/.pi/agent/auth.json` **read-only at a staging path**
(`/opt/pa/auth.host.json`) and the entrypoint's `seed-auth.sh` copies it to a
writable `~/.pi/agent/auth.json` in the ephemeral home. **Nothing is mounted at
pi's real `auth.json` path**, so the container cannot write your host file, and
its own copy dies with the container.

### Why seeded rather than mounted

Because pi writes that file. Two paths, and only two:

- **`/login`** — a completed login is persisted to `auth.json`.
- **OAuth refresh** — a stored `oauth` credential within five minutes of
  `expires` is refreshed and the rotated token written back.

Mounting the host file at the real path forced a choice between two bad options:

- **`:ro`** — reads work (pi's lock file lands in the directory, not the file), so
  an API-key-only setup looks healthy for weeks, then dies the day you log into an
  OAuth provider:

  ```
  Credential store modify failed for anthropic-oauth: EACCES: permission denied,
  open '/home/agent/.pi/agent/auth.json'
  ```

- **`rw`** — works, but a disposable container can rewrite the credentials file on
  the host it was handed.

Seeding avoids both: there is no host file at that path to fail on or corrupt.
Same approach as `settings.json` and `trust.json`.

### OAuth still survives across containers

For **`anthropic-oauth`** nothing is lost. Its real tokens live in
`~/.pi/agent/auth2api/claude-<email>.json`, which is mounted **read-write and
persists** — auth2api owns refreshing them. The `auth.json` entry is only a stub
(access/refresh copied from that file, plus an expiry pi accepts), so
`seed-auth.sh` rebuilds it from the newest readable `claude-*.json` on every
boot. No re-login.

pi-**native** OAuth providers (anthropic subscription, gemini) store their tokens
*only* in `auth.json`, so those do need a fresh `/login` per container.

`seed-auth.sh` takes its base from the first of:

1. `PA_AUTH_SEED` — the file's *content* in an env var, so a launcher can resolve
   it from a vault without it ever touching disk on the host. The entrypoint
   `unset`s it before `exec`, so neither pi nor the agent inherits it.
2. `/opt/pa/auth.host.json` — the staged host file.
3. An `auth.json` already present at the target — see *Older launchers* below.

With none of them, no file is written: pi creates its own `{}` when it first needs
to. The `anthropic-oauth` stub is layered on top of whichever base was used, and
overwrites any `anthropic-oauth` entry that came in with it — a stub from the
host may name a token auth2api has already rotated away, while the token file is
by definition current.

### Older launchers keep working

A `pa` old enough to bind-mount `auth.json` **read-write at pi's real path** is
still fine: the file it mounts is found at the target and used as the base, so
nothing is lost, and it is only rewritten when there is genuinely something to add
(an `anthropic-oauth` entry rebuilt from the token file). With nothing to add it is
left byte-identical, because under that mount every write lands on the host's own
file.

So upgrading the launcher and the image is not a coordinated flag day:

| Launcher | Image | Result |
|---|---|---|
| old (rw at real path) | old | as it always was |
| **old** (rw at real path) | **new** | works; host file used as the base, preserved, only touched when the oauth entry changes |
| **new** (ro staging) | **old** | works; the launcher stages the file into the ephemeral home itself |
| new (ro staging) | new | the arrangement described above |

### Keeping the secret out of the file (recommended)

pi resolves an `api_key` credential's `key` at read time, so the value need not
be in the file at all:

| Form | Meaning |
|------|---------|
| `"sk-abc…"` | literal |
| `"$MY_KEY"` / `"${MY_KEY}"` | environment variable (`$$` escapes a literal `$`) |
| `"!some command"` | run in a shell, use trimmed stdout (cached for the process) |

So point `auth.json` at env vars and let `pa` fill them from 1Password at
launch (see [Forwarding secrets / env vars](#forwarding-secrets--env-vars)):

```json
{
  "openrouter": { "type": "api_key", "key": "$OPENROUTER_API_KEY" }
}
```

```
# ~/.pi/agent/pa.openv
OPENROUTER_API_KEY=my-1password-item:credential
```

Now the host `auth.json` holds **no secret** — it is a list of variable names,
safe to commit — and the real value is pulled live from your vault into the
container's environment, never written to disk on either side. Unresolvable
vars make the provider unavailable with a clear error rather than sending a
bogus key.

This works for `api_key` credentials only. OAuth credentials store
`access`/`refresh`/`expires` literally and are rewritten on refresh, which is
what the seeding above is for.

Provider **headers** in `models.json` go through the same resolver, so a provider
that needs a custom auth header can interpolate the same variable:

```json
"headers": { "Authorization": "Bearer $OPENROUTER_API_KEY" }
```

Note a provider still needs its `auth.json` entry to exist — a header alone
leaves it `credentials_not_configured`.

### Or don't share credentials at all

`MOUNT_AUTH=0` stages nothing — no read, no write, not even the staging mount —
and the sandbox then needs its own auth inside.

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

The next `pa` run recreates the volume and re-downloads versions on first use
(seconds each — they are prebuilt, not compiled).
