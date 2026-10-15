#!/usr/bin/env bash
set -euo pipefail

# ffmpeg + ffprobe, for the `video` skill: cutting frames / contact sheets out
# of a video so a vision model can read them, and for yt-dlp to merge formats
# and download time sections.
#
# WHY DEBIAN'S PACKAGE, NOT A STATIC BUILD
#   Same reasoning as poppler-utils: one apt line, both architectures for free,
#   security updates with every rebuild. Measured on trixie arm64 with
#   --no-install-recommends: ~175MB of libraries on top of what the image
#   already carries. A static build (johnvansickle / BtbN) is not meaningfully
#   smaller once ffprobe is included, and would need its own pinning and
#   checksum plumbing per arch.
#
# drawtext (used to burn timestamps into contact-sheet tiles) needs libfreetype,
# which Debian's ffmpeg links; the DejaVu font it uses comes from
# install-system-deps.sh (fonts-dejavu).
#
# Its own RUN layer, placed below the other third-party installs, so adding it
# does not invalidate apt / node / Chromium / mise / CloakBrowser.

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends ffmpeg
rm -rf /var/lib/apt/lists/*

v="$(ffmpeg -hide_banner -version)";  echo "${v%%$'\n'*}"
v="$(ffprobe -hide_banner -version)"; echo "${v%%$'\n'*}"
# Capture first, THEN grep. Piping straight into `grep -q` is a false negative
# under pipefail: grep exits on the first match, ffmpeg takes SIGPIPE writing
# the rest of the filter list, and the pipeline reports failure.
filters="$(ffmpeg -hide_banner -filters 2>/dev/null)"
grep -qw drawtext <<<"$filters" \
  || { echo "ERROR: this ffmpeg has no drawtext filter (contact sheets need it)" >&2; exit 1; }
