#!/bin/bash
set -euo pipefail

IMAGE="${IMAGE:-davidsiaw/pi-sandbox}"
TAG="${TAG:-latest}"
# Remember whether the caller pinned PLATFORMS before we apply the default, so
# the LOAD=1 branch below can narrow it without silently overriding a choice.
PLATFORMS_PINNED="${PLATFORMS:+1}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
PUSH="${PUSH:-1}"
BUILDER="${BUILDER:-pi-sandbox-builder}"
PI_VERSION="${PI_VERSION:-latest}"

cd "$(dirname "$0")"

if [ "${SKIP_QEMU:-0}" != "1" ]; then
  docker run --privileged --rm tonistiigi/binfmt --install all >/dev/null 2>&1 || true
fi

if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  docker buildx create --name "$BUILDER" --driver docker-container --use
else
  docker buildx use "$BUILDER"
fi
docker buildx inspect --bootstrap >/dev/null

OUTPUT_ARGS=()
if [ "$PUSH" = "1" ]; then
  OUTPUT_ARGS+=(--push)
elif [ "${LOAD:-0}" = "1" ]; then
  OUTPUT_ARGS+=(--load)
  # `--load` imports into the local docker image store, which cannot hold a
  # manifest list -- a multi-arch build here fails with "docker exporter does
  # not currently support exporting manifest lists". Narrow to the host arch
  # (the only one the local daemon can run anyway) unless PLATFORMS was pinned.
  if [ -z "$PLATFORMS_PINNED" ]; then
    case "$(uname -m)" in
      aarch64|arm64) PLATFORMS="linux/arm64" ;;
      *)             PLATFORMS="linux/amd64" ;;
    esac
  fi
  case "$PLATFORMS" in
    *,*)
      echo "LOAD=1 cannot load a multi-arch build (PLATFORMS=$PLATFORMS)." >&2
      echo "  Pin a single platform, e.g. PLATFORMS=linux/amd64 LOAD=1 sh build.sh" >&2
      exit 1
      ;;
  esac
  echo "LOAD=1 -> building $PLATFORMS and loading into local docker"
else
  echo "PUSH=0 -> building without pushing or loading (image not available locally)"
  echo "  Set LOAD=1 to load into local docker, or PUSH=1 to push to registry"
fi

TAG_ARGS=()
if [ -n "${TAGS:-}" ]; then
  for t in $TAGS; do TAG_ARGS+=(--tag "$t"); done
else
  TAG_ARGS+=(--tag "${IMAGE}:${TAG}")
fi

BUILD_ARGS=(--build-arg "PI_VERSION=${PI_VERSION}")
if [ -n "${CLOAKBROWSER_VERSION:-}" ]; then
  BUILD_ARGS+=(--build-arg "CLOAKBROWSER_VERSION=${CLOAKBROWSER_VERSION}")
fi
if [ -n "${PA_UITAG_MODEL_URL:-}" ]; then
  BUILD_ARGS+=(--build-arg "PA_UITAG_MODEL_URL=${PA_UITAG_MODEL_URL}")
fi

set -x
docker buildx build \
  --platform "$PLATFORMS" \
  "${BUILD_ARGS[@]}" \
  "${TAG_ARGS[@]}" \
  ${OUTPUT_ARGS[@]+"${OUTPUT_ARGS[@]}"} \
  .
