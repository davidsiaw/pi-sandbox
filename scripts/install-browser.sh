#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/ms-playwright}"

npm install -g playwright

mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"
playwright install --with-deps chromium

chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"

rm -rf /var/lib/apt/lists/*

playwright --version
