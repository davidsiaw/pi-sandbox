# Build cache: the layer tetris

How to keep CI builds fast, why they were slow, and what to check before adding
anything to the `Dockerfile`.

## The measurement

Two consecutive `master` pushes, nothing else changed about the runners:

| run | commit | total | amd64 build | smoke test | arm64 (multi-arch push) |
|-----|--------|-------|-------------|------------|--------------------------|
| [#83](https://github.com/davidsiaw/pi-sandbox/actions/runs/31285133144) | `5cea610` *move from gha to registry* | **25m 03s** | 3m | 6m | 17m |
| [#84](https://github.com/davidsiaw/pi-sandbox/actions/runs/31286221183) | `9bc74a4` *rearrange deps* | **11m 44s** | 2m | — | 6m |

Every run *before* #83 was ~25m as well. The arm64 leg is always the long pole:
it runs under QEMU emulation, so it is roughly 3x the amd64 leg for the same
work — which means **cache misses cost about three times as much on arm64**.

## Read this first

**A caching change cannot prove itself on the build that introduces it.**

Run #83 *is* the commit that switched to a registry cache — and it took 25m,
because the registry cache did not exist yet and the base-image digest pins in
the same commit invalidated layer 1. It looked like a failure. The benefit showed
up on #84.

So: judge a cache change on run **N+1**, and do not revert it because N was slow.

## What was actually wrong

Four separate causes, all producing the same symptom — "I changed a README and
it rebuilt from `apt-get`".

### 1. The GitHub Actions cache could not hold this image

`cache-to: type=gha,mode=max` on a **~3.8 GB** rootfs, with `mode=max` exporting
every intermediate layer, for **two architectures**. The Actions cache is capped
at **10 GB per repository** with LRU eviction, so each run evicted the previous
run's entries and the next build started cold.

**Fix:** a registry cache, which has no such cap and which you already have
credentials for:

```yaml
cache-from: type=registry,ref=davidsiaw/pi-sandbox:buildcache
cache-to:   type=registry,ref=davidsiaw/pi-sandbox:buildcache,mode=max,image-manifest=true,oci-mediatypes=true
```

`image-manifest=true,oci-mediatypes=true` are required for Docker Hub to store
the cache manifest.

**Keep `mode=max`, not `min`.** Only `max` caches the `uitag-export` stage, whose
~1 GB torch install never appears in the final image and would otherwise re-run
on every build.

### 2. The two build steps were overwriting each other's cache

The workflow builds twice: amd64 with `load: true` for the smoke test, then
multi-arch with `push: true`. Both used to write `type=gha` with **no `scope`**,
so the amd64-only export and the multi-arch export clobbered each other each run.

**Fix:** only the multi-arch step writes (`cache-to`); the test step reads only.
Nothing is lost — both steps run in the same job on the same buildx instance, so
the test build's layers are still reused locally by the push step.

### 3. Base image tags move

`FROM debian:trixie-slim` is a moving tag. Debian re-pushed it on 2026-08-05;
when the digest changes, **every layer beneath it** is invalidated, starting at
`apt-get`. Same for `python:3.13-slim` feeding the torch stage.

**Fix:** pin the **manifest-list** digest, never a per-arch one (a per-arch
digest breaks the other architecture's leg outright):

```bash
docker buildx imagetools inspect debian:trixie-slim | head -3   # Digest: sha256:...
```

Bumping is then a deliberate edit rather than a surprise.

### 4. Volatile files sat above expensive steps

`COPY pa-extensions` used to sit above six npm installs (pa-rag's tree alone is
329 MB), the 23 MB RAG model bake, the ONNX Runtime prune, two upstream patches
and the uitag model bake. Editing one comment in one extension re-ran all of it.

**Fix:** the manifest/source split — copy only `package.json` (+ lockfiles),
install dependencies, bake models, and copy extension **source** last. See the
comments around the manifest COPY block in the `Dockerfile`.

## The tetris: what order things go in

Top to bottom, cheapest-to-invalidate last:

```
1. base images            pinned by manifest-list digest
2. third-party & slow     apt, Node, Chromium, mise, CloakBrowser, auth2api
   ------------------------------------------------------------------ the line
3. dependency manifests   pa-extensions/*/package.json (+ lockfiles) ONLY
4. expensive installs     npm installs, RAG model bake, ONNX prune, patches,
                          uitag model bake
5. source                 COPY pa-extensions   (+ the --verify guard)
6. prose & runtime files  pa-skills, docs, APPEND_SYSTEM.base.md, entrypoint
7. pi itself              install-pi.sh (PI_VERSION changes nightly, so last)
```

The rule that generates this: **a `COPY` must sit below anything expensive that
does not read it.** Almost every mistake here is a `COPY` placed higher than it
needs to be.

Corollaries worth remembering:

- **`COPY` merges, it does not delete.** That is why `COPY pa-extensions` at
  step 5 cannot remove the `node_modules` installed at step 4.
- **`.dockerignore` excluding `**/node_modules/` is load-bearing** for the same
  reason — a local `node_modules` in the build context would collide with it.
- **Model bakes write to `/opt/pa/models`**, outside the extension directories,
  so the source copy cannot disturb them.
- **`install-pi.sh` stays last** even though it is expensive: `PI_VERSION` is a
  build arg that changes with every nightly pi release, so it would invalidate
  everything below it wherever you put it.

## Diagnosing a slow build

| symptom | most likely cause |
|---|---|
| starts at `apt-get` (`stage-1 3/42`) | base digest moved, `install-system-deps.sh` changed, or the cache is simply empty |
| `uitag-export` re-runs the torch install | `mode=min`, or a cold cache — that stage is only cached by `mode=max` |
| npm installs / model bakes re-run after a source-only edit | something was copied above them; check the manifest/source split |
| everything cold on consecutive runs | cache not being written — look for a `cache export` warning at the end of the log |
| first build after a cache change is slow | expected, see "Read this first" |

Useful checks:

```bash
# has the base tag moved since the pin?
docker buildx imagetools inspect debian:trixie-slim | head -3

# what actually got rebuilt — buildx prints CACHED for hits
docker buildx build ... --progress=plain 2>&1 | grep -c CACHED
```

## Before you add a step to the Dockerfile

1. Does anything expensive below it read what it copies? If not, move it down.
2. Does it install packages? Add them to `install-system-deps.sh` rather than a
   new `apt` layer — a second `apt-get update` layer was installing
   `fonts-liberation` and `fonts-noto-color-emoji` twice.
3. Does it add an extension with npm dependencies? Add its `package.json` to the
   manifest COPY block, or the `--verify` pass after the source COPY fails the
   build (deliberately — otherwise it would fail at runtime when jiti cannot
   resolve the imports).
4. Does it need a new base image? Pin the manifest-list digest.
5. Expect the next build to be slow if you touched anything at or above step 2.

## The remaining floor

With a warm cache the arm64 QEMU leg dominates. The one knob that removes work
rather than caching it is `PA_UITAG_MODEL_URL`: point it at a self-hosted
`yolo-ui.onnx` and the `uitag-export` stage — the ~1 GB torch install — is
skipped entirely. See [uitag.md](uitag.md).
