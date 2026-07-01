#!/usr/bin/env bash
set -euo pipefail

HOME_DIR=/home/agent
MISE_DATA_DIR="${HOME_DIR}/.local/share/mise"

mkdir -p "${HOME_DIR}"
chmod 0777 "${HOME_DIR}"

mkdir -p "${HOME_DIR}/.pi/agent"
chmod -R 0777 "${HOME_DIR}/.pi"

mkdir -p "${MISE_DATA_DIR}"
chmod -R 0777 "${HOME_DIR}/.local"

mkdir -p "${HOME_DIR}/.cache/mise"
chmod -R 0777 "${HOME_DIR}/.cache"

mkdir -p "${HOME_DIR}/.config"
chmod -R 0777 "${HOME_DIR}/.config"

chmod 0666 /etc/passwd /etc/shadow

echo 'ALL ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/nopasswd-all
chmod 0440 /etc/sudoers.d/nopasswd-all
