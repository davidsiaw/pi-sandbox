#!/usr/bin/env bash
set -euo pipefail

curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh

chmod 0755 /usr/local/bin/mise

cat > /etc/profile.d/mise.sh <<'EOF'
export PATH="${MISE_DATA_DIR:-/home/agent/.local/share/mise}/shims:$PATH"
if command -v mise >/dev/null 2>&1; then
  eval "$(mise activate bash)"
fi
EOF
chmod 0644 /etc/profile.d/mise.sh

mise --version
