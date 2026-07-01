#!/usr/bin/env bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

PI_NODE_MAJOR="${PI_NODE_MAJOR:-22}"

curl -fsSL "https://deb.nodesource.com/setup_${PI_NODE_MAJOR}.x" | bash -
apt-get install -y --no-install-recommends nodejs
rm -rf /var/lib/apt/lists/*

node --version
npm --version
