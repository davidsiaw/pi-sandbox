#!/usr/bin/env bash
# contact-sheet.sh <video> [outdir=sheets] [interval_s=auto] [cols=4] [rows=4]
#
# Tiles frames of <video> into cols x rows contact sheets (320 px wide tiles,
# each with its timestamp burned in) written to <outdir>/sheet_001.jpg, ...
# interval_s is the gap between sampled frames; "auto" (default) spaces them so
# the whole video fits on one sheet. Prints the sheet paths.
set -euo pipefail

if [ $# -lt 1 ] || [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
  sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi

video="$1"
outdir="${2:-sheets}"
interval="${3:-auto}"
cols="${4:-4}"
rows="${5:-4}"
font=/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf

[ -f "$video" ] || { echo "contact-sheet: no such file: $video" >&2; exit 1; }

if [ "$interval" = "auto" ]; then
  dur="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$video")"
  case "$dur" in ''|N/A) echo "contact-sheet: cannot read duration of $video; pass an interval" >&2; exit 1 ;; esac
  interval="$(awk -v d="$dur" -v n="$((cols * rows))" 'BEGIN { printf "%.3f", d / n }')"
fi

mkdir -p "$outdir"
rm -f "$outdir"/sheet_*.jpg

# select keeps a frame once at least $interval has passed since the last kept
# one, so N*interval == duration yields at most N frames (one sheet). Unlike
# the fps filter it keeps original timestamps, so the burned-in time is exact.
ffmpeg -hide_banner -v error -y -i "$video" -an -sn -dn \
  -vf "select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,$interval)',scale=320:-2,drawtext=fontfile=$font:text='%{pts\\:hms}':x=4:y=4:fontsize=16:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=3,tile=${cols}x${rows}:padding=2:margin=2" \
  -fps_mode passthrough -q:v 3 "$outdir/sheet_%03d.jpg"

ls "$outdir"/sheet_*.jpg
