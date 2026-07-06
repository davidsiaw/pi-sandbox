#!/usr/bin/env bash
set -euo pipefail

PI_VERSION="${PI_VERSION:-latest}"

npm install -g --cache /tmp/npm-cache "@earendil-works/pi-coding-agent@${PI_VERSION}"
rm -rf /tmp/npm-cache

pi --version || true
