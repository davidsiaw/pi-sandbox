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

# The container runs as an ARBITRARY uid, so entrypoint.sh has to append a
# passwd line naming that uid at startup -- hence /etc/passwd must be writable
# by anyone. That is unavoidable.
#
# /etc/shadow is NOT in the same position. sudo's PAM account stage does require
# a shadow entry (without one it fails with "account validation failure, is your
# account locked?" -- verified), but the entry is keyed by NAME and its contents
# carry no uid:
#
#     agent:*:20000:0:99999:7:::
#
# So it can be written once here, at build time, as root. PAM reads it as root
# via setuid sudo, so 0640 is fine. That keeps the world-writable hole to
# /etc/passwd alone instead of handing every process in the container the
# ability to rewrite password hashes.
chmod 0666 /etc/passwd

if ! grep -q '^agent:' /etc/shadow; then
  echo 'agent:*:20000:0:99999:7:::' >> /etc/shadow
fi

echo 'ALL ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/nopasswd-all
chmod 0440 /etc/sudoers.d/nopasswd-all
