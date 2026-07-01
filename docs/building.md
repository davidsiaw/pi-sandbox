# Building & publishing

The image is published to Docker Hub as **`davidsiaw/pi-sandbox`**, built for
both `linux/amd64` and `linux/arm64`.

## Local build: `build.sh`

```bash
sh build.sh                 # build both arches and push :latest
PUSH=0 sh build.sh          # build both arches without pushing
TAG=dev sh build.sh         # override the tag (default: latest)
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

Triggers:

- push to `main`
- push of a `v*` tag
- manual `workflow_dispatch` (with an optional `tag` input)

Steps: checkout → setup QEMU → setup buildx → log in to Docker Hub → run
`sh build.sh` with `PUSH=1` and `SKIP_QEMU=1`.

### Required repository secrets

| Secret               | Value |
|----------------------|-------|
| `DOCKERHUB_USERNAME` | `davidsiaw` |
| `DOCKERHUB_TOKEN`    | a Docker Hub access token (Account → Settings → Security → New Access Token) |

### Tagging

- Push to `main` → publishes `:latest`.
- `workflow_dispatch` → publishes the tag you enter (default `latest`).
- To publish a versioned tag, adjust the workflow to derive `TAG` from the git
  tag (currently the tag trigger still uses the dispatch/default `TAG`; wire
  `TAG=${{ github.ref_name }}` on tag pushes if you want `:v1.2.3` images).

## Customizing the pinned Node for pi

pi's system Node major version is a build arg:

```bash
docker buildx build --build-arg PI_NODE_MAJOR=20 ... .
```

This only affects the Node that pi itself runs on. Project Node versions are
independent and managed by mise at runtime.
