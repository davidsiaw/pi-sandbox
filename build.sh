#!/usr/bin/env bash
set -eu pipefail

IMAGE="${IMAGE:-davidsiaw/pi-sandbox}"
TAG="${TAG:-latest}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
PUSH="${PUSH:-1}"
BUILDER="${BUILDER:-pi-sandbox-builder}"

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
else
  echo "PUSH=0 -> building both arches without pushing (image not loaded locally)"
fi

set -x
docker buildx build \
  --platform "$PLATFORMS" \
  --tag "${IMAGE}:${TAG}" \
  ${OUTPUT_ARGS[@]+"${OUTPUT_ARGS[@]}"} \
  .
