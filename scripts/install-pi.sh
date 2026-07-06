#!/usr/bin/env bash
set -euo pipefail

PI_VERSION="${PI_VERSION:-latest}"

npm install -g "@earendil-works/pi-coding-agent@${PI_VERSION}"

pi --version || true
