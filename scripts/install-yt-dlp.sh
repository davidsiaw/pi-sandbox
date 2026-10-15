#!/usr/bin/env bash
set -euo pipefail

# yt-dlp, for the `video` skill. Installs the official standalone (PyInstaller)
# Linux binary for this architecture to /usr/local/bin/yt-dlp and points it at
# the system node for YouTube's JS challenges.
#
# WHY THE STANDALONE BINARY
#   The image has no system Python by design (runtimes are mise-managed and
#   optional). The PyInstaller build bundles its own interpreter AND the
#   yt-dlp-ejs challenge-solver scripts, so it needs nothing else from us.
#   The zipimport `yt-dlp` asset would need python3 on PATH.
#
# WHY NODE, AND WHY THE ABSOLUTE PATH
#   YouTube downloads need an external JS runtime. yt-dlp enables only deno by
#   default; node (>= 22) is supported via --js-runtimes. The image already has
#   node 22 at /usr/bin/node (pi's own), so no deno is baked. The path is
#   absolute because a project's mise config can put an older `node` shim
#   first on PATH, which yt-dlp would then pick up and reject.
#
# WHY UNPINNED BY DEFAULT
#   YouTube changes break old yt-dlp releases within weeks; a pinned version
#   rots. This script runs LOW in the Dockerfile (after the pi install, which
#   changes on every pi release), so each image build fetches the current
#   release. Pin to reproduce an old image:
#     YTDLP_VERSION=2026.08.19 sh build.sh
#   The installed version is whatever `yt-dlp --version` prints.
#
# Integrity: the binary is checked against the SHA2-256SUMS file published in
# the same release. A mismatch fails the build.

VERSION="${YTDLP_VERSION:-}"

case "$(dpkg --print-architecture)" in
  amd64) ASSET=yt-dlp_linux ;;
  arm64) ASSET=yt-dlp_linux_aarch64 ;;
  *) echo "ERROR: no yt-dlp standalone build for $(dpkg --print-architecture)" >&2; exit 1 ;;
esac

if [ -n "$VERSION" ]; then
  BASE="https://github.com/yt-dlp/yt-dlp/releases/download/${VERSION}"
else
  BASE="https://github.com/yt-dlp/yt-dlp/releases/latest/download"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL --retry 3 -o "$tmp/$ASSET" "$BASE/$ASSET"
curl -fsSL --retry 3 -o "$tmp/SHA2-256SUMS" "$BASE/SHA2-256SUMS"

expected="$(awk -v a="$ASSET" '$2 == a { print $1 }' "$tmp/SHA2-256SUMS")"
[ -n "$expected" ] || { echo "ERROR: $ASSET not listed in SHA2-256SUMS" >&2; exit 1; }
echo "$expected  $tmp/$ASSET" | sha256sum -c -

install -m 0755 "$tmp/$ASSET" /usr/local/bin/yt-dlp

# System-wide config (yt-dlp reads /etc/yt-dlp.conf). Users can still add their
# own ~/.config/yt-dlp/config or pass --ignore-config.
cat > /etc/yt-dlp.conf <<'CONF'
# Baked by pa (scripts/install-yt-dlp.sh).
# YouTube needs a JS runtime; use pi's node 22 by absolute path so a project's
# mise node shim cannot shadow it.
--js-runtimes node:/usr/bin/node
CONF
chmod 0644 /etc/yt-dlp.conf

echo "yt-dlp $(/usr/local/bin/yt-dlp --version) installed ($ASSET)"
