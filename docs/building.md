# Building & publishing

The image is published to Docker Hub as **`davidsiaw/pi-sandbox`**, built for
both `linux/amd64` and `linux/arm64`.

## Local build: `build.sh`

```bash
sh build.sh                       # build both arches and push :latest
PUSH=0 sh build.sh                # build both arches without pushing
TAG=dev sh build.sh               # override the tag (default: latest)
PI_VERSION=0.80.3 sh build.sh     # pin a specific pi release
TAGS="davidsiaw/pi-sandbox:latest davidsiaw/pi-sandbox:0.80.3" sh build.sh   # multiple tags
```

### What it does

1. Registers QEMU binfmt handlers (via `tonistiigi/binfmt`) so foreign
   architectures can be built locally. Skipped when `SKIP_QEMU=1` (CI already
   sets up QEMU with an action).
2. Creates (once) and selects a buildx builder using the `docker-container`
   driver, which is required for multi-arch builds.
3. Runs `docker buildx build --platform linux/amd64,linux/arm64` and, unless
   `PUSH=0`, pushes the result.

### Environment variables

| Variable    | Default                          | Meaning |
|-------------|----------------------------------|---------|
| `IMAGE`     | `davidsiaw/pi-sandbox`           | image repository |
| `TAG`       | `latest`                         | image tag |
| `PLATFORMS` | `linux/amd64,linux/arm64`        | target platforms |
| `PUSH`      | `1`                              | push to the registry (`0` = build only) |
| `BUILDER`   | `pi-sandbox-builder`             | buildx builder name |
| `SKIP_QEMU` | `0`                              | `1` = don't run the binfmt install step |
| `PI_VERSION`| `latest`                         | pi release to install (passed as `--build-arg`) |
| `TAGS`      | —                                | space-separated tag list; overrides `TAG` when set |

### Important: multi-arch images can't be loaded locally

`docker buildx` with multiple platforms produces a manifest list that the local
Docker daemon can't `--load`. So:

- `sh build.sh` (PUSH=1) pushes to the registry; the image is **not** left in
  your local daemon.
- `PUSH=0 sh build.sh` only verifies the build; nothing is loaded either.

To get a locally-runnable image (e.g. to smoke-test), build a **single** arch
with `--load`:

```bash
docker buildx build --platform linux/arm64 -t davidsiaw/pi-sandbox:latest --load .
# or on amd64 hosts: --platform linux/amd64
```

Then `sh smoketest.sh` can test it. See [testing.md](testing.md).

### Build time

The amd64 leg built under QEMU emulation on an arm64 Mac is **slow** (Chromium
download plus any source compilation). The native leg is fast. CI builds each
arch on native runners where possible, which is quicker.

## CI: `.github/workflows/build.yml`

Two jobs: a lightweight **check** that decides whether to build, and the
**build** that runs only when check says so.

Triggers:

- **schedule** (daily `cron`) — checks npm for a newer pi and builds if the
  matching image tag doesn't exist yet
- **push** to `master` or a `v*` tag — always builds (source changed)
- **workflow_dispatch** — manual, with optional `pi_version` (blank = npm
  latest) and `force` (build even if the tag already exists)

### The check job

1. Resolves the pi version: the `pi_version` input if given, else npm's
   `@earendil-works/pi-coding-agent@latest`.
2. Decides `should_build`:
   - push event → always true
   - `force=true` → true
   - otherwise → true only if `davidsiaw/pi-sandbox:<version>` does **not**
     already exist on Docker Hub (checked via the registry tags API,
     HTTP 200 = exists = skip).
3. Exposes `pi_version` and `should_build` as outputs.

### The build job

Runs only when `should_build == 'true'`. It first builds a single-arch
(`linux/amd64`) image, loads it locally, and runs `smoketest.sh` against it.
Only if the smoke test passes does it build both arches with
`--build-arg PI_VERSION=<version>` and push two tags: `:latest` and
`:<version>`. (Multi-arch images can't be loaded locally, hence the separate
load-and-test build; the buildx cache makes the second build cheap.) The
`:<version>` tag is what the next scheduled check looks for, so each pi release
is built at most once.

Steps: checkout → setup QEMU → setup buildx → log in to Docker Hub →
build+load amd64 → smoke test → build-push both arches.

### Required repository secrets

| Secret               | Value |
|----------------------|-------|
| `DOCKERHUB_USERNAME` | `davidsiaw` |
| `DOCKERHUB_TOKEN`    | a Docker Hub access token (Account → Settings → Security → New Access Token) |

### Tagging

- Every build publishes both `:latest` and `:<pi-version>` (e.g. `:0.80.3`).
- The versioned tag doubles as the "already built this release" marker the
  scheduled check keys off.

## Customizing the pinned Node for pi

pi's system Node major version is a build arg:

```bash
docker buildx build --build-arg PI_NODE_MAJOR=20 ... .
```

This only affects the Node that pi itself runs on. Project Node versions are
independent and managed by mise at runtime.

## Pinning the pi version

The pi release installed into the image is a build arg (default `latest`):

```bash
docker buildx build --build-arg PI_VERSION=0.80.3 ... .
```

The scheduled CI passes this automatically so each published image pins an
exact pi release and is tagged with it.
